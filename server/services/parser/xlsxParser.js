const xlsx = require('xlsx');

async function parse(file) {
  try {
    const workbook = xlsx.readFile(file.path);
    let markdownContent = '';

    for (const sheetName of workbook.SheetNames) {
      const sheet = workbook.Sheets[sheetName];
      // Convert sheet to JSON array (array of arrays) to easily build a markdown table
      const data = xlsx.utils.sheet_to_json(sheet, { header: 1 });
      
      if (data.length > 0) {
        markdownContent += `## Sheet: ${sheetName}\n\n`;
        
        // Convert to basic markdown table
        data.forEach((row, rowIndex) => {
          if (row && row.length > 0) {
            markdownContent += '| ' + row.map(cell => cell !== undefined ? String(cell).replace(/\|/g, '\\|') : '').join(' | ') + ' |\n';
            // Add header separator
            if (rowIndex === 0) {
              markdownContent += '| ' + row.map(() => '---').join(' | ') + ' |\n';
            }
          }
        });
        markdownContent += '\n';
      }
    }

    return markdownContent;
  } catch (err) {
    console.error(`XLSX Parsing error for ${file.original_filename}:`, err);
    throw new Error('Failed to parse XLSX/CSV document');
  }
}

module.exports = { parse };
