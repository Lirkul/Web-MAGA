import { randomUUID } from 'node:crypto';
import pg from 'pg';
import request from 'supertest';
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
import app from '../src/app.js';
import { runMigrations } from '../src/db/migrate.js';

const { query, connect } = vi.hoisted(() => ({ query: vi.fn(), connect: vi.fn() }));
// Только подключение направлено в тестовую схему. SQL и блокировки — настоящие PostgreSQL.
vi.mock('../src/db/pool.js', () => ({ pool: { query, connect }, checkDatabaseConnection: () => query('SELECT 1') }));

const testUrl = process.env.TEST_DATABASE_URL;
if (!testUrl || !decodeURIComponent(new URL(testUrl).pathname).endsWith('_test')) {
  throw new Error('Set TEST_DATABASE_URL to a separate database ending in _test');
}
const admin = new pg.Pool({ connectionString: testUrl });
let pool;
let schema;

beforeEach(async () => {
  schema = `loans_test_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  pool = new pg.Pool({
    connectionString: testUrl, application_name: schema,
    options: `-c search_path=${schema} -c timezone=Pacific/Kiritimati`,
  });
  await runMigrations(pool);
  query.mockReset();
  connect.mockReset();
  query.mockImplementation((...args) => pool.query(...args));
  connect.mockImplementation(() => pool.connect());
});

afterEach(async () => {
  await pool?.end();
  await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
});

afterAll(async () => {
  await admin.end();
});

async function createReader() {
  const response = await request(app).post('/api/readers').send({
    fullName: 'Test reader', email: `${randomUUID()}@example.com`, registrationNumber: randomUUID(),
  });
  expect(response.status).toBe(201);
  return response.body;
}

async function createFixtures(totalCopies = 1) {
  const response = await request(app).post('/api/books').send({
    title: 'Test book', authors: ['Author'], isbn: '9780132350884', totalCopies,
  });
  expect(response.status).toBe(201);
  const reader = await createReader();
  return { bookId: response.body.id, readerId: reader.id };
}

async function loanCount() {
  return Number((await pool.query('SELECT COUNT(*) AS count FROM loans')).rows[0].count);
}

async function waitUntilBlockedBy(pid) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const { rows } = await admin.query(`
      SELECT pid FROM pg_stat_activity
      WHERE application_name = $1 AND $2::integer = ANY(pg_blocking_pids(pid))
    `, [schema, pid]);
    if (rows.length) return rows[0].pid;
    // Ждём наблюдаемую блокировку БД, а не произвольную задержку перед действием.
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`No PostgreSQL lock wait on backend ${pid}`);
}

it('creates a loan with HTTP 201, server UTC dates and exact decimal money', async () => {
  const data = await createFixtures();
  query.mockClear();
  const response = await request(app).post('/api/loans').send(data);
  expect(response.status).toBe(201);
  expect(response.body).toEqual({
    id: expect.any(Number), ...data, loanedAt: expect.any(String), dueDate: expect.any(String),
    returnedAt: null, status: 'active', fineAmount: '0.00', createdAt: expect.any(String),
  });
  expect(response.body.dueDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  const expectedDueDate = new Date(response.body.loanedAt);
  expectedDueDate.setUTCDate(expectedDueDate.getUTCDate() + 14);
  expect(response.body.dueDate).toBe(expectedDueDate.toISOString().slice(0, 10));
  expect(typeof response.body.fineAmount).toBe('string');
  expect(query).not.toHaveBeenCalled();
  expect(connect).toHaveBeenCalledOnce();
  expect(pool.idleCount).toBe(pool.totalCount);
  const stored = (await pool.query("SELECT *, to_char(due_date, 'YYYY-MM-DD') AS due_date_text FROM loans")).rows[0];
  expect(stored).toMatchObject({
    book_id: String(data.bookId), reader_id: String(data.readerId),
    due_date_text: response.body.dueDate, status: 'active', returned_at: null, fine_amount: '0.00',
  });
});

it.each(['bookId', 'readerId'])('validates numeric %s', async (field) => {
  for (const value of [0, -1, 1.5, '1', null, true, {}, [], Number.MAX_SAFE_INTEGER + 1]) {
    const response = await request(app).post('/api/loans').send({ bookId: 1, readerId: 1, [field]: value });
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
    expect(response.body.error.details[0].path).toBe(field);
  }
  expect(await loanCount()).toBe(0);
});

it.each([{}, { bookId: 1 }, { readerId: 1 }])('rejects missing loan identifiers %j', async (data) => {
  const response = await request(app).post('/api/loans').send(data);
  expect(response.status).toBe(400);
  expect(response.body.error.code).toBe('VALIDATION_ERROR');
  expect(await loanCount()).toBe(0);
});

it.each([
  { status: 'active' }, { dueDate: '2026-11-26' }, { loanedAt: '2026-11-12T10:00:00Z' },
  { fineAmount: '0.00' }, { returnedAt: null }, { id: 1 }, { createdAt: '2026-11-12' }, { extra: true },
])('rejects client-controlled loan fields %j', async (fields) => {
  const response = await request(app).post('/api/loans').send({ bookId: 1, readerId: 1, ...fields });
  expect(response.status).toBe(400);
  expect(response.body.error.code).toBe('VALIDATION_ERROR');
  expect(await loanCount()).toBe(0);
});

it.each([
  ['bookId', 404, 'BOOK_NOT_FOUND', 'Книга не найдена'],
  ['readerId', 404, 'READER_NOT_FOUND', 'Читатель не найден'],
])('rejects missing %s and releases the transaction', async (field, status, code, message) => {
  const data = await createFixtures();
  const response = await request(app).post('/api/loans').send({ ...data, [field]: 999999 });
  expect(response.status).toBe(status);
  expect(response.body).toEqual({ error: { code, message, details: [] } });
  expect(await loanCount()).toBe(0);
  expect(pool.idleCount).toBe(pool.totalCount);
});

it('rejects a blocked reader without creating a loan', async () => {
  const data = await createFixtures();
  await request(app).patch(`/api/readers/${data.readerId}`).send({ status: 'blocked' }).expect(200);
  const response = await request(app).post('/api/loans').send(data);
  expect(response.status).toBe(409);
  expect(response.body).toEqual({ error: { code: 'READER_BLOCKED', message: 'Выдача книг заблокированному читателю запрещена', details: [] } });
  expect(await loanCount()).toBe(0);
  expect(pool.idleCount).toBe(pool.totalCount);
});

it('rejects a book with zero copies', async () => {
  const data = await createFixtures(0);
  const response = await request(app).post('/api/loans').send(data);
  expect(response.status).toBe(409);
  expect(response.body).toEqual({ error: { code: 'BOOK_UNAVAILABLE', message: 'Нет доступных экземпляров книги', details: [] } });
  expect(await loanCount()).toBe(0);
});

it('decrements both book representations and rejects a fully issued book', async () => {
  const data = await createFixtures();
  await request(app).post('/api/loans').send(data).expect(201);
  expect((await request(app).get(`/api/books/${data.bookId}`)).body.availableCopies).toBe(0);
  expect((await request(app).get('/api/books')).body.data[0].availableCopies).toBe(0);
  const response = await request(app).post('/api/loans').send(data);
  expect(response.status).toBe(409);
  expect(response.body.error.code).toBe('BOOK_UNAVAILABLE');
  expect(await loanCount()).toBe(1);
});

it('allows several loans when enough copies remain', async () => {
  const data = await createFixtures(3);
  const responses = await Promise.all(Array.from({ length: 3 }, () => request(app).post('/api/loans').send(data)));
  expect(responses.map((response) => response.status)).toEqual([201, 201, 201]);
  expect(new Set(responses.map((response) => response.body.id)).size).toBe(3);
  expect(await loanCount()).toBe(3);
  expect((await request(app).get(`/api/books/${data.bookId}`)).body.availableCopies).toBe(0);
});

it.each(['overdue', 'returned'])('uses returned_at rather than only status for a %s fixture', async (status) => {
  const data = await createFixtures();
  await pool.query(`
    INSERT INTO loans (book_id, reader_id, due_date, status, returned_at)
    VALUES ($1, $2, CURRENT_DATE, $3, CASE WHEN $3 = 'returned' THEN NOW() ELSE NULL END)
  `, [data.bookId, data.readerId, status]);
  const response = await request(app).post('/api/loans').send(data);
  expect(response.status).toBe(status === 'overdue' ? 409 : 201);
  if (status === 'overdue') expect(response.body.error.code).toBe('BOOK_UNAVAILABLE');
  expect(await loanCount()).toBe(status === 'overdue' ? 1 : 2);
});

it('rolls back an inserted loan when COMMIT fails and then reuses the connection', async () => {
  const data = await createFixtures();
  await pool.query(`
    CREATE FUNCTION reject_loan_commit() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'private database failure'; RETURN NEW; END;
    $$;
    CREATE CONSTRAINT TRIGGER reject_loan_commit AFTER INSERT ON loans
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION reject_loan_commit();
  `);
  const response = await request(app).post('/api/loans').send(data);
  expect(response.status).toBe(500);
  expect(response.body).toEqual({ error: { code: 'INTERNAL_SERVER_ERROR', message: 'Внутренняя ошибка сервера', details: [] } });
  expect(await loanCount()).toBe(0);
  expect(pool.idleCount).toBe(pool.totalCount);
  expect((await request(app).get(`/api/books/${data.bookId}`)).body.availableCopies).toBe(1);
  await pool.query('DROP TRIGGER reject_loan_commit ON loans');
  await request(app).post('/api/loans').send(data).expect(201);
});

it('issues the last copy to exactly one of two simultaneous readers', async () => {
  const data = await createFixtures();
  const second = await createReader();
  const responses = await Promise.all([
    request(app).post('/api/loans').send(data),
    request(app).post('/api/loans').send({ ...data, readerId: second.id }),
  ]);
  expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
  expect(responses.find((response) => response.status === 409).body.error.code).toBe('BOOK_UNAVAILABLE');
  expect(await loanCount()).toBe(1);
  expect((await request(app).get(`/api/books/${data.bookId}`)).body.availableCopies).toBe(0);
  expect(pool.idleCount).toBe(pool.totalCount);
});

it('serializes a loan with PATCH totalCopies using real PostgreSQL locks', async () => {
  const data = await createFixtures();
  const blocker = await pool.connect();
  let open = false;
  let pendingLoan;
  let pendingPatch;
  try {
    await blocker.query('BEGIN');
    open = true;
    const pid = (await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    await blocker.query('UPDATE readers SET status = status WHERE id = $1', [data.readerId]);
    pendingLoan = request(app).post('/api/loans').send(data).then((response) => response);
    const loanPid = await waitUntilBlockedBy(pid);
    pendingPatch = request(app).patch(`/api/books/${data.bookId}`).send({ totalCopies: 0 }).then((response) => response);
    await waitUntilBlockedBy(loanPid);
    await blocker.query('COMMIT');
    open = false;
    const [loan, patch] = await Promise.all([pendingLoan, pendingPatch]);
    expect(loan.status).toBe(201);
    expect(patch.status).toBe(409);
    expect(patch.body.error.code).toBe('INSUFFICIENT_TOTAL_COPIES');
    expect((await request(app).get(`/api/books/${data.bookId}`)).body).toMatchObject({ totalCopies: 1, availableCopies: 0 });
  } finally {
    if (open) await blocker.query('ROLLBACK');
    blocker.release();
    await Promise.allSettled([pendingLoan, pendingPatch]);
  }
}, 10000);

it('sees a reader block committed while its FOR SHARE is waiting', async () => {
  const data = await createFixtures();
  const blocker = await pool.connect();
  let open = false;
  let pending;
  try {
    await blocker.query('BEGIN');
    open = true;
    const pid = (await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    await blocker.query("UPDATE readers SET status = 'blocked' WHERE id = $1", [data.readerId]);
    pending = request(app).post('/api/loans').send(data).then((response) => response);
    await waitUntilBlockedBy(pid);
    await blocker.query('COMMIT');
    open = false;
    const response = await pending;
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('READER_BLOCKED');
    expect(await loanCount()).toBe(0);
  } finally {
    if (open) await blocker.query('ROLLBACK');
    blocker.release();
    await Promise.allSettled([pending]);
  }
}, 10000);

it('does not expose loan listing or return endpoints', async () => {
  expect((await request(app).get('/api/loans')).status).toBe(404);
  expect((await request(app).get('/api/loans/1')).status).toBe(404);
  expect((await request(app).post('/api/loans/1/return')).status).toBe(404);
});
