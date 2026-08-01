const OpenAI = require('openai');
const { TAXONOMY_MAP } = require('../normalization/taxonomyMap');
const { normalizePeriod } = require('../normalization/periodNormalizer');

async function extractMetrics(document) {
  const groq = new OpenAI({
    apiKey: process.env.GROQ_API_KEY,
    baseURL: 'https://api.groq.com/openai/v1'
  });

  const taxonomyInstructions = Object.entries(TAXONOMY_MAP)
    .map(([key, { canonical, aliases }]) => 
      `- ${canonical}: "${aliases.slice(0, 5).join('", "')}" → ${canonical}`
    ).join('\n');

  const EXTRACTION_PROMPT = `
You are a financial data extraction specialist. 
Given the following ${document.document_category} content, extract ALL financial and operational metrics.

For each metric found, extract the following:
- company_name: the company or entity name found in this document
- metric_name: Original name as it appears in the document
- normalized_name: Map to standard taxonomy
- metric_category: One of [revenue, profit, liquidity, growth, ownership, operational]
- value: Numeric value (convert lakhs/crores to absolute numbers)
- unit: Currency code or 'pct' or 'count'
- period: Time period as stated (e.g., "FY26", "Q3 2025")
- source_page: Page number where found
- source_context: Exact sentence/row containing this metric
- confidence: 0.0-1.0 confidence in extraction accuracy
- metric_currency: 'INR', 'USD', 'EUR', etc.
- period_type: 'historical', 'current', 'projected', 'unknown'

TAXONOMY MAPPING RULES:
${taxonomyInstructions}

You must return ONLY a JSON object containing an array named "metrics".
Example format:
{
  "metrics": [
    {
      "company_name": "Example Corp",
      "metric_name": "Total Revenue",
      "normalized_name": "Revenue",
      "metric_category": "revenue",
      "value": 1500000,
      "unit": "USD",
      "period": "FY24",
      "source_page": 2,
      "source_context": "Total revenue for FY24 was $1.5M",
      "confidence": 0.98,
      "metric_currency": "USD",
      "period_type": "historical"
    }
  ]
}
`;

  try {
    const completion = await groq.chat.completions.create({
      messages: [
        { role: 'system', content: EXTRACTION_PROMPT },
        { role: 'user', content: "DOCUMENT CONTENT:\n" + document.parsed_content }
      ],
      model: 'llama-3.3-70b-versatile',
      temperature: 0.1,
      response_format: { type: "json_object" }
    });

    const responseText = completion.choices[0].message.content;
    const extractedData = JSON.parse(responseText);

    if (!extractedData.metrics || !Array.isArray(extractedData.metrics)) {
      throw new Error("Invalid output format from LLM");
    }

    // Add normalized period
    return extractedData.metrics.map(metric => ({
      ...metric,
      normalized_period: normalizePeriod(metric.period),
      document_id: document.id,
      session_id: document.session_id
    }));

  } catch (err) {
    console.error(`Extraction error for ${document.original_filename}:`, err);
    throw new Error('Failed to extract metrics using AI model');
  }
}

module.exports = { extractMetrics };
