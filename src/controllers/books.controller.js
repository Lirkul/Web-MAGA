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
