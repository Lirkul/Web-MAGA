import * as statsService from '../services/stats.service.js';

export async function getTopBooks(req, res) {
  res.json(await statsService.getTopBooks(req.validated.query));
}

export async function getOverdueReaders(req, res) {
  res.json(await statsService.getOverdueReaders(req.validated.query));
}
