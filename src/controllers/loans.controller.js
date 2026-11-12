import * as loansService from '../services/loans.service.js';

export async function createLoan(req, res) {
  res.status(201).json(await loansService.createLoan(req.validated.body));
}
