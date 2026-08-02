const OpenAI = require('openai');
const responseParser = require('./responseParser');

async function callGroq(prompt, model) {
  const groq = new OpenAI({
    apiKey: process.env.GROQ_API_KEY,
    baseURL: 'https://api.groq.com/openai/v1'
  });

  const completion = await groq.chat.completions.create({
    messages: [{ role: 'user', content: prompt }],
    model: model,
    temperature: 0.1,
    response_format: { type: "json_object" }
  });

  return completion.choices[0].message.content;
}

async function callGeminiFallback(prompt) {
  const { GoogleGenerativeAI } = require('@google/generative-ai');
  const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);
  const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

  const result = await model.generateContent({
    contents: [{ role: 'user', parts: [{ text: prompt }] }]
  });
  return result.response.text();
}

async function analyzeDiscrepancies(compiledBundle) {
  const REASONING_PROMPT = `
You are an institutional-grade financial auditor performing cross-document consistency analysis.

You are given extracted metrics and validation results from multiple fundraising documents. Your task:

1. CROSS-DOCUMENT VERIFICATION:
   - Compare Revenue/ARR figures across Pitch Deck vs Financial Statements
   - Compare actual MIS run rates vs Projection baselines
   - Compare Cap Table ownership vs Pitch Deck claims
   - Check internal trend continuity (historical → projected)

2. CLASSIFY each finding into EXACTLY one tier:
   - VERIFIED_MISMATCH: Material conflict >2% variance (severity_weight: 15)
   - UNRESOLVED_INCONSISTENCY: Marginal conflict ≤2% variance (severity_weight: 5)
   - MISSING_INFORMATION: Required backing data absent (severity_weight: 10)
   - UNUSUAL_ASSUMPTION_CHANGE: Unexplained mathematical leaps (severity_weight: 8)

3. For EACH discrepancy, provide:
   - ref_code: Unique reference (e.g., "REV-MISMATCH-01")
   - classification: One of the four tiers
   - metric_name: What metric is affected
   - description: Clear explanation of the discrepancy
   - source_a: {filename, page, value, context}
   - source_b: {filename, page, value, context}  
   - variance_pct: Numerical percentage difference
   - follow_up_question: Specific investor question to resolve this

4. Generate a ONE-PAGE FUNDRAISING READINESS SUMMARY formatted in Markdown.
   The summary MUST contain:
   - **Executive Overview**: A high-level assessment of the data quality.
   - **Critical Discrepancies**: A bulleted list of the most severe issues found.
   - **Fundraising Readiness Verdict**: Your final conclusion on whether this company is ready for investor due diligence.
   Do not return a single sentence. This must be a detailed, professional, multi-paragraph markdown report.

INPUT BUNDLE:
${JSON.stringify(compiledBundle, null, 2)}

OUTPUT FORMAT: Respond with a JSON object wrapped in \`\`\`json code fences containing two keys: "summary" (string containing the detailed markdown report) and "discrepancies" (array).
Think step by step. Show your reasoning for each cross-document comparison.
`;

  let responseContent = '';
  let modelUsed = '';

  try {
    modelUsed = 'llama-3.3-70b-versatile';
    responseContent = await callGroq(REASONING_PROMPT, modelUsed);
  } catch (err1) {
    console.warn('Groq 70B failed, falling back to 32B', err1.message);
    try {
      modelUsed = 'deepseek-r1-distill-qwen-32b';
      responseContent = await callGroq(REASONING_PROMPT, modelUsed);
    } catch (err2) {
      console.warn('Groq 32B failed, falling back to Gemini', err2.message);
      modelUsed = 'gemini-2.5-flash-fallback';
      responseContent = await callGeminiFallback(REASONING_PROMPT);
    }
  }

  // Parse the output using the 4-layer cascade
  const parsedData = await responseParser.parseCascade(responseContent);

  return {
    parsedData,
    reasoningChain: responseContent,
    modelUsed
  };
}

module.exports = { analyzeDiscrepancies };
