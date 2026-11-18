import { pool } from './pool.js';
import { runMigrations } from './migrate.js';
import { seedDatabase } from './seed.js';

try {
  await runMigrations(pool);
  console.log('Demo data:', await seedDatabase(pool));
} catch {
  console.error('Не удалось добавить демонстрационные данные');
  process.exitCode = 1;
} finally {
  await pool.end();
}
