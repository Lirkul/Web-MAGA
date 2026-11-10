import { pool } from './pool.js';
import { runMigrations } from './migrate.js';

try {
  await runMigrations(pool);
} catch (error) {
  console.error('Database migrations failed:', error.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
