const express = require('express');
const router = express.Router();
const db = require('../db/queries');
const { verifyToken } = require('../middleware/auth');
const pdfGenerator = require('../services/export/pdfGenerator');
const csvExporter = require('../services/export/csvExporter');
const { adjudicate, diff } = require('../engine/adjudicate');
const rulepack = require('../engine/rulepack.json');

/**
 * Load a session and confirm it belongs to the caller.
 *
 * Returns null and sends the response on failure, so handlers stay flat.
 *
 * The ownership check is the important part: session ids are UUIDs, but "hard to guess" is not
 * an access control policy. Without this, any authenticated user could read any other user's
 * financial documents by iterating ids.
 */
async function loadOwnedSession(req, res) {
  const session = await db.getSessionById(req.params.id);

  if (!session) {
    res.status(404).json({ error: 'Session not found' });
    return null;
  }

  if (session.user_id !== req.user.userId) {
    // Deliberately 404, not 403. A 403 would confirm the session exists.
    res.status(404).json({ error: 'Session not found' });
    return null;
  }

  return session;
}

/** Sessions produced by the old AI-decides pipeline are served in their original shape. */
function isEngineSession(session) {
  return Boolean(session.engine_version) && session.engine_version !== 'legacy';
}

// GET /api/v1/sessions - history list
router.get('/', verifyToken, async (req, res) => {
  try {
    const sessions = await db.getUserSessions(req.user.userId);

    // The list view needs a summary, not full reports. Sending every score_breakdown here would
    // make the history screen many times heavier than it needs to be.
    res.json(sessions.map(s => ({
      id: s.id,
      created_at: s.created_at,
      updated_at: s.updated_at,
      status: s.status,
      readiness_score: s.readiness_score,
      band: s.score_breakdown ? s.score_breakdown.band : null,
      label: s.score_breakdown ? s.score_breakdown.label : null,
      total_mismatches: s.total_mismatches,
      total_inconsistencies: s.total_inconsistencies,
      total_missing: s.total_missing,
      total_unusual: s.total_unusual,
      engine_version: s.engine_version || 'legacy',
      rulepack_version: s.rulepack_version
    })));
  } catch (error) {
    console.error('Failed to list sessions:', error);
    res.status(500).json({ error: 'Failed to fetch sessions' });
  }
});

// GET /api/v1/sessions/:id - the full report
router.get('/:id', verifyToken, async (req, res) => {
  try {
    const session = await loadOwnedSession(req, res);
    if (!session) return;

    const documents = await db.getSessionDocuments(session.id);

    if (!isEngineSession(session)) {
      // Old pipeline. Served unchanged, with a marker so the client knows which shape it has
      // rather than having to guess from which fields are present.
      const discrepancies = await db.getSessionDiscrepancies(session.id);
      return res.json({
        schema: 'legacy',
        session,
        discrepancies,
        documents
      });
    }

    const findings = await db.getSessionFindings(session.id);

    res.json({
      schema: 'engine',
      session: {
        id: session.id,
        created_at: session.created_at,
        updated_at: session.updated_at,
        status: session.status,
        engine_version: session.engine_version,
        rulepack_version: session.rulepack_version
      },
      score: session.readiness_score,
      breakdown: session.score_breakdown,
      executive_summary: session.executive_summary,
      findings,
      follow_up_questions: session.follow_up_questions || [],
      fx_rates: session.fx_rates || {},
      adjudications: session.adjudications || [],
      // Kept separate from everything above, and carrying its own disclaimer, because it is the
      // only part of the response an AI wrote freely.
      ai_notes: session.ai_notes || null,
      documents: documents.map(d => ({
        id: d.id,
        original_filename: d.original_filename,
        document_category: d.document_category,
        file_type: d.file_type,
        file_size_bytes: d.file_size_bytes,
        page_count: d.page_count,
        company_name: d.company_name,
        extraction_stats: d.extraction_stats,
        parse_error: d.parse_error
      }))
    });
  } catch (error) {
    console.error('Failed to fetch session:', error);
    res.status(500).json({ error: 'Failed to fetch session details' });
  }
});

// GET /api/v1/sessions/:id/observations - the raw extracted figures
router.get('/:id/observations', verifyToken, async (req, res) => {
  try {
    const session = await loadOwnedSession(req, res);
    if (!session) return;

    if (!isEngineSession(session)) {
      const metrics = await db.getSessionMetrics(session.id);
      return res.json({ schema: 'legacy', metrics });
    }

    const observations = await db.getSessionObservations(session.id);
    res.json({ schema: 'engine', observations });
  } catch (error) {
    console.error('Failed to fetch observations:', error);
    res.status(500).json({ error: 'Failed to fetch observations' });
  }
});

// GET /api/v1/sessions/:id/metrics - kept as an alias so existing clients do not break
router.get('/:id/metrics', verifyToken, async (req, res) => {
  try {
    const session = await loadOwnedSession(req, res);
    if (!session) return;

    if (isEngineSession(session)) {
      const observations = await db.getSessionObservations(session.id);
      return res.json(observations);
    }

    const metrics = await db.getSessionMetrics(session.id);
    res.json(metrics);
  } catch (error) {
    console.error('Failed to fetch metrics:', error);
    res.status(500).json({ error: 'Failed to fetch metrics' });
  }
});

/**
 * GET /api/v1/sessions/:id/rulepack
 *
 * The weights, tolerances and thresholds that produced this session's score.
 *
 * Exposed so the UI can show "why this score" without hardcoding a copy of the configuration -
 * which would drift the moment anyone tuned the engine.
 */
router.get('/:id/rulepack', verifyToken, async (req, res) => {
  try {
    const session = await loadOwnedSession(req, res);
    if (!session) return;

    res.json({
      version: rulepack.version,
      session_rulepack_version: session.rulepack_version,
      // True when the engine has been retuned since this session ran, so the UI can warn that
      // re-running would not necessarily reproduce the stored score.
      stale: Boolean(session.rulepack_version) && session.rulepack_version !== rulepack.version,
      base_weights: rulepack.base_weights,
      tolerances: rulepack.tolerances,
      importance: rulepack.importance,
      severity: rulepack.severity,
      bands: rulepack.bands,
      pillars: rulepack.pillars,
      scoring: rulepack.scoring,
      identities: rulepack.identities.map(i => ({
        id: i.id,
        expression: i.expression,
        tolerance_pct: i.tolerance_pct,
        tolerance_abs: i.tolerance_abs
      })),
      temporal: rulepack.temporal,
      plausibility_bands: rulepack.plausibility_bands
    });
  } catch (error) {
    console.error('Failed to fetch rulepack:', error);
    res.status(500).json({ error: 'Failed to fetch rule pack' });
  }
});

/**
 * POST /api/v1/sessions/:id/adjudicate
 *
 * Apply user overrides and recompute. Body: { adjudications: [...], persist: boolean }
 *
 * Fast because scoring is arithmetic, not an LLM call - which is what makes live what-if
 * possible: change an assumption, see the score move immediately.
 *
 * `persist` defaults to false so the UI can explore freely without committing. Only an explicit
 * persist writes the new verdicts back.
 */
router.post('/:id/adjudicate', verifyToken, async (req, res) => {
  try {
    const session = await loadOwnedSession(req, res);
    if (!session) return;

    if (!isEngineSession(session)) {
      return res.status(400).json({
        error: 'This session was produced by the previous pipeline and cannot be adjudicated. ' +
          'Re-run the analysis to enable it.'
      });
    }

    const adjudications = Array.isArray(req.body.adjudications) ? req.body.adjudications : [];
    if (adjudications.length === 0) {
      return res.status(400).json({ error: 'No adjudications supplied.' });
    }

    const observations = await db.getSessionObservationsForEngine(session.id);
    if (observations.length === 0) {
      return res.status(409).json({
        error: 'This session has no stored observations, so it cannot be recomputed.'
      });
    }

    const documents = await db.getSessionDocuments(session.id);
    const options = {
      fxRates: session.fx_rates || {},
      documents: documents.map(d => ({
        document_id: d.id,
        document_category: d.document_category,
        original_filename: d.original_filename
      }))
    };

    // Recompute the original verdict from the same stored observations rather than trusting the
    // saved score. If the rule pack was retuned since, the stored number no longer reflects what
    // the engine does now, and a before/after diff against it would be misleading.
    const engine = require('../engine');
    const before = engine.verify(observations, options);
    const after = adjudicate(observations, options, adjudications);

    if (req.body.persist === true) {
      await db.replaceFindings(session.id, after.findings);
      await db.updateSessionAdjudications(session.id, {
        score: after.score,
        breakdown: after.breakdown,
        adjudications: after.adjudications
      });
    }

    res.json({
      persisted: req.body.persist === true,
      score: after.score,
      breakdown: after.breakdown,
      findings: after.findings,
      adjudications: after.adjudications,
      // What actually changed, so the UI can highlight the moved pillars instead of just
      // swapping one number for another.
      diff: diff(before, after)
    });
  } catch (error) {
    console.error('Adjudication failed:', error);
    res.status(500).json({ error: 'Failed to apply adjudication' });
  }
});

// GET /api/v1/sessions/:id/export/pdf
router.get('/:id/export/pdf', verifyToken, async (req, res) => {
  try {
    const session = await loadOwnedSession(req, res);
    if (!session) return;

    const documents = await db.getSessionDocuments(session.id);

    if (isEngineSession(session)) {
      const findings = await db.getSessionFindings(session.id);
      return pdfGenerator.generatePdf(session, findings, documents, res);
    }

    const discrepancies = await db.getSessionDiscrepancies(session.id);
    pdfGenerator.generateLegacyPdf(session, discrepancies, documents, res);
  } catch (error) {
    console.error('PDF export failed:', error);
    // Headers may already be sent if the stream started, in which case the client gets a
    // truncated file rather than a JSON error. Nothing better is possible once piping begins.
    if (!res.headersSent) res.status(500).json({ error: 'Failed to generate PDF' });
  }
});

// GET /api/v1/sessions/:id/export/csv
router.get('/:id/export/csv', verifyToken, async (req, res) => {
  try {
    const session = await loadOwnedSession(req, res);
    if (!session) return;

    const documents = await db.getSessionDocuments(session.id);

    if (isEngineSession(session)) {
      const findings = await db.getSessionFindings(session.id);
      const observations = await db.getSessionObservations(session.id);
      return csvExporter.generateCsv(session, findings, observations, documents, res);
    }

    const discrepancies = await db.getSessionDiscrepancies(session.id);
    const metrics = await db.getSessionMetrics(session.id);
    const docMap = Object.fromEntries(documents.map(d => [d.id, d.document_category]));
    csvExporter.generateLegacyCsv(
      session,
      discrepancies,
      metrics.map(m => ({ ...m, document_category: docMap[m.document_id] })),
      res
    );
  } catch (error) {
    console.error('CSV export failed:', error);
    if (!res.headersSent) res.status(500).json({ error: 'Failed to generate CSV' });
  }
});

module.exports = router;
