import { Router } from 'express';
import { createLoan } from '../controllers/loans.controller.js';
import { validate } from '../middlewares/validate.js';
import { createLoanSchema } from '../schemas/loans.schemas.js';

const router = Router();
router.post('/', validate(createLoanSchema), createLoan);

export default router;
