import { parentPort, workerData } from 'node:worker_threads';
import { config } from '../../src/config/index.js';
import { openDatabase } from '../../src/db/database.js';
import { createLoansService } from '../../src/services/loans.service.js';

// У каждого потока своё соединение к одному файлу SQLite.
const database = openDatabase(workerData.path);
try {
  const loans = createLoansService(database, {
    now: () => new Date(workerData.timestamp),
    settings: { ...config, ...workerData.settings },
  });
  const start = new Int32Array(workerData.start);
  parentPort.postMessage({ ready: true });
  Atomics.wait(start, 0, 0);
  try {
    const loan = workerData.operation === 'return'
      ? loans.return(workerData.id)
      : loans.create(workerData.body);
    parentPort.postMessage({ status: 'ok', loan });
  } catch (error) {
    parentPort.postMessage({ status: error.status ?? 500, code: error.code, message: error.message });
  }
} finally {
  database.close();
}
