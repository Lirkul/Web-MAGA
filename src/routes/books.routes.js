import { Router } from 'express';
import * as controller from '../controllers/books.controller.js';
import { validate } from '../middlewares/validate.js';
import { bookIdSchema, createBookSchema, listBooksSchema } from '../schemas/books.schemas.js';

const router = Router();

router.post('/', validate(createBookSchema), controller.createBook);
router.get('/', validate(listBooksSchema, 'query'), controller.listBooks);
router.get('/:id', validate(bookIdSchema, 'params'), controller.getBookById);

export default router;
