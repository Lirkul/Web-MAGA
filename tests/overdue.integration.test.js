import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import test from 'node:test';
import { apiFixture } from './support/api-fixture.js';

function entryProcess(script, env) {
  // Подменяем только часы тестового дочернего процесса, не код приложения.
  const bootstrap = `
    import { mock } from 'node:test';
    mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-23T12:00:00.000Z') });
    await import(${JSON.stringify(new URL(script, import.meta.url).href)});
  `;
  const child = spawn(process.execPath, ['--input-type=module', '--eval', bootstrap], {
    env: { ...process.env, DAILY_FINE_KOPECKS: '1000', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (data) => { stdout += data; });
  child.stderr.on('data', (data) => { stderr += data; });
  const closed = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout, stderr }));
  });

  async function waitFor(check) {
    let timer;
    try {
      return await Promise.race([
        check,
        new Promise((resolve, reject) => {
          timer = setTimeout(() => reject(new Error(`Child process timeout: ${stdout}\n${stderr}`)), 5000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    exit: () => waitFor(closed),
    async ready() {
      if (stdout.includes('Library API:')) return;
      const ready = new Promise((resolve, reject) => {
        child.stdout.on('data', () => { if (stdout.includes('Library API:')) resolve(); });
        closed.then((result) => reject(new Error(`Server exited: ${JSON.stringify(result)}`)), reject);
      });
      await waitFor(ready);
    },
    async stop() {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await closed;
    },
    output: () => stdout,
  };
}

async function unusedPort() {
  const server = createServer().listen(0);
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test('manual CLI updates overdue loans, logs counts, and exits after an idempotent repeat', async (context) => {
  const api = await apiFixture(context);
  const book = await api.book();
  const reader = await api.reader();
  const id = api.loan(book.id, reader.id, 'ACTIVE', undefined, { dueDate: '2026-10-20' });
  const returnedId = api.loan(book.id, reader.id, 'RETURNED', undefined, { dueDate: '2026-10-10', fineAmount: 700 });
  const first = entryProcess('../src/scripts/run-overdue.js', { DATABASE_PATH: api.path });
  try {
    const result = await first.exit();
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /Проверка начата/);
    assert.match(result.stdout, /Проверка завершена/);
    assert.match(result.stdout, /processed: 1/);
    assert.match(result.stdout, /updated: 1/);
  } finally {
    await first.stop();
  }
  const loan = (await api.request('GET', `/loans/${id}`)).data;
  assert.equal(loan.status, 'OVERDUE');
  assert.equal(loan.fineAmount, 3000);
  assert.equal((await api.request('GET', `/loans/${returnedId}`)).data.fineAmount, 700);

  const second = entryProcess('../src/scripts/run-overdue.js', { DATABASE_PATH: api.path });
  try {
    const result = await second.exit();
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /updated: 0/);
  } finally {
    await second.stop();
  }
  assert.deepEqual((await api.request('GET', `/loans/${id}`)).data, loan);
});

test('manual CLI reports a failure, exits nonzero and leaves the database unchanged', async (context) => {
  const api = await apiFixture(context);
  const book = await api.book();
  const reader = await api.reader();
  const id = api.loan(book.id, reader.id, 'ACTIVE', undefined, { dueDate: '2026-10-20' });
  const before = (await api.request('GET', `/loans/${id}`)).data;
  const child = entryProcess('../src/scripts/run-overdue.js', {
    DATABASE_PATH: api.path, DAILY_FINE_KOPECKS: String(Number.MAX_SAFE_INTEGER),
  });
  try {
    const result = await child.exit();
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Ошибка проверки/);
    assert.match(result.stderr, /Проверка просрочек завершилась ошибкой/);
  } finally {
    await child.stop();
  }
  assert.deepEqual((await api.request('GET', `/loans/${id}`)).data, before);
});

test('server catches up overdue loans before accepting HTTP and exposes no job endpoint', async (context) => {
  const api = await apiFixture(context);
  const book = await api.book();
  const reader = await api.reader();
  const overdueId = api.loan(book.id, reader.id, 'ACTIVE', undefined, { dueDate: '2026-10-20' });
  const todayId = api.loan(book.id, reader.id, 'ACTIVE', undefined, { dueDate: '2026-10-23' });
  const returnedId = api.loan(book.id, reader.id, 'RETURNED', undefined, { dueDate: '2026-10-10', fineAmount: 700 });
  const port = await unusedPort();
  const child = entryProcess('../src/server.js', { DATABASE_PATH: api.path, PORT: String(port) });
  try {
    await child.ready();
    const base = `http://127.0.0.1:${port}/api`;
    assert.deepEqual(await (await fetch(`${base}/health`)).json(), { status: 'ok' });
    const loan = await (await fetch(`${base}/loans/${overdueId}`)).json();
    assert.equal(loan.status, 'OVERDUE');
    assert.equal(loan.fineAmount, 3000);
    assert.equal((await (await fetch(`${base}/loans/${todayId}`)).json()).status, 'ACTIVE');
    assert.equal((await (await fetch(`${base}/loans/${returnedId}`)).json()).fineAmount, 700);
    assert.ok(child.output().indexOf('Проверка завершена') < child.output().indexOf('Library API:'));
    const job = await fetch(`${base}/jobs/overdue`, { method: 'POST' });
    assert.equal(job.status, 404);
    await job.json();
    const stats = await fetch(`${base}/stats`);
    assert.equal(stats.status, 404);
    await stats.json();
  } finally {
    await child.stop();
  }
});

test('a failed HTTP listen stops cron and exits instead of leaving a background process', async (context) => {
  const api = await apiFixture(context);
  const occupied = createServer().listen(0);
  await once(occupied, 'listening');
  const port = occupied.address().port;
  const child = entryProcess('../src/server.js', { DATABASE_PATH: api.path, PORT: String(port) });
  try {
    const result = await child.exit();
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Не удалось запустить HTTP-сервер/);
    assert.match(result.stderr, /EADDRINUSE/);
  } finally {
    await child.stop();
    await new Promise((resolve) => occupied.close(resolve));
  }
});
