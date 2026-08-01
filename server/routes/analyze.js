const express = require('express');
const router = express.Router();
const upload = require('../middleware/upload');
const db = require('../db/queries');
const { verifyToken } = require('../middleware/auth');
const reportBuilder = require('../services/reportBuilder');

// POST /api/v1/analyze
router.post('/', verifyToken, upload.array('files', 8), async (req, res) => {
  try {
    const session = await db.createSession(req.user.userId);
    
    // Return IMMEDIATELY (Fix P1)
    res.json({ sessionId: session.id, status: 'processing' });
    
    const io = req.app.get('io');
    
    // Launch the pipeline as a detached async operation
    setImmediate(() => {
      console.log(`Session ${session.id} processing started for ${req.files?.length || 0} files.`);
      io.of('/analysis').to(`session:${session.id}`).emit('status:update', { stage: 'initializing' });
      
      const docTypes = req.body.documentTypes || [];
      const typesArray = Array.isArray(docTypes) ? docTypes : [docTypes];
      
      reportBuilder.runPipeline(session.id, req.files, typesArray, io)
        .catch(err => {
          io.of('/analysis').to(`session:${session.id}`).emit('analysis:error', { error: err.message });
          db.updateSessionStatus(session.id, 'failed');
        });
    });
  } catch (error) {
    console.error('Error starting analysis:', error);
    res.status(500).json({ error: 'Failed to start analysis' });
  }
});

module.exports = router;
