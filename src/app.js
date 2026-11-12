import express from 'express';
import { checkDatabaseConnection } from './db/pool.js';
import { ApiError } from './errors/ApiError.js';
import { errorHandler } from './middlewares/errorHandler.js';
import booksRoutes from './routes/books.routes.js';
import readersRoutes from './routes/readers.routes.js';
import loansRoutes from './routes/loans.routes.js';

const app = express();

app.use(express.json());

app.get('/api/health', async (req, res) => {
  try {
    await checkDatabaseConnection();
    res.status(200).json({ status: 'ok', database: 'connected' });
  } catch {
    res.status(503).json({ status: 'error', database: 'disconnected' });
  }
});

app.use('/api/books', booksRoutes);
app.use('/api/readers', readersRoutes);
app.use('/api/loans', loansRoutes);

app.use((req, res, next) => {
  next(ApiError.notFound('Эндпоинт не найден'));
});

app.use(errorHandler);

export default app;
