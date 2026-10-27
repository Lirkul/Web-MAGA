import assert from 'node:assert/strict';
import test from 'node:test';
import { calculateFine } from '../src/utils/fines.js';
import { config } from '../src/config/index.js';
import { apiFixture } from './support/api-fixture.js';

test('fine is 0 before/on the due date and 1000/3000 kopecks after 1/3 UTC dates', () => {
  assert.equal(calculateFine('2026-10-20', '2026-10-19', 1000), 0);
  assert.equal(calculateFine('2026-10-20', '2026-10-20', 1000), 0);
  assert.equal(calculateFine('2026-10-20', '2026-10-21', 1000), 1000);
  assert.equal(calculateFine('2026-10-20', '2026-10-23', 1000), 3000);
  assert.equal(calculateFine('2026-10-20', '2026-10-21'), config.dailyFineKopecks);
});

test('fine calculation handles leap days, year boundaries and a configured integer tariff', () => {
  assert.equal(calculateFine('2028-02-28', '2028-03-01', 1000), 2000);
  assert.equal(calculateFine('2027-02-28', '2027-03-01', 1000), 1000);
  assert.equal(calculateFine('2026-12-31', '2027-01-02', 1000), 2000);
  assert.equal(calculateFine('2026-10-20', '2026-10-23', 125), 375);
  assert.equal(calculateFine('2026-10-20', '2026-10-23', 0), 0);
  assert.equal(calculateFine('2026-10-20', '2026-10-23', 125), 375);
});

test('fine calculation rejects invalid calendar dates, rates and unsafe amounts', () => {
  for (const date of ['2026-02-30', '2026-13-01', '2026-10-00', '2026-1-01', '20.10.2026',
    '2026-10-20T00:00:00Z', '', null, undefined]) {
    assert.throws(() => calculateFine(date, '2026-10-23', 1000), RangeError);
    assert.throws(() => calculateFine('2026-10-20', date, 1000), RangeError);
  }
  for (const rate of [-1, 1.5, NaN, Infinity, '1000', Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => calculateFine('2026-10-20', '2026-10-23', rate), RangeError);
  }
  assert.throws(() => calculateFine('2026-10-20', '2026-10-23', Number.MAX_SAFE_INTEGER), RangeError);
});

test('return calculates final fines from UTC dates even if an overdue loan still has ACTIVE status', async (context) => {
  const clock = { value: '2026-10-23T12:00:00.000Z' };
  const api = await apiFixture(context, {
    now: () => new Date(clock.value), settings: { ...config, dailyFineKopecks: 1000 },
  });
  const book = await api.book();
  const reader = await api.reader();
  for (const [returnedAt, expected] of [
    ['2026-10-19T23:59:59.000Z', 0],
    ['2026-10-20T23:59:59.999Z', 0],
    ['2026-10-21T00:00:00.000Z', 1000],
    ['2026-10-23T12:00:00.000Z', 3000],
  ]) {
    const id = api.loan(book.id, reader.id, 'ACTIVE', '2026-10-01T12:00:00.000Z', {
      dueDate: '2026-10-20', fineAmount: 999,
    });
    clock.value = returnedAt;
    const returned = (await api.request('POST', `/loans/${id}/return`)).data;
    assert.equal(returned.status, 'RETURNED');
    assert.equal(returned.returnedAt, returnedAt);
    assert.equal(returned.fineAmount, expected);
    await api.request('POST', `/loans/${id}/return`, undefined, 409);
    assert.deepEqual((await api.request('GET', `/loans/${id}`)).data, returned);
  }
});

test('return uses UTC rather than local dates or complete 24-hour periods', async (context) => {
  const clock = { value: '2026-10-21T00:30:00+07:00' };
  const api = await apiFixture(context, {
    now: () => new Date(clock.value), settings: { ...config, dailyFineKopecks: 1000 },
  });
  const book = await api.book();
  const reader = await api.reader();
  const onTime = api.loan(book.id, reader.id, 'ACTIVE', '2026-10-01T00:00:00.000Z', { dueDate: '2026-10-20' });
  assert.equal((await api.request('POST', `/loans/${onTime}/return`)).data.fineAmount, 0);
  const late = api.loan(book.id, reader.id, 'ACTIVE', '2026-10-01T00:00:00.000Z', { dueDate: '2026-10-20' });
  clock.value = '2026-10-20T23:30:00-04:00';
  const returned = (await api.request('POST', `/loans/${late}/return`)).data;
  assert.equal(returned.returnedAt, '2026-10-21T03:30:00.000Z');
  assert.equal(returned.fineAmount, 1000);
});

test('return uses the configured tariff and rolls back when a fine cannot fit an integer', async (context) => {
  const settings = { ...config, dailyFineKopecks: 125 };
  const api = await apiFixture(context, { now: () => new Date('2026-10-23T12:00:00.000Z'), settings });
  const book = await api.book();
  const reader = await api.reader();
  const id = api.loan(book.id, reader.id, 'ACTIVE', '2026-10-01T00:00:00.000Z', { dueDate: '2026-10-20' });
  assert.equal((await api.request('POST', `/loans/${id}/return`)).data.fineAmount, 375);

  const failedId = api.loan(book.id, reader.id, 'ACTIVE', '2026-10-01T00:00:00.000Z', { dueDate: '2026-10-20' });
  settings.dailyFineKopecks = Number.MAX_SAFE_INTEGER;
  const log = context.mock.method(console, 'error', () => {});
  await api.request('POST', `/loans/${failedId}/return`, undefined, 500);
  const unchanged = (await api.request('GET', `/loans/${failedId}`)).data;
  assert.equal(unchanged.status, 'ACTIVE');
  assert.equal(unchanged.returnedAt, null);
  assert.equal(unchanged.fineAmount, 0);
  assert.equal(log.mock.callCount(), 1);
});
