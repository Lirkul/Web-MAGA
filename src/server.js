import app from './app.js';
import { getFinePerDay } from './config/fine.js';
import { pool } from './db/pool.js';
import { startOverdueJob } from './jobs/overdue.job.js';

getFinePerDay();
const port = Number(process.env.PORT || 3000);
const overdueJob = process.env.NODE_ENV === 'test' ? null : startOverdueJob();

const server = app.listen(port, () => {
  console.log(`Server is listening on port ${port}`);
});

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    await overdueJob?.destroy();
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    await pool.end();
    console.log('Server stopped');
  } catch {
    console.error('Server shutdown failed');
    process.exitCode = 1;
  }
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
