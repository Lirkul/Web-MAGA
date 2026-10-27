// Все подстановки ниже собирают только постоянные SQL-фрагменты.
// Данные пользователя передаются отдельно через именованные параметры.
const bookDetails = `
  WITH book_details AS (
    SELECT books.*, totalCopies - (
      SELECT count(*) FROM loans
      WHERE loans.bookId = books.id AND loans.status IN ('ACTIVE', 'OVERDUE')
    ) AS availableCopies
    FROM books
  )
`;

const filters = `
  WHERE (@q = '' OR instr(lower_unicode(title), @q) > 0
    OR (@isbnQuery <> '' AND instr(isbn, @isbnQuery) > 0))
    AND (@genre IS NULL OR lower_unicode(genre) = @genre)
    AND (@author IS NULL OR EXISTS (
      SELECT 1 FROM json_each(authors) WHERE instr(lower_unicode(value), @author) > 0
    ))
    AND (@availableOnly = 0 OR (availableCopies > 0 AND isArchived = 0))
`;

function toBook(row) {
  if (!row) return undefined;
  return { ...row, authors: JSON.parse(row.authors), isArchived: Boolean(row.isArchived) };
}

function parameters(book) {
  return {
    title: book.title, authors: JSON.stringify(book.authors), isbn: book.isbn,
    publishedYear: book.publishedYear, genre: book.genre,
    totalCopies: book.totalCopies, isArchived: Number(book.isArchived),
  };
}

export function createBooksRepository(database) {
  const find = database.prepare(`${bookDetails} SELECT * FROM book_details WHERE id = ?`);
  const count = database.prepare(`${bookDetails} SELECT count(*) AS total FROM book_details ${filters}`);
  const list = database.prepare(`${bookDetails} SELECT * FROM book_details ${filters}
    ORDER BY lower_unicode(title), id LIMIT @limit OFFSET @offset`);
  const insert = database.prepare(`
    INSERT INTO books (title, authors, isbn, publishedYear, genre, totalCopies, isArchived)
    VALUES (@title, @authors, @isbn, @publishedYear, @genre, @totalCopies, @isArchived)
  `);
  const update = database.prepare(`
    UPDATE books SET title = @title, authors = @authors, isbn = @isbn,
      publishedYear = @publishedYear, genre = @genre, totalCopies = @totalCopies,
      isArchived = @isArchived WHERE id = @id
  `);
  const hasLoans = database.prepare('SELECT 1 FROM loans WHERE bookId = ? LIMIT 1');
  const remove = database.prepare('DELETE FROM books WHERE id = ?');

  return {
    findById: (id) => toBook(find.get(id)),
    insert: (book) => insert.run(parameters(book)).lastInsertRowid,
    update: (id, book) => update.run({ id, ...parameters(book) }),
    hasLoans: (id) => Boolean(hasLoans.get(id)),
    remove: (id) => remove.run(id),
    list: database.transaction((query) => {
      const { page, limit, q, genre, author, availableOnly } = query;
      const bindings = {
        q: q.toLowerCase(), isbnQuery: q.replace(/[\s-]/g, '').toUpperCase(),
        genre: genre?.toLowerCase() ?? null, author: author?.toLowerCase() ?? null,
        availableOnly: Number(availableOnly),
      };
      return {
        page, limit, total: count.get(bindings).total,
        items: list.all({ ...bindings, limit, offset: (page - 1) * limit }).map(toBook),
      };
    }),
  };
}
