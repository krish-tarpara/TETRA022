const express = require('express');
const http = require('http');
const cors = require('cors');
const path = require('path');

/**
 * Load .env before anything else requires it.
 *
 * Resolved relative to this file, not the working directory, so `node server/index.js` works from
 * any cwd. The parent directory is checked as a fallback because that is where this project's .env
 * actually lives.
 */
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
if (!process.env.DATABASE_URL) {
  require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
}

const pool = require('./db/pool');
const authRoutes = require('./routes/auth');
const analyzeRoutes = require('./routes/analyze');
const sessionsRoutes = require('./routes/sessions');
const setupSocket = require('./socket');
const rulepack = require('./engine/rulepack.json');

const app = express();
const server = http.createServer(app);
const io = setupSocket(server);

app.set('io', io);

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

app.use(express.static(path.join(__dirname, '../Frontend')));

app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/analyze', analyzeRoutes);
app.use('/api/v1/sessions', sessionsRoutes);

/**
 * Health check that actually checks something.
 *
 * The previous version returned `{status:'ok'}` unconditionally, which reported healthy while the
 * database was unreachable - so the first upload failed with a confusing error instead of the
 * problem being visible up front.
 */
app.get('/health', async (req, res) => {
  const db = await pool.healthCheck();
  res.status(db.ok ? 200 : 503).json({
    status: db.ok ? 'ok' : 'degraded',
    database: db.ok ? db.database : `unreachable: ${db.error}`,
    rulepack_version: rulepack.version,
    ai_keys: {
      groq: Boolean(process.env.GROQ_API_KEY),
      llamacloud: Boolean(process.env.LLAMA_CLOUD_API_KEY)
    }
  });
});

/** Multer and JSON parse errors otherwise surface as unhandled HTML error pages. */
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);

  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: 'A file exceeds the 25MB limit.' });
  }
  if (err.code === 'LIMIT_FILE_COUNT') {
    return res.status(413).json({ error: 'Too many files. The maximum is 8.' });
  }
  if (err.code === 'LIMIT_UNEXPECTED_FILE') {
    return res.status(400).json({ error: 'Unexpected upload field. Files must be sent as "files".' });
  }
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Request body was not valid JSON.' });
  }

  console.error('Unhandled request error:', err);
  res.status(500).json({ error: 'Something went wrong.' });
});

const PORT = process.env.PORT || 5000;

/**
 * Check the database before accepting traffic.
 *
 * The server still starts if the database is down - the health endpoint then reports it, which is
 * more useful than refusing to boot - but the warning appears at startup rather than surfacing as
 * a mysterious failure on someone's first upload.
 */
async function start() {
  const db = await pool.healthCheck();

  if (db.ok) {
    console.log(`Database connected: ${db.database}`);
  } else {
    console.warn(`WARNING: database unreachable (${db.error})`);
    console.warn('Uploads will fail. Check DATABASE_URL in .env, then run: npm run migrate');
  }

  if (!process.env.GROQ_API_KEY) {
    console.warn('WARNING: GROQ_API_KEY is not set. Document extraction will fail.');
  }
  if (!process.env.LLAMA_CLOUD_API_KEY) {
    console.warn('WARNING: LLAMA_CLOUD_API_KEY is not set. PDF and PPTX parsing will fail.');
  }
  if (!process.env.JWT_SECRET) {
    console.warn('WARNING: JWT_SECRET is not set. Sessions will not survive a restart.');
  }

  server.listen(PORT, () => {
    console.log(`FinVerify listening on http://localhost:${PORT}  (rule pack v${rulepack.version})`);
  });
}

start();

/** Close the pool on shutdown so the hosted database does not hold stale connections. */
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log(`\n${signal} received, shutting down.`);
    server.close(() => pool.end().then(() => process.exit(0)).catch(() => process.exit(0)));
    setTimeout(() => process.exit(0), 5000);
  });
}

module.exports = { app, server };
