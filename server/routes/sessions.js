const express = require('express');
const router = express.Router();
const db = require('../db/queries');
const { verifyToken } = require('../middleware/auth');
const pdfGenerator = require('../services/export/pdfGenerator');
const csvExporter = require('../services/export/csvExporter');

// GET /api/v1/sessions
router.get('/', verifyToken, async (req, res) => {
  try {
    const sessions = await db.getUserSessions(req.user.userId);
    res.json(sessions);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch sessions' });
  }
});

// GET /api/v1/sessions/:id
router.get('/:id', verifyToken, async (req, res) => {
  try {
    const session = await db.getSessionById(req.params.id);
    if (!session || session.user_id !== req.user.userId) {
      return res.status(404).json({ error: 'Session not found' });
    }
    
    const discrepancies = await db.getSessionDiscrepancies(session.id);
    const documents = await db.getSessionDocuments(session.id);
    
    res.json({ session, discrepancies, documents });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch session details' });
  }
});

// GET /api/v1/sessions/:id/metrics
router.get('/:id/metrics', verifyToken, async (req, res) => {
  try {
    const metrics = await db.getSessionMetrics(req.params.id);
    res.json(metrics);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch metrics' });
  }
});

// GET /api/v1/sessions/:id/export/pdf
router.get('/:id/export/pdf', verifyToken, async (req, res) => {
  try {
    const session = await db.getSessionById(req.params.id);
    if (!session || session.user_id !== req.user.userId) return res.status(404).json({ error: 'Session not found' });
    const discrepancies = await db.getSessionDiscrepancies(session.id);
    const documents = await db.getSessionDocuments(session.id);
    pdfGenerator.generatePdf(session, discrepancies, documents, res);
  } catch (error) {
    res.status(500).json({ error: 'Failed to generate PDF' });
  }
});

// GET /api/v1/sessions/:id/export/csv
router.get('/:id/export/csv', verifyToken, async (req, res) => {
  try {
    const session = await db.getSessionById(req.params.id);
    if (!session || session.user_id !== req.user.userId) return res.status(404).json({ error: 'Session not found' });
    const discrepancies = await db.getSessionDiscrepancies(session.id);
    const metrics = await db.getSessionMetrics(session.id);
    
    // Enrich metrics with doc categories for CSV
    const docs = await db.getSessionDocuments(session.id);
    const docMap = {};
    docs.forEach(d => docMap[d.id] = d.document_category);
    const enrichedMetrics = metrics.map(m => ({ ...m, document_category: docMap[m.document_id] }));
    
    csvExporter.generateCsv(session, discrepancies, enrichedMetrics, res);
  } catch (error) {
    res.status(500).json({ error: 'Failed to generate CSV' });
  }
});

module.exports = router;
