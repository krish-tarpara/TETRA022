const axios = require('axios');
const fs = require('fs');
const FormData = require('form-data');
const pdfParse = require('pdf-parse'); // Fallback

const PARSE_TIMEOUT_MS = 120_000;

async function llamaParse(file) {
  const formData = new FormData();
  formData.append('file', fs.createReadStream(file.path));

  const headers = {
    ...formData.getHeaders(),
    'Authorization': `Bearer ${process.env.LLAMA_CLOUD_API_KEY}`
  };

  try {
    // 1. Upload to LlamaParse
    const uploadRes = await axios.post('https://api.cloud.llamaindex.ai/api/parsing/upload', formData, { headers });
    const jobId = uploadRes.data.id;

    // 2. Poll for completion
    let status = 'PENDING';
    while (status !== 'SUCCESS') {
      await new Promise(resolve => setTimeout(resolve, 2000));
      const statusRes = await axios.get(`https://api.cloud.llamaindex.ai/api/parsing/job/${jobId}`, {
        headers: { 'Authorization': `Bearer ${process.env.LLAMA_CLOUD_API_KEY}` }
      });
      status = statusRes.data.status;
      
      if (status === 'ERROR') {
        throw new Error('LlamaParse job failed');
      }
    }

    // 3. Get Result
    const resultRes = await axios.get(`https://api.cloud.llamaindex.ai/api/parsing/job/${jobId}/result/markdown`, {
      headers: { 'Authorization': `Bearer ${process.env.LLAMA_CLOUD_API_KEY}` }
    });
    
    return resultRes.data.markdown || resultRes.data;

  } catch (error) {
    console.error('LlamaParse Error:', error.message);
    throw error;
  }
}

async function basicPdfParse(file) {
  const dataBuffer = fs.readFileSync(file.path);
  const data = await pdfParse(dataBuffer);
  return data.text;
}

async function parse(file) {
  try {
    // If API key is missing, fallback immediately
    if (!process.env.LLAMA_CLOUD_API_KEY || process.env.LLAMA_CLOUD_API_KEY.includes('your_llamacloud_key')) {
      console.warn('LlamaParse key not found, using pdf-parse fallback');
      return await basicPdfParse(file);
    }

    return await Promise.race([
      llamaParse(file),
      new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT')), PARSE_TIMEOUT_MS))
    ]);
  } catch (err) {
    console.warn(`LlamaParse error or timeout for ${file.original_filename}, falling back to pdf-parse. Error: ${err.message}`);
    return await basicPdfParse(file);
  }
}

module.exports = { parse };
