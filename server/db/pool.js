const { Pool } = require('pg');
const path = require('path');

/**
 * PostgreSQL connection pool.
 *
 * Two things here are load-bearing and were both breaking connections:
 *
 * 1. `.env` location. dotenv defaults to the process working directory, which is only correct
 *    when the server is started from the project root. Resolving relative to this file instead
 *    means `node server/index.js` works from anywhere, and the parent directory is checked as a
 *    fallback because that is where this project's .env actually lives.
 *
 * 2. SSL. Recent pg versions treat `sslmode=require` in a connection string as `verify-full`,
 *    which demands a CA certificate chain. Hosted providers like Neon and Supabase issue certs
 *    that do not verify against the system trust store, so the connection hangs until it times
 *    out - with no error message explaining why. Passing an explicit ssl object overrides that
 *    and restores the intended behaviour: encrypted transport, no CA verification.
 */
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
if (!process.env.DATABASE_URL) {
  require('dotenv').config({ path: path.resolve(__dirname, '../../../.env') });
}
if (!process.env.DATABASE_URL) {
  require('dotenv').config();
}

if (!process.env.DATABASE_URL) {
  console.error(
    'DATABASE_URL is not set. Create a .env file with DATABASE_URL=postgresql://... ' +
    'See SETUP.md.'
  );
}

/** Hosted Postgres needs TLS; a local server on localhost generally does not. */
function sslConfig(connectionString) {
  if (!connectionString) return false;

  const isLocal = /@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(connectionString);
  if (isLocal) return false;

  const mentionsSsl = /sslmode=|ssl=true/.test(connectionString);
  if (!mentionsSsl) return false;

  // Encrypt, but do not verify the CA. Managed providers commonly present certificates that
  // fail verify-full against the system trust store, and the failure mode is a silent timeout.
  return { rejectUnauthorized: false };
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: sslConfig(process.env.DATABASE_URL),
  // Neon and similar suspend idle compute and take several seconds to wake. The pg default of
  // 0 (no timeout) would hang forever on an unreachable host instead of reporting an error.
  connectionTimeoutMillis: 30000,
  idleTimeoutMillis: 30000,
  max: 10
});

/**
 * Idle client errors.
 *
 * The previous version called process.exit(-1) here, which killed the whole server whenever a
 * managed database dropped an idle connection - a routine event on Neon, which suspends compute
 * after inactivity. The pool replaces failed clients on its own, so logging is the correct
 * response.
 */
pool.on('error', err => {
  console.error('Idle database client error (pool will recover):', err.message);
});

/** Connectivity check for startup, so failures surface at boot rather than on first request. */
async function healthCheck() {
  try {
    const result = await pool.query('SELECT current_database() AS db');
    return { ok: true, database: result.rows[0].db };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = pool;
module.exports.healthCheck = healthCheck;
