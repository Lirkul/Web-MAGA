import { createApp } from './app.js';
import { config } from './config/index.js';
import { openDatabase } from './db/database.js';
import { migrateDatabase } from './db/migrate.js';
import { createOverdueService } from './services/overdue.service.js';
import { startOverdueJob } from './jobs/overdue.job.js';

const database = openDatabase();
let overdueJob;

try {
  migrateDatabase(database);
  const app = createApp(database);
  const overdue = createOverdueService(database);
  overdue.run();
  overdueJob = startOverdueJob(overdue);

  const server = app.listen(config.port, () => {
    console.log(`Library API: http://localhost:${config.port}`);
    console.log(`SQLite: ${config.databasePath}`);
  });

  server.on('error', (error) => {
    console.error('Не удалось запустить HTTP-сервер:', error.message);
    overdueJob.destroy();
    if (database.open) database.close();
    process.exitCode = 1;
  });

  let shuttingDown = false;
  function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    overdueJob.destroy();
    server.close(() => {
      if (database.open) database.close();
    });
  }

  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
} catch (error) {
  overdueJob?.destroy();
  database.close();
  throw error;
}
