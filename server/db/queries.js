const pool = require('./pool');

async function query(text, params) {
  const start = Date.now();
  const res = await pool.query(text, params);
  const duration = Date.now() - start;
  console.log('Executed query', { text, duration, rows: res.rowCount });
  return res;
}

// User methods
async function createUser(sessionToken) {
  const result = await query(
    'INSERT INTO users (session_token) VALUES ($1) RETURNING *',
    [sessionToken]
  );
  return result.rows[0];
}

async function getUserByToken(sessionToken) {
  const result = await query(
    'SELECT * FROM users WHERE session_token = $1',
    [sessionToken]
  );
  return result.rows[0];
}

async function updateLastActive(userId) {
  await query(
    'UPDATE users SET last_active = NOW() WHERE id = $1',
    [userId]
  );
}

// Session methods
async function createSession(userId) {
  const result = await query(
    'INSERT INTO analysis_sessions (user_id) VALUES ($1) RETURNING *',
    [userId]
  );
  return result.rows[0];
}

async function getSessionById(sessionId) {
  const result = await query(
    'SELECT * FROM analysis_sessions WHERE id = $1',
    [sessionId]
  );
  return result.rows[0];
}

async function updateSessionStatus(sessionId, status) {
  await query(
    'UPDATE analysis_sessions SET status = $2, updated_at = NOW() WHERE id = $1',
    [sessionId, status]
  );
}

async function updateSessionReport(sessionId, data) {
  const { score, mismatches, inconsistencies, missing, unusual, report, questions, reasoning, model } = data;
  await query(
    `UPDATE analysis_sessions 
     SET status = 'complete',
         readiness_score = $2,
         total_mismatches = $3,
         total_inconsistencies = $4,
         total_missing = $5,
         total_unusual = $6,
         summary_report = $7,
         follow_up_questions = $8,
         reasoning_chain = $9,
         model_used = $10,
         updated_at = NOW()
     WHERE id = $1`,
    [sessionId, score, mismatches, inconsistencies, missing, unusual, JSON.stringify(report), JSON.stringify(questions), reasoning, model]
  );
}

async function getUserSessions(userId) {
  const result = await query(
    'SELECT * FROM analysis_sessions WHERE user_id = $1 ORDER BY created_at DESC',
    [userId]
  );
  return result.rows;
}

// Document methods
async function createDocument(data) {
  const { sessionId, originalFilename, storedFilename, fileType, documentCategory, fileSizeBytes } = data;
  const result = await query(
    `INSERT INTO documents (session_id, original_filename, stored_filename, file_type, document_category, file_size_bytes)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [sessionId, originalFilename, storedFilename, fileType, documentCategory, fileSizeBytes]
  );
  return result.rows[0];
}

async function getSessionDocuments(sessionId) {
  const result = await query(
    'SELECT * FROM documents WHERE session_id = $1',
    [sessionId]
  );
  return result.rows;
}

async function updateDocumentParsed(documentId, parsedContent, pageCount) {
  await query(
    'UPDATE documents SET parsed_content = $2, page_count = $3 WHERE id = $1',
    [documentId, parsedContent, pageCount]
  );
}

async function updateDocumentExtracted(documentId, extractedMetrics) {
  await query(
    'UPDATE documents SET extracted_metrics = $2 WHERE id = $1',
    [documentId, JSON.stringify(extractedMetrics)]
  );
}

// Extracted metrics methods
async function insertExtractedMetrics(metrics) {
  if (!metrics || metrics.length === 0) return;
  // Naive bulk insert; in production, use pg-format or multiple values string
  for (const m of metrics) {
    await query(
      `INSERT INTO extracted_metrics 
       (session_id, document_id, metric_name, normalized_name, metric_category, metric_value, metric_unit, period, normalized_period, source_page, source_row_text, source_context, confidence, metric_currency, period_type)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
      [m.sessionId, m.documentId, m.metricName, m.normalizedName, m.metricCategory, m.metricValue, m.metricUnit, m.period, m.normalizedPeriod, m.sourcePage, m.sourceRowText, m.sourceContext, m.confidence, m.metricCurrency, m.periodType]
    );
  }
}

async function getSessionMetrics(sessionId) {
  const result = await query(
    'SELECT * FROM extracted_metrics WHERE session_id = $1',
    [sessionId]
  );
  return result.rows;
}

// Discrepancies methods
async function insertDiscrepancies(discrepancies) {
  if (!discrepancies || discrepancies.length === 0) return;
  for (const d of discrepancies) {
    await query(
      `INSERT INTO discrepancies 
       (session_id, ref_code, classification, severity_weight, metric_name, description, source_a_doc_id, source_a_filename, source_a_page, source_a_value, source_a_context, source_b_doc_id, source_b_filename, source_b_page, source_b_value, source_b_context, variance_pct, follow_up_question, details)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)`,
      [d.sessionId, d.refCode, d.classification, d.severityWeight, d.metricName, d.description, d.sourceADocId, d.sourceAFilename, d.sourceAPage, d.sourceAValue, d.sourceAContext, d.sourceBDocId, d.sourceBFilename, d.sourceBPage, d.sourceBValue, d.sourceBContext, d.variancePct, d.followUpQuestion, JSON.stringify(d.details || {})]
    );
  }
}

async function getSessionDiscrepancies(sessionId) {
  const result = await query(
    'SELECT * FROM discrepancies WHERE session_id = $1',
    [sessionId]
  );
  return result.rows;
}

module.exports = {
  createUser,
  getUserByToken,
  updateLastActive,
  createSession,
  getSessionById,
  updateSessionStatus,
  updateSessionReport,
  getUserSessions,
  createDocument,
  getSessionDocuments,
  updateDocumentParsed,
  updateDocumentExtracted,
  insertExtractedMetrics,
  getSessionMetrics,
  insertDiscrepancies,
  getSessionDiscrepancies
};
