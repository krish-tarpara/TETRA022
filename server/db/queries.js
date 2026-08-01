const pool = require('./pool');

/**
 * Query wrapper with optional timing.
 *
 * Logging every statement was drowning out the messages that matter, and a bulk observation
 * insert prints a multi-kilobyte parameter list. Set DEBUG_SQL=1 to get it back when debugging.
 *
 * Slow queries are always reported, since the hosted database cold-starts and a five-second
 * insert is worth knowing about without turning on full tracing.
 */
const DEBUG_SQL = process.env.DEBUG_SQL === '1';
const SLOW_QUERY_MS = 3000;

async function query(text, params) {
  const start = Date.now();
  const res = await pool.query(text, params);
  const duration = Date.now() - start;

  if (DEBUG_SQL) {
    console.log('SQL', { text: text.replace(/\s+/g, ' ').slice(0, 120), duration, rows: res.rowCount });
  } else if (duration > SLOW_QUERY_MS) {
    console.warn(`Slow query (${duration}ms): ${text.replace(/\s+/g, ' ').slice(0, 90)}`);
  }

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

// ── Engine tables: observations and findings ─────────────────────────────────────────────────

/**
 * Bulk-insert observations.
 *
 * Built as a single multi-row INSERT rather than a loop. A ten-document session can produce a
 * couple of thousand observations, and one round trip per row would take longer than the AI
 * extraction that produced them.
 */
async function insertObservations(observations) {
  if (!observations || observations.length === 0) return 0;

  const COLUMNS = 24;
  const CHUNK = 200; // keeps each statement under Postgres' 65535 parameter ceiling
  let inserted = 0;

  for (let start = 0; start < observations.length; start += CHUNK) {
    const chunk = observations.slice(start, start + CHUNK);
    const values = [];
    const placeholders = [];

    chunk.forEach((o, i) => {
      const base = i * COLUMNS;
      placeholders.push(`(${Array.from({ length: COLUMNS }, (_, k) => `$${base + k + 1}`).join(',')})`);
      values.push(
        o.session_id, o.document_id,
        o.metric_key, o.raw_label,
        o.value_raw, o.value_base, o.currency, o.unit,
        o.period_raw, o.period_key, o.period_granularity, o.period_type,
        o.basis, o.basis_class, o.subject,
        o.source ? o.source.page : null,
        o.source ? o.source.cell : null,
        o.source ? o.source.quote : '',
        o.confidence ? o.confidence.value : null,
        o.confidence ? o.confidence.label : null,
        o.confidence ? o.confidence.period : null,
        o.confidence ? o.confidence.parse : null,
        o.node_key,
        JSON.stringify(o.diagnostics || {})
      );
    });

    await query(
      `INSERT INTO observations
         (session_id, document_id, metric_key, raw_label, value_raw, value_base, currency, unit,
          period_raw, period_key, period_granularity, period_type, basis, basis_class, subject,
          source_page, source_cell, source_quote,
          conf_value, conf_label, conf_period, conf_parse, node_key, diagnostics)
       VALUES ${placeholders.join(',')}`,
      values
    );
    inserted += chunk.length;
  }

  return inserted;
}

async function getSessionObservations(sessionId) {
  const result = await query(
    'SELECT * FROM observations WHERE session_id = $1 ORDER BY metric_key, period_key',
    [sessionId]
  );
  return result.rows;
}

/**
 * Rebuild engine-shaped observations from stored rows.
 *
 * Needed by adjudication, which re-runs the engine against a session that finished minutes or
 * days ago. The engine expects nested `source` and `confidence` objects, so the flat table
 * layout has to be reassembled rather than passed through.
 */
function rowToObservation(row) {
  return {
    observation_id: row.id,
    session_id: row.session_id,
    document_id: row.document_id,
    filename: row.filename || null,
    document_category: row.document_category || null,
    metric_key: row.metric_key,
    raw_label: row.raw_label,
    value_raw: row.value_raw,
    value_base: row.value_base === null ? null : Number(row.value_base),
    currency: row.currency,
    unit: row.unit,
    period_raw: row.period_raw,
    period_key: row.period_key,
    period_granularity: row.period_granularity,
    period_type: row.period_type,
    basis: row.basis,
    basis_class: row.basis_class,
    subject: row.subject,
    source: { page: row.source_page, cell: row.source_cell, quote: row.source_quote },
    confidence: {
      value: row.conf_value === null ? 1 : Number(row.conf_value),
      label: row.conf_label === null ? 1 : Number(row.conf_label),
      period: row.conf_period === null ? 1 : Number(row.conf_period),
      parse: row.conf_parse === null ? 1 : Number(row.conf_parse)
    },
    diagnostics: row.diagnostics || {},
    node_key: row.node_key
  };
}

/** Observations joined to their document, ready to hand straight back to the engine. */
async function getSessionObservationsForEngine(sessionId) {
  const result = await query(
    `SELECT o.*, d.original_filename AS filename, d.document_category
       FROM observations o
       JOIN documents d ON d.id = o.document_id
      WHERE o.session_id = $1`,
    [sessionId]
  );
  return result.rows.map(rowToObservation);
}

async function insertFindings(sessionId, findings) {
  if (!findings || findings.length === 0) return 0;

  const COLUMNS = 20;
  const CHUNK = 100;
  let inserted = 0;

  for (let start = 0; start < findings.length; start += CHUNK) {
    const chunk = findings.slice(start, start + CHUNK);
    const values = [];
    const placeholders = [];

    chunk.forEach((f, i) => {
      const base = i * COLUMNS;
      placeholders.push(`(${Array.from({ length: COLUMNS }, (_, k) => `$${base + k + 1}`).join(',')})`);
      values.push(
        sessionId,
        f.ref_code, f.rule_id, f.rule_class, f.rulepack_version,
        f.classification, f.classification_reason, f.severity_score, f.severity_band, f.pillar,
        f.metric_key, f.metric_label, f.period_key, f.node_key,
        JSON.stringify(f.computation || {}),
        JSON.stringify(f.factors || {}),
        JSON.stringify(f.evidence || []),
        JSON.stringify(f.details || {}),
        f.narrative, f.follow_up_question
      );
    });

    await query(
      `INSERT INTO findings
         (session_id, ref_code, rule_id, rule_class, rulepack_version,
          classification, classification_reason, severity_score, severity_band, pillar,
          metric_key, metric_label, period_key, node_key,
          computation, factors, evidence, details, narrative, follow_up_question)
       VALUES ${placeholders.join(',')}`,
      values
    );
    inserted += chunk.length;
  }

  return inserted;
}

/** Findings for a session, worst first - the order the dashboard renders them in. */
async function getSessionFindings(sessionId) {
  const result = await query(
    'SELECT * FROM findings WHERE session_id = $1 ORDER BY severity_score DESC, ref_code',
    [sessionId]
  );
  return result.rows.map(row => ({
    ...row,
    severity_score: Number(row.severity_score)
  }));
}

/** Write the engine's result onto the session row. */
async function updateSessionEngineReport(sessionId, data) {
  const { score, breakdown, executiveSummary, fxRates, questions, engineVersion } = data;
  const counts = breakdown.counts;

  await query(
    `UPDATE analysis_sessions
        SET status = 'complete',
            readiness_score = $2,
            total_mismatches = $3,
            total_inconsistencies = $4,
            total_missing = $5,
            total_unusual = $6,
            score_breakdown = $7,
            pillar_scores = $8,
            coverage = $9,
            rulepack_version = $10,
            executive_summary = $11,
            fx_rates = $12,
            follow_up_questions = $13,
            engine_version = $14,
            updated_at = NOW()
      WHERE id = $1`,
    [
      sessionId,
      score,
      counts.VERIFIED_MISMATCH,
      counts.UNRESOLVED_INCONSISTENCY,
      counts.MISSING_INFORMATION,
      counts.UNUSUAL_ASSUMPTION_CHANGE,
      JSON.stringify(breakdown),
      JSON.stringify(breakdown.pillars),
      JSON.stringify(breakdown.coverage),
      breakdown.rulepack_version,
      executiveSummary,
      JSON.stringify(fxRates || {}),
      JSON.stringify(questions || []),
      engineVersion || 'engine-1'
    ]
  );
}

/** The AI second opinion. Written separately so a failure here cannot affect the report. */
async function updateSessionAiNotes(sessionId, notes) {
  await query('UPDATE analysis_sessions SET ai_notes = $2 WHERE id = $1', [
    sessionId,
    notes ? JSON.stringify(notes) : null
  ]);
}

async function updateSessionAdjudications(sessionId, data) {
  const { score, breakdown, adjudications } = data;
  await query(
    `UPDATE analysis_sessions
        SET readiness_score = $2,
            score_breakdown = $3,
            pillar_scores = $4,
            adjudications = $5,
            updated_at = NOW()
      WHERE id = $1`,
    [sessionId, score, JSON.stringify(breakdown), JSON.stringify(breakdown.pillars), JSON.stringify(adjudications)]
  );
}

/** Replace a session's findings. Used when adjudication changes the verdicts. */
async function replaceFindings(sessionId, findings) {
  await query('DELETE FROM findings WHERE session_id = $1', [sessionId]);
  return insertFindings(sessionId, findings);
}

async function updateDocumentExtractionStats(documentId, stats, companyName) {
  await query(
    'UPDATE documents SET extraction_stats = $2, company_name = $3 WHERE id = $1',
    [documentId, JSON.stringify(stats || {}), companyName || null]
  );
}

async function updateDocumentParseError(documentId, message) {
  await query('UPDATE documents SET parse_error = $2 WHERE id = $1', [documentId, message]);
}

async function updateSessionFxRates(sessionId, fxRates) {
  await query('UPDATE analysis_sessions SET fx_rates = $2 WHERE id = $1', [
    sessionId,
    JSON.stringify(fxRates || {})
  ]);
}

module.exports = {
  insertObservations,
  getSessionObservations,
  getSessionObservationsForEngine,
  rowToObservation,
  insertFindings,
  getSessionFindings,
  replaceFindings,
  updateSessionEngineReport,
  updateSessionAiNotes,
  updateSessionAdjudications,
  updateDocumentExtractionStats,
  updateDocumentParseError,
  updateSessionFxRates,
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
