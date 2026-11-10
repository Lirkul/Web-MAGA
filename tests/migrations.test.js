import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import pg from 'pg';
import { afterAll, afterEach, beforeEach, expect, it } from 'vitest';
import { runMigrations } from '../src/db/migrate.js';

const testUrl = process.env.TEST_DATABASE_URL;
if (!testUrl || !decodeURIComponent(new URL(testUrl).pathname).endsWith('_test')) {
  throw new Error('Set TEST_DATABASE_URL to a separate database ending in _test');
}

const admin = new pg.Pool({ connectionString: testUrl });
const exec = promisify(execFile);
let pool;
let schema;
let fixtureDirectory;

beforeEach(async () => {
  schema = `migration_test_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  pool = new pg.Pool({ connectionString: testUrl, options: `-c search_path=${schema}` });
});

afterEach(async () => {
  await pool?.end();
  await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  if (fixtureDirectory) {
    const prefix = join(resolve(tmpdir()), 'web-maga-migrations-');
    if (!resolve(fixtureDirectory).startsWith(prefix)) throw new Error('Unsafe fixture path');
    await rm(fixtureDirectory, { recursive: true, force: true });
    fixtureDirectory = undefined;
  }
});

afterAll(async () => {
  await admin.end();
});

async function insertFixtures() {
  await pool.query("INSERT INTO books (title, authors, isbn) VALUES ('Test book', ARRAY['Author'], '9780000000001')");
  await pool.query("INSERT INTO readers (full_name, email, registration_number) VALUES ('Test reader', 'Reader@example.com', 'TEST-1')");
  await pool.query(`
    INSERT INTO loans (book_id, reader_id, due_date)
    SELECT books.id, readers.id, CURRENT_DATE + 14 FROM books CROSS JOIN readers
  `);
}

it('creates all columns with correct PostgreSQL types, nullability and serial IDs', async () => {
  await runMigrations(pool);
  const { rows } = await pool.query(`
    SELECT c.relname AS table_name, a.attname AS column_name,
           format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull AS required
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema() AND c.relkind = 'r'
      AND a.attnum > 0 AND NOT a.attisdropped
  `);
  const types = {};
  for (const row of rows) {
    types[`${row.table_name}.${row.column_name}`] = row.type;
    const nullable = ['books.publication_year', 'books.genre', 'loans.returned_at'];
    expect(row.required).toBe(!nullable.includes(`${row.table_name}.${row.column_name}`));
  }
  expect(types).toEqual({
    'books.id': 'bigint', 'books.title': 'text', 'books.authors': 'text[]',
    'books.isbn': 'character varying(20)', 'books.publication_year': 'integer',
    'books.genre': 'text', 'books.total_copies': 'integer',
    'books.created_at': 'timestamp with time zone', 'books.updated_at': 'timestamp with time zone',
    'readers.id': 'bigint', 'readers.full_name': 'text', 'readers.email': 'text',
    'readers.registration_number': 'text', 'readers.status': 'text',
    'readers.created_at': 'timestamp with time zone', 'readers.updated_at': 'timestamp with time zone',
    'loans.id': 'bigint', 'loans.book_id': 'bigint', 'loans.reader_id': 'bigint',
    'loans.loaned_at': 'timestamp with time zone', 'loans.due_date': 'date',
    'loans.returned_at': 'timestamp with time zone', 'loans.status': 'text',
    'loans.fine_amount': 'numeric(12,2)', 'loans.created_at': 'timestamp with time zone',
    'schema_migrations.filename': 'text', 'schema_migrations.applied_at': 'timestamp with time zone',
  });
  for (const table of ['books', 'readers', 'loans']) {
    const result = await pool.query('SELECT pg_get_serial_sequence($1, $2) AS sequence', [table, 'id']);
    expect(result.rows[0].sequence).toBeTruthy();
  }
});

it('creates the requested indexes and RESTRICT foreign keys', async () => {
  await runMigrations(pool);
  const indexes = await pool.query('SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = current_schema()');
  for (const [name, definition] of [
    ['loans_book_id_idx', '(book_id)'],
    ['loans_reader_id_idx', '(reader_id)'],
    ['loans_unreturned_due_date_idx', '(due_date) WHERE (returned_at IS NULL)'],
    ['loans_loaned_at_idx', '(loaned_at)'],
    ['readers_email_lower_key', 'UNIQUE INDEX'],
  ]) {
    expect(indexes.rows.find((row) => row.indexname === name)?.indexdef).toContain(definition);
  }
  const keys = await pool.query(`
    SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
    WHERE conrelid = 'loans'::regclass AND contype = 'f' ORDER BY conname
  `);
  expect(keys.rows.map((row) => row.definition)).toEqual([
    'FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE RESTRICT',
    'FOREIGN KEY (reader_id) REFERENCES readers(id) ON DELETE RESTRICT',
  ]);
});

it('sets defaults and accepts the allowed statuses', async () => {
  await runMigrations(pool);
  await insertFixtures();
  const books = await pool.query('SELECT * FROM books');
  expect(books.rows[0]).toMatchObject({ total_copies: 0, publication_year: null, genre: null });
  expect(books.rows[0].created_at).toBeInstanceOf(Date);
  expect(books.rows[0].updated_at).toBeInstanceOf(Date);
  const readers = await pool.query('SELECT * FROM readers');
  expect(readers.rows[0].status).toBe('active');
  expect(readers.rows[0].created_at).toBeInstanceOf(Date);
  expect(readers.rows[0].updated_at).toBeInstanceOf(Date);
  const loans = await pool.query('SELECT * FROM loans');
  expect(loans.rows[0]).toMatchObject({ status: 'active', returned_at: null, fine_amount: '0.00' });
  expect(loans.rows[0].loaned_at).toBeInstanceOf(Date);
  expect(loans.rows[0].created_at).toBeInstanceOf(Date);
  for (const status of ['active', 'blocked']) await pool.query('UPDATE readers SET status = $1', [status]);
  for (const status of ['active', 'overdue', 'returned']) await pool.query('UPDATE loans SET status = $1', [status]);
});

it.each([
  ['duplicate ISBN', '23505', "INSERT INTO books (title, authors, isbn) VALUES ('Other', ARRAY['Author'], '9780000000001')"],
  ['email ignoring case', '23505', "INSERT INTO readers (full_name, email, registration_number) VALUES ('Other', 'reader@EXAMPLE.COM', 'TEST-2')"],
  ['registration number', '23505', "INSERT INTO readers (full_name, email, registration_number) VALUES ('Other', 'other@example.com', 'TEST-1')"],
  ['negative copies', '23514', 'UPDATE books SET total_copies = -1'],
  ['empty authors', '23514', "UPDATE books SET authors = ARRAY[]::text[]"],
  ['empty title', '23514', "UPDATE books SET title = ' '"],
  ['empty ISBN', '23514', "UPDATE books SET isbn = ''"],
  ['empty full name', '23514', "UPDATE readers SET full_name = ''"],
  ['empty email', '23514', "UPDATE readers SET email = ''"],
  ['empty registration number', '23514', "UPDATE readers SET registration_number = ''"],
  ['invalid reader status', '23514', "UPDATE readers SET status = 'unknown'"],
  ['invalid loan status', '23514', "UPDATE loans SET status = 'unknown'"],
  ['negative fine', '23514', 'UPDATE loans SET fine_amount = -0.01'],
  ['missing book', '23503', 'INSERT INTO loans (book_id, reader_id, due_date) SELECT -1, id, CURRENT_DATE + 14 FROM readers'],
  ['missing reader', '23503', 'INSERT INTO loans (book_id, reader_id, due_date) SELECT id, -1, CURRENT_DATE + 14 FROM books'],
  ['book deletion with history', '23503', 'DELETE FROM books'],
  ['reader deletion with history', '23503', 'DELETE FROM readers'],
  ['NULL authors', '23502', 'UPDATE books SET authors = NULL'],
  ['NULL copies', '23502', 'UPDATE books SET total_copies = NULL'],
  ['NULL reader status', '23502', 'UPDATE readers SET status = NULL'],
  ['NULL book reference', '23502', 'UPDATE loans SET book_id = NULL'],
  ['NULL due date', '23502', 'UPDATE loans SET due_date = NULL'],
  ['NULL fine', '23502', 'UPDATE loans SET fine_amount = NULL'],
])('rejects %s', async (_name, code, sql) => {
  await runMigrations(pool);
  await insertFixtures();
  await expect(pool.query(sql)).rejects.toMatchObject({ code });
});

it('does not change existing tables, data or migration timestamps on a repeated run', async () => {
  await runMigrations(pool);
  await insertFixtures();
  const before = await pool.query('SELECT * FROM schema_migrations');
  const tablesBefore = await pool.query("SELECT oid FROM pg_class WHERE relnamespace = current_schema()::regnamespace ORDER BY oid");
  await runMigrations(pool);
  expect((await pool.query('SELECT * FROM schema_migrations')).rows).toEqual(before.rows);
  expect((await pool.query("SELECT oid FROM pg_class WHERE relnamespace = current_schema()::regnamespace ORDER BY oid")).rows).toEqual(tablesBefore.rows);
  expect((await pool.query('SELECT count(*) FROM loans')).rows[0].count).toBe('1');
});

it('serializes simultaneous migration runners', async () => {
  await Promise.all([runMigrations(pool), runMigrations(pool)]);
  expect((await pool.query('SELECT filename FROM schema_migrations')).rows).toEqual([
    { filename: '001_initial_schema.sql' },
  ]);
});

it('rolls back a failed file, stops before the next file and can retry after correction', async () => {
  fixtureDirectory = await mkdtemp(join(tmpdir(), 'web-maga-migrations-'));
  // Файлы записаны не по порядку: исполнитель должен отсортировать имена.
  await writeFile(join(fixtureDirectory, '003_after.sql'), 'CREATE TABLE after_probe (id INTEGER);');
  await writeFile(join(fixtureDirectory, '002_broken.sql'), 'CREATE TABLE rollback_probe (id INTEGER); SELECT * FROM missing_table;');
  await writeFile(join(fixtureDirectory, '001_before.sql'), 'CREATE TABLE before_probe (id INTEGER);');
  await expect(runMigrations(pool, fixtureDirectory)).rejects.toMatchObject({ code: '42P01' });
  const applied = await pool.query('SELECT * FROM schema_migrations');
  expect(applied.rows.map((row) => row.filename)).toEqual(['001_before.sql']);
  expect((await pool.query("SELECT to_regclass('rollback_probe') AS probe, to_regclass('after_probe') AS later")).rows[0]).toEqual({ probe: null, later: null });
  await writeFile(join(fixtureDirectory, '002_broken.sql'), 'CREATE TABLE rollback_probe (id INTEGER);');
  await runMigrations(pool, fixtureDirectory);
  expect((await pool.query('SELECT filename FROM schema_migrations ORDER BY filename')).rows.map((row) => row.filename)).toEqual([
    '001_before.sql', '002_broken.sql', '003_after.sql',
  ]);
  expect((await pool.query("SELECT * FROM schema_migrations WHERE filename = '001_before.sql'")).rows).toEqual(applied.rows);
});

it('closes connections and exits successfully when run as a CLI', async () => {
  const script = fileURLToPath(new URL('../src/db/run-migrations.js', import.meta.url));
  const result = await exec(process.execPath, [script], {
    env: { ...process.env, DATABASE_URL: testUrl, PGOPTIONS: `-c search_path=${schema}` },
    timeout: 5000,
  });
  expect(result.stdout).toContain('Applied migration: 001_initial_schema.sql');
  expect((await pool.query('SELECT count(*) FROM schema_migrations')).rows[0].count).toBe('1');
});
