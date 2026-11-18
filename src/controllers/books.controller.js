import * as booksService from '../services/books.service.js';
import { withCsvUpload } from '../middlewares/csvUpload.js';

export async function importBooks(req, res) {
  const cancellation = new AbortController();
  const onClose = () => { if (!res.writableEnded) cancellation.abort(); };
  res.once('close', onClose);
  try {
    res.json(await withCsvUpload(req,
      (path) => booksService.importBooks(path, cancellation.signal), cancellation.signal));
  } finally {
    res.off('close', onClose);
  }
}

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
