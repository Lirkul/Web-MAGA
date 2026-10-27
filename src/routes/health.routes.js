import { Router } from 'express';

export const healthRouter = Router();

healthRouter.get('/health', (request, response) => {
  response.status(200).json({ status: 'ok' });
});
