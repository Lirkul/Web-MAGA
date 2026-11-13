import { Router } from 'express';
import * as controller from '../controllers/stats.controller.js';
import { validate } from '../middlewares/validate.js';
import { overdueReadersSchema, topBooksSchema } from '../schemas/stats.schemas.js';

const router = Router();
router.get('/top-books', validate(topBooksSchema, 'query'), controller.getTopBooks);
router.get('/overdue-readers', validate(overdueReadersSchema, 'query'), controller.getOverdueReaders);

export default router;
