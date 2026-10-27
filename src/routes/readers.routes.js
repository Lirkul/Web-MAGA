import { Router } from 'express';
import { createReadersService } from '../services/readers.service.js';
import { createReaderSchema, readersQuerySchema, updateReaderSchema } from '../schemas/readers.schemas.js';
import { idParamsSchema, paginationSchema } from '../schemas/common.schemas.js';
import { validate } from '../middleware/validate.js';

export function createReadersRouter(database) {
  const router = Router();
  const readers = createReadersService(database);

  router.get('/', validate(readersQuerySchema, 'query'), (request, response) => {
    response.json(readers.list(response.locals.query));
  });

  router.post('/', validate(createReaderSchema), (request, response) => {
    const reader = readers.create(response.locals.body);
    response.location(`/api/readers/${reader.id}`).status(201).json(reader);
  });

  router.use('/:id', validate(idParamsSchema, 'params'));

  router.get('/:id', (request, response) => {
    response.json(readers.get(response.locals.params.id));
  });

  router.patch('/:id', validate(updateReaderSchema), (request, response) => {
    response.json(readers.update(response.locals.params.id, response.locals.body));
  });

  router.delete('/:id', (request, response) => {
    readers.remove(response.locals.params.id);
    response.status(204).end();
  });

  router.get('/:id/loans', validate(paginationSchema, 'query'), (request, response) => {
    response.json(readers.history(response.locals.params.id, response.locals.query));
  });

  return router;
}
