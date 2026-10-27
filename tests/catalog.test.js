import assert from 'node:assert/strict';
import test from 'node:test';
import { apiFixture } from './support/api-fixture.js';

function validationError(data) {
  assert.equal(data.error.code, 'VALIDATION_ERROR');
  assert.ok(data.error.details.issues.length > 0);
  assert.equal('stack' in data.error, false);
}

test('book CRUD normalizes values, preserves fields on PATCH and persists real SQL rows', async (context) => {
  const { request, database } = await apiFixture(context);
  const { data: book, headers } = await request('POST', '/books', {
    title: '  Преступление и наказание  ', authors: [' Фёдор Достоевский '],
    isbn: '978-5 170906304', publishedYear: 1866, genre: ' Роман ', totalCopies: 4,
  }, 201);
  assert.equal(headers.get('location'), `/api/books/${book.id}`);
  assert.equal(book.title, 'Преступление и наказание');
  assert.equal(book.genre, 'Роман');
  assert.deepEqual(book.authors, ['Фёдор Достоевский']);
  assert.equal(book.isbn, '9785170906304');
  assert.equal(book.isArchived, false);
  assert.equal(book.availableCopies, 4);
  assert.match(book.createdAt, /Z$/);
  assert.deepEqual((await request('GET', `/books/${book.id}`)).data, book);
  const stored = database.prepare('SELECT * FROM books WHERE id = ?').get(book.id);
  assert.deepEqual(JSON.parse(stored.authors), book.authors);
  assert.equal(stored.isArchived, 0);

  await request('PATCH', `/books/${book.id}`, { isArchived: true });
  const changed = (await request('PATCH', `/books/${book.id}`, { title: 'Новое название' })).data;
  assert.equal(changed.title, 'Новое название');
  assert.equal(changed.isArchived, true);
  assert.equal(changed.isbn, book.isbn);
  assert.equal(changed.createdAt, book.createdAt);
  await request('DELETE', `/books/${book.id}`, undefined, 204);
  await request('GET', `/books/${book.id}`, undefined, 404);
  await request('DELETE', `/books/${book.id}`, undefined, 404);
  await request('PATCH', `/books/${book.id}`, { title: 'Нет книги' }, 404);
  assert.equal(database.prepare('SELECT count(*) AS count FROM books').get().count, 0);
});

test('ISBN uniqueness includes normalization, applies to PATCH, and accepts ISBN-10 with X', async (context) => {
  const { book, request } = await apiFixture(context);
  const first = await book({ isbn: '9785170906304' });
  const second = await book({ isbn: '123456789x' });
  assert.equal(second.isbn, '123456789X');
  const duplicate = await request('POST', '/books', { ...{
    title: 'Дубликат', authors: ['Автор'], publishedYear: 2000, genre: 'Роман', totalCopies: 1,
  }, isbn: '978-5-17090630-4' }, 409);
  assert.equal(duplicate.data.error.code, 'ISBN_CONFLICT');
  const conflict = await request('PATCH', `/books/${second.id}`, { isbn: first.isbn, title: 'Не сохранится' }, 409);
  assert.equal(conflict.data.error.code, 'ISBN_CONFLICT');
  assert.equal((await request('GET', `/books/${second.id}`)).data.title, second.title);
  assert.equal((await request('PATCH', `/books/${first.id}`, { isbn: first.isbn })).data.isbn, first.isbn);
});

test('book body validation rejects missing, invalid and read-only fields without writes', async (context) => {
  const { request, database } = await apiFixture(context);
  const valid = {
    title: 'Книга', authors: ['Автор'], isbn: '9785170906304',
    publishedYear: 2000, genre: 'Роман', totalCopies: 1,
  };
  const invalidBodies = [
    undefined, null, [], {}, { ...valid, title: '' }, { ...valid, title: ' ' },
    { ...valid, title: 'a'.repeat(256) }, { ...valid, title: 'a\0b' },
    { ...valid, authors: [] }, { ...valid, authors: [' '] }, { ...valid, authors: [1] },
    { ...valid, authors: 'Автор' }, { ...valid, authors: [null] },
    { ...valid, isbn: 9785170906304 }, { ...valid, isbn: '123456789012' },
    { ...valid, isbn: 'X234567890' }, { ...valid, publishedYear: 1449 },
    { ...valid, publishedYear: new Date().getUTCFullYear() + 2 },
    { ...valid, publishedYear: 2000.5 }, { ...valid, publishedYear: '2000' },
    { ...valid, genre: '' }, { ...valid, genre: 'a'.repeat(101) },
    { ...valid, totalCopies: 0 }, { ...valid, totalCopies: -1 },
    { ...valid, totalCopies: 1.5 }, { ...valid, totalCopies: '2' },
    { ...valid, totalCopies: Number.MAX_SAFE_INTEGER + 1 },
    { ...valid, isArchived: 'false' }, { ...valid, id: 5 },
    { ...valid, availableCopies: 1 }, { ...valid, createdAt: '2020-01-01' },
  ];
  for (const body of invalidBodies) {
    validationError((await request('POST', '/books', body, 400)).data);
  }
  assert.equal(database.prepare('SELECT count(*) AS count FROM books').get().count, 0);
});

test('PATCH validation rejects empty or invalid book changes and allows boundary years', async (context) => {
  const { book, request } = await apiFixture(context);
  const created = await book({ publishedYear: 1450 });
  const bodies = [{}, null, [], { totalCopies: 0 }, { isbn: 'bad' }, { authors: [] },
    { updatedAt: '2000-01-01' }, { isArchived: 1 }];
  for (const body of bodies) {
    validationError((await request('PATCH', `/books/${created.id}`, body, 400)).data);
  }
  assert.equal((await request('GET', `/books/${created.id}`)).data.publishedYear, 1450);
  const nextYear = new Date().getUTCFullYear() + 1;
  assert.equal((await request('PATCH', `/books/${created.id}`, { publishedYear: nextYear })).data.publishedYear, nextYear);
});

test('book PATCH updates all writable fields and reader PATCH renormalizes email and registration', async (context) => {
  const { book, reader, request } = await apiFixture(context);
  const created = await book();
  const changes = {
    title: 'Обновлённая книга', authors: [' Новый автор ', 'Соавтор'],
    isbn: '0-12345678-x', publishedYear: 2021, genre: ' История ', totalCopies: 2, isArchived: true,
  };
  const updated = (await request('PATCH', `/books/${created.id}`, changes)).data;
  assert.deepEqual(updated.authors, ['Новый автор', 'Соавтор']);
  assert.equal(updated.isbn, '012345678X');
  assert.equal(updated.genre, 'История');
  assert.equal(updated.totalCopies, 2);
  assert.equal(updated.publishedYear, 2021);
  assert.equal(updated.availableCopies, 2);
  assert.equal(updated.isArchived, true);
  const borrower = await reader();
  const edited = (await request('PATCH', `/readers/${borrower.id}`, {
    email: ' New@Example.COM ', registrationNumber: ' NEW-NUMBER ', fullName: ' Новое Имя ',
  })).data;
  assert.equal(edited.email, 'new@example.com');
  assert.equal(edited.registrationNumber, 'NEW-NUMBER');
  assert.equal(edited.fullName, 'Новое Имя');
});

test('book search supports Cyrillic case, multiple authors, combined filters and literal SQL characters', async (context) => {
  const { book, request } = await apiFixture(context);
  const first = await book({ title: 'Атом', genre: 'Наука', authors: ['Иван Петров', 'Анна Сидорова'] });
  await book({ title: 'Яблоко', genre: 'Роман', authors: ['Другой автор'] });
  const third = await book({ title: 'АТОМНЫЙ МИР', genre: 'Наука', authors: ['Иван Петров'] });
  const matching = (await request('GET', '/books?q=аТоМ&genre=НАУКА&author=пЕтРоВ')).data;
  assert.equal(matching.total, 2);
  assert.deepEqual(matching.items.map((item) => item.id), [first.id, third.id]);
  assert.equal((await request('GET', '/books?author=сидорова')).data.total, 1);
  assert.equal((await request('GET', '/books?q=Петров')).data.total, 0);
  const isbnQuery = encodeURIComponent(`${first.isbn.slice(0, 3)}-${first.isbn.slice(3)}`);
  assert.equal((await request('GET', `/books?q=${isbnQuery}`)).data.items[0].id, first.id);
  assert.equal((await request('GET', '/books?q=---')).data.total, 0);
  for (const term of ["' OR 1=1 --", '%', '_']) {
    assert.equal((await request('GET', `/books?q=${encodeURIComponent(term)}`)).data.total, 0);
  }
  const special = await book({ title: "100%_O'Reilly" });
  assert.equal((await request('GET', '/books?q=%25_')).data.items[0].id, special.id);
});

test('book pagination has stable title/id order, defaults, totals and empty distant pages', async (context) => {
  const { book, request } = await apiFixture(context);
  await book({ title: 'Бета' });
  const firstAlpha = await book({ title: 'Альфа' });
  const secondAlpha = await book({ title: 'Альфа' });
  await book({ title: 'Янтарь' });
  const defaults = (await request('GET', '/books')).data;
  assert.equal(defaults.page, 1);
  assert.equal(defaults.limit, 20);
  assert.equal(defaults.total, 4);
  assert.deepEqual(defaults.items.slice(0, 2).map((item) => item.id), [firstAlpha.id, secondAlpha.id]);
  const page = (await request('GET', '/books?page=2&limit=1')).data;
  assert.equal(page.page, 2);
  assert.equal(page.limit, 1);
  assert.equal(page.total, 4);
  assert.equal(page.items[0].id, secondAlpha.id);
  assert.deepEqual((await request('GET', '/books?page=9&limit=2')).data, {
    page: 9, limit: 2, total: 4, items: [],
  });
});

test('availableOnly uses SQL loan counts and excludes archived or exhausted books', async (context) => {
  const { book, reader, loan, request } = await apiFixture(context);
  const borrower = await reader();
  const available = await book({ totalCopies: 3 });
  const exhausted = await book({ totalCopies: 1 });
  await book({ isArchived: true });
  loan(available.id, borrower.id, 'ACTIVE');
  loan(available.id, borrower.id, 'OVERDUE');
  loan(available.id, borrower.id, 'RETURNED');
  loan(exhausted.id, borrower.id);
  const details = (await request('GET', `/books/${available.id}`)).data;
  assert.equal(details.availableCopies, 1);
  assert.equal(details.totalCopies, 3);
  assert.deepEqual((await request('GET', '/books?availableOnly=true')).data.items.map((item) => item.id), [available.id]);
  assert.equal((await request('GET', '/books?availableOnly=false')).data.total, 3);
});

test('book edits protect outstanding copies and delete protects every kind of loan history', async (context) => {
  const { book, reader, loan, request } = await apiFixture(context);
  const borrower = await reader();
  const inUse = await book({ totalCopies: 3 });
  loan(inUse.id, borrower.id, 'ACTIVE');
  loan(inUse.id, borrower.id, 'OVERDUE');
  loan(inUse.id, borrower.id, 'RETURNED');
  const conflict = (await request('PATCH', `/books/${inUse.id}`, { totalCopies: 1 }, 409)).data;
  assert.equal(conflict.error.code, 'COPIES_IN_USE');
  assert.equal(conflict.error.details.minimumCopies, 2);
  assert.equal((await request('GET', `/books/${inUse.id}`)).data.totalCopies, 3);
  assert.equal((await request('PATCH', `/books/${inUse.id}`, { totalCopies: 2 })).data.availableCopies, 0);
  await request('PATCH', `/books/${inUse.id}`, { isArchived: true });
  for (const status of ['ACTIVE', 'OVERDUE', 'RETURNED']) {
    const linked = await book();
    loan(linked.id, borrower.id, status);
    const deleted = (await request('DELETE', `/books/${linked.id}`, undefined, 409)).data;
    assert.equal(deleted.error.code, 'BOOK_HAS_LOANS');
    assert.match(deleted.error.message, /архивируйте/);
    await request('GET', `/books/${linked.id}`);
  }
});

test('reader CRUD normalizes email, changes status, preserves PATCH fields and deletes', async (context) => {
  const { request, database } = await apiFixture(context);
  const { data: reader, headers } = await request('POST', '/readers', {
    fullName: ' Иван Иванов ', email: ' Reader@Example.COM ', registrationNumber: ' R-0001 ',
  }, 201);
  assert.equal(headers.get('location'), `/api/readers/${reader.id}`);
  assert.equal(reader.fullName, 'Иван Иванов');
  assert.equal(reader.email, 'reader@example.com');
  assert.equal(reader.registrationNumber, 'R-0001');
  assert.equal(reader.status, 'ACTIVE');
  assert.equal(database.prepare('SELECT email FROM readers WHERE id = ?').get(reader.id).email, reader.email);
  assert.deepEqual((await request('GET', `/readers/${reader.id}`)).data, reader);
  await request('PATCH', `/readers/${reader.id}`, { status: 'BLOCKED' });
  const changed = (await request('PATCH', `/readers/${reader.id}`, { fullName: 'Пётр Петров' })).data;
  assert.equal(changed.status, 'BLOCKED');
  assert.equal(changed.email, reader.email);
  assert.equal(changed.createdAt, reader.createdAt);
  assert.equal((await request('PATCH', `/readers/${reader.id}`, { status: 'ACTIVE' })).data.status, 'ACTIVE');
  assert.deepEqual((await request('GET', `/readers/${reader.id}/loans`)).data, {
    page: 1, limit: 20, total: 0, items: [],
  });
  await request('DELETE', `/readers/${reader.id}`, undefined, 204);
  await request('GET', `/readers/${reader.id}`, undefined, 404);
  await request('DELETE', `/readers/${reader.id}`, undefined, 404);
  await request('PATCH', `/readers/${reader.id}`, { fullName: 'Нет читателя' }, 404);
});

test('reader email and registration uniqueness protect POST/PATCH and failed updates are atomic', async (context) => {
  const { reader, request } = await apiFixture(context);
  const first = await reader();
  const second = await reader();
  const emailConflict = (await request('POST', '/readers', {
    fullName: 'Другой читатель', email: first.email.toUpperCase(), registrationNumber: 'unique',
  }, 409)).data;
  assert.equal(emailConflict.error.code, 'EMAIL_CONFLICT');
  const numberConflict = (await request('POST', '/readers', {
    fullName: 'Другой читатель', email: 'other@example.com', registrationNumber: first.registrationNumber,
  }, 409)).data;
  assert.equal(numberConflict.error.code, 'REGISTRATION_NUMBER_CONFLICT');
  assert.equal((await request('PATCH', `/readers/${second.id}`, {
    email: first.email.toUpperCase(), fullName: 'Не сохранится',
  }, 409)).data.error.code, 'EMAIL_CONFLICT');
  assert.equal((await request('PATCH', `/readers/${second.id}`, {
    registrationNumber: first.registrationNumber,
  }, 409)).data.error.code, 'REGISTRATION_NUMBER_CONFLICT');
  assert.deepEqual((await request('GET', `/readers/${second.id}`)).data, second);
  await request('PATCH', `/readers/${first.id}`, { email: first.email, registrationNumber: first.registrationNumber });
});

test('reader validation rejects invalid inputs and empty PATCH requests', async (context) => {
  const { reader, request } = await apiFixture(context);
  const valid = { fullName: 'Иван Иванов', email: 'reader@example.com', registrationNumber: 'R-0001' };
  const bodies = [undefined, null, [], {}, { ...valid, fullName: 'A' },
    { ...valid, fullName: ' '.repeat(2) }, { ...valid, fullName: 'A'.repeat(201) },
    { ...valid, email: 'invalid' }, { ...valid, email: 'a@@example.com' },
    { ...valid, email: 'a @example.com' }, { ...valid, email: 123 },
    { ...valid, registrationNumber: '' }, { ...valid, registrationNumber: 1 },
    { ...valid, status: 'UNKNOWN' }, { ...valid, id: 1 }, { ...valid, createdAt: 'now' }];
  for (const body of bodies) {
    validationError((await request('POST', '/readers', body, 400)).data);
  }
  const created = await reader();
  for (const body of [{}, null, [], { status: 'UNKNOWN' }, { email: 'invalid' }, { id: 99 }]) {
    validationError((await request('PATCH', `/readers/${created.id}`, body, 400)).data);
  }
});

test('reader list searches name/email/registration, combines status and paginates stably', async (context) => {
  const { reader, request } = await apiFixture(context);
  const first = await reader({ fullName: 'Анна Иванова', status: 'BLOCKED', registrationNumber: 'ЧИТ-0001' });
  const second = await reader({ fullName: 'Анна Иванова' });
  await reader({ fullName: 'Пётр Петров' });
  const matches = (await request('GET', '/readers?q=иВаНоВа&status=BLOCKED')).data;
  assert.equal(matches.total, 1);
  assert.equal(matches.items[0].id, first.id);
  assert.equal((await request('GET', `/readers?q=${encodeURIComponent(first.email.toUpperCase())}`)).data.total, 1);
  assert.equal((await request('GET', '/readers?q=чит-0001')).data.items[0].id, first.id);
  assert.equal((await request('GET', '/readers?page=2&limit=1')).data.items[0].id, second.id);
  assert.deepEqual((await request('GET', '/readers?page=9&limit=2')).data, {
    page: 9, limit: 2, total: 3, items: [],
  });
  for (const term of ["' OR 1=1 --", '%', '_']) {
    assert.equal((await request('GET', `/readers?q=${encodeURIComponent(term)}`)).data.total, 0);
  }
});

test('reader deletion protects active, overdue and returned history and allows blocking', async (context) => {
  const { book, reader, loan, request } = await apiFixture(context);
  const linkedBook = await book();
  for (const status of ['ACTIVE', 'OVERDUE', 'RETURNED']) {
    const borrower = await reader();
    loan(linkedBook.id, borrower.id, status);
    const conflict = (await request('DELETE', `/readers/${borrower.id}`, undefined, 409)).data;
    assert.equal(conflict.error.code, 'READER_HAS_LOANS');
    assert.match(conflict.error.message, /заблокируйте/);
    await request('GET', `/readers/${borrower.id}`);
    assert.equal((await request('PATCH', `/readers/${borrower.id}`, { status: 'BLOCKED' })).data.status, 'BLOCKED');
  }
});

test('reader history is paginated, sorted and isolated to that reader', async (context) => {
  const { book, reader, loan, request } = await apiFixture(context);
  const linkedBook = await book();
  const borrower = await reader();
  const other = await reader();
  loan(linkedBook.id, borrower.id, 'RETURNED', '2026-10-01T12:00:00.000Z');
  const second = loan(linkedBook.id, borrower.id, 'ACTIVE', '2026-10-02T12:00:00.000Z');
  const third = loan(linkedBook.id, borrower.id, 'OVERDUE', '2026-10-02T12:00:00.000Z');
  loan(linkedBook.id, other.id);
  const page = (await request('GET', `/readers/${borrower.id}/loans?limit=1`)).data;
  assert.equal(page.total, 3);
  assert.equal(page.items[0].id, third);
  assert.equal((await request('GET', `/readers/${borrower.id}/loans?page=2&limit=1`)).data.items[0].id, second);
  await request('GET', '/readers/9999/loans', undefined, 404);
  validationError((await request('GET', `/readers/${borrower.id}/loans?limit=0`, undefined, 400)).data);
});

test('query and id validation reject ambiguous, unsafe and unsupported values', async (context) => {
  const { request } = await apiFixture(context);
  const invalidQueries = ['page=0', 'page=-1', 'page=1.5', 'page=1e2', 'page=',
    'page=9007199254740991&limit=100', 'limit=0', 'limit=101', 'limit=true',
    'page=1&page=2', 'q=a&q=b', 'q[x]=value', 'unexpected=value'];
  for (const resource of ['books', 'readers']) {
    for (const query of invalidQueries) {
      validationError((await request('GET', `/${resource}?${query}`, undefined, 400)).data);
    }
    for (const id of ['0', '-1', '1.5', '1e2', 'abc', '9007199254740992']) {
      validationError((await request('GET', `/${resource}/${id}`, undefined, 400)).data);
    }
  }
  for (const query of ['availableOnly=1', 'availableOnly=', 'availableOnly=false&availableOnly=true', 'author=', 'genre=']) {
    validationError((await request('GET', `/books?${query}`, undefined, 400)).data);
  }
  validationError((await request('GET', '/readers?status=UNKNOWN', undefined, 400)).data);
  await request('GET', '/books/9999', undefined, 404);
  await request('GET', '/readers/9999', undefined, 404);
});

test('server errors hide implementation details, oversized JSON is rejected, and stage 4+ APIs remain absent', async (context) => {
  const { request, database } = await apiFixture(context);
  assert.equal((await request('POST', '/books', { title: 'a'.repeat(110000) }, 413)).data.error.code, 'PAYLOAD_TOO_LARGE');
  await request('GET', '/loans', undefined, 200);
  await request('POST', '/loans/9999/return', undefined, 404);
  await request('GET', '/stats', undefined, 404);
  const log = context.mock.method(console, 'error', () => {});
  database.close();
  const error = (await request('GET', '/books', undefined, 500)).data;
  assert.deepEqual(error, {
    error: { code: 'INTERNAL_ERROR', message: 'Внутренняя ошибка сервера', details: {} },
  });
  assert.equal(log.mock.callCount(), 1);
});
