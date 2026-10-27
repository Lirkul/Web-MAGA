import { createBooksRepository } from '../repositories/books.repository.js';
import { HttpError } from '../utils/errors.js';

export function createBooksService(database) {
  const books = createBooksRepository(database);

  function get(id) {
    const book = books.findById(id);
    if (!book) throw new HttpError(404, 'BOOK_NOT_FOUND', 'Книга не найдена');
    return book;
  }

  return {
    list: (query) => books.list(query),
    get,
    create: database.transaction((data) => get(books.insert(data))),
    update: database.transaction((id, changes) => {
      const current = get(id);
      const outstandingCopies = current.totalCopies - current.availableCopies;
      if (changes.totalCopies !== undefined && changes.totalCopies < outstandingCopies) {
        throw new HttpError(409, 'COPIES_IN_USE', 'Нельзя уменьшить количество экземпляров ниже числа невозвращённых', {
          minimumCopies: outstandingCopies,
        });
      }
      books.update(id, { ...current, ...changes });
      return get(id);
    }).immediate,
    remove: database.transaction((id) => {
      get(id);
      if (books.hasLoans(id)) {
        throw new HttpError(409, 'BOOK_HAS_LOANS', 'У книги есть история выдач. Вместо удаления архивируйте книгу');
      }
      books.remove(id);
    }).immediate,
  };
}
