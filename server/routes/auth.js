const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const db = require('../db/queries');
const { verifyToken } = require('../middleware/auth');

// Create anonymous session, return JWT
router.post('/session', async (req, res) => {
  try {
    const userId = uuidv4();
    const token = jwt.sign({ userId }, process.env.JWT_SECRET, { expiresIn: '24h' });
    
    // Store user with session token in DB
    const user = await db.createUser(token);
    
    res.json({ token, user: { id: user.id, created_at: user.created_at } });
  } catch (error) {
    console.error('Error creating session:', error);
    res.status(500).json({ error: 'Failed to create session' });
  }
});

// Verify token validity, return user info
router.get('/verify', verifyToken, async (req, res) => {
  try {
    const user = await db.getUserByToken(req.headers.authorization.split(' ')[1]);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    res.json({ user: { id: user.id, created_at: user.created_at, last_active: user.last_active } });
  } catch (error) {
    console.error('Error verifying session:', error);
    res.status(500).json({ error: 'Failed to verify session' });
  }
});

module.exports = router;
