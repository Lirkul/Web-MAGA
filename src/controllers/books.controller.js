import * as booksService from '../services/books.service.js';

export async function createBook(req, res) {
  res.status(201).json(await booksService.createBook(req.validated.body));
}

export async function listBooks(req, res) {
  res.json(await booksService.listBooks(req.validated.query));
}

export async function getBookById(req, res) {
  res.json(await booksService.getBookById(req.validated.params.id));
}

export async function updateBook(req, res) {
  res.json(await booksService.updateBook(req.validated.params.id, req.validated.body));
}

export async function deleteBook(req, res) {
  await booksService.deleteBook(req.validated.params.id);
  res.status(204).end();
}
