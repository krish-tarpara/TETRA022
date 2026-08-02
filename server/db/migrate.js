/**
 * Migration runner.  node server/db/migrate.js
 *
 * Applies schema.sql then every file in migrations/ in filename order, and records what it has
 * applied so re-running is safe.
 *
 * Written rather than using psql because psql is not installed on this project's dev machines and
 * the hosted database is only reachable over TLS with relaxed verification - which the pool
 * already handles. One `npm run migrate` is a much shorter setup path than "install the Postgres
 * client tools first".
 */

const fs = require('fs');
const path = require('path');
const pool = require('./pool');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');
const SCHEMA_FILE = path.join(__dirname, 'schema.sql');

async function ensureLedger() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename VARCHAR(200) PRIMARY KEY,
      applied_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
}

async function alreadyApplied() {
  const result = await pool.query('SELECT filename FROM schema_migrations');
  return new Set(result.rows.map(r => r.filename));
}

/**
 * Run one SQL file as a single statement batch.
 *
 * Deliberately not split on semicolons: doing so breaks any statement containing a semicolon
 * inside a string literal or a function body. node-postgres accepts multi-statement strings, so
 * the whole file goes as one unit and either applies completely or not at all.
 */
async function apply(filename, sql) {
  console.log(`  applying ${filename}...`);
  await pool.query('BEGIN');
  try {
    await pool.query(sql);
    await pool.query(
      'INSERT INTO schema_migrations (filename) VALUES ($1) ON CONFLICT DO NOTHING',
      [filename]
    );
    await pool.query('COMMIT');
    console.log(`  ok      ${filename}`);
  } catch (err) {
    await pool.query('ROLLBACK');
    throw new Error(`${filename} failed: ${err.message}`);
  }
}

async function main() {
  const health = await pool.healthCheck();
  if (!health.ok) {
    console.error(`Cannot reach the database: ${health.error}`);
    console.error('Check DATABASE_URL in your .env file. See SETUP.md.');
    process.exit(1);
  }

  console.log(`Connected to ${health.database}`);
  await ensureLedger();
  const applied = await alreadyApplied();

  // Base schema first. It is written with CREATE TABLE IF NOT EXISTS throughout, so it is safe to
  // re-run against a database that already has the original tables.
  if (fs.existsSync(SCHEMA_FILE) && !applied.has('schema.sql')) {
    await apply('schema.sql', fs.readFileSync(SCHEMA_FILE, 'utf8'));
  } else if (applied.has('schema.sql')) {
    console.log('  skip    schema.sql (already applied)');
  }

  if (!fs.existsSync(MIGRATIONS_DIR)) {
    console.log('No migrations directory. Done.');
    return;
  }

  const files = fs.readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.sql'))
    .sort(); // numeric prefixes give a deterministic order

  for (const file of files) {
    if (applied.has(file)) {
      console.log(`  skip    ${file} (already applied)`);
      continue;
    }
    await apply(file, fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'));
  }

  // Confirm the tables the engine depends on actually exist, so a partially applied migration is
  // reported here rather than as a confusing runtime error on the first upload.
  const required = ['users', 'analysis_sessions', 'documents', 'observations', 'findings'];
  const present = await pool.query(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = ANY($1)`,
    [required]
  );
  const found = new Set(present.rows.map(r => r.table_name));
  const missing = required.filter(t => !found.has(t));

  if (missing.length > 0) {
    console.error(`\nMigration finished but these tables are missing: ${missing.join(', ')}`);
    process.exit(1);
  }

  console.log('\nAll migrations applied. Tables verified.');
}

main()
  .catch(err => {
    console.error(`\nMigration failed: ${err.message}`);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
