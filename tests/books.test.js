import { randomUUID } from 'node:crypto';
import pg from 'pg';
import request from 'supertest';
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
import app from '../src/app.js';
import { runMigrations } from '../src/db/migrate.js';

const { query } = vi.hoisted(() => ({ query: vi.fn() }));
// Подменяется только соединение: маршруты, сервисы и SQL работают по-настоящему.
vi.mock('../src/db/pool.js', () => ({
  pool: { query },
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
