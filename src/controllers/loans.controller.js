import * as loansService from '../services/loans.service.js';

export async function createLoan(req, res) {
  res.status(201).json(await loansService.createLoan(req.validated.body));
}

export async function returnLoan(req, res) {
  res.json(await loansService.returnLoan(req.validated.params.id));
}
