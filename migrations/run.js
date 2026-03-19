/**
 * LUXXPOOL — Migration Runner
 * Execute: node migrations/run.js
 */

require('dotenv').config();
const { initDatabase, runMigrations, closeDatabase } = require('../src/utils/database');

async function main() {
  console.log('LUXXPOOL — Running migrations...');
  initDatabase();
  await runMigrations();
  await closeDatabase();
  console.log('Done.');
  process.exit(0);
}

main().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
