import { config } from '../config/index.js';
import { openDatabase } from './database.js';
import { migrateDatabase } from './migrate.js';

const database = openDatabase();
try {
  const applied = migrateDatabase(database);
  console.log(`База данных: ${config.databasePath}. Применено миграций: ${applied}.`);
} finally {
  database.close();
}
