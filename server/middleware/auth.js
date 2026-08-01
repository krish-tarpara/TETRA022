const jwt = require('jsonwebtoken');
const db = require('../db/queries');

const verifyToken = async (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid authorization header' });
  }

  const token = authHeader.split(' ')[1];

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await db.getUserByToken(token);
    
    if (!user) {
      return res.status(401).json({ error: 'Invalid session' });
    }

    // Update last active in background
    db.updateLastActive(user.id).catch(err => console.error('Failed to update last active', err));

    req.user = { ...decoded, userId: user.id }; // Use DB user.id instead of JWT userId
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Token expired or invalid' });
  }
};

module.exports = { verifyToken };
