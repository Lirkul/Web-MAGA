import { pool } from '../db/pool.js';
import { ApiError } from '../errors/ApiError.js';
import * as booksRepository from '../repositories/books.repository.js';
import * as readersRepository from '../repositories/readers.repository.js';
import * as loansRepository from '../repositories/loans.repository.js';

function toLoan(row) {
  return {
    id: Number(row.id),
    bookId: Number(row.book_id),
    readerId: Number(row.reader_id),
    loanedAt: row.loaned_at,
    dueDate: row.due_date,
    returnedAt: row.returned_at,
    status: row.status,
    fineAmount: row.fine_amount,
    createdAt: row.created_at,
  };
}

export async function createLoan(data) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const book = await booksRepository.lockBookById(data.bookId, client);
    if (!book) throw new ApiError(404, 'BOOK_NOT_FOUND', 'Книга не найдена');

    const reader = await readersRepository.lockReaderById(data.readerId, client);
    if (!reader) throw new ApiError(404, 'READER_NOT_FOUND', 'Читатель не найден');
    if (reader.status !== 'active') {
      throw new ApiError(409, 'READER_BLOCKED', 'Выдача книг заблокированному читателю запрещена');
    }
    const unreturned = await booksRepository.countUnreturnedLoans(data.bookId, client);
    if (book.total_copies <= unreturned) {
      throw new ApiError(409, 'BOOK_UNAVAILABLE', 'Нет доступных экземпляров книги');
    }
    const loan = await loansRepository.insertLoan(data, client);
    await client.query('COMMIT');
    return toLoan(loan);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
