import { randomUUID } from 'node:crypto';
import pg from 'pg';
import request from 'supertest';
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
import app from '../src/app.js';
import { runMigrations } from '../src/db/migrate.js';

const { query, connect } = vi.hoisted(() => ({ query: vi.fn(), connect: vi.fn() }));
// Подменяется только соединение: маршруты, сервисы и SQL работают по-настоящему.
vi.mock('../src/db/pool.js', () => ({
  pool: { query, connect },
  checkDatabaseConnection: () => query('SELECT 1'),
}));

const testUrl = process.env.TEST_DATABASE_URL;
if (!testUrl || !decodeURIComponent(new URL(testUrl).pathname).endsWith('_test')) {
  throw new Error('Set TEST_DATABASE_URL to a separate database ending in _test');
}
const admin = new pg.Pool({ connectionString: testUrl });
let pool;
let schema;

beforeEach(async () => {
  schema = `books_test_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  pool = new pg.Pool({ connectionString: testUrl, options: `-c search_path=${schema}` });
  await runMigrations(pool);
  query.mockReset();
  query.mockImplementation((...args) => pool.query(...args));
  connect.mockReset();
  connect.mockImplementation(() => pool.connect());
});

afterEach(async () => {
  await pool?.end();
  await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
});

afterAll(async () => {
  await admin.end();
});

const validBook = {
  title: 'Чистый код', authors: ['Роберт Мартин'], isbn: '9780132350884',
  publicationYear: 2008, genre: 'Программирование', totalCopies: 5,
};

async function createBook(overrides = {}) {
  const response = await request(app).post('/api/books').send({ ...validBook, ...overrides });
  expect(response.status).toBe(201);
  return response.body;
}

async function createCatalog() {
  return [
    await createBook(),
    await createBook({ title: 'Рефакторинг', authors: ['Мартин Фаулер'], isbn: '9780306406157' }),
    await createBook({ title: 'Код космоса', authors: ['Другой автор'], isbn: '080442957X', genre: 'Наука' }),
  ];
}

it('creates a book, normalizes strings and returns camelCase fields with HTTP 201', async () => {
  const book = await createBook({
    title: '  Чистый   код  ', authors: [' Роберт   Мартин '],
    isbn: '978-0-13 235088-4', genre: ' Программирование ',
  });
  expect(book).toEqual({
    ...validBook, id: expect.any(Number), availableCopies: 5,
    createdAt: expect.any(String), updatedAt: expect.any(String),
  });
  expect(book.id).toBeGreaterThan(0);
  expect(Number.isNaN(Date.parse(book.createdAt))).toBe(false);
  const stored = (await pool.query('SELECT * FROM books')).rows[0];
  expect(stored).toMatchObject({ title: validBook.title, authors: validBook.authors, isbn: validBook.isbn });
  expect(stored).not.toHaveProperty('available_copies');
});

it('defaults totalCopies to zero and stores absent optional fields as NULL', async () => {
  const response = await request(app).post('/api/books').send({ title: 'Книга', authors: ['Автор'], isbn: '9780132350884' });
  expect(response.status).toBe(201);
  expect(response.body).toMatchObject({ publicationYear: null, genre: null, totalCopies: 0, availableCopies: 0 });
});

it.each([
  ['0-306-40615-2', '0306406152'],
  ['0 8044 2957 x', '080442957X'],
  ['978-0-306-40615-7', '9780306406157'],
])('accepts ISBN %s', async (isbn, normalized) => {
  const book = await createBook({ isbn });
  expect(book.isbn).toBe(normalized);
});

it('accepts the next calendar year', async () => {
  const year = new Date().getUTCFullYear() + 1;
  expect((await createBook({ publicationYear: year })).publicationYear).toBe(year);
});

it('rejects a duplicate ISBN after separator normalization with BOOK_ALREADY_EXISTS', async () => {
  await createBook();
  const response = await request(app).post('/api/books').send({ ...validBook, isbn: '978-0-13-235088-4' });
  expect(response.status).toBe(409);
  expect(response.body).toEqual({ error: { code: 'BOOK_ALREADY_EXISTS', message: 'Книга с таким ISBN уже существует', details: [] } });
  expect((await pool.query('SELECT count(*) FROM books')).rows[0].count).toBe('1');
});

it('handles simultaneous requests for the same normalized ISBN', async () => {
  const responses = await Promise.all([
    request(app).post('/api/books').send(validBook),
    request(app).post('/api/books').send({ ...validBook, isbn: '978 0 13 235088 4' }),
  ]);
  expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
  expect((await pool.query('SELECT count(*) FROM books')).rows[0].count).toBe('1');
});

it.each([
  ['missing title', { title: undefined }],
  ['empty title', { title: '   ' }],
  ['missing authors', { authors: undefined }],
  ['empty authors', { authors: [] }],
  ['blank author', { authors: ['Автор', '  '] }],
  ['non-array authors', { authors: 'Автор' }],
  ['missing ISBN', { isbn: undefined }],
  ['invalid ISBN format', { isbn: 'not-an-isbn' }],
  ['wrong ISBN-13 checksum', { isbn: '9780132350885' }],
  ['wrong ISBN-10 checksum', { isbn: '0306406153' }],
  ['non-ISBN EAN prefix', { isbn: '1234567890128' }],
  ['negative copies', { totalCopies: -1 }],
  ['fractional copies', { totalCopies: 1.5 }],
  ['text copies', { totalCopies: '5' }],
  ['copies outside PostgreSQL INTEGER range', { totalCopies: 2147483648 }],
  ['zero year', { publicationYear: 0 }],
  ['fractional year', { publicationYear: 2008.5 }],
  ['text year', { publicationYear: '2008' }],
  ['future year', { publicationYear: new Date().getUTCFullYear() + 2 }],
  ['non-string genre', { genre: 5 }],
  ['unknown field', { availableCopies: 99 }],
])('returns 400 for %s without inserting data', async (_name, overrides) => {
  const response = await request(app).post('/api/books').send({ ...validBook, ...overrides });
  expect(response.status).toBe(400);
  expect(response.body.error).toMatchObject({ code: 'VALIDATION_ERROR', message: 'Некорректные данные запроса' });
  expect(response.body.error.details.length).toBeGreaterThan(0);
  expect((await pool.query('SELECT count(*) FROM books')).rows[0].count).toBe('0');
});

it('lists books in ascending ID order with default pagination', async () => {
  const books = await createCatalog();
  const response = await request(app).get('/api/books');
  expect(response.status).toBe(200);
  expect(response.body.data).toEqual(books);
  expect(response.body.pagination).toEqual({ page: 1, limit: 10, total: 3, totalPages: 1 });
});

it.each([
  ['title', { search: '  КОД  ' }, [0, 2]],
  ['author', { search: 'мАрТиН' }, [0, 1]],
  ['ISBN', { search: '9780132350884' }, [0]],
  ['formatted ISBN', { search: '978-0-13-235088-4' }, [0]],
  ['genre', { genre: ' прогРАММИрование ' }, [0, 1]],
  ['search and genre', { search: 'код', genre: 'Программирование' }, [0]],
])('filters by %s in PostgreSQL', async (_name, filter, indexes) => {
  const books = await createCatalog();
  const response = await request(app).get('/api/books').query(filter);
  expect(response.status).toBe(200);
  expect(response.body.data.map((book) => book.id)).toEqual(indexes.map((index) => books[index].id));
  expect(response.body.pagination.total).toBe(indexes.length);
});

it('applies LIMIT/OFFSET while counting all matching books', async () => {
  const books = await createCatalog();
  const response = await request(app).get('/api/books').query({ search: 'код', page: 2, limit: 1 });
  expect(response.status).toBe(200);
  expect(response.body.data).toEqual([books[2]]);
  expect(response.body.pagination).toEqual({ page: 2, limit: 1, total: 2, totalPages: 2 });
  const beyond = await request(app).get('/api/books').query({ page: 5, limit: 2 });
  expect(beyond.body).toEqual({ data: [], pagination: { page: 5, limit: 2, total: 3, totalPages: 2 } });
});

it('returns an empty page with HTTP 200 when there are no matches', async () => {
  await createBook();
  const response = await request(app).get('/api/books').query({ search: 'несуществующая книга' });
  expect(response.status).toBe(200);
  expect(response.body).toEqual({ data: [], pagination: { page: 1, limit: 10, total: 0, totalPages: 0 } });
});

it('treats SQL LIKE wildcards as literal search characters', async () => {
  const special = await createBook({ title: '100%_буквально' });
  await createBook({ title: 'Другая книга', isbn: '9780306406157' });
  const response = await request(app).get('/api/books').query({ search: '%_' });
  expect(response.body.data.map((book) => book.id)).toEqual([special.id]);
});

it.each(["' OR 1=1 --", '-'])('does not broaden a search for %s', async (search) => {
  await createCatalog();
  const response = await request(app).get('/api/books').query({ search });
  expect(response.status).toBe(200);
  expect(response.body.pagination.total).toBe(0);
});

it.each([
  { page: 0 }, { page: -1 }, { page: 1.5 }, { page: 'abc' },
  { limit: 0 }, { limit: 101 }, { limit: 1.5 }, { page: ['1', '2'] },
  { page: '9007199254740991', limit: 100 }, { search: ' ' }, { genre: ' ' }, { extra: 'unknown' },
])('rejects invalid query parameters %j', async (parameters) => {
  const response = await request(app).get('/api/books').query(parameters);
  expect(response.status).toBe(400);
  expect(response.body.error.code).toBe('VALIDATION_ERROR');
});

it('gets one book by ID', async () => {
  const book = await createBook();
  const response = await request(app).get(`/api/books/${book.id}`);
  expect(response.status).toBe(200);
  expect(response.body).toEqual(book);
});

it('returns BOOK_NOT_FOUND for a missing book', async () => {
  const response = await request(app).get('/api/books/999999');
  expect(response.status).toBe(404);
  expect(response.body).toEqual({ error: { code: 'BOOK_NOT_FOUND', message: 'Книга не найдена', details: [] } });
});

it.each(['0', '-1', 'abc', '1.5', '1e2', '9007199254740992', '999999999999999999999999'])('rejects invalid ID %s', async (id) => {
  const response = await request(app).get(`/api/books/${id}`);
  expect(response.status).toBe(400);
  expect(response.body.error.details[0].path).toBe('id');
});

it('counts active and overdue unreturned loans, but excludes returned loans in both GET endpoints', async () => {
  const book = await createBook();
  const reader = (await pool.query("INSERT INTO readers (full_name, email, registration_number) VALUES ('Test', 'reader@example.com', 'R-1') RETURNING id")).rows[0];
  await pool.query(`
    INSERT INTO loans (book_id, reader_id, due_date, status, returned_at)
    VALUES ($1, $2, CURRENT_DATE + 14, 'active', NULL),
           ($1, $2, CURRENT_DATE - 1, 'overdue', NULL),
           ($1, $2, CURRENT_DATE + 14, 'returned', NOW())
  `, [book.id, reader.id]);
  expect((await request(app).get(`/api/books/${book.id}`)).body.availableCopies).toBe(3);
  query.mockClear();
  const list = await request(app).get('/api/books');
  expect(list.body.data[0].availableCopies).toBe(3);
  expect(list.body.pagination.total).toBe(1);
  expect(query).toHaveBeenCalledTimes(2);
});

it('lists multiple books with two SQL queries and no per-book queries', async () => {
  await createCatalog();
  query.mockClear();
  const response = await request(app).get('/api/books');
  expect(response.body.data.map((book) => book.availableCopies)).toEqual([5, 5, 5]);
  expect(query).toHaveBeenCalledTimes(2);
});

it('hides unexpected PostgreSQL errors', async () => {
  query.mockRejectedValueOnce(Object.assign(new Error('private SQL and connection details'), { code: 'XX000' }));
  const response = await request(app).post('/api/books').send(validBook);
  expect(response.status).toBe(500);
  expect(response.body).toEqual({ error: { code: 'INTERNAL_SERVER_ERROR', message: 'Внутренняя ошибка сервера', details: [] } });
});

async function createLoanFixtures(bookId, statuses) {
  const reader = (await pool.query(`
    INSERT INTO readers (full_name, email, registration_number)
    VALUES ('Test reader', $1, $2) RETURNING id
  `, [`${randomUUID()}@example.com`, randomUUID()])).rows[0];
  for (const status of statuses) {
    await pool.query(`
      INSERT INTO loans (book_id, reader_id, due_date, status, returned_at)
      VALUES ($1, $2, CURRENT_DATE + 14, $3, CASE WHEN $3 = 'returned' THEN NOW() ELSE NULL END)
    `, [bookId, reader.id, status]);
  }
  return reader.id;
}

it('PATCH changes the title and updatedAt while preserving every omitted field', async () => {
  const book = await createBook();
  await pool.query("UPDATE books SET updated_at = '2000-01-01T00:00:00Z' WHERE id = $1", [book.id]);
  const response = await request(app).patch(`/api/books/${book.id}`).send({ title: ' Новое   название ' });
  expect(response.status).toBe(200);
  expect(response.body).toEqual({ ...book, title: 'Новое название', updatedAt: expect.any(String) });
  expect(Date.parse(response.body.updatedAt)).toBeGreaterThan(Date.parse('2000-01-01T00:00:00Z'));
  expect(response.body.totalCopies).toBe(5);
  expect(pool.idleCount).toBe(pool.totalCount);
});

it('PATCH changes multiple fields, normalizes ISBN and recalculates availableCopies', async () => {
  const book = await createBook();
  const response = await request(app).patch(`/api/books/${book.id}`).send({
    title: 'Изменённая книга', authors: [' Другой   автор '], isbn: '0-8044-2957-x',
    publicationYear: 2020, genre: ' Наука ', totalCopies: 8,
  });
  expect(response.status).toBe(200);
  expect(response.body).toMatchObject({
    id: book.id, title: 'Изменённая книга', authors: ['Другой автор'], isbn: '080442957X',
    publicationYear: 2020, genre: 'Наука', totalCopies: 8, availableCopies: 8, createdAt: book.createdAt,
  });
  expect((await request(app).get(`/api/books/${book.id}`)).body).toEqual(response.body);
});

it('PATCH allows clearing only the nullable optional fields', async () => {
  const book = await createBook();
  const response = await request(app).patch(`/api/books/${book.id}`).send({ publicationYear: null, genre: null });
  expect(response.status).toBe(200);
  expect(response.body).toEqual({ ...book, publicationYear: null, genre: null, updatedAt: expect.any(String) });
  expect((await pool.query('SELECT publication_year, genre FROM books WHERE id = $1', [book.id])).rows[0])
    .toEqual({ publication_year: null, genre: null });
});

it('PATCH accepts the same ISBN with different separators', async () => {
  const book = await createBook();
  const response = await request(app).patch(`/api/books/${book.id}`).send({ isbn: '978-0-13 235088-4' });
  expect(response.status).toBe(200);
  expect(response.body.isbn).toBe(book.isbn);
});

it('PATCH rolls back all fields and updatedAt on an ISBN conflict', async () => {
  const book = await createBook();
  await createBook({ isbn: '9780306406157' });
  const response = await request(app).patch(`/api/books/${book.id}`).send({ title: 'Не сохранять', isbn: '978-0-306-40615-7' });
  expect(response.status).toBe(409);
  expect(response.body.error.code).toBe('BOOK_ALREADY_EXISTS');
  expect((await request(app).get(`/api/books/${book.id}`)).body).toEqual(book);
  expect(pool.idleCount).toBe(pool.totalCount);
});

it.each([
  {}, { title: '' }, { title: null }, { title: 5 },
  { authors: [] }, { authors: [' '] }, { authors: 'Автор' }, { authors: null },
  { isbn: 'invalid' }, { isbn: null }, { isbn: '9780132350885' },
  { publicationYear: '2008' }, { publicationYear: 0 }, { publicationYear: new Date().getUTCFullYear() + 2 },
  { genre: 5 }, { totalCopies: -1 }, { totalCopies: 1.5 }, { totalCopies: '5' }, { totalCopies: null },
  { id: 2 }, { createdAt: '2000-01-01' }, { updatedAt: '2000-01-01' }, { availableCopies: 99 },
])('PATCH rejects invalid fields %j without changing the book', async (data) => {
  const book = await createBook();
  const response = await request(app).patch(`/api/books/${book.id}`).send(data);
  expect(response.status).toBe(400);
  expect(response.body.error.code).toBe('VALIDATION_ERROR');
  expect((await request(app).get(`/api/books/${book.id}`)).body).toEqual(book);
});

it('PATCH returns BOOK_NOT_FOUND and releases its connection for a missing book', async () => {
  const response = await request(app).patch('/api/books/999999').send({ title: 'Книга' });
  expect(response.status).toBe(404);
  expect(response.body.error.code).toBe('BOOK_NOT_FOUND');
  expect(pool.idleCount).toBe(pool.totalCount);
});

it.each(['patch', 'delete'])('%s validates the book ID', async (method) => {
  for (const id of ['0', '-1', 'wrong', '1.5']) {
    const response = await request(app)[method](`/api/books/${id}`).send({ title: 'Книга' });
    expect(response.status).toBe(400);
    expect(response.body.error.details[0].path).toBe('id');
  }
});

it('PATCH allows reducing copies to the number of unreturned loans and increasing them', async () => {
  const book = await createBook();
  await createLoanFixtures(book.id, ['active', 'active', 'overdue', 'returned']);
  const equal = await request(app).patch(`/api/books/${book.id}`).send({ totalCopies: 3 });
  expect(equal.status).toBe(200);
  expect(equal.body).toMatchObject({ totalCopies: 3, availableCopies: 0 });
  const increased = await request(app).patch(`/api/books/${book.id}`).send({ totalCopies: 10 });
  expect(increased.status).toBe(200);
  expect(increased.body).toMatchObject({ totalCopies: 10, availableCopies: 7 });
});

it('PATCH rejects copies below active and overdue loans without persisting any changes', async () => {
  const book = await createBook();
  await createLoanFixtures(book.id, ['active', 'active', 'overdue', 'returned']);
  const before = (await request(app).get(`/api/books/${book.id}`)).body;
  const response = await request(app).patch(`/api/books/${book.id}`).send({ title: 'Не сохранять', totalCopies: 2 });
  expect(response.status).toBe(409);
  expect(response.body).toEqual({ error: {
    code: 'INSUFFICIENT_TOTAL_COPIES',
    message: 'Количество экземпляров не может быть меньше числа невозвращённых выдач', details: [],
  } });
  expect((await request(app).get(`/api/books/${book.id}`)).body).toEqual(before);
  expect(pool.idleCount).toBe(pool.totalCount);
});

it('PATCH rolls back even an error after UPDATE and releases the transaction client', async () => {
  const book = await createBook();
  let querySpy;
  connect.mockImplementationOnce(async () => {
    const client = await pool.connect();
    const original = client.query.bind(client);
    querySpy = vi.spyOn(client, 'query').mockImplementation((sql, ...args) =>
      /SELECT b\.\*/.test(sql) ? original('SELECT * FROM forced_missing_table') : original(sql, ...args));
    return client;
  });
  try {
    const response = await request(app).patch(`/api/books/${book.id}`).send({ title: 'Не сохранять', totalCopies: 9 });
    expect(response.status).toBe(500);
    expect(response.body.error.code).toBe('INTERNAL_SERVER_ERROR');
  } finally {
    querySpy?.mockRestore();
  }
  expect((await request(app).get(`/api/books/${book.id}`)).body).toEqual(book);
  expect(pool.idleCount).toBe(pool.totalCount);
});

it('PATCH waits for the book lock and sees a loan committed while waiting', async () => {
  const book = await createBook({ totalCopies: 1 });
  const readerId = await createLoanFixtures(book.id, []);
  const blocker = await pool.connect();
  await blocker.query('BEGIN');
  await blocker.query('SELECT id FROM books WHERE id = $1 FOR UPDATE', [book.id]);
  const lockReached = Promise.withResolvers();
  let querySpy;
  let timer;
  connect.mockImplementationOnce(async () => {
    const client = await pool.connect();
    const original = client.query.bind(client);
    querySpy = vi.spyOn(client, 'query').mockImplementation((sql, ...args) => {
      if (sql.includes('FOR UPDATE')) lockReached.resolve();
      return original(sql, ...args);
    });
    return client;
  });
  const pending = request(app).patch(`/api/books/${book.id}`).send({ totalCopies: 0 }).then((response) => response);
  try {
    await Promise.race([
      lockReached.promise,
      new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error('No SELECT FOR UPDATE')), 2000); }),
    ]);
    await blocker.query('INSERT INTO loans (book_id, reader_id, due_date) VALUES ($1, $2, CURRENT_DATE + 14)', [book.id, readerId]);
    await blocker.query('COMMIT');
    const response = await pending;
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('INSUFFICIENT_TOTAL_COPIES');
    expect((await pool.query('SELECT total_copies FROM books WHERE id = $1', [book.id])).rows[0].total_copies).toBe(1);
  } finally {
    clearTimeout(timer);
    await blocker.query('ROLLBACK');
    blocker.release();
    await pending;
    querySpy?.mockRestore();
  }
});

it('DELETE removes an unused book with HTTP 204 and an empty body', async () => {
  const book = await createBook();
  const response = await request(app).delete(`/api/books/${book.id}`);
  expect(response.status).toBe(204);
  expect(response.text).toBe('');
  expect((await request(app).get(`/api/books/${book.id}`)).status).toBe(404);
});

it('DELETE returns BOOK_NOT_FOUND for an absent book', async () => {
  const response = await request(app).delete('/api/books/999999');
  expect(response.status).toBe(404);
  expect(response.body.error.code).toBe('BOOK_NOT_FOUND');
});

it.each(['active', 'overdue', 'returned'])('DELETE preserves a book and its %s loan history', async (status) => {
  const book = await createBook();
  await createLoanFixtures(book.id, [status]);
  const response = await request(app).delete(`/api/books/${book.id}`);
  expect(response.status).toBe(409);
  expect(response.body).toEqual({ error: { code: 'BOOK_HAS_LOANS', message: 'Невозможно удалить книгу, имеющую историю выдач', details: [] } });
  expect((await request(app).get(`/api/books/${book.id}`)).status).toBe(200);
  expect((await pool.query('SELECT count(*) FROM loans WHERE book_id = $1', [book.id])).rows[0].count).toBe('1');
});

it('DELETE translates a real FK violation when a loan appears after the history check', async () => {
  const book = await createBook();
  const readerId = await createLoanFixtures(book.id, []);
  let inserted = false;
  query.mockImplementation(async (sql, values) => {
    if (/^DELETE FROM books/.test(sql)) {
      await pool.query('INSERT INTO loans (book_id, reader_id, due_date) VALUES ($1, $2, CURRENT_DATE + 14)', [book.id, readerId]);
      inserted = true;
    }
    return pool.query(sql, values);
  });
  const response = await request(app).delete(`/api/books/${book.id}`);
  expect(inserted).toBe(true);
  expect(response.status).toBe(409);
  expect(response.body.error.code).toBe('BOOK_HAS_LOANS');
  expect((await pool.query('SELECT count(*) FROM books WHERE id = $1', [book.id])).rows[0].count).toBe('1');
  expect((await pool.query('SELECT count(*) FROM loans WHERE book_id = $1', [book.id])).rows[0].count).toBe('1');
});
