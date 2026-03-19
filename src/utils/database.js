/**
 * LUXXPOOL — Database Module
 * PostgreSQL connection pool and migration runner
 */

const { Pool } = require('pg');
const { createLogger } = require('../utils/logger');
const config = require('../../config');

const log = createLogger('database');

let pool = null;

/**
 * Initialize the PostgreSQL connection pool
 */
function initDatabase() {
  pool = new Pool({
    host:     config.postgres.host,
    port:     config.postgres.port,
    database: config.postgres.database,
    user:     config.postgres.user,
    password: config.postgres.password,
    max:      config.postgres.poolSize,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  });

  pool.on('error', (err) => {
    log.error({ err: err.message }, 'Unexpected PostgreSQL pool error');
  });

  pool.on('connect', () => {
    log.debug('New database connection established');
  });

  log.info({
    host: config.postgres.host,
    database: config.postgres.database,
    poolSize: config.postgres.poolSize,
  }, 'Database pool initialized');

  return pool;
}

/**
 * Get the active pool instance
 */
function getPool() {
  if (!pool) throw new Error('Database not initialized. Call initDatabase() first.');
  return pool;
}

/**
 * Run a query
 */
async function query(text, params) {
  const start = Date.now();
  const result = await getPool().query(text, params);
  const duration = Date.now() - start;

  if (duration > 1000) {
    log.warn({ duration, query: text.substring(0, 100) }, 'Slow query detected');
  }

  return result;
}

/**
 * Run database migrations
 */
async function runMigrations() {
  log.info('Running database migrations...');

  // Ensure migrations tracking table exists
  await query(`
    CREATE TABLE IF NOT EXISTS migrations (
      id SERIAL PRIMARY KEY,
      name VARCHAR(256) NOT NULL UNIQUE,
      applied_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // Load and run migrations
  const fs = require('fs');
  const path = require('path');
  const migrationsDir = path.join(__dirname, '../../migrations');

  const files = fs.readdirSync(migrationsDir)
    .filter(f => f.endsWith('.js') && f !== 'run.js')
    .sort();

  for (const file of files) {
    const { rows } = await query('SELECT 1 FROM migrations WHERE name = $1', [file]);
    if (rows.length > 0) {
      log.debug({ migration: file }, 'Already applied');
      continue;
    }

    const migration = require(path.join(migrationsDir, file));
    if (migration.MIGRATION_SQL) {
      await query(migration.MIGRATION_SQL);
      await query('INSERT INTO migrations (name) VALUES ($1)', [file]);
      log.info({ migration: file }, 'Migration applied');
    }
  }

  log.info('All migrations complete');
}

/**
 * Close the pool
 */
async function closeDatabase() {
  if (pool) {
    await pool.end();
    log.info('Database pool closed');
  }
}

module.exports = {
  initDatabase,
  getPool,
  query,
  runMigrations,
  closeDatabase,
};
