import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../src/app.js';
import { openDatabase } from '../../src/db/database.js';
import { migrateDatabase } from '../../src/db/migrate.js';

export async function apiFixture(context, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'library-api-'));
  const path = join(directory, 'test.sqlite');
  const database = openDatabase(path);
  migrateDatabase(database);
  const server = createApp(database, options).listen(0, '127.0.0.1');
  context.after(async () => {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    if (database.open) database.close();
    rmSync(directory, { recursive: true, force: true });
  });
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;

  async function request(method, route, body, expectedStatus = 200) {
    const response = await fetch(`${base}/api${route}`, {
      method,
      ...(body !== undefined ? {
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      } : {}),
    });
    const content = await response.text();
    assert.equal(response.status, expectedStatus, `${method} ${route}: ${content}`);
    if (expectedStatus === 204) {
      assert.equal(content, '');
      return { headers: response.headers };
    }
    assert.match(response.headers.get('content-type'), /application\/json/);
    return { data: JSON.parse(content), headers: response.headers };
  }

  let bookNumber = 0;
  let readerNumber = 0;
  async function book(changes = {}) {
    bookNumber += 1;
    return (await request('POST', '/books', {
      title: 'Учебная книга', authors: ['Автор Один', 'Автор Два'],
      isbn: `978${String(bookNumber).padStart(10, '0')}`,
      publishedYear: 2020, genre: 'Наука', totalCopies: 3, ...changes,
    }, 201)).data;
  }
  async function reader(changes = {}) {
    readerNumber += 1;
    return (await request('POST', '/readers', {
      fullName: 'Иван Иванов', email: `reader${readerNumber}@example.com`,
      registrationNumber: `R-${readerNumber}`, ...changes,
    }, 201)).data;
  }

  // SQL-фикстуры позволяют проверить исторические и просроченные записи без cron.
  function loan(bookId, readerId, status = 'ACTIVE', loanedAt = '2026-10-01T12:00:00.000Z', fields = {}) {
    return database.prepare(`
      INSERT INTO loans (bookId, readerId, dueDate, status, returnedAt, loanedAt, fineAmount)
      VALUES (@bookId, @readerId, @dueDate, @status, @returnedAt, @loanedAt, @fineAmount)
    `).run({
      bookId, readerId, status, loanedAt, dueDate: '2026-11-10', fineAmount: 0,
      returnedAt: status === 'RETURNED' ? '2026-10-20T12:00:00.000Z' : null,
      ...fields,
    }).lastInsertRowid;
  }

  return { request, book, reader, loan, database, path };
}
