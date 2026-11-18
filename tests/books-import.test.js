import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import pg from 'pg';
import request from 'supertest';
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
import app from '../src/app.js';
import { runMigrations } from '../src/db/migrate.js';

const { query, connect } = vi.hoisted(() => ({ query: vi.fn(), connect: vi.fn() }));
// Меняется только подключение: multipart, CSV, валидация и SQL настоящие.
vi.mock('../src/db/pool.js', () => ({
  pool: { query, connect }, checkDatabaseConnection: () => query('SELECT 1'),
}));

const testUrl = process.env.TEST_DATABASE_URL;
if (!testUrl || !decodeURIComponent(new URL(testUrl).pathname).endsWith('_test')) {
  throw new Error('Set TEST_DATABASE_URL to a separate database ending in _test');
}
const admin = new pg.Pool({ connectionString: testUrl });
let pool;
let schema;
let directory;

beforeEach(async () => {
  schema = `import_test_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  pool = new pg.Pool({ connectionString: testUrl, options: `-c search_path=${schema}` });
  await runMigrations(pool);
  query.mockImplementation((...args) => pool.query(...args));
  connect.mockImplementation(() => pool.connect());
  directory = await mkdtemp(join(tmpdir(), 'web-maga-import-test-'));
});

afterEach(async () => {
  await pool?.end();
  await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  if (!resolve(directory).startsWith(join(resolve(tmpdir()), 'web-maga-import-test-'))) {
    throw new Error('Unsafe fixture path');
  }
  await rm(directory, { recursive: true, force: true });
});

afterAll(async () => { await admin.end(); });

const header = 'title,authors,isbn,publicationYear,genre,totalCopies';
const first = 'Чистый код,Роберт Мартин,9780132350884,2008,Программирование,5';
const second = 'Совершенный код,Стив Макконнелл,9780735619678,2004,Программирование,3';

async function upload(csv, { filename = 'books.csv', field = 'file', chunkSize = 64 * 1024 } = {}) {
  const path = join(directory, randomUUID());
  await writeFile(path, csv, 'utf8');
  return request(app).post('/api/books/import')
    .attach(field, createReadStream(path, { highWaterMark: chunkSize }), { filename });
}

async function catalog() {
  return (await request(app).get('/api/books?limit=100').expect(200)).body.data;
}

it('imports books from a real multipart file stream and exposes them through the books API', async () => {
  const response = await upload(`${header}\n${first}\n${second}\n`);
  expect(response.status).toBe(200);
  expect(response.body).toEqual({ processed: 2, imported: 2, duplicates: 0, invalid: 0, errors: [] });
  expect(await catalog()).toMatchObject([
    { title: 'Чистый код', authors: ['Роберт Мартин'], isbn: '9780132350884', publicationYear: 2008, genre: 'Программирование', totalCopies: 5, availableCopies: 5 },
    { title: 'Совершенный код', authors: ['Стив Макконнелл'], isbn: '9780735619678', totalCopies: 3 },
  ]);
});

it('skips existing, repeated and concurrent normalized ISBNs without changing existing books', async () => {
  await upload(`${header}\n${first}`).then((response) => expect(response.status).toBe(200));
  const original = await catalog();
  const response = await upload(`${header}\nChanged,Other,978-0-13-235088-4,2020,Other,99\n${second}\n${second}`);
  expect(response.status).toBe(200);
  expect(response.body).toEqual({ processed: 3, imported: 1, duplicates: 2, invalid: 0, errors: [] });
  expect((await catalog())[0]).toEqual(original[0]);
  const concurrentCsv = `${header}\nThird,Author,080442957X,,,1`;
  const responses = await Promise.all([upload(concurrentCsv), upload(concurrentCsv)]);
  expect(responses.map((item) => item.status)).toEqual([200, 200]);
  expect(responses.map((item) => item.body.imported).sort()).toEqual([0, 1]);
  expect(responses.map((item) => item.body.duplicates).sort()).toEqual([0, 1]);
  expect(await catalog()).toHaveLength(3);
});

it('skips invalid ISBNs, authors, years and copy counts and continues importing valid records', async () => {
  const response = await upload([
    header, first,
    'Broken,Author,bad,,,1',
    'No author,,9780132350884,,,1',
    'Negative,Author,9780132350884,,,-1',
    'Wrong year,Author,9780132350884,10000,,1',
    'Wrong copies,Author,9780132350884,,,text',
    'Wrong columns,Author',
    second,
  ].join('\n'));
  expect(response.status).toBe(200);
  expect(response.body).toMatchObject({ processed: 8, imported: 2, duplicates: 0, invalid: 6 });
  expect(response.body.errors.map((error) => error.row)).toEqual([3, 4, 5, 6, 7, 8]);
  expect(response.body.errors[0].message).toContain('ISBN');
  expect(await catalog()).toHaveLength(2);
});

it('supports reordered columns, BOM, CRLF, quoted newlines and multiple authors across one-byte chunks', async () => {
  const csv = '\uFEFF\r\n'
    + 'isbn,title,authors,totalCopies,genre,publicationYear\r\n'
    + '9780262046305," Алгоритмы, ""введение""\r\nв курс "," Томас Кормен | Чарльз Лейзерсон ",,,\r\n'
    + '   \r\n'
    + 'bad,Invalid,Author,1,,\r\n';
  const response = await upload(csv, { chunkSize: 1, filename: 'каталог.CSV' });
  expect(response.status).toBe(200);
  expect(response.body).toMatchObject({ processed: 2, imported: 1, duplicates: 0, invalid: 1 });
  expect(response.body.errors).toEqual([{ row: 6, message: expect.stringContaining('ISBN') }]);
  expect(await catalog()).toMatchObject([{
    title: 'Алгоритмы, "введение" в курс', authors: ['Томас Кормен', 'Чарльз Лейзерсон'],
    isbn: '9780262046305', publicationYear: null, genre: null, totalCopies: 0,
  }]);
});

it('rejects missing files, invalid headers, malformed CSV and oversized uploads without hiding partial imports', async () => {
  await request(app).post('/api/books/import').expect(400);
  for (const csv of ['', 'title,authors,isbn\nBook,Author,9780132350884',
    'title,authors,isbn,publicationYear,genre,title\nBook,Author,9780132350884,,,1']) {
    expect((await upload(csv)).status).toBe(400);
  }
  expect((await upload(`${header}\n${first}`, { filename: 'books.txt' })).status).toBe(400);
  expect((await upload(`${header}\n${first}`, { field: 'other' })).status).toBe(400);
  expect(await catalog()).toHaveLength(0);
  const oversized = await upload(`${header}\n${'x'.repeat(10 * 1024 * 1024)}`);
  expect(oversized.status).toBe(413);
  expect(oversized.body.error.code).toBe('CSV_TOO_LARGE');
  expect(await catalog()).toHaveLength(0);
  // Много небольших записей позволяют записать книги до ошибки в следующем блоке файла.
  const malformed = await upload(`${header}\n${`${first}\n`.repeat(400)}"unfinished`);
  expect(malformed.status).toBe(400);
  expect(malformed.body.error.code).toBe('CSV_INVALID');
  expect(malformed.body.error.message).toContain('сохранены');
  expect(malformed.body.error.details[0].imported).toBe(1);
  expect(await catalog()).toHaveLength(1);
  const brokenForm = await request(app).post('/api/books/import')
    .set('Content-Type', 'multipart/form-data; boundary=broken').send('--broken\r\n');
  expect(brokenForm.status).toBe(400);
});

it('counts every data record, ignores blank lines and caps validation details at the first twenty errors', async () => {
  const empty = await upload(`${header}\n\n`);
  expect(empty.status).toBe(200);
  expect(empty.body).toEqual({ processed: 0, imported: 0, duplicates: 0, invalid: 0, errors: [] });
  const response = await upload([
    header, '', first, first,
    ...Array(25).fill('Broken,Author,bad,,,1'),
    '""', '', second,
  ].join('\n'));
  expect(response.status).toBe(200);
  expect(response.body).toMatchObject({ processed: 29, imported: 2, duplicates: 1, invalid: 26 });
  expect(response.body.errors).toHaveLength(20);
  expect(response.body.errors[0]).toEqual({ row: 5, message: expect.stringContaining('ISBN') });
  expect(response.body.errors[19].row).toBe(24);
  expect(await catalog()).toHaveLength(2);
});
