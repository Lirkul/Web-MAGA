import { createApp } from './app.js';
import { config } from './config/index.js';
import { openDatabase } from './db/database.js';
import { migrateDatabase } from './db/migrate.js';

const database = openDatabase();

try {
  migrateDatabase(database);
} catch (error) {
  database.close();
  throw error;
}

const app = createApp(database);
const server = app.listen(config.port, () => {
  console.log(`Library API: http://localhost:${config.port}`);
  console.log(`SQLite: ${config.databasePath}`);
});

server.on('error', (error) => {
  console.error('Не удалось запустить HTTP-сервер:', error.message);
  database.close();
  process.exitCode = 1;
});

function shutdown() {
  server.close(() => {
    database.close();
  });
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
