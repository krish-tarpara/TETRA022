const pdfParser = require('./pdfParser');
const xlsxParser = require('./xlsxParser');
const docTypeClassifier = require('./docTypeClassifier');

async function parseDocument(file, documentCategory) {
  let parsedContent = '';
  
  // Use file_type to route
  if (file.file_type === '.pdf' || file.file_type === '.pptx') {
    parsedContent = await pdfParser.parse(file);
  } else if (file.file_type === '.xlsx' || file.file_type === '.csv') {
    parsedContent = await xlsxParser.parse(file);
  } else {
    throw new Error(`Unsupported file type: ${file.file_type}`);
  }

  // Auto-classify if category is not provided
  let finalCategory = documentCategory;
  if (!finalCategory || finalCategory === 'unknown') {
    finalCategory = docTypeClassifier.classify(parsedContent, file.original_filename);
  }

  return { parsedContent, finalCategory };
}

module.exports = { parseDocument };
