const xlsx = require('xlsx');

/**
 * XLSX and CSV parser.
 *
 * Produces markdown tables with the cell reference on every row, so the extractor can cite a
 * specific cell and the engine can trace a figure back to it.
 *
 * The important detail is percentage formatting. A cell displayed as "62%" is stored by Excel as
 * the number 0.62 with a percent display format. Reading the raw value gives 0.62, which then
 * enters the engine as a gross margin of 0.62% instead of 62% - a hundredfold error that produces a
 * confident, completely wrong finding. The default `sheet_to_json` does exactly that.
 *
 * So this reads the FORMATTED text (`w`) in preference to the raw value, which is what a human
 * reading the spreadsheet would see, and falls back to reconstructing the percentage when no
 * formatted text is available.
 */

/** Excel number-format codes containing a literal % mean the value is a stored fraction. */
function isPercentFormat(cell) {
  if (!cell) return false;
  if (typeof cell.z === 'string' && cell.z.includes('%')) return true;
  if (typeof cell.w === 'string' && cell.w.trim().endsWith('%')) return true;
  return false;
}

/**
 * The text a human would see in this cell.
 *
 * Order matters: formatted text first, because that is the displayed truth. Only fall back to the
 * raw value when the file carries no formatting, and in that case rebuild the percentage by hand.
 */
function cellText(cell) {
  if (!cell) return '';

  // Formatted value, as displayed. Handles percentages, currency symbols, thousands separators
  // and dates without any guessing on our part.
  if (typeof cell.w === 'string' && cell.w.trim() !== '') return cell.w.trim();

  if (cell.v === undefined || cell.v === null) return '';

  // No formatted text but a percent format: 0.62 -> "62%".
  if (isPercentFormat(cell) && typeof cell.v === 'number') {
    const pct = cell.v * 100;
    return `${Number.isInteger(pct) ? pct : Number(pct.toFixed(4))}%`;
  }

  if (cell.t === 'd' && cell.v instanceof Date) return cell.v.toISOString().slice(0, 10);

  return String(cell.v);
}

function columnLetter(index) {
  let letter = '';
  let n = index;
  while (n >= 0) {
    letter = String.fromCharCode((n % 26) + 65) + letter;
    n = Math.floor(n / 26) - 1;
  }
  return letter;
}

async function parse(file) {
  try {
    // cellNF and cellText make `z` (number format) and `w` (formatted text) available, which the
    // default read options omit - and without them percentages cannot be recovered.
    const workbook = xlsx.readFile(file.path, {
      cellNF: true,
      cellText: true,
      cellDates: true,
      raw: false
    });

    let markdown = '';

    for (const sheetName of workbook.SheetNames) {
      const sheet = workbook.Sheets[sheetName];
      if (!sheet || !sheet['!ref']) continue;

      const range = xlsx.utils.decode_range(sheet['!ref']);
      const rows = [];

      for (let r = range.s.r; r <= range.e.r; r++) {
        const cells = [];
        let hasContent = false;

        for (let c = range.s.c; c <= range.e.c; c++) {
          const address = xlsx.utils.encode_cell({ r, c });
          const text = cellText(sheet[address]);
          if (text !== '') hasContent = true;
          cells.push(text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' '));
        }

        // Blank rows are common as visual spacing and carry no data.
        if (hasContent) rows.push({ rowNumber: r + 1, cells });
      }

      if (rows.length === 0) continue;

      markdown += `## Sheet: ${sheetName}\n\n`;

      const columnCount = rows[0].cells.length;

      // A leading Cell column gives the extractor something concrete to cite, which turns
      // source_cell from a guess into a fact.
      markdown += `| Cell | ${rows[0].cells.join(' | ')} |\n`;
      markdown += `| --- | ${Array.from({ length: columnCount }, () => '---').join(' | ')} |\n`;

      for (const row of rows.slice(1)) {
        const ref = `${columnLetter(range.s.c)}${row.rowNumber}`;
        markdown += `| ${ref} | ${row.cells.join(' | ')} |\n`;
      }

      markdown += '\n';
    }

    if (markdown.trim() === '') {
      throw new Error('The spreadsheet contains no readable cells');
    }

    return markdown;
  } catch (err) {
    console.error(`XLSX/CSV parsing error for ${file.originalname || file.original_filename}:`, err.message);
    throw new Error(`Failed to parse spreadsheet: ${err.message}`);
  }
}

module.exports = { parse, cellText, isPercentFormat };
