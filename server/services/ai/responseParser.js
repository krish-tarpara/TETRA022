const { GoogleGenerativeAI, SchemaType } = require('@google/generative-ai');

async function parseCascade(text) {
  // Layer 1: Extract JSON from code fences
  try {
    const jsonMatch = text.match(/```json\n([\s\S]*?)\n```/);
    if (jsonMatch && jsonMatch[1]) {
      return JSON.parse(jsonMatch[1]);
    }
  } catch (e) { /* ignore and fallback */ }

  // Layer 2: Strip <think> and find JSON anywhere
  try {
    const stripped = text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
    const jsonStart = stripped.indexOf('{');
    const jsonEnd = stripped.lastIndexOf('}');
    if (jsonStart >= 0 && jsonEnd >= 0) {
      return JSON.parse(stripped.substring(jsonStart, jsonEnd + 1));
    }
  } catch (e) { /* ignore and fallback */ }

  // Layer 3 (Skipped regex extraction directly to Layer 4 for robustness)

  // Layer 4: Gemini Fallback
  console.warn('Parsing cascade fell back to Gemini structured extraction');
  const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);
  const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

  const schema = {
    type: SchemaType.OBJECT,
    properties: {
      summary: { type: SchemaType.STRING },
      discrepancies: {
        type: SchemaType.ARRAY,
        items: {
          type: SchemaType.OBJECT,
          properties: {
            ref_code: { type: SchemaType.STRING },
            classification: { type: SchemaType.STRING },
            metric_name: { type: SchemaType.STRING },
            description: { type: SchemaType.STRING },
            source_a: {
              type: SchemaType.OBJECT,
              properties: { filename: { type: SchemaType.STRING }, page: { type: SchemaType.INTEGER }, value: { type: SchemaType.STRING }, context: { type: SchemaType.STRING } }
            },
            source_b: {
              type: SchemaType.OBJECT,
              properties: { filename: { type: SchemaType.STRING }, page: { type: SchemaType.INTEGER }, value: { type: SchemaType.STRING }, context: { type: SchemaType.STRING } }
            },
            variance_pct: { type: SchemaType.NUMBER },
            follow_up_question: { type: SchemaType.STRING }
          }
        }
      }
    },
    required: ["summary", "discrepancies"]
  };

  const result = await model.generateContent({
    contents: [{ role: 'user', parts: [{ text: `Extract the JSON analysis from the following text:\n\n${text}` }] }],
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: schema,
      maxOutputTokens: 8192,
    }
  });

  return JSON.parse(result.response.text());
}

module.exports = { parseCascade };
