import { randomUUID } from 'node:crypto';
import pg from 'pg';
import request from 'supertest';
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
import app from '../src/app.js';
import { runMigrations } from '../src/db/migrate.js';

const { query } = vi.hoisted(() => ({ query: vi.fn() }));
// Все SQL-запросы выполняются на настоящей отдельной тестовой PostgreSQL.
vi.mock('../src/db/pool.js', () => ({ pool: { query }, checkDatabaseConnection: () => query('SELECT 1') }));

const testUrl = process.env.TEST_DATABASE_URL;
if (!testUrl || !decodeURIComponent(new URL(testUrl).pathname).endsWith('_test')) {
  throw new Error('Set TEST_DATABASE_URL to a separate database ending in _test');
}
const admin = new pg.Pool({ connectionString: testUrl });
let pool;
let schema;

beforeEach(async () => {
  schema = `readers_test_${randomUUID().replaceAll('-', '')}`;
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

const validReader = {
  fullName: 'Иванов Иван Иванович', email: 'ivanov@example.com', registrationNumber: 'LIB-000001',
};

async function createReader(overrides = {}) {
  const response = await request(app).post('/api/readers').send({ ...validReader, ...overrides });
  expect(response.status).toBe(201);
  return response.body;
}

async function createCatalog() {
  const first = await createReader();
  const second = await createReader({ fullName: 'Петров Пётр', email: 'petrov@example.com', registrationNumber: 'LIB-000002' });
  const third = await createReader({ fullName: 'Иванов Павел', email: 'pavel@example.com', registrationNumber: 'ABC-000003' });
  const blockedSecond = await request(app).patch(`/api/readers/${second.id}`).send({ status: 'blocked' });
  const blockedThird = await request(app).patch(`/api/readers/${third.id}`).send({ status: 'blocked' });
  expect(blockedSecond.status).toBe(200);
  expect(blockedThird.status).toBe(200);
  return [first, blockedSecond.body, blockedThird.body];
}

it('registers an active reader with normalized email, trimmed fields and automatic timestamps', async () => {
  const reader = await createReader({
    fullName: ' Иванов Иван Иванович ', email: ' IvanOV@Example.COM ', registrationNumber: ' LIB-000001 ',
  });
  expect(reader).toEqual({
    ...validReader, id: expect.any(Number), status: 'active', createdAt: expect.any(String), updatedAt: expect.any(String),
  });
  expect(reader.id).toBeGreaterThan(0);
  expect(Number.isNaN(Date.parse(reader.createdAt))).toBe(false);
  expect(Number.isNaN(Date.parse(reader.updatedAt))).toBe(false);
  expect((await pool.query('SELECT email, status FROM readers')).rows[0]).toEqual({ email: 'ivanov@example.com', status: 'active' });
});

it.each([
  { fullName: undefined }, { fullName: '' }, { fullName: ' ' }, { fullName: null }, { fullName: 5 },
  { email: undefined }, { email: 'invalid' }, { email: null }, { email: 5 },
  { registrationNumber: undefined }, { registrationNumber: ' ' }, { registrationNumber: null },
  { status: 'active' }, { status: 'blocked' }, { id: 1 }, { createdAt: '2000-01-01' }, { updatedAt: '2000-01-01' },
])('rejects invalid registration data %j without inserting a reader', async (data) => {
  const response = await request(app).post('/api/readers').send({ ...validReader, ...data });
  expect(response.status).toBe(400);
  expect(response.body.error.code).toBe('VALIDATION_ERROR');
  expect((await pool.query('SELECT count(*) FROM readers')).rows[0].count).toBe('0');
});

it.each(['ivanov@example.com', 'IVANOV@EXAMPLE.COM'])('rejects duplicate email %s', async (email) => {
  await createReader();
  const response = await request(app).post('/api/readers').send({ ...validReader, email, registrationNumber: 'LIB-2' });
  expect(response.status).toBe(409);
  expect(response.body).toEqual({ error: { code: 'EMAIL_ALREADY_EXISTS', message: 'Читатель с таким email уже зарегистрирован', details: [] } });
});

it('uses the PostgreSQL case-insensitive index for an existing mixed-case email', async () => {
  await pool.query("INSERT INTO readers (full_name, email, registration_number) VALUES ('Existing', 'IVANOV@Example.com', 'EXISTING')");
  const response = await request(app).post('/api/readers').send(validReader);
  expect(response.status).toBe(409);
  expect(response.body.error.code).toBe('EMAIL_ALREADY_EXISTS');
});

it('rejects duplicate registration numbers', async () => {
  await createReader();
  const response = await request(app).post('/api/readers').send({ ...validReader, email: 'other@example.com' });
  expect(response.status).toBe(409);
  expect(response.body.error.code).toBe('REGISTRATION_NUMBER_ALREADY_EXISTS');
  expect((await pool.query('SELECT count(*) FROM readers')).rows[0].count).toBe('1');
});

it.each(['email', 'registrationNumber'])('handles concurrent registration with the same %s', async (field) => {
  const other = field === 'email'
    ? { ...validReader, email: 'IVANOV@EXAMPLE.COM', registrationNumber: 'LIB-2' }
    : { ...validReader, email: 'other@example.com' };
  const responses = await Promise.all([
    request(app).post('/api/readers').send(validReader),
    request(app).post('/api/readers').send(other),
  ]);
  expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
  expect(responses.find((response) => response.status === 409).body.error.code)
    .toBe(field === 'email' ? 'EMAIL_ALREADY_EXISTS' : 'REGISTRATION_NUMBER_ALREADY_EXISTS');
  expect((await pool.query('SELECT count(*) FROM readers')).rows[0].count).toBe('1');
});

it('lists readers with stable sorting and the same pagination contract as books', async () => {
  const readers = await createCatalog();
  const response = await request(app).get('/api/readers');
  expect(response.status).toBe(200);
  expect(response.body).toEqual({ data: readers, pagination: { page: 1, limit: 10, total: 3, totalPages: 1 } });
});

it.each([
  [{ search: ' ИВАНОВ ' }, [0, 2]],
  [{ search: 'PETROV@' }, [1]],
  [{ search: 'lib-00000' }, [0, 1]],
  [{ status: 'active' }, [0]],
  [{ status: 'blocked' }, [1, 2]],
  [{ search: 'иванов', status: 'blocked' }, [2]],
])('searches and filters with %j', async (parameters, indexes) => {
  const readers = await createCatalog();
  const response = await request(app).get('/api/readers').query(parameters);
  expect(response.status).toBe(200);
  expect(response.body.data.map((reader) => reader.id)).toEqual(indexes.map((index) => readers[index].id));
  expect(response.body.pagination.total).toBe(indexes.length);
});

it('paginates filtered readers with LIMIT/OFFSET and keeps the total beyond the last page', async () => {
  const readers = await createCatalog();
  const response = await request(app).get('/api/readers').query({ search: 'Иванов', page: 2, limit: 1 });
  expect(response.status).toBe(200);
  expect(response.body).toEqual({ data: [readers[2]], pagination: { page: 2, limit: 1, total: 2, totalPages: 2 } });
  const beyond = await request(app).get('/api/readers').query({ page: 10, limit: 2 });
  expect(beyond.body).toEqual({ data: [], pagination: { page: 10, limit: 2, total: 3, totalPages: 2 } });
});

it('returns an empty search result with HTTP 200', async () => {
  await createReader();
  const response = await request(app).get('/api/readers').query({ search: 'Несуществующий читатель' });
  expect(response.status).toBe(200);
  expect(response.body).toEqual({ data: [], pagination: { page: 1, limit: 10, total: 0, totalPages: 0 } });
});

it('escapes LIKE characters and does not interpret search as SQL', async () => {
  const special = await createReader({ fullName: '100%_читатель' });
  await createReader({ email: 'other@example.com', registrationNumber: 'LIB-2' });
  const literal = await request(app).get('/api/readers').query({ search: '%_' });
  expect(literal.body.data.map((reader) => reader.id)).toEqual([special.id]);
  const injection = await request(app).get('/api/readers').query({ search: "' OR 1=1 --" });
  expect(injection.status).toBe(200);
  expect(injection.body.pagination.total).toBe(0);
});

it.each([
  { page: 0 }, { page: -1 }, { page: 1.5 }, { page: 'invalid' },
  { limit: 0 }, { limit: 101 }, { limit: 1.5 }, { status: 'unknown' },
  { page: ['1', '2'] }, { page: '9007199254740991', limit: 100 }, { search: ' ' }, { extra: 'unknown' },
])('validates reader query %j', async (parameters) => {
  const response = await request(app).get('/api/readers').query(parameters);
  expect(response.status).toBe(400);
  expect(response.body.error.code).toBe('VALIDATION_ERROR');
});

it('gets a reader by ID without adding loan history', async () => {
  const reader = await createReader();
  const response = await request(app).get(`/api/readers/${reader.id}`);
  expect(response.status).toBe(200);
  expect(response.body).toEqual(reader);
});

it.each(['get', 'patch'])('%s returns READER_NOT_FOUND for an absent reader', async (method) => {
  const response = await request(app)[method]('/api/readers/999999').send({ fullName: 'Читатель' });
  expect(response.status).toBe(404);
  expect(response.body).toEqual({ error: { code: 'READER_NOT_FOUND', message: 'Читатель не найден', details: [] } });
});

it.each(['get', 'patch'])('%s validates reader IDs', async (method) => {
  for (const id of ['0', '-1', 'wrong', '1.5', '9007199254740992']) {
    const response = await request(app)[method](`/api/readers/${id}`).send({ fullName: 'Читатель' });
    expect(response.status).toBe(400);
    expect(response.body.error.details[0].path).toBe('id');
  }
});

it('partially updates a reader and updatedAt while preserving all omitted fields', async () => {
  const reader = await createReader();
  await pool.query("UPDATE readers SET updated_at = '2000-01-01T00:00:00Z' WHERE id = $1", [reader.id]);
  const response = await request(app).patch(`/api/readers/${reader.id}`).send({ fullName: ' Новое ФИО ' });
  expect(response.status).toBe(200);
  expect(response.body).toEqual({ ...reader, fullName: 'Новое ФИО', updatedAt: expect.any(String) });
  expect(Date.parse(response.body.updatedAt)).toBeGreaterThan(Date.parse('2000-01-01T00:00:00Z'));
});

it('updates and normalizes several reader fields together', async () => {
  const reader = await createReader();
  const response = await request(app).patch(`/api/readers/${reader.id}`).send({
    email: ' New.Reader@EXAMPLE.COM ', registrationNumber: ' LIB-NEW ', status: 'blocked',
  });
  expect(response.status).toBe(200);
  expect(response.body).toEqual({
    ...reader, email: 'new.reader@example.com', registrationNumber: 'LIB-NEW', status: 'blocked', updatedAt: expect.any(String),
  });
});

it.each([
  {}, { fullName: '' }, { fullName: null }, { fullName: 5 },
  { email: 'invalid' }, { email: null }, { email: 5 },
  { registrationNumber: ' ' }, { registrationNumber: null }, { registrationNumber: 5 },
  { status: 'unknown' }, { status: null }, { status: 5 },
  { id: 2 }, { createdAt: '2000-01-01' }, { updatedAt: '2000-01-01' }, { loans: [] },
])('rejects invalid PATCH %j without changing any fields', async (data) => {
  const reader = await createReader();
  const response = await request(app).patch(`/api/readers/${reader.id}`).send(data);
  expect(response.status).toBe(400);
  expect(response.body.error.code).toBe('VALIDATION_ERROR');
  expect((await request(app).get(`/api/readers/${reader.id}`)).body).toEqual(reader);
});

it.each([
  [{ email: ' OTHER@EXAMPLE.COM ' }, 'EMAIL_ALREADY_EXISTS'],
  [{ registrationNumber: 'LIB-2' }, 'REGISTRATION_NUMBER_ALREADY_EXISTS'],
])('rejects PATCH conflict %j atomically', async (data, code) => {
  const reader = await createReader();
  await createReader({ email: 'other@example.com', registrationNumber: 'LIB-2' });
  const response = await request(app).patch(`/api/readers/${reader.id}`).send({ fullName: 'Не сохранять', ...data });
  expect(response.status).toBe(409);
  expect(response.body.error.code).toBe(code);
  expect((await request(app).get(`/api/readers/${reader.id}`)).body).toEqual(reader);
});

it('allows keeping the same normalized email and registration number', async () => {
  const reader = await createReader();
  const response = await request(app).patch(`/api/readers/${reader.id}`).send({ email: ' IVANOV@EXAMPLE.COM ', registrationNumber: reader.registrationNumber });
  expect(response.status).toBe(200);
  expect(response.body.email).toBe(reader.email);
});

it('blocks, unblocks and accepts repeated statuses while preserving the reader', async () => {
  const reader = await createReader();
  for (const status of ['active', 'blocked', 'blocked', 'active', 'active']) {
    const response = await request(app).patch(`/api/readers/${reader.id}`).send({ status });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ id: reader.id, status, email: reader.email });
    const list = await request(app).get('/api/readers').query({ status });
    expect(list.body.data.map((item) => item.id)).toEqual([reader.id]);
  }
  expect((await pool.query('SELECT count(*) FROM readers')).rows[0].count).toBe('1');
});

it('blocking and unblocking leave existing loans untouched and omit history from the response', async () => {
  const reader = await createReader();
  const book = (await pool.query("INSERT INTO books (title, authors, isbn, total_copies) VALUES ('Test', ARRAY['Author'], '9780132350884', 2) RETURNING id")).rows[0];
  await pool.query(`
    INSERT INTO loans (book_id, reader_id, due_date, status, returned_at)
    VALUES ($1, $2, CURRENT_DATE + 14, 'active', NULL), ($1, $2, CURRENT_DATE, 'returned', NOW())
  `, [book.id, reader.id]);
  const before = (await pool.query('SELECT * FROM loans ORDER BY id')).rows;
  for (const status of ['blocked', 'active']) {
    const response = await request(app).patch(`/api/readers/${reader.id}`).send({ status });
    expect(response.status).toBe(200);
    expect(response.body).not.toHaveProperty('loans');
    expect((await pool.query('SELECT * FROM loans ORDER BY id')).rows).toEqual(before);
  }
});

it('does not expose reader DELETE or separate block/unblock endpoints', async () => {
  const reader = await createReader();
  expect((await request(app).delete(`/api/readers/${reader.id}`)).status).toBe(404);
  for (const action of ['block', 'unblock']) {
    expect((await request(app).post(`/api/readers/${reader.id}/${action}`)).status).toBe(404);
  }
  expect((await request(app).get(`/api/readers/${reader.id}`)).body).toEqual(reader);
});
