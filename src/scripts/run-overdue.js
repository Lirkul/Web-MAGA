import { openDatabase } from '../db/database.js';
import { migrateDatabase } from '../db/migrate.js';
import { createOverdueService } from '../services/overdue.service.js';

const database = openDatabase();
try {
  migrateDatabase(database);
  createOverdueService(database).run();
} catch (error) {
  console.error('Проверка просрочек завершилась ошибкой:', error.message);
  process.exitCode = 1;
} finally {
  database.close();
}
