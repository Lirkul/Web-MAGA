import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { Worker } from 'node:worker_threads';
import { config } from '../src/config/index.js';
import { apiFixture } from './support/api-fixture.js';

const timestamp = '2026-10-27T23:30:00.000Z';

async function fixture(context, settings = {}) {
  const clock = { value: timestamp };
  const api = await apiFixture(context, {
    now: () => new Date(clock.value),
    settings: { ...config, maxActiveLoans: 5, defaultLoanDays: 14, ...settings },
  });
  return { ...api, clock };
}

async function issue(api, bookId, readerId, dueDate) {
  return (await api.request('POST', '/loans', { bookId, readerId, ...(dueDate ? { dueDate } : {}) }, 201)).data;
}

async function race(context, path, operations, settings = {}) {
  const start = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  const workers = operations.map((operation) => {
    const worker = new Worker(new URL('./support/loans-worker.js', import.meta.url), {
      workerData: { path, start, timestamp, settings, ...operation },
    });
    context.after(() => worker.terminate());
    return { worker, exit: once(worker, 'exit') };
  });
  await Promise.all(workers.map(async ({ worker }) => {
    const [message] = await once(worker, 'message');
    assert.equal(message.ready, true);
  }));
  // Подписываемся на результаты до одновременного разрешения обеих операций.
  const results = workers.map(({ worker }) => once(worker, 'message'));
  Atomics.store(new Int32Array(start), 0, 1);
  Atomics.notify(new Int32Array(start), 0, workers.length);
  const messages = await Promise.all(results);
  await Promise.all(workers.map(({ exit }) => exit));
  return messages.map(([message]) => message);
}

test('issuing creates an ACTIVE SQL record, uses a UTC deadline and updates book/history reads', async (context) => {
  const api = await fixture(context);
  const book = await api.book({ totalCopies: 2 });
  const reader = await api.reader();
  const { data: loan, headers } = await api.request('POST', '/loans', { bookId: book.id, readerId: reader.id }, 201);
  assert.equal(headers.get('location'), `/api/loans/${loan.id}`);
  assert.equal(loan.bookId, book.id);
  assert.equal(loan.readerId, reader.id);
  assert.equal(loan.status, 'ACTIVE');
  assert.equal(loan.loanedAt, timestamp);
  assert.equal(loan.dueDate, '2026-11-10');
  assert.equal(loan.returnedAt, null);
  assert.equal(loan.fineAmount, 0);
  assert.deepEqual((await api.request('GET', `/loans/${loan.id}`)).data, loan);
  assert.deepEqual(api.database.prepare('SELECT * FROM loans WHERE id = ?').get(loan.id), loan);
  const details = (await api.request('GET', `/books/${book.id}`)).data;
  assert.equal(details.totalCopies, 2);
  assert.equal(details.availableCopies, 1);
  const history = (await api.request('GET', `/readers/${reader.id}/loans`)).data;
  assert.equal(history.total, 1);
  assert.equal(history.items[0].id, loan.id);
});

test('the last copy can be issued and further attempts return 409 without extra records', async (context) => {
  const api = await fixture(context);
  const book = await api.book({ totalCopies: 1 });
  const firstReader = await api.reader();
  const secondReader = await api.reader();
  await issue(api, book.id, firstReader.id);
  const conflict = (await api.request('POST', '/loans', { bookId: book.id, readerId: secondReader.id }, 409)).data;
  assert.equal(conflict.error.code, 'BOOK_UNAVAILABLE');
  assert.equal(api.database.prepare('SELECT count(*) AS count FROM loans').get().count, 1);
  assert.equal((await api.request('GET', `/books/${book.id}`)).data.availableCopies, 0);
  assert.equal((await api.request('GET', '/books?availableOnly=true')).data.total, 0);
});

test('creation validates JSON fields, IDs and real calendar dates before writing', async (context) => {
  const api = await fixture(context);
  const book = await api.book();
  const reader = await api.reader();
  const valid = { bookId: book.id, readerId: reader.id };
  const invalid = [undefined, null, [], {}, { ...valid, bookId: 0 }, { ...valid, bookId: -1 },
    { ...valid, readerId: 1.5 }, { ...valid, bookId: '1' }, { ...valid, readerId: true },
    { ...valid, bookId: Number.MAX_SAFE_INTEGER + 1 }, { ...valid, id: 1 },
    { ...valid, status: 'RETURNED' }, { ...valid, returnedAt: timestamp },
    { ...valid, loanedAt: timestamp }, { ...valid, fineAmount: 0 }];
  for (const dueDate of [null, 20261110, '2026-02-30', '2025-02-29', '2026-11-31',
    '2026-00-10', '2026-13-01', '2026-11-00', '2026-1-01', '10-11-2026',
    '2026-11-10T00:00:00Z', ' 2026-11-10', '']) {
    invalid.push({ ...valid, dueDate });
  }
  for (const body of invalid) {
    const error = (await api.request('POST', '/loans', body, 400)).data.error;
    assert.equal(error.code, 'VALIDATION_ERROR');
    assert.ok(error.details.issues.length > 0);
  }
  assert.equal(api.database.prepare('SELECT count(*) AS count FROM loans').get().count, 0);
});

test('explicit dueDate must be after the UTC calendar date and remains unchanged', async (context) => {
  const api = await fixture(context);
  const book = await api.book();
  const reader = await api.reader();
  // В Томске уже 28 октября, но календарная дата выдачи UTC ещё 27 октября.
  api.clock.value = '2026-10-28T00:30:00+07:00';
  for (const dueDate of ['2026-10-26', '2026-10-27']) {
    const error = (await api.request('POST', '/loans', { bookId: book.id, readerId: reader.id, dueDate }, 400)).data.error;
    assert.equal(error.code, 'INVALID_DUE_DATE');
    assert.equal(error.details.today, '2026-10-27');
  }
  const loan = await issue(api, book.id, reader.id, '2026-10-28');
  assert.equal(loan.dueDate, '2026-10-28');
  assert.equal(loan.loanedAt, '2026-10-27T17:30:00.000Z');
});

test('default deadlines cross month/year/leap boundaries using UTC calendar days', async (context) => {
  const api = await fixture(context);
  const book = await api.book({ totalCopies: 5 });
  const reader = await api.reader();
  for (const [now, expected] of [
    ['2026-12-25T23:59:59.000Z', '2027-01-08'],
    ['2028-02-20T20:00:00.000Z', '2028-03-05'],
    ['2026-03-25T23:30:00-04:00', '2026-04-09'],
  ]) {
    api.clock.value = now;
    const loan = await issue(api, book.id, reader.id);
    assert.equal(loan.dueDate, expected);
    await api.request('POST', `/loans/${loan.id}/return`);
  }
  api.clock.value = '2028-02-28T23:59:59.000Z';
  assert.equal((await issue(api, book.id, reader.id, '2028-02-29')).dueDate, '2028-02-29');
});

test('missing book/reader, archived books and blocked readers reject issuance without side effects', async (context) => {
  const api = await fixture(context);
  const book = await api.book();
  const reader = await api.reader();
  assert.equal((await api.request('POST', '/loans', { bookId: 9999, readerId: reader.id }, 404)).data.error.code, 'BOOK_NOT_FOUND');
  assert.equal((await api.request('POST', '/loans', { bookId: book.id, readerId: 9999 }, 404)).data.error.code, 'READER_NOT_FOUND');
  await api.request('PATCH', `/books/${book.id}`, { isArchived: true });
  assert.equal((await api.request('POST', '/loans', { bookId: book.id, readerId: reader.id }, 409)).data.error.code, 'BOOK_ARCHIVED');
  await api.request('PATCH', `/books/${book.id}`, { isArchived: false });
  await api.request('PATCH', `/readers/${reader.id}`, { status: 'BLOCKED' });
  assert.equal((await api.request('POST', '/loans', { bookId: book.id, readerId: reader.id }, 409)).data.error.code, 'READER_BLOCKED');
  assert.equal(api.database.prepare('SELECT count(*) AS count FROM loans').get().count, 0);
  assert.equal((await api.request('GET', `/books/${book.id}`)).data.availableCopies, book.totalCopies);
  await api.request('PATCH', `/readers/${reader.id}`, { status: 'ACTIVE' });
  await issue(api, book.id, reader.id);
});

test('an overdue ACTIVE record blocks new loans even before cron updates its status', async (context) => {
  const api = await fixture(context);
  const oldBook = await api.book();
  const nextBook = await api.book();
  const reader = await api.reader();
  const overdueId = api.loan(oldBook.id, reader.id, 'ACTIVE', timestamp, { dueDate: '2026-10-26' });
  const error = (await api.request('POST', '/loans', { bookId: nextBook.id, readerId: reader.id }, 409)).data.error;
  assert.equal(error.code, 'READER_OVERDUE');
  assert.equal((await api.request('GET', `/loans/${overdueId}`)).data.status, 'ACTIVE');
  await api.request('POST', `/loans/${overdueId}/return`);
  await issue(api, nextBook.id, reader.id);
});

test('a loan due today and old returned loans do not count as current overdue', async (context) => {
  const api = await fixture(context);
  const book = await api.book({ totalCopies: 10 });
  const reader = await api.reader();
  api.loan(book.id, reader.id, 'ACTIVE', timestamp, { dueDate: '2026-10-27' });
  for (let index = 0; index < 6; index += 1) {
    api.loan(book.id, reader.id, 'RETURNED', timestamp, { dueDate: '2026-10-01' });
  }
  await issue(api, book.id, reader.id);
  assert.equal((await api.request('GET', `/books/${book.id}`)).data.availableCopies, 8);
});

test('the default five-loan limit rejects the sixth loan and a return frees a place', async (context) => {
  const api = await fixture(context);
  const book = await api.book({ totalCopies: 10 });
  const reader = await api.reader();
  const loans = [];
  for (let index = 0; index < 5; index += 1) loans.push(await issue(api, book.id, reader.id));
  const error = (await api.request('POST', '/loans', { bookId: book.id, readerId: reader.id }, 409)).data.error;
  assert.equal(error.code, 'LOAN_LIMIT_REACHED');
  assert.equal(error.details.maxActiveLoans, 5);
  assert.equal(api.database.prepare("SELECT count(*) AS count FROM loans WHERE status = 'ACTIVE'").get().count, 5);
  await api.request('POST', `/loans/${loans[0].id}/return`);
  await issue(api, book.id, reader.id);
});

test('configured loan limit/deadline apply and both ACTIVE and OVERDUE consume the quota', async (context) => {
  const api = await fixture(context, { maxActiveLoans: 2, defaultLoanDays: 7 });
  const book = await api.book();
  const reader = await api.reader();
  const first = await issue(api, book.id, reader.id);
  assert.equal(first.dueDate, '2026-11-03');
  // Имитация устаревшего статуса: лимит всё равно считает невозвращённую запись.
  api.loan(book.id, reader.id, 'OVERDUE', timestamp, { dueDate: '2026-11-10' });
  const error = (await api.request('POST', '/loans', { bookId: book.id, readerId: reader.id }, 409)).data.error;
  assert.equal(error.code, 'LOAN_LIMIT_REACHED');
  assert.equal(error.details.maxActiveLoans, 2);
});

test('return restores availability once, preserves totalCopies and works after blocking/archiving', async (context) => {
  const api = await fixture(context);
  const book = await api.book({ totalCopies: 1 });
  const reader = await api.reader();
  const loan = await issue(api, book.id, reader.id);
  await api.request('PATCH', `/books/${book.id}`, { isArchived: true });
  await api.request('PATCH', `/readers/${reader.id}`, { status: 'BLOCKED' });
  api.clock.value = '2026-11-01T01:02:03.000Z';
  const returned = (await api.request('POST', `/loans/${loan.id}/return`)).data;
  assert.equal(returned.status, 'RETURNED');
  assert.equal(returned.returnedAt, api.clock.value);
  assert.equal(returned.loanedAt, timestamp);
  assert.equal(returned.dueDate, loan.dueDate);
  assert.equal(returned.fineAmount, 0);
  const details = (await api.request('GET', `/books/${book.id}`)).data;
  assert.equal(details.totalCopies, 1);
  assert.equal(details.availableCopies, 1);
  api.clock.value = '2026-11-02T00:00:00.000Z';
  assert.equal((await api.request('POST', `/loans/${loan.id}/return`, {}, 409)).data.error.code, 'LOAN_ALREADY_RETURNED');
  assert.deepEqual((await api.request('GET', `/loans/${loan.id}`)).data, returned);
});

test('return closes OVERDUE records and preserves their existing fine until stage 4', async (context) => {
  const api = await fixture(context);
  const book = await api.book();
  const reader = await api.reader();
  const id = api.loan(book.id, reader.id, 'OVERDUE', timestamp, { dueDate: '2026-10-24', fineAmount: 3000 });
  const returned = (await api.request('POST', `/loans/${id}/return`, {})).data;
  assert.equal(returned.status, 'RETURNED');
  assert.equal(returned.fineAmount, 3000);
  assert.equal(returned.returnedAt, timestamp);
  assert.equal((await api.request('GET', `/readers/${reader.id}/loans`)).data.items[0].fineAmount, 3000);
  await issue(api, book.id, reader.id);
});

test('return validation protects server-managed fields and loans have no PATCH/DELETE API', async (context) => {
  const api = await fixture(context);
  const book = await api.book();
  const reader = await api.reader();
  const loan = await issue(api, book.id, reader.id);
  for (const body of [null, [], { returnedAt: timestamp }, { status: 'RETURNED' }, { fineAmount: 0 }]) {
    assert.equal((await api.request('POST', `/loans/${loan.id}/return`, body, 400)).data.error.code, 'VALIDATION_ERROR');
  }
  assert.equal((await api.request('GET', `/loans/${loan.id}`)).data.status, 'ACTIVE');
  assert.equal((await api.request('POST', '/loans/9999/return', undefined, 404)).data.error.code, 'LOAN_NOT_FOUND');
  await api.request('PATCH', `/loans/${loan.id}`, { dueDate: '2026-11-30' }, 404);
  await api.request('DELETE', `/loans/${loan.id}`, undefined, 404);
});

test('loan list supports combined filters, stable pagination and empty results', async (context) => {
  const api = await fixture(context);
  const firstBook = await api.book();
  const secondBook = await api.book();
  const firstReader = await api.reader();
  const secondReader = await api.reader();
  const first = await issue(api, firstBook.id, firstReader.id);
  const second = await issue(api, firstBook.id, firstReader.id);
  const third = await issue(api, secondBook.id, secondReader.id);
  await api.request('POST', `/loans/${first.id}/return`);
  const overdueId = api.loan(firstBook.id, secondReader.id, 'OVERDUE', '2026-10-01T00:00:00.000Z');
  const all = (await api.request('GET', '/loans')).data;
  assert.equal(all.page, 1);
  assert.equal(all.limit, 20);
  assert.equal(all.total, 4);
  assert.deepEqual(all.items.map((item) => item.id), [third.id, second.id, first.id, overdueId]);
  const filtered = (await api.request('GET', `/loans?status=ACTIVE&bookId=${firstBook.id}&readerId=${firstReader.id}`)).data;
  assert.equal(filtered.total, 1);
  assert.equal(filtered.items[0].id, second.id);
  assert.equal((await api.request('GET', '/loans?status=OVERDUE')).data.items[0].id, overdueId);
  assert.equal((await api.request('GET', '/loans?status=RETURNED')).data.items[0].id, first.id);
  assert.equal((await api.request('GET', '/loans?page=2&limit=1')).data.items[0].id, second.id);
  assert.deepEqual((await api.request('GET', '/loans?page=9&limit=2')).data, { page: 9, limit: 2, total: 4, items: [] });
  assert.equal((await api.request('GET', '/loans?bookId=9999')).data.total, 0);
});

test('loan list/ID validation rejects invalid or ambiguous inputs', async (context) => {
  const api = await fixture(context);
  for (const query of ['page=0', 'page=1&page=2', 'limit=101', 'status=UNKNOWN', 'status=ACTIVE&status=RETURNED',
    'bookId=0', 'readerId=-1', 'bookId=1.5', 'readerId=abc', 'readerId=1&readerId=2',
    'bookId=9007199254740992', 'page=9007199254740991&limit=100', 'q=anything']) {
    assert.equal((await api.request('GET', `/loans?${query}`, undefined, 400)).data.error.code, 'VALIDATION_ERROR');
  }
  for (const id of ['0', '-1', '1.5', 'abc', '9007199254740992']) {
    await api.request('GET', `/loans/${id}`, undefined, 400);
    await api.request('POST', `/loans/${id}/return`, undefined, 400);
  }
  assert.equal((await api.request('GET', '/loans/9999', undefined, 404)).data.error.code, 'LOAN_NOT_FOUND');
});

test('real loans protect book copy reductions and availability returns after a book is returned', async (context) => {
  const api = await fixture(context);
  const book = await api.book({ totalCopies: 2 });
  const reader = await api.reader();
  const first = await issue(api, book.id, reader.id);
  await issue(api, book.id, reader.id);
  await api.request('PATCH', `/books/${book.id}`, { totalCopies: 1 }, 409);
  await api.request('DELETE', `/books/${book.id}`, undefined, 409);
  await api.request('DELETE', `/readers/${reader.id}`, undefined, 409);
  await api.request('POST', `/loans/${first.id}/return`);
  assert.equal((await api.request('GET', '/books?availableOnly=true')).data.total, 1);
  const details = (await api.request('PATCH', `/books/${book.id}`, { totalCopies: 1 })).data;
  assert.equal(details.availableCopies, 0);
  assert.equal(details.totalCopies, 1);
});

test('independent SQLite connections cannot both issue the last copy', { timeout: 15000 }, async (context) => {
  const api = await fixture(context);
  const book = await api.book({ totalCopies: 1 });
  const first = await api.reader();
  const second = await api.reader();
  const results = await race(context, api.path, [first, second].map((reader) => ({ body: { bookId: book.id, readerId: reader.id } })));
  assert.equal(results.filter((result) => result.status === 'ok').length, 1, JSON.stringify(results));
  assert.equal(results.find((result) => result.status !== 'ok').code, 'BOOK_UNAVAILABLE');
  assert.equal(api.database.prepare('SELECT count(*) AS count FROM loans').get().count, 1);
  assert.equal((await api.request('GET', `/books/${book.id}`)).data.availableCopies, 0);
});

test('independent SQLite connections cannot exceed one reader loan quota', { timeout: 15000 }, async (context) => {
  const api = await fixture(context);
  const first = await api.book();
  const second = await api.book();
  const reader = await api.reader();
  const results = await race(context, api.path, [first, second].map((book) => ({ body: { bookId: book.id, readerId: reader.id } })), { maxActiveLoans: 1 });
  assert.equal(results.filter((result) => result.status === 'ok').length, 1, JSON.stringify(results));
  assert.equal(results.find((result) => result.status !== 'ok').code, 'LOAN_LIMIT_REACHED');
  assert.equal(api.database.prepare('SELECT count(*) AS count FROM loans').get().count, 1);
});

test('concurrent returns succeed once and never increase totalCopies', { timeout: 15000 }, async (context) => {
  const api = await fixture(context);
  const book = await api.book({ totalCopies: 1 });
  const reader = await api.reader();
  const loan = await issue(api, book.id, reader.id);
  const results = await race(context, api.path, [1, 2].map(() => ({ operation: 'return', id: loan.id })));
  assert.equal(results.filter((result) => result.status === 'ok').length, 1, JSON.stringify(results));
  assert.equal(results.find((result) => result.status !== 'ok').code, 'LOAN_ALREADY_RETURNED');
  const details = (await api.request('GET', `/books/${book.id}`)).data;
  assert.equal(details.availableCopies, 1);
  assert.equal(details.totalCopies, 1);
});
