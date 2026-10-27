import { Router } from 'express';
import { createLoansService } from '../services/loans.service.js';
import { createLoanSchema, loansQuerySchema, returnLoanSchema } from '../schemas/loans.schemas.js';
import { idParamsSchema } from '../schemas/common.schemas.js';
import { validate } from '../middleware/validate.js';

export function createLoansRouter(database, options) {
  const router = Router();
  const loans = createLoansService(database, options);

  router.get('/', validate(loansQuerySchema, 'query'), (request, response) => {
    response.json(loans.list(response.locals.query));
  });

  router.post('/', validate(createLoanSchema), (request, response) => {
    const loan = loans.create(response.locals.body);
    response.location(`/api/loans/${loan.id}`).status(201).json(loan);
  });

  router.use('/:id', validate(idParamsSchema, 'params'));

  router.get('/:id', (request, response) => {
    response.json(loans.get(response.locals.params.id));
  });

  router.post('/:id/return', validate(returnLoanSchema), (request, response) => {
    response.json(loans.return(response.locals.params.id));
  });

  return router;
}
