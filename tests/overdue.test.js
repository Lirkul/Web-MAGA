import assert from 'node:assert/strict';
import test from 'node:test';
import { config } from '../src/config/index.js';
import { createOverdueService } from '../src/services/overdue.service.js';
import { startOverdueJob } from '../src/jobs/overdue.job.js';
import { apiFixture } from './support/api-fixture.js';

function loggerFixture() {
  const info = [];
  const errors = [];
  return {
    info, errors,
    logger: { info: (...args) => info.push(args), error: (...args) => errors.push(args) },
  };
}

test('overdue checks update only unreturned past-due loans and repeat without duplicate charges', async (context) => {
  const api = await apiFixture(context);
  const book = await api.book({ totalCopies: 6 });
  const reader = await api.reader();
  const activeId = api.loan(book.id, reader.id, 'ACTIVE', undefined, { dueDate: '2026-10-20' });
  const overdueId = api.loan(book.id, reader.id, 'OVERDUE', undefined, { dueDate: '2026-10-22', fineAmount: 500 });
  const todayId = api.loan(book.id, reader.id, 'ACTIVE', undefined, { dueDate: '2026-10-23' });
  const futureId = api.loan(book.id, reader.id, 'ACTIVE', undefined, { dueDate: '2026-10-24' });
  const returnedId = api.loan(book.id, reader.id, 'RETURNED', undefined, { dueDate: '2026-10-10', fineAmount: 2000 });
  const returnedBefore = (await api.request('GET', `/loans/${returnedId}`)).data;
  const logs = loggerFixture();
  const service = createOverdueService(api.database, {
    logger: logs.logger, settings: { ...config, dailyFineKopecks: 1000 },
  });

  assert.deepEqual(service.run('2026-10-23'), { asOfDate: '2026-10-23', processed: 2, updated: 2 });
  const active = (await api.request('GET', `/loans/${activeId}`)).data;
  assert.equal(active.status, 'OVERDUE');
  assert.equal(active.returnedAt, null);
  assert.equal(active.fineAmount, 3000);
  assert.equal((await api.request('GET', `/loans/${overdueId}`)).data.fineAmount, 1000);
  assert.equal((await api.request('GET', `/loans/${todayId}`)).data.status, 'ACTIVE');
  assert.equal((await api.request('GET', `/loans/${futureId}`)).data.fineAmount, 0);
  assert.deepEqual((await api.request('GET', `/loans/${returnedId}`)).data, returnedBefore);
  const snapshot = api.database.prepare('SELECT * FROM loans ORDER BY id').all();
  assert.deepEqual(service.run('2026-10-23'), { asOfDate: '2026-10-23', processed: 2, updated: 0 });
  assert.deepEqual(api.database.prepare('SELECT * FROM loans ORDER BY id').all(), snapshot);
  assert.equal((await api.request('GET', `/books/${book.id}`)).data.availableCopies, 2);
  assert.equal(logs.info.length, 4);
  assert.match(logs.info[0][0], /начата/);
  assert.equal(logs.info[1][1].processed, 2);
  assert.equal(logs.errors.length, 0);

  assert.deepEqual(service.run('2026-10-24'), { asOfDate: '2026-10-24', processed: 3, updated: 3 });
  assert.equal((await api.request('GET', `/loans/${activeId}`)).data.fineAmount, 4000);
  assert.equal((await api.request('GET', `/loans/${todayId}`)).data.fineAmount, 1000);
  assert.equal((await api.request('GET', `/loans/${futureId}`)).data.status, 'ACTIVE');
});

test('a returned fine stays fixed across later overdue checks', async (context) => {
  const logs = loggerFixture();
  const options = {
    now: () => new Date('2026-10-23T23:59:59.000Z'),
    settings: { ...config, dailyFineKopecks: 1000 }, logger: logs.logger,
  };
  const api = await apiFixture(context, options);
  const book = await api.book();
  const reader = await api.reader();
  const id = api.loan(book.id, reader.id, 'ACTIVE', undefined, { dueDate: '2026-10-20' });
  const service = createOverdueService(api.database, options);
  service.run('2026-10-21');
  assert.equal((await api.request('GET', `/loans/${id}`)).data.fineAmount, 1000);
  const returned = (await api.request('POST', `/loans/${id}/return`)).data;
  assert.equal(returned.status, 'RETURNED');
  assert.equal(returned.fineAmount, 3000);
  assert.deepEqual(service.run('2026-11-30'), { asOfDate: '2026-11-30', processed: 0, updated: 0 });
  assert.deepEqual((await api.request('GET', `/loans/${id}`)).data, returned);
  assert.equal((await api.request('GET', `/readers/${reader.id}/loans`)).data.items[0].fineAmount, 3000);
});

test('overdue service supports an injected UTC clock, custom tariff and zero tariff', async (context) => {
  const api = await apiFixture(context);
  const book = await api.book();
  const reader = await api.reader();
  const id = api.loan(book.id, reader.id, 'ACTIVE', undefined, { dueDate: '2026-10-20' });
  const logs = loggerFixture();
  const settings = { ...config, dailyFineKopecks: 250 };
  const clock = { value: '2026-10-21T00:05:00+07:00' };
  const service = createOverdueService(api.database, { now: () => new Date(clock.value), settings, logger: logs.logger });
  assert.deepEqual(service.run(), { asOfDate: '2026-10-20', processed: 0, updated: 0 });
  clock.value = '2026-10-23T00:05:00.000Z';
  assert.equal(service.run().updated, 1);
  assert.equal((await api.request('GET', `/loans/${id}`)).data.fineAmount, 750);
  settings.dailyFineKopecks = 0;
  assert.equal(service.run().updated, 1);
  const loan = (await api.request('GET', `/loans/${id}`)).data;
  assert.equal(loan.fineAmount, 0);
  assert.equal(loan.status, 'OVERDUE');
});

test('invalid check dates are rejected and logged even when there are no loans', async (context) => {
  const api = await apiFixture(context);
  const logs = loggerFixture();
  const service = createOverdueService(api.database, { logger: logs.logger });
  for (const date of ['2026-02-30', '2026-10-23T00:00:00Z', '23.10.2026', null]) {
    assert.throws(() => service.run(date), RangeError);
  }
  assert.equal(logs.errors.length, 4);
  assert.equal(logs.info.length, 4);
  assert.equal(api.database.prepare('SELECT count(*) AS count FROM loans').get().count, 0);
});

test('one failed fine rolls back the entire overdue batch and logs the error', async (context) => {
  const api = await apiFixture(context);
  const book = await api.book();
  const reader = await api.reader();
  api.loan(book.id, reader.id, 'ACTIVE', undefined, { dueDate: '2026-10-22' });
  api.loan(book.id, reader.id, 'ACTIVE', undefined, { dueDate: '2026-10-21' });
  const before = api.database.prepare('SELECT * FROM loans ORDER BY id').all();
  const logs = loggerFixture();
  const service = createOverdueService(api.database, {
    logger: logs.logger, settings: { ...config, dailyFineKopecks: Number.MAX_SAFE_INTEGER },
  });
  assert.throws(() => service.run('2026-10-23'), RangeError);
  assert.deepEqual(api.database.prepare('SELECT * FROM loans ORDER BY id').all(), before);
  assert.equal(logs.errors.length, 1);
  assert.equal(logs.errors[0][1].asOfDate, '2026-10-23');
  assert.equal(logs.info.length, 1);
});

test('cron schedules 00:05 UTC, invokes the same service, and can be destroyed', async (context) => {
  context.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-27T00:06:00.000Z') });
  let calls = 0;
  const task = startOverdueJob({ run() { calls += 1; return { processed: 2 }; } });
  context.after(() => task.destroy());
  assert.equal(calls, 0);
  assert.equal(task.getStatus(), 'idle');
  assert.equal(task.getNextRun().toISOString(), '2026-10-28T00:05:00.000Z');
  assert.deepEqual(await task.execute(), { processed: 2 });
  assert.equal(calls, 1);
  task.destroy();
  assert.equal(task.getStatus(), 'destroyed');
});

test('a failed scheduled run leaves the cron task available for the next day', async (context) => {
  let calls = 0;
  const task = startOverdueJob({ run() { calls += 1; throw new Error('logged by service'); } });
  context.after(() => task.destroy());
  assert.equal(await task.execute(), undefined);
  assert.equal(calls, 1);
  assert.equal(task.getStatus(), 'idle');
  assert.ok(task.getNextRun() instanceof Date);
});
