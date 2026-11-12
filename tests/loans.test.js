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
  vi.unstubAllEnvs();
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

it('returns an on-time loan with no fine, even for a blocked reader', async () => {
  vi.stubEnv('FINE_PER_DAY', undefined);
  const data = await createFixtures();
  const issued = await request(app).post('/api/loans').send(data).expect(201);
  await request(app).patch(`/api/readers/${data.readerId}`).send({ status: 'blocked' }).expect(200);
  const response = await request(app).post(`/api/loans/${issued.body.id}/return`);
  expect(response.status).toBe(200);
  expect(response.body).toEqual({
    ...issued.body, status: 'returned', returnedAt: expect.any(String), fineAmount: '0.00',
  });
  expect(pool.idleCount).toBe(pool.totalCount);
});

it('charges overdue calendar days for active and overdue loans without relying on cron', async () => {
  vi.stubEnv('FINE_PER_DAY', undefined);
  const data = await createFixtures();
  for (const status of ['active', 'overdue']) {
    const issued = await request(app).post('/api/loans').send(data).expect(201);
    await pool.query(`
      UPDATE loans SET due_date = (clock_timestamp() AT TIME ZONE 'UTC')::date - 2,
                       status = $2 WHERE id = $1
    `, [issued.body.id, status]);
    const response = await request(app).post(`/api/loans/${issued.body.id}/return`).send({});
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ status: 'returned', fineAmount: '20.00' });
    const stored = (await pool.query('SELECT returned_at, fine_amount::text FROM loans WHERE id = $1', [issued.body.id])).rows[0];
    expect(stored.returned_at.toISOString()).toBe(response.body.returnedAt);
    expect(stored.fine_amount).toBe('20.00');
  }
});

it('rejects a repeated return and preserves the recorded return time and fine', async () => {
  const data = await createFixtures();
  const issued = await request(app).post('/api/loans').send(data).expect(201);
  await request(app).post(`/api/loans/${issued.body.id}/return`).expect(200);
  const before = (await pool.query('SELECT * FROM loans WHERE id = $1', [issued.body.id])).rows[0];
  const repeated = await request(app).post(`/api/loans/${issued.body.id}/return`);
  expect(repeated.status).toBe(409);
  expect(repeated.body).toEqual({ error: { code: 'LOAN_ALREADY_RETURNED', message: 'Книга уже возвращена', details: [] } });
  expect((await pool.query('SELECT * FROM loans WHERE id = $1', [issued.body.id])).rows[0]).toEqual(before);
});

it('returns LOAN_NOT_FOUND for a missing loan and releases the transaction', async () => {
  const response = await request(app).post('/api/loans/999999/return');
  expect(response.status).toBe(404);
  expect(response.body).toEqual({ error: { code: 'LOAN_NOT_FOUND', message: 'Выдача не найдена', details: [] } });
  expect(pool.idleCount).toBe(pool.totalCount);
});

it('restores book availability after return without changing totalCopies or erasing history', async () => {
  const data = await createFixtures();
  const issued = await request(app).post('/api/loans').send(data).expect(201);
  expect((await request(app).get(`/api/books/${data.bookId}`)).body.availableCopies).toBe(0);
  await request(app).post(`/api/loans/${issued.body.id}/return`).send({}).expect(200);
  expect((await request(app).get(`/api/books/${data.bookId}`)).body).toMatchObject({ totalCopies: 1, availableCopies: 1 });
  expect((await request(app).get('/api/books')).body.data[0].availableCopies).toBe(1);
  expect(await loanCount()).toBe(1);
});

it('allows exactly one of two simultaneous returns using PostgreSQL locks', async () => {
  const data = await createFixtures();
  const issued = await request(app).post('/api/loans').send(data).expect(201);
  const responses = await Promise.all([
    request(app).post(`/api/loans/${issued.body.id}/return`),
    request(app).post(`/api/loans/${issued.body.id}/return`),
  ]);
  expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
  expect(responses.find((response) => response.status === 409).body.error.code).toBe('LOAN_ALREADY_RETURNED');
  const winner = responses.find((response) => response.status === 200).body;
  const stored = (await pool.query('SELECT returned_at FROM loans WHERE id = $1', [issued.body.id])).rows[0];
  expect(stored.returned_at.toISOString()).toBe(winner.returnedAt);
  expect((await request(app).get(`/api/books/${data.bookId}`)).body.availableCopies).toBe(1);
});

it('uses a changed decimal FINE_PER_DAY and rounds only the final NUMERIC amount', async () => {
  vi.stubEnv('FINE_PER_DAY', '2.555');
  const data = await createFixtures();
  const issued = await request(app).post('/api/loans').send(data).expect(201);
  await pool.query("UPDATE loans SET due_date = (clock_timestamp() AT TIME ZONE 'UTC')::date - 3 WHERE id = $1", [issued.body.id]);
  const response = await request(app).post(`/api/loans/${issued.body.id}/return`);
  expect(response.status).toBe(200);
  expect(response.body.fineAmount).toBe('7.67');
  expect((await pool.query('SELECT fine_amount::text FROM loans WHERE id = $1', [issued.body.id])).rows[0].fine_amount).toBe('7.67');
});

async function createHistory() {
  const first = await createFixtures(5);
  const secondReader = await createReader();
  const secondBook = await request(app).post('/api/books').send({
    title: 'Second book', authors: ['Author'], isbn: '9780201616224', totalCopies: 1,
  }).expect(201);
  const loans = [];
  for (const data of [
    first,
    { bookId: first.bookId, readerId: secondReader.id },
    { bookId: secondBook.body.id, readerId: first.readerId },
    first,
  ]) {
    const issued = await request(app).post('/api/loans').send(data).expect(201);
    loans.push(issued.body);
  }
  const { rows } = await pool.query(`
    UPDATE loans SET due_date = (clock_timestamp() AT TIME ZONE 'UTC')::date - 2
    WHERE id = $1 RETURNING to_char(due_date, 'YYYY-MM-DD') AS due_date
  `, [loans[0].id]);
  loans[0].dueDate = rows[0].due_date;
  await pool.query("UPDATE loans SET status = 'overdue' WHERE id = $1", [loans[1].id]);
  loans[1].status = 'overdue';
  loans[2] = (await request(app).post(`/api/loans/${loans[2].id}/return`).expect(200)).body;
  return loans;
}

it('lists loan history in id order with defaults and supports an empty library', async () => {
  const empty = await request(app).get('/api/loans').expect(200);
  expect(empty.body).toEqual({ data: [], pagination: { page: 1, limit: 10, total: 0, totalPages: 0 } });
  const loans = await createHistory();
  const response = await request(app).get('/api/loans').expect(200);
  expect(response.body).toEqual({ data: loans, pagination: { page: 1, limit: 10, total: 4, totalPages: 1 } });
});

it('filters history by reader and book separately and together with status', async () => {
  const loans = await createHistory();
  for (const filters of [
    { readerId: loans[0].readerId },
    { bookId: loans[0].bookId },
    { readerId: loans[0].readerId, bookId: loans[0].bookId },
    { readerId: loans[0].readerId, bookId: loans[0].bookId, status: 'active' },
    { readerId: loans[1].readerId, bookId: loans[2].bookId },
    { readerId: 999999 }, { bookId: 999999 },
  ]) {
    const expected = loans.filter((loan) => Object.entries(filters).every(([key, value]) => loan[key] === value));
    const response = await request(app).get('/api/loans').query(filters).expect(200);
    expect(response.body).toEqual({
      data: expected, pagination: { page: 1, limit: 10, total: expected.length, totalPages: expected.length ? 1 : 0 },
    });
  }
});

it('filters by each stored status without marking past-due active loans overdue', async () => {
  const loans = await createHistory();
  const before = (await pool.query('SELECT * FROM loans ORDER BY id')).rows;
  for (const status of ['active', 'overdue', 'returned']) {
    const response = await request(app).get('/api/loans').query({ status }).expect(200);
    const expected = loans.filter((loan) => loan.status === status);
    expect(response.body.data).toEqual(expected);
    expect(response.body.pagination.total).toBe(expected.length);
  }
  expect((await pool.query('SELECT * FROM loans ORDER BY id')).rows).toEqual(before);
});

it('paginates in PostgreSQL with stable ordering and filtered totals', async () => {
  const loans = await createHistory();
  for (const page of [1, 2, 3]) {
    const response = await request(app).get('/api/loans').query({ page, limit: 2 }).expect(200);
    expect(response.body).toEqual({
      data: loans.slice((page - 1) * 2, page * 2), pagination: { page, limit: 2, total: 4, totalPages: 2 },
    });
  }
  const filtered = await request(app).get('/api/loans')
    .query({ readerId: loans[0].readerId, page: 2, limit: 2 }).expect(200);
  expect(filtered.body).toEqual({ data: [loans[3]], pagination: { page: 2, limit: 2, total: 3, totalPages: 2 } });
  const maximum = await request(app).get('/api/loans?limit=100').expect(200);
  expect(maximum.body).toEqual({ data: loans, pagination: { page: 1, limit: 100, total: 4, totalPages: 1 } });
});

it('gets individual active and returned loans preserving dates and decimal strings', async () => {
  const loans = await createHistory();
  for (const loan of [loans[0], loans[2]]) {
    const response = await request(app).get(`/api/loans/${loan.id}`).expect(200);
    expect(response.body).toEqual(loan);
    expect(response.body.fineAmount).toMatch(/^\d+\.\d{2}$/);
    expect(response.body.dueDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(response.body.loanedAt).toBe(new Date(loan.loanedAt).toISOString());
  }
});

it('returns 404 for a missing loan and 400 for invalid ids, filters and pagination', async () => {
  const missing = await request(app).get('/api/loans/999999').expect(404);
  expect(missing.body).toEqual({ error: { code: 'LOAN_NOT_FOUND', message: 'Выдача не найдена', details: [] } });
  for (const id of ['0', '-1', '1.5', 'abc', '9007199254740992']) {
    const response = await request(app).get(`/api/loans/${id}`).expect(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
  }
  for (const queryString of [
    'readerId=0', 'readerId=abc', 'readerId=1&readerId=2', 'bookId=-1', 'bookId=1.5',
    'bookId=9007199254740992', 'status=blocked', 'status=', 'status=active&status=overdue',
    'page=0', 'page=1.5', 'page=abc', 'page=9007199254740991&limit=100',
    'limit=0', 'limit=101', 'limit=1.5', 'limit=', 'unknown=value', "readerId=1%20OR%201=1",
  ]) {
    const response = await request(app).get(`/api/loans?${queryString}`).expect(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
    expect(response.body.error.details.length).toBeGreaterThan(0);
  }
});
