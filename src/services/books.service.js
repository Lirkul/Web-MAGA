import { ApiError } from '../errors/ApiError.js';
import { pool } from '../db/pool.js';
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

function mapIsbnConflict(error) {
  if (error.code === '23505' && error.constraint === 'books_isbn_key') {
    return new ApiError(409, 'BOOK_ALREADY_EXISTS', 'Книга с таким ISBN уже существует');
  }
  return error;
}

function bookHasLoansError() {
  return new ApiError(409, 'BOOK_HAS_LOANS', 'Невозможно удалить книгу, имеющую историю выдач');
}

export async function createBook(data) {
  try {
    return toBook(await booksRepository.insertBook(data));
  } catch (error) {
    throw mapIsbnConflict(error);
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

export async function updateBook(id, data) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const book = await booksRepository.lockBookById(id, client);
    if (!book) throw new ApiError(404, 'BOOK_NOT_FOUND', 'Книга не найдена');

    if (data.totalCopies !== undefined) {
      const unreturned = await booksRepository.countUnreturnedLoans(id, client);
      if (data.totalCopies < unreturned) {
        throw new ApiError(409, 'INSUFFICIENT_TOTAL_COPIES',
          'Количество экземпляров не может быть меньше числа невозвращённых выдач');
      }
    }
    await booksRepository.updateBookFields(id, data, client);
    const updated = await booksRepository.findBookById(id, client);
    await client.query('COMMIT');
    return toBook(updated);
  } catch (error) {
    await client.query('ROLLBACK');
    throw mapIsbnConflict(error);
  } finally {
    client.release();
  }
}

export async function deleteBook(id) {
  await getBookById(id);
  if (await booksRepository.hasBookLoans(id)) throw bookHasLoansError();

  try {
    const deleted = await booksRepository.deleteBookById(id);
    if (!deleted) throw new ApiError(404, 'BOOK_NOT_FOUND', 'Книга не найдена');
  } catch (error) {
    // Выдача могла появиться между проверкой истории и DELETE.
    if (error.code === '23503' && error.constraint === 'loans_book_id_fkey') {
      throw bookHasLoansError();
    }
    throw error;
  }
}
