import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import pg from 'pg';
import request from 'supertest';
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
import { runMigrations } from '../src/db/migrate.js';

const testUrl = process.env.TEST_DATABASE_URL;
if (!testUrl || !decodeURIComponent(new URL(testUrl).pathname).endsWith('_test')) {
  throw new Error('Set TEST_DATABASE_URL to a separate database ending in _test');
}
const admin = new pg.Pool({ connectionString: testUrl });
const tempRoot = resolve(tmpdir());
let app;
let pool;
let schema;
let directory;
let uploads;

beforeEach(async () => {
  pool = undefined;
  directory = undefined;
  uploads = undefined;
  schema = `integration_test_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  directory = await mkdtemp(join(tempRoot, 'web-maga-integration-'));
  uploads = join(directory, 'uploads');
  await mkdir(uploads);

  // Приложение использует собственный реальный pg.Pool, но только в нашей схеме.
  const isolatedUrl = new URL(testUrl);
  isolatedUrl.searchParams.set('options', `-c search_path=${schema} -c timezone=UTC`);
  vi.stubEnv('DATABASE_URL', isolatedUrl.href);
  vi.stubEnv('FINE_PER_DAY', '10');
  vi.stubEnv('CRON_SCHEDULE', 'invalid-test-schedule');
  for (const name of ['TMPDIR', 'TEMP', 'TMP']) vi.stubEnv(name, uploads);
  vi.resetModules();
  ({ default: app } = await import('../src/app.js'));
  ({ pool } = await import('../src/db/pool.js'));
  await runMigrations(pool);
});

afterEach(async () => {
  try {
    await pool?.end();
  } finally {
    try {
      if (!/^integration_test_[a-f0-9]{32}$/.test(schema)) throw new Error('Unsafe test schema');
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    } finally {
      vi.unstubAllEnvs();
      if (directory) {
        if (!resolve(directory).startsWith(join(tempRoot, 'web-maga-integration-'))) {
          throw new Error('Unsafe fixture path');
        }
        try {
          if (uploads) expect(await readdir(uploads)).toEqual([]);
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
      }
    }
  }
});

afterAll(async () => { await admin.end(); });

const bookData = { title: 'Чистый код', authors: ['Роберт Мартин'], isbn: '9780132350884', totalCopies: 1 };
const readerData = { fullName: 'Иван Иванов', email: 'reader@example.com', registrationNumber: 'TEST-001' };
const header = 'title,authors,isbn,publicationYear,genre,totalCopies\n';

it('seeds demo books and a reader twice without duplicates or overwritten data', async () => {
  const script = fileURLToPath(new URL('../src/db/run-seed.js', import.meta.url));
  const run = () => promisify(execFile)(process.execPath, [script], { env: { ...process.env }, timeout: 5000 });
  await run();
  const books = (await request(app).get('/api/books').expect(200)).body.data;
  const readers = (await request(app).get('/api/readers').expect(200)).body.data;
  expect(books.map((book) => book.isbn).sort()).toEqual(['9780132350884', '9780735619678']);
  expect(readers).toMatchObject([{ registrationNumber: 'DEMO-001', status: 'active' }]);
  await run();
  expect((await request(app).get('/api/books').expect(200)).body.data).toEqual(books);
  expect((await request(app).get('/api/readers').expect(200)).body.data).toEqual(readers);
}, 15000);

async function createBook(data = {}) {
  return (await request(app).post('/api/books').send({ ...bookData, ...data }).expect(201)).body;
}

async function createReader() {
  return (await request(app).post('/api/readers').send(readerData).expect(201)).body;
}

async function issue(book, reader) {
  return (await request(app).post('/api/loans').send({ bookId: book.id, readerId: reader.id }).expect(201)).body;
}

async function history(query = {}) {
  return (await request(app).get('/api/loans').query(query).expect(200)).body;
}

async function topBooks(loan) {
  const date = loan.loanedAt.slice(0, 10);
  return (await request(app).get('/api/stats/top-books').query({ from: date, to: date }).expect(200)).body.data;
}

async function csvFile(chunks) {
  const path = join(directory, `${randomUUID()}.csv`);
  await pipeline(Readable.from(chunks), createWriteStream(path));
  return path;
}

function upload(path) {
  return request(app).post('/api/books/import').attach('file', createReadStream(path));
}

it('completes a book-reader-loan-return journey and preserves history and statistics', async () => {
  await request(app).get('/api/health').expect(200, { status: 'ok', database: 'connected' });
  const book = await createBook();
  const reader = await createReader();
  const loan = await issue(book, reader);
  expect((await request(app).get(`/api/books/${book.id}`).expect(200)).body.availableCopies).toBe(0);
  expect((await request(app).get(`/api/loans/${loan.id}`).expect(200)).body).toEqual(loan);
  expect((await history({ readerId: reader.id, bookId: book.id, status: 'active' })).data).toEqual([loan]);

  const returned = (await request(app).post(`/api/loans/${loan.id}/return`).expect(200)).body;
  expect(returned).toEqual({ ...loan, returnedAt: expect.any(String), status: 'returned', fineAmount: '0.00' });
  expect((await request(app).get(`/api/books/${book.id}`).expect(200)).body).toMatchObject({ totalCopies: 1, availableCopies: 1 });
  expect((await history({ readerId: reader.id, status: 'returned' })).data).toEqual([returned]);
  expect((await history({ status: 'active' })).data).toEqual([]);
  expect(await topBooks(loan)).toEqual([{
    bookId: book.id, title: book.title, authors: book.authors, isbn: book.isbn, loansCount: 1,
  }]);
  expect((await request(app).get('/api/stats/overdue-readers').expect(200)).body.data).toEqual([]);
  expect((await request(app).delete(`/api/books/${book.id}`).expect(409)).body.error.code).toBe('BOOK_HAS_LOANS');
  expect((await request(app).get(`/api/loans/${loan.id}`).expect(200)).body).toEqual(returned);
});

it('finds overdue active loans before cron, marks them once and returns them for a blocked reader', async () => {
  const book = await createBook();
  const reader = await createReader();
  const loan = await issue(book, reader);
  // Только подготовка даты в изолированной тестовой схеме; расчёт выполняет API.
  await pool.query("UPDATE loans SET due_date = (clock_timestamp() AT TIME ZONE 'UTC')::date - 2 WHERE id = $1", [loan.id]);
  await request(app).patch(`/api/readers/${reader.id}`).send({ status: 'blocked' }).expect(200);
  const overdue = (await request(app).get('/api/stats/overdue-readers').expect(200)).body;
  expect(overdue.data).toMatchObject([{ readerId: reader.id, status: 'blocked', overdueLoansCount: 1, maxDaysOverdue: 2 }]);
  expect((await history({ status: 'active' })).data[0].id).toBe(loan.id);

  const { checkOverdueLoans } = await import('../src/services/loans.service.js');
  expect(await checkOverdueLoans()).toBe(1);
  expect(await checkOverdueLoans()).toBe(0);
  expect((await history({ status: 'overdue' })).data[0].id).toBe(loan.id);
  const returned = (await request(app).post(`/api/loans/${loan.id}/return`).expect(200)).body;
  expect(returned).toMatchObject({ status: 'returned', fineAmount: '20.00' });
  expect((await request(app).get('/api/stats/overdue-readers').expect(200)).body.pagination.total).toBe(0);
  const blocked = await request(app).post('/api/loans').send({ bookId: book.id, readerId: reader.id }).expect(409);
  expect(blocked.body.error.code).toBe('READER_BLOCKED');
  await request(app).patch(`/api/readers/${reader.id}`).send({ status: 'active' }).expect(200);
  const nextLoan = await issue(book, reader);
  expect((await history({ readerId: reader.id, page: 1, limit: 1 })).data).toEqual([returned]);
  expect((await history({ readerId: reader.id, page: 2, limit: 1 })).data).toEqual([nextLoan]);
  expect((await topBooks(nextLoan))[0].loansCount).toBe(2);
});

it('updates and deletes an unused book, then allows its ISBN to be registered again', async () => {
  const book = await createBook();
  const changed = await request(app).patch(`/api/books/${book.id}`).send({ title: 'Новое название', totalCopies: 0 }).expect(200);
  expect(changed.body).toMatchObject({ id: book.id, title: 'Новое название', totalCopies: 0, availableCopies: 0 });
  await request(app).delete(`/api/books/${book.id}`).expect(204, '');
  await request(app).get(`/api/books/${book.id}`).expect(404);
  await request(app).patch(`/api/books/${book.id}`).send({ title: 'Не сохранять' }).expect(404);
  await request(app).delete(`/api/books/${book.id}`).expect(404);
  const replacement = await createBook();
  expect(replacement.id).not.toBe(book.id);
  expect((await request(app).get('/api/books').expect(200)).body.data).toEqual([replacement]);
  expect((await history()).data).toEqual([]);
});

it('keeps the catalog and history consistent after invalid, missing and conflicting operations', async () => {
  const book = await createBook();
  const reader = await createReader();
  await request(app).post('/api/books').send(bookData).expect(409);
  await request(app).post('/api/readers').send(readerData).expect(409);
  await request(app).post('/api/loans').send({ bookId: '1', readerId: reader.id }).expect(400);
  await request(app).post('/api/loans').send({ bookId: book.id + 100, readerId: reader.id }).expect(404);
  await request(app).post('/api/loans').send({ bookId: book.id, readerId: reader.id + 100 }).expect(404);
  await request(app).patch(`/api/readers/${reader.id}`).send({ status: 'unknown' }).expect(400);
  expect((await history()).pagination.total).toBe(0);

  await request(app).patch(`/api/readers/${reader.id}`).send({ fullName: 'Новое ФИО' }).expect(200);
  expect((await request(app).get('/api/readers').query({ search: 'Новое ФИО' }).expect(200)).body.data).toMatchObject([{ id: reader.id }]);
  const loan = await issue(book, reader);
  expect((await request(app).post('/api/loans').send({ bookId: book.id, readerId: reader.id }).expect(409)).body.error.code).toBe('BOOK_UNAVAILABLE');
  await request(app).patch(`/api/books/${book.id}`).send({ totalCopies: 0 }).expect(409);
  await request(app).post(`/api/loans/${loan.id}/return`).send({ fineAmount: '0.00' }).expect(400);
  expect((await request(app).get(`/api/loans/${loan.id}`).expect(200)).body).toEqual(loan);
  const returned = (await request(app).post(`/api/loans/${loan.id}/return`).expect(200)).body;
  await request(app).post(`/api/loans/${loan.id}/return`).expect(409);
  await request(app).post(`/api/loans/${loan.id + 100}/return`).expect(404);
  expect((await history()).data).toEqual([returned]);
  expect((await topBooks(loan))[0].loansCount).toBe(1);
  expect((await request(app).get(`/api/books/${book.id}`).expect(200)).body.availableCopies).toBe(1);
});

it('imports a file, loans its book and retains the changed book after a duplicate import', async () => {
  const path = await csvFile([header, 'Чистый код,Роберт Мартин,9780132350884,2008,Программирование,1\n']);
  expect((await upload(path).expect(200)).body).toEqual({ processed: 1, imported: 1, duplicates: 0, invalid: 0, errors: [] });
  const book = (await request(app).get('/api/books').expect(200)).body.data[0];
  await request(app).patch(`/api/books/${book.id}`).send({ title: 'Моё название' }).expect(200);
  const reader = await createReader();
  const loan = await issue(book, reader);
  expect((await upload(path).expect(200)).body).toMatchObject({ imported: 0, duplicates: 1 });
  expect((await request(app).get(`/api/books/${book.id}`).expect(200)).body).toMatchObject({ title: 'Моё название', totalCopies: 1, availableCopies: 0 });
  await request(app).post(`/api/loans/${loan.id}/return`).expect(200);
  expect((await topBooks(loan))[0]).toMatchObject({ bookId: book.id, title: 'Моё название', loansCount: 1 });
});

it('streams five thousand CSV records and preserves exact counters and paginated totals', async () => {
  const path = await csvFile((function* () {
    yield header;
    for (let index = 0; index < 5000; index++) {
      const digits = `978${100000000 + index}`;
      const sum = [...digits].reduce((total, digit, position) => total + Number(digit) * (position % 2 ? 3 : 1), 0);
      const isbn = digits + (10 - sum % 10) % 10;
      yield `Книга ${index},Автор,${isbn},2020,Тест,1\n`;
    }
  })());
  expect((await upload(path).expect(200)).body).toEqual({ processed: 5000, imported: 5000, duplicates: 0, invalid: 0, errors: [] });
  const lastPage = (await request(app).get('/api/books?page=50&limit=100').expect(200)).body;
  expect(lastPage.pagination).toEqual({ page: 50, limit: 100, total: 5000, totalPages: 50 });
  expect(lastPage.data).toHaveLength(100);
  expect(lastPage.data[99].title).toBe('Книга 4999');
  expect((await history()).data).toEqual([]);
}, 30000);

it('rejects extra files, form fields and truncated uploads without inserting books or leaving temporary files', async () => {
  const path = await csvFile([header, 'Чистый код,Роберт Мартин,9780132350884,,,1\n']);
  await request(app).post('/api/books/import').attach('file', createReadStream(path)).attach('file', createReadStream(path)).expect(400);
  await request(app).post('/api/books/import').field('extra', 'value').attach('file', createReadStream(path)).expect(400);
  await request(app).post('/api/books/import')
    .set('Content-Type', 'multipart/form-data; boundary=truncated')
    .send(`--truncated\r\nContent-Disposition: form-data; name="file"; filename="books.csv"\r\nContent-Type: text/csv\r\n\r\n${header}unfinished`)
    .expect(400);
  expect((await request(app).get('/api/books').expect(200)).body.pagination.total).toBe(0);
});

it('accepts exactly ten MiB but rejects one additional byte before any inserts', async () => {
  const path = await csvFile((function* () {
    yield header;
    let remaining = 10 * 1024 * 1024 - Buffer.byteLength(header);
    while (remaining > 0) {
      const size = Math.min(remaining, 64 * 1024);
      yield ' '.repeat(size);
      remaining -= size;
    }
  })());
  expect((await upload(path).expect(200)).body).toEqual({ processed: 0, imported: 0, duplicates: 0, invalid: 0, errors: [] });
  await pipeline(Readable.from([' ']), createWriteStream(path, { flags: 'a' }));
  expect((await upload(path).expect(413)).body.error.code).toBe('CSV_TOO_LARGE');
  expect((await request(app).get('/api/books').expect(200)).body.pagination.total).toBe(0);
}, 20000);
