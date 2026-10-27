import { createReadersRepository } from '../repositories/readers.repository.js';
import { HttpError } from '../utils/errors.js';

export function createReadersService(database) {
  const readers = createReadersRepository(database);

  function get(id) {
    const reader = readers.findById(id);
    if (!reader) throw new HttpError(404, 'READER_NOT_FOUND', 'Читатель не найден');
    return reader;
  }

  return {
    list: (query) => readers.list(query),
    get,
    create: database.transaction((data) => get(readers.insert(data))),
    update: database.transaction((id, changes) => {
      const current = get(id);
      readers.update(id, { ...current, ...changes });
      return get(id);
    }).immediate,
    remove: database.transaction((id) => {
      get(id);
      if (readers.hasLoans(id)) {
        throw new HttpError(409, 'READER_HAS_LOANS', 'У читателя есть история выдач. Вместо удаления заблокируйте читателя');
      }
      readers.remove(id);
    }).immediate,
    history: (id, query) => {
      get(id);
      return readers.history(id, query);
    },
  };
}
