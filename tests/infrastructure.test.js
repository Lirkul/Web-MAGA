import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import test from 'node:test';
import { createApp } from '../src/app.js';
import { openDatabase } from '../src/db/database.js';
import { migrateDatabase } from '../src/db/migrate.js';

function databaseFixture(context) {
  const directory = mkdtempSync(join(tmpdir(), 'library-stage1-'));
  const path = join(directory, 'nested', 'test.sqlite');
  const database = openDatabase(path);
  context.after(() => {
    if (database.open) database.close();
    rmSync(directory, { recursive: true, force: true });
  });
  migrateDatabase(database);
  return { database, path };
}

function insertBook(database, changes = {}) {
  return database.prepare(`
    INSERT INTO books (title, authors, isbn, publishedYear, genre, totalCopies)
    VALUES (@title, @authors, @isbn, @publishedYear, @genre, @totalCopies)
  `).run({
    title: 'Учебная книга', authors: '["Автор Один","Автор Два"]',
    isbn: '9785170906304', publishedYear: 2020, genre: 'Наука', totalCopies: 2,
    ...changes,
  }).lastInsertRowid;
}

function insertReader(database, changes = {}) {
  return database.prepare(`
    INSERT INTO readers (fullName, email, registrationNumber)
    VALUES (@fullName, @email, @registrationNumber)
  `).run({
    fullName: 'Иван Иванов', email: 'reader@example.com', registrationNumber: 'R-0001',
    ...changes,
  }).lastInsertRowid;
}

function constraintViolation(action) {
  assert.throws(action, (error) => error.code?.startsWith('SQLITE_CONSTRAINT'));
}

test('migrations create the schema and indexes, repeat safely and preserve data on reopen', (context) => {
  const { database, path } = databaseFixture(context);
  const tables = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all().map((row) => row.name);
  assert.deepEqual(tables, ['books', 'loans', 'readers', 'schema_migrations']);
  assert.equal(database.pragma('foreign_keys', { simple: true }), 1);
  assert.equal(database.pragma('table_info(books)').some((column) => column.name === 'availableCopies'), false);
  assert.equal(database.pragma('index_list(loans)').length, 4);

  insertBook(database);
  const migrations = database.prepare('SELECT * FROM schema_migrations').all();
  assert.equal(migrateDatabase(database), 0);
  assert.deepEqual(database.prepare('SELECT * FROM schema_migrations').all(), migrations);
  database.close();

  const reopened = openDatabase(path);
  try {
    assert.equal(migrateDatabase(reopened), 0);
    assert.equal(reopened.prepare('SELECT count(*) AS count FROM books').get().count, 1);
    assert.equal(reopened.pragma('foreign_keys', { simple: true }), 1);
    assert.equal(reopened.pragma('integrity_check', { simple: true }), 'ok');
    assert.deepEqual(reopened.pragma('foreign_key_check'), []);
  } finally {
    reopened.close();
  }
});

test('book constraints reject duplicates, malformed JSON, invalid authors, ISBN, year and quantities', (context) => {
  const { database } = databaseFixture(context);
  insertBook(database);
  constraintViolation(() => insertBook(database));

  const invalidBooks = [
    { title: '' }, { title: ' ' }, { title: 'a'.repeat(256) },
    { authors: 'invalid json' }, { authors: '{}' }, { authors: '[]' },
    { authors: '[123]' }, { authors: '[null]' }, { authors: '[""]' },
    { authors: '["Автор", false]' }, { isbn: '978-5170906304' }, { isbn: 'abcdefghijklm' },
    { publishedYear: 1449 }, { publishedYear: new Date().getUTCFullYear() + 2 },
    { publishedYear: 2020.5 }, { genre: '' }, { genre: 'a'.repeat(101) },
    { totalCopies: 0 }, { totalCopies: -1 }, { totalCopies: 1.5 },
  ];
  for (const invalid of invalidBooks) {
    constraintViolation(() => insertBook(database, { isbn: '9785000000009', ...invalid }));
  }
  insertBook(database, { isbn: '123456789X', publishedYear: new Date().getUTCFullYear() + 1 });
  constraintViolation(() => database.prepare('UPDATE books SET isArchived = 2').run());
  constraintViolation(() => database.prepare('UPDATE books SET authors = ?').run('[null]'));
  constraintViolation(() => database.prepare('UPDATE books SET publishedYear = ?')
    .run(new Date().getUTCFullYear() + 2));
});

test('reader constraints enforce case-insensitive email, registration number and status', (context) => {
  const { database } = databaseFixture(context);
  insertReader(database);
  constraintViolation(() => insertReader(database, { email: 'READER@EXAMPLE.COM', registrationNumber: 'R-2' }));
  constraintViolation(() => insertReader(database, { email: 'other@example.com' }));
  constraintViolation(() => insertReader(database, { email: 'invalid', registrationNumber: 'R-2' }));
  constraintViolation(() => insertReader(database, { fullName: 'A', email: 'other@example.com', registrationNumber: 'R-2' }));
  constraintViolation(() => insertReader(database, { email: 'other@example.com', registrationNumber: ' ' }));
  constraintViolation(() => database.prepare("UPDATE readers SET status = 'UNKNOWN'").run());
  assert.equal(database.prepare('SELECT status FROM readers').get().status, 'ACTIVE');
});

test('loan constraints protect references, history, statuses, dates and integer fines', (context) => {
  const { database } = databaseFixture(context);
  const bookId = insertBook(database);
  const readerId = insertReader(database);
  const insertLoan = database.prepare('INSERT INTO loans (bookId, readerId, dueDate) VALUES (?, ?, ?)');
  insertLoan.run(bookId, readerId, '2026-11-10');
  constraintViolation(() => insertLoan.run(999, readerId, '2026-11-10'));
  constraintViolation(() => insertLoan.run(bookId, 999, '2026-11-10'));
  constraintViolation(() => insertLoan.run(bookId, readerId, '2026-02-30'));
  constraintViolation(() => insertLoan.run(bookId, readerId, '10-11-2026'));
  constraintViolation(() => database.prepare('DELETE FROM books WHERE id = ?').run(bookId));
  constraintViolation(() => database.prepare('DELETE FROM readers WHERE id = ?').run(readerId));
  constraintViolation(() => database.prepare('UPDATE loans SET fineAmount = -1').run());
  constraintViolation(() => database.prepare('UPDATE loans SET fineAmount = 1.5').run());
  constraintViolation(() => database.prepare("UPDATE loans SET status = 'UNKNOWN'").run());
  constraintViolation(() => database.prepare("UPDATE loans SET status = 'RETURNED'").run());

  const loan = database.prepare('SELECT * FROM loans').get();
  assert.equal(loan.status, 'ACTIVE');
  assert.equal(loan.fineAmount, 0);
  assert.equal(loan.returnedAt, null);
  assert.match(loan.loanedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

  database.prepare("UPDATE loans SET status = 'RETURNED', returnedAt = ?").run('2026-11-01T12:00:00.000Z');
  constraintViolation(() => database.prepare('DELETE FROM books WHERE id = ?').run(bookId));
  constraintViolation(() => database.prepare('DELETE FROM readers WHERE id = ?').run(readerId));
});

test('creation defaults and update triggers maintain UTC timestamps', (context) => {
  const { database } = databaseFixture(context);
  insertBook(database);
  insertReader(database);
  for (const table of ['books', 'readers']) {
    const row = database.prepare(`SELECT * FROM ${table}`).get();
    assert.match(row.createdAt, /Z$/);
    assert.match(row.updatedAt, /Z$/);
    // Известная старая метка позволяет проверить триггер без ожидания часов.
    database.prepare(`UPDATE ${table} SET updatedAt = ?`).run('2000-01-01T00:00:00.000Z');
  }
  database.prepare('UPDATE books SET title = ?').run('Новое название');
  database.prepare('UPDATE readers SET fullName = ?').run('Пётр Петров');
  assert.equal(database.prepare('SELECT isArchived FROM books').get().isArchived, 0);
  assert.notEqual(database.prepare('SELECT updatedAt FROM books').get().updatedAt, '2000-01-01T00:00:00.000Z');
  assert.notEqual(database.prepare('SELECT updatedAt FROM readers').get().updatedAt, '2000-01-01T00:00:00.000Z');
});

test('HTTP health, unknown routes and invalid JSON return the expected responses', async (context) => {
  const { database } = databaseFixture(context);
  const app = createApp(database);
  const server = app.listen(0, '127.0.0.1');
  context.after(() => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;

  const health = await fetch(`${base}/api/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: 'ok' });

  const unknown = await fetch(`${base}/api/unknown`);
  assert.equal(unknown.status, 404);
  assert.equal((await unknown.json()).error.code, 'NOT_FOUND');

  const malformed = await fetch(`${base}/api/health`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{',
  });
  assert.equal(malformed.status, 400);
  assert.deepEqual(await malformed.json(), {
    error: { code: 'INVALID_JSON', message: 'Некорректный JSON', details: {} },
  });
});
