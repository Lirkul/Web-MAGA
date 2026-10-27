import express from 'express';
import { healthRouter } from './routes/health.routes.js';
import { errorHandler } from './middleware/error-handler.js';
import { createBooksRouter } from './routes/books.routes.js';
import { createReadersRouter } from './routes/readers.routes.js';
import { createLoansRouter } from './routes/loans.routes.js';

export function createApp(database, options = {}) {
  const app = express();

  // Парсим любой корректный JSON; требование объекта проверяют схемы маршрутов.
  app.use(express.json({ strict: false }));
  app.use('/api', healthRouter);
  app.use('/api/books', createBooksRouter(database));
  app.use('/api/readers', createReadersRouter(database));
  app.use('/api/loans', createLoansRouter(database, options));

  app.use((request, response) => {
    response.status(404).json({
      error: { code: 'NOT_FOUND', message: 'Маршрут не найден', details: {} },
    });
  });

  app.use(errorHandler);
  return app;
}
