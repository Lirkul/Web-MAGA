import { config } from '../config/index.js';
import { createBooksRepository } from '../repositories/books.repository.js';
import { createReadersRepository } from '../repositories/readers.repository.js';
import { createLoansRepository } from '../repositories/loans.repository.js';
import { addUtcDays, utcDate } from '../utils/dates.js';
import { HttpError } from '../utils/errors.js';

export function createLoansService(database, { now = () => new Date(), settings = config } = {}) {
  const books = createBooksRepository(database);
  const readers = createReadersRepository(database);
  const loans = createLoansRepository(database);

  function get(id) {
    const loan = loans.findById(id);
    if (!loan) throw new HttpError(404, 'LOAN_NOT_FOUND', 'Выдача не найдена');
    return loan;
  }

  return {
    get,
    list: (query) => loans.list(query),
    create: database.transaction(({ bookId, readerId, dueDate }) => {
      const timestamp = now();
      const today = utcDate(timestamp);
      if (dueDate !== undefined && dueDate <= today) {
        throw new HttpError(400, 'INVALID_DUE_DATE', 'Срок возврата должен быть позднее текущей даты UTC', {
          field: 'dueDate', today,
        });
      }

      const book = books.findById(bookId);
      if (!book) throw new HttpError(404, 'BOOK_NOT_FOUND', 'Книга не найдена');
      const reader = readers.findById(readerId);
      if (!reader) throw new HttpError(404, 'READER_NOT_FOUND', 'Читатель не найден');
      if (book.isArchived) throw new HttpError(409, 'BOOK_ARCHIVED', 'Архивную книгу нельзя выдавать');
      if (reader.status !== 'ACTIVE') throw new HttpError(409, 'READER_BLOCKED', 'Читатель заблокирован');

      const summary = loans.readerSummary(readerId, today);
      if (summary.hasOverdue) {
        throw new HttpError(409, 'READER_OVERDUE', 'У читателя есть невозвращённые книги с истёкшим сроком');
      }
      if (summary.outstandingCount >= settings.maxActiveLoans) {
        throw new HttpError(409, 'LOAN_LIMIT_REACHED', 'Достигнут лимит невозвращённых выдач', {
          maxActiveLoans: settings.maxActiveLoans,
        });
      }
      if (book.availableCopies <= 0) {
        throw new HttpError(409, 'BOOK_UNAVAILABLE', 'Нет доступных экземпляров книги');
      }

      return get(loans.insert({
        bookId, readerId, loanedAt: timestamp.toISOString(),
        dueDate: dueDate ?? addUtcDays(today, settings.defaultLoanDays),
      }));
    }).immediate,
    return: database.transaction((id) => {
      const loan = get(id);
      if (loan.status === 'RETURNED') {
        throw new HttpError(409, 'LOAN_ALREADY_RETURNED', 'Книга по этой выдаче уже возвращена');
      }
      const changed = loans.markReturned(id, now().toISOString());
      if (changed !== 1) {
        throw new HttpError(409, 'LOAN_ALREADY_RETURNED', 'Книга по этой выдаче уже возвращена');
      }
      // Расчёт окончательного штрафа добавляется в этапе 4; текущая сумма сохраняется.
      return get(id);
    }).immediate,
  };
}
