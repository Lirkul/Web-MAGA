import { randomInt, randomUUID } from 'node:crypto';
import pg from 'pg';
import request from 'supertest';
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
import app from '../src/app.js';
import { runMigrations } from '../src/db/migrate.js';

const { query } = vi.hoisted(() => ({ query: vi.fn() }));
// Подменяется только подключение: SQL выполняется в отдельной тестовой PostgreSQL.
vi.mock('../src/db/pool.js', () => ({ pool: { query }, checkDatabaseConnection: () => query('SELECT 1') }));

const testUrl = process.env.TEST_DATABASE_URL;
if (!testUrl || !decodeURIComponent(new URL(testUrl).pathname).endsWith('_test')) {
  throw new Error('Set TEST_DATABASE_URL to a separate database ending in _test');
}
const admin = new pg.Pool({ connectionString: testUrl });
let pool;
let schema;
let today;

beforeEach(async () => {
  schema = `stats_test_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  pool = new pg.Pool({
    connectionString: testUrl, options: `-c search_path=${schema} -c timezone=Pacific/Kiritimati`,
  });
  await runMigrations(pool);
  today = (await pool.query("SELECT to_char((CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD') AS today")).rows[0].today;
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

async function createBook(title = 'Book') {
  const digits = `978${String(randomInt(0, 1000000000)).padStart(9, '0')}`;
  const sum = [...digits].reduce((sum, digit, i) => sum + Number(digit) * (i % 2 ? 3 : 1), 0);
  const isbn = digits + (10 - sum % 10) % 10;
  const { rows } = await pool.query(`
    INSERT INTO books (title, authors, isbn, total_copies)
    VALUES ($1, ARRAY['Author'], $2, 100) RETURNING *
  `, [title, isbn]);
  return rows[0];
}

async function createReader(status = 'active') {
  const token = randomUUID();
  const { rows } = await pool.query(`
    INSERT INTO readers (full_name, email, registration_number, status)
    VALUES ($1, $2, $3, $4) RETURNING *
  `, [`Reader ${token}`, `${token}@example.com`, token, status]);
  return rows[0];
}

async function createLoan(book, reader, {
  loanedAt = '2026-01-15T12:00:00Z', dueOffset = 14, status = 'active', returned = false,
} = {}) {
  await pool.query(`
    INSERT INTO loans (book_id, reader_id, loaned_at, due_date, status, returned_at)
    VALUES ($1, $2, $3::timestamptz, $4::date + $5::integer, $6,
      CASE WHEN $7 THEN CURRENT_TIMESTAMP ELSE NULL END)
  `, [book.id, reader.id, loanedAt, today, dueOffset, status, returned]);
}

function topBook(book, loansCount) {
  return { bookId: Number(book.id), title: book.title, authors: book.authors, isbn: book.isbn, loansCount };
}

function overdueReader(reader, overdueLoansCount, maxDaysOverdue) {
  const date = new Date(`${today}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - maxDaysOverdue);
  return {
    readerId: Number(reader.id), fullName: reader.full_name, email: reader.email,
    registrationNumber: reader.registration_number, status: reader.status,
    overdueLoansCount, oldestDueDate: date.toISOString().slice(0, 10), maxDaysOverdue,
  };
}

const period = { from: '2026-01-01', to: '2026-01-31' };

it('returns at most five books ordered by all loan counts then book id, including repeated and returned loans', async () => {
  const reader = await createReader();
  const books = [];
  const counts = [4, 4, 6, 3, 2, 1, 1, 0];
  for (let i = 0; i < counts.length; i++) {
    const book = await createBook(i === 0 ? 'Z title' : `A title ${i}`);
    books.push(book);
    for (let j = 0; j < counts[i]; j++) {
      await createLoan(book, reader, { returned: j % 2 === 0, status: j % 2 === 0 ? 'returned' : 'active' });
    }
  }
  const response = await request(app).get('/api/stats/top-books').query(period).expect(200);
  expect(response.body).toEqual({
    period, data: [topBook(books[2], 6), topBook(books[0], 4), topBook(books[1], 4), topBook(books[3], 3), topBook(books[4], 2)],
  });
});

it('uses inclusive UTC calendar bounds including the final microsecond, and supports an empty period', async () => {
  const reader = await createReader();
  const included = await createBook();
  const excluded = await createBook();
  for (const loanedAt of ['2026-02-01T00:00:00Z', '2026-02-28T23:59:59.999999Z', '2026-03-01T13:59:59.999999+14:00']) {
    await createLoan(included, reader, { loanedAt });
  }
  for (const loanedAt of ['2026-01-31T23:59:59.999999Z', '2026-03-01T00:00:00Z']) {
    await createLoan(excluded, reader, { loanedAt });
  }
  const february = { from: '2026-02-01', to: '2026-02-28' };
  expect((await request(app).get('/api/stats/top-books').query(february).expect(200)).body)
    .toEqual({ period: february, data: [topBook(included, 3)] });
  const singleDay = { from: '2026-02-28', to: '2026-02-28' };
  expect((await request(app).get('/api/stats/top-books').query(singleDay).expect(200)).body)
    .toEqual({ period: singleDay, data: [topBook(included, 2)] });
  const empty = { from: '2030-01-01', to: '2030-12-31' };
  expect((await request(app).get('/api/stats/top-books').query(empty).expect(200)).body)
    .toEqual({ period: empty, data: [] });
});

it('rejects missing, malformed, impossible or reversed dates with validation details', async () => {
  for (const dates of [
    {}, { from: period.from }, { to: period.to },
    { ...period, from: '2026-1-01' }, { ...period, from: '2026-02-30' },
    { ...period, from: '2026-02-29' }, { ...period, to: '2026-13-01' },
    { ...period, to: '2026-01-00' }, { ...period, from: '0000-01-01' },
    { ...period, from: '2026-02-01' }, { ...period, from: '2026-01-01T00:00:00Z' },
    { ...period, from: '' }, { ...period, from: [period.from, period.from] },
    { ...period, from: "2026-01-01' OR 1=1--" }, { ...period, extra: 'value' },
  ]) {
    const response = await request(app).get('/api/stats/top-books').query(dates).expect(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
    expect(response.body.error.details.length).toBeGreaterThan(0);
  }
  expect(query).not.toHaveBeenCalled();
  await request(app).get('/api/stats/top-books').query({ from: '2024-02-29', to: '2024-02-29' }).expect(200);
});

it('aggregates current overdue loans once per reader including blocked readers, excluding today and future dates', async () => {
  const empty = await request(app).get('/api/stats/overdue-readers').expect(200);
  expect(empty.body).toEqual({ data: [], pagination: { page: 1, limit: 10, total: 0, totalPages: 0 } });
  const book = await createBook();
  const first = await createReader();
  const blocked = await createReader('blocked');
  const onTime = await createReader();
  await createLoan(book, first, { dueOffset: -5 });
  await createLoan(book, first, { dueOffset: -1, status: 'overdue' });
  await createLoan(book, blocked, { dueOffset: -10 });
  await createLoan(book, onTime, { dueOffset: 0 });
  await createLoan(book, onTime, { dueOffset: 2 });
  const response = await request(app).get('/api/stats/overdue-readers').expect(200);
  expect(response.body).toEqual({
    data: [overdueReader(first, 2, 5), overdueReader(blocked, 1, 10)],
    pagination: { page: 1, limit: 10, total: 2, totalPages: 1 },
  });
});

it('counts past-due active loans but excludes actual returns regardless of status and never modifies loans or fines', async () => {
  const book = await createBook();
  const active = await createReader();
  const returned = await createReader();
  await createLoan(book, active, { dueOffset: -3 });
  await createLoan(book, active, { dueOffset: -20, returned: true, status: 'returned' });
  await createLoan(book, returned, { dueOffset: -30, returned: true, status: 'returned' });
  await createLoan(book, returned, { dueOffset: -40, returned: true, status: 'active' });
  await createLoan(book, returned, { dueOffset: 0, status: 'overdue' });
  const before = (await pool.query('SELECT * FROM loans ORDER BY id')).rows;
  const response = await request(app).get('/api/stats/overdue-readers').expect(200);
  expect(response.body).toEqual({
    data: [overdueReader(active, 1, 3)], pagination: { page: 1, limit: 10, total: 1, totalPages: 1 },
  });
  await request(app).get('/api/stats/top-books').query(period).expect(200);
  expect((await pool.query('SELECT * FROM loans ORDER BY id')).rows).toEqual(before);
});

it('paginates readers by overdue count, longest overdue duration and reader id, validating page and limit', async () => {
  const book = await createBook();
  const first = await createReader();
  const second = await createReader();
  const third = await createReader();
  const fourth = await createReader();
  for (const [reader, offsets] of [[first, [-3]], [second, [-5]], [third, [-1, -2]], [fourth, [-5]]]) {
    for (const dueOffset of offsets) await createLoan(book, reader, { dueOffset });
  }
  const sorted = [overdueReader(third, 2, 2), overdueReader(second, 1, 5), overdueReader(fourth, 1, 5), overdueReader(first, 1, 3)];
  for (const page of [1, 2, 3]) {
    const response = await request(app).get('/api/stats/overdue-readers').query({ page, limit: 2 }).expect(200);
    expect(response.body).toEqual({
      data: sorted.slice((page - 1) * 2, page * 2), pagination: { page, limit: 2, total: 4, totalPages: 2 },
    });
  }
  expect((await request(app).get('/api/stats/overdue-readers?limit=100').expect(200)).body)
    .toEqual({ data: sorted, pagination: { page: 1, limit: 100, total: 4, totalPages: 1 } });
  for (const params of ['page=0', 'page=-1', 'page=1.5', 'page=abc', 'page=1&page=2',
    'limit=0', 'limit=101', 'limit=1.5', 'limit=', 'page=9007199254740991&limit=100', 'extra=value']) {
    const response = await request(app).get(`/api/stats/overdue-readers?${params}`).expect(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
  }
});
