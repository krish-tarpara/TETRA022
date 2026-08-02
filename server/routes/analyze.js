const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const upload = require('../middleware/upload');
const db = require('../db/queries');
const { verifyToken } = require('../middleware/auth');
const reportBuilder = require('../services/reportBuilder');

/**
 * POST /api/v1/analyze
 *
 * Accepts up to 8 files with a parallel array of document types, and an optional set of exchange
 * rates. Returns a sessionId immediately; results arrive over the websocket.
 *
 * The immediate return is not an optimisation, it is a requirement. A full analysis takes 30-90
 * seconds, and holding the request open for that long blocks the Express event loop - which kills
 * the Socket.io heartbeats that are supposed to be reporting progress, so the client sees a frozen
 * page and then a timeout.
 */
router.post('/', verifyToken, upload.array('files', 8), async (req, res) => {
  let session;

  try {
    session = await db.createSession(req.user.userId);
  } catch (error) {
    console.error('Could not create analysis session:', error);
    cleanupFiles(req.files);
    return res.status(500).json({ error: 'Could not start the analysis. Please try again.' });
  }

  const files = req.files || [];
  const documentTypes = toArray(req.body.documentTypes);
  const fxRates = req.body.fxRates;

  // The client sends documentTypes as a parallel array to files. Multipart form encoding does not
  // guarantee they arrive aligned if a field is omitted, so mismatched lengths are treated as the
  // client's bug and rejected loudly rather than silently mislabelling every document.
  if (documentTypes.length > 0 && documentTypes.length !== files.length) {
    cleanupFiles(files);
    await db.updateSessionStatus(session.id, 'failed').catch(() => {});
    return res.status(400).json({
      error: `Received ${files.length} files but ${documentTypes.length} document types. ` +
        `Each file needs exactly one type.`
    });
  }

  res.json({ sessionId: session.id, status: 'processing' });

  const io = req.app.get('io');

  setImmediate(() => {
    console.log(`Session ${session.id}: processing ${files.length} file(s)`);

    try {
      io.of('/analysis').to(`session:${session.id}`).emit('status:update', {
        stage: 'initializing',
        message: 'Starting analysis...',
        timestamp: Date.now()
      });
    } catch (err) {
      console.warn('Initial socket emit failed:', err.message);
    }

    reportBuilder
      .runPipeline(session.id, files, documentTypes, io, { fxRates })
      .catch(err => {
        console.error(`Unhandled pipeline rejection for session ${session.id}:`, err);
        try {
          io.of('/analysis').to(`session:${session.id}`).emit('analysis:error', {
            error: 'The analysis failed unexpectedly.',
            timestamp: Date.now()
          });
        } catch { /* client already gone */ }
        db.updateSessionStatus(session.id, 'failed').catch(console.error);
      })
      // Uploaded files are only needed during parsing. Left in place they accumulate
      // indefinitely - the uploads directory already holds dozens of orphans from earlier runs.
      .finally(() => cleanupFiles(files));
  });
});

/** A single form field arrives as a string; multiple arrive as an array. Normalise both. */
function toArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

/** Best-effort temp file removal. Never throws - a leftover file is not worth failing a run. */
function cleanupFiles(files) {
  for (const file of files || []) {
    if (!file || !file.path) continue;
    fs.unlink(path.resolve(file.path), err => {
      if (err && err.code !== 'ENOENT') {
        console.warn(`Could not remove upload ${file.path}:`, err.message);
      }
    });
  }
}

module.exports = router;
