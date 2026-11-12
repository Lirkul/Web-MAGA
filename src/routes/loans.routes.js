import { Router } from 'express';
import { createLoan, returnLoan } from '../controllers/loans.controller.js';
import { validate } from '../middlewares/validate.js';
import { createLoanSchema, loanIdSchema, returnLoanSchema } from '../schemas/loans.schemas.js';

const router = Router();
router.post('/', validate(createLoanSchema), createLoan);
router.post('/:id/return', validate(loanIdSchema, 'params'), validate(returnLoanSchema), returnLoan);

export default router;
