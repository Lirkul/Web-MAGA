import * as readersService from '../services/readers.service.js';

export async function createReader(req, res) {
  res.status(201).json(await readersService.createReader(req.validated.body));
}

export async function listReaders(req, res) {
  res.json(await readersService.listReaders(req.validated.query));
}

export async function getReaderById(req, res) {
  res.json(await readersService.getReaderById(req.validated.params.id));
}

export async function updateReader(req, res) {
  res.json(await readersService.updateReader(req.validated.params.id, req.validated.body));
}
