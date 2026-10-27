import { Router } from 'express';
import { createBooksService } from '../services/books.service.js';
import { booksQuerySchema, createBookSchema, updateBookSchema } from '../schemas/books.schemas.js';
import { idParamsSchema } from '../schemas/common.schemas.js';
import { validate } from '../middleware/validate.js';

export function createBooksRouter(database) {
  const router = Router();
  const books = createBooksService(database);

  router.get('/', validate(booksQuerySchema, 'query'), (request, response) => {
    response.json(books.list(response.locals.query));
  });

  router.post('/', validate(createBookSchema), (request, response) => {
    const book = books.create(response.locals.body);
    response.location(`/api/books/${book.id}`).status(201).json(book);
  });

  router.use('/:id', validate(idParamsSchema, 'params'));

  router.get('/:id', (request, response) => {
    response.json(books.get(response.locals.params.id));
  });

  router.patch('/:id', validate(updateBookSchema), (request, response) => {
    response.json(books.update(response.locals.params.id, response.locals.body));
  });

  router.delete('/:id', (request, response) => {
    books.remove(response.locals.params.id);
    response.status(204).end();
  });

  return router;
}
