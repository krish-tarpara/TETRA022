/**
 * Observation extractor.
 *
 * The model's entire job is: read this document, and tell me every number you can see and
 * where you saw it. It does not classify, compare, judge, or score anything. Those are the
 * rule engine's job, and keeping the model out of them is what makes the verdicts
 * reproducible.
 *
 * The output contract is one flat list of observations. Every observation must carry a
 * verbatim quote from the document; the canonicalizer discards any that doesn't, so the
 * prompt states that requirement bluntly and repeatedly.
 *
 * Provider note: this runs on Groq (llama-3.3-70b-versatile) because it supports
 * `response_format: json_object` and the project's Groq key is already wired up. The file
 * keeps its historical name for import compatibility. GEMINI_MODEL/EXTRACTOR_PROVIDER env
 * vars can switch it to Google without touching callers.
 */

const OpenAI = require('openai');
const { TAXONOMY_MAP } = require('../normalization/taxonomyMap');
const { canonicalizeBatch } = require('../../engine/canonicalize');

const MODEL = process.env.EXTRACTOR_MODEL || 'llama-3.3-70b-versatile';
const MAX_CHARS_PER_CHUNK = 45000;
const MAX_RETRIES = 3;

/** The metric vocabulary, rendered for the prompt straight from the taxonomy. */
function buildTaxonomySection() {
  return Object.entries(TAXONOMY_MAP)
    .map(([key, def]) => {
      const aliases = def.aliases.slice(0, 8).join('", "');
      return `  ${key}  (${def.unit})  <- "${aliases}"`;
    })
    .join('\n');
}

function buildPrompt(documentCategory) {
  return `You are a financial data extraction engine. You read one document and report every
number you can find in it. You do NOT analyse, compare, judge, or flag anything - a separate
deterministic engine does that. Your output is raw evidence, nothing more.

DOCUMENT TYPE: ${documentCategory || 'unknown'}

Return a JSON object with a single key "observations", whose value is an array. One array
entry per number you found. Use these fields:

  metric_key      Which metric this is. MUST be one of the keys listed below. If the number
                  does not fit any listed key, OMIT the observation entirely.
  raw_label       The label exactly as the document writes it. e.g. "Topline (FY26E)"
  value_raw       The value exactly as the document writes it, INCLUDING currency symbol and
                  scale word. e.g. "Rs 5.2 Cr", "$1.5M", "38.5%", "42". Never strip these -
                  the engine re-parses this string and relies on it being verbatim.
  value           The same number as a plain numeric, fully expanded. "5.2 Cr" -> 52000000.
  period          The time period as the document states it. e.g. "FY26", "Q3 FY25",
                  "Mar-2025", "Year 1". Use null if the document truly states none.
  period_type     One of: historical, current, projected, unknown
  basis           One of: audited, management, projected, pro_forma
  source_page     Page or slide number where you found it, as an integer. null if unknown.
  source_cell     Spreadsheet cell or table reference if applicable, else null.
  source_quote    REQUIRED. The verbatim sentence, table row, or line containing this number,
                  copied character-for-character from the document.
  confidence      0.0-1.0. How sure are you that you read this number and label correctly?
  company_name    The company or entity this document is about.

ABSOLUTE RULES:

1. source_quote is mandatory and must be copied verbatim from the document text. If you
   cannot produce a real quote containing the number, DO NOT emit the observation. An
   observation without a genuine quote is discarded and counts against extraction quality.
2. Never invent, estimate, infer, or calculate a number. If the document does not state it,
   it does not exist. Do not compute totals, margins, or growth rates yourself.
3. Report every period separately. A table with FY24, FY25 and FY26 revenue is THREE
   observations, not one.
4. Report every line item separately, including subtotals that the document states
   explicitly (revenue, cogs, gross_profit, opex, ebitda are five observations).
5. For cap tables, emit one ownership observation per shareholder, with the shareholder name
   in raw_label.
6. Keep the currency symbol and scale word in value_raw. "5.2" and "Rs 5.2 Cr" are not the
   same evidence.
7. Do not deduplicate. If the same figure appears on two pages, report it twice with
   different source_page values.

METRIC KEYS (use the key on the left, exactly as written):

${buildTaxonomySection()}

Return ONLY the JSON object. No commentary, no markdown fences.`;
}

function getClient() {
  return new OpenAI({
    apiKey: process.env.GROQ_API_KEY,
    baseURL: 'https://api.groq.com/openai/v1'
  });
}

/**
 * Split long documents on page-marker boundaries.
 *
 * A single oversized request gets silently truncated by the model, which looks like "the
 * back half of the document contained no metrics" - a failure mode that is invisible in the
 * output. Chunking makes the truncation impossible instead of undetectable.
 */
function chunkContent(content) {
  if (!content) return [];
  if (content.length <= MAX_CHARS_PER_CHUNK) return [content];

  const lines = content.split('\n');
  const chunks = [];
  let current = '';

  for (const line of lines) {
    const isPageBreak = /^\s*(#+\s*)?(page|slide)\s+\d+/i.test(line) || /^---\s*$/.test(line);

    if (current.length + line.length > MAX_CHARS_PER_CHUNK && current.length > 0 && isPageBreak) {
      chunks.push(current);
      current = '';
    } else if (current.length + line.length > MAX_CHARS_PER_CHUNK * 1.3 && current.length > 0) {
      // Hard cap: no page break appeared in time, split anyway rather than truncate.
      chunks.push(current);
      current = '';
    }
    current += line + '\n';
  }

  if (current.trim()) chunks.push(current);
  return chunks;
}

async function callModel(client, systemPrompt, userContent) {
  let lastError;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const completion = await client.chat.completions.create({
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `DOCUMENT CONTENT:\n${userContent}` }
        ],
        model: MODEL,
        temperature: 0,
        response_format: { type: 'json_object' }
      });

      const parsed = JSON.parse(completion.choices[0].message.content);
      const records = parsed.observations || parsed.metrics || [];
      if (!Array.isArray(records)) throw new Error('observations was not an array');
      return records;
    } catch (err) {
      lastError = err;
      const retriable = err.status === 429 || err.status >= 500 || err instanceof SyntaxError;
      if (!retriable || attempt === MAX_RETRIES) break;
      await sleep(1000 * Math.pow(2, attempt - 1));
    }
  }

  throw lastError;
}

/**
 * Extract canonical observations from one parsed document.
 *
 * @param {object} document  { id, session_id, original_filename, document_category,
 *                             file_type, parsed_content, period_hint }
 * @returns {Promise<{observations:Array, dropped:Array, company_name:string|null, stats:object}>}
 */
async function extractObservations(document) {
  const client = getClient();
  const systemPrompt = buildPrompt(document.document_category);
  const chunks = chunkContent(document.parsed_content);

  const rawRecords = [];
  const chunkErrors = [];

  for (let i = 0; i < chunks.length; i++) {
    try {
      const records = await callModel(client, systemPrompt, chunks[i]);
      rawRecords.push(...records);
    } catch (err) {
      // One bad chunk should not cost us the rest of the document.
      console.error(`Extraction failed on chunk ${i + 1}/${chunks.length} of ${document.original_filename}:`, err.message);
      chunkErrors.push({ chunk: i + 1, error: err.message });
    }
  }

  if (rawRecords.length === 0 && chunkErrors.length === chunks.length) {
    throw new Error(`Extraction failed for ${document.original_filename}: all ${chunks.length} chunk(s) errored`);
  }

  const { observations, dropped } = canonicalizeBatch(rawRecords, document, document.session_id);

  const companyName = mostCommon(
    rawRecords.map(r => (typeof r.company_name === 'string' ? r.company_name.trim() : null)).filter(Boolean)
  );

  return {
    observations,
    dropped,
    company_name: companyName,
    stats: {
      chunks: chunks.length,
      chunk_errors: chunkErrors,
      raw_count: rawRecords.length,
      kept_count: observations.length,
      dropped_count: dropped.length,
      dropped_by_reason: countBy(dropped, d => d.reason)
    }
  };
}

function mostCommon(values) {
  if (values.length === 0) return null;
  const counts = new Map();
  for (const v of values) {
    const k = v.toLowerCase();
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  let best = null;
  let bestCount = 0;
  for (const [k, c] of counts) {
    if (c > bestCount) { best = k; bestCount = c; }
  }
  // Return the original casing of the winning name.
  return values.find(v => v.toLowerCase() === best) || null;
}

function countBy(items, fn) {
  return items.reduce((acc, item) => {
    const k = fn(item) || 'unknown';
    acc[k] = (acc[k] || 0) + 1;
    return acc;
  }, {});
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = { extractObservations, chunkContent, buildPrompt };
