import { Router } from 'express';
import { createLoan, getLoanById, listLoans, returnLoan } from '../controllers/loans.controller.js';
import { validate } from '../middlewares/validate.js';
import { createLoanSchema, listLoansSchema, loanIdSchema, returnLoanSchema } from '../schemas/loans.schemas.js';

const router = Router();
router.post('/', validate(createLoanSchema), createLoan);
router.get('/', validate(listLoansSchema, 'query'), listLoans);
router.get('/:id', validate(loanIdSchema, 'params'), getLoanById);
router.post('/:id/return', validate(loanIdSchema, 'params'), validate(returnLoanSchema), returnLoan);

export default router;
