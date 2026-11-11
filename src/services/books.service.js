import { ApiError } from '../errors/ApiError.js';
import * as booksRepository from '../repositories/books.repository.js';

function toBook(row) {
  return {
    id: Number(row.id),
    title: row.title,
    authors: row.authors,
    isbn: row.isbn,
    publicationYear: row.publication_year,
    genre: row.genre,
    totalCopies: row.total_copies,
    availableCopies: Number(row.available_copies),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function createBook(data) {
  try {
    return toBook(await booksRepository.insertBook(data));
  } catch (error) {
    if (error.code === '23505' && error.constraint === 'books_isbn_key') {
      throw new ApiError(409, 'BOOK_ALREADY_EXISTS', 'Книга с таким ISBN уже существует');
    }
    throw error;
  }
}

export async function getBookById(id) {
  const row = await booksRepository.findBookById(id);
  if (!row) throw new ApiError(404, 'BOOK_NOT_FOUND', 'Книга не найдена');
  return toBook(row);
}

export async function listBooks(query) {
  const isbnSearch = query.search?.replace(/[-\s]/g, '').toUpperCase();
  const { rows, total } = await booksRepository.findBooks({ ...query, isbnSearch });
  return {
    data: rows.map(toBook),
    pagination: {
      page: query.page,
      limit: query.limit,
      total,
      totalPages: Math.ceil(total / query.limit),
    },
  };
}
