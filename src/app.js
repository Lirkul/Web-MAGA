import express from 'express';
import { healthRouter } from './routes/health.routes.js';
import { errorHandler } from './middleware/error-handler.js';

export const app = express();

app.use(express.json());
app.use('/api', healthRouter);

app.use((request, response) => {
  response.status(404).json({
    error: { code: 'NOT_FOUND', message: 'Маршрут не найден', details: {} },
  });
});

app.use(errorHandler);
