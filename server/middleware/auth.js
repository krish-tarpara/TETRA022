const jwt = require('jsonwebtoken');
const db = require('../db/queries');

const verifyToken = async (req, res, next) => {
  const authHeader = req.headers.authorization;

  let token = null;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.split(' ')[1];
  } else if (req.query.token) {
    token = req.query.token;  // fallback for window.open export links
  }

  if (!token) {
    return res.status(401).json({ error: 'Missing or invalid authorization token' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    
    // Try ID-based lookup first (login users have their real DB id in the JWT)
    let user = await db.getUserById(decoded.userId);
    
    // Fall back to token-based lookup (anonymous sessions store the full JWT in session_token)
    if (!user) {
      user = await db.getUserByToken(token);
    }
    
    if (!user) {
      return res.status(401).json({ error: 'Invalid session' });
    }

    // Update last active in background
    db.updateLastActive(user.id).catch(err => console.error('Failed to update last active', err));

    req.user = { ...decoded, userId: user.id };
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Token expired or invalid' });
  }
};

module.exports = { verifyToken };
