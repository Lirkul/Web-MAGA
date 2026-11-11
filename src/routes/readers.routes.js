import { Router } from 'express';
import * as controller from '../controllers/readers.controller.js';
import { validate } from '../middlewares/validate.js';
import { createReaderSchema, listReadersSchema, readerIdSchema, updateReaderSchema } from '../schemas/readers.schemas.js';

const router = Router();

router.post('/', validate(createReaderSchema), controller.createReader);
router.get('/', validate(listReadersSchema, 'query'), controller.listReaders);
router.get('/:id', validate(readerIdSchema, 'params'), controller.getReaderById);
router.patch('/:id', validate(readerIdSchema, 'params'), validate(updateReaderSchema), controller.updateReader);

export default router;
