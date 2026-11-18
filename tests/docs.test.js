import request from 'supertest';
import { expect, it, vi } from 'vitest';
import app from '../src/app.js';
import { checkDatabaseConnection } from '../src/db/pool.js';

vi.mock('../src/db/pool.js', () => ({ checkDatabaseConnection: vi.fn(), pool: { query: vi.fn() } }));

it('serves Swagger UI and its local stylesheet through /docs', async () => {
  await request(app).get('/docs').expect(301).expect('Location', '/docs/');
  const page = await request(app).get('/docs/').expect(200).expect('Content-Type', /html/);
  expect(page.text).toContain('swagger-ui');
  await request(app).get('/docs/swagger-ui.css').expect(200).expect('Content-Type', /css/);
});

it('publishes OpenAPI 3.0 with all seventeen existing API operations and five groups', async () => {
  const { body } = await request(app).get('/docs/openapi.json').expect(200);
  expect(body.openapi).toBe('3.0.3');
  expect(body.tags.map((tag) => tag.name)).toEqual(['Books', 'Readers', 'Loans', 'Statistics', 'Health']);
  const operations = Object.entries(body.paths).flatMap(([path, methods]) =>
    Object.keys(methods).map((method) => `${method.toUpperCase()} ${path}`));
  expect(operations.sort()).toEqual([
    'POST /api/books', 'GET /api/books', 'POST /api/books/import',
    'GET /api/books/{id}', 'PATCH /api/books/{id}', 'DELETE /api/books/{id}',
    'POST /api/readers', 'GET /api/readers', 'GET /api/readers/{id}', 'PATCH /api/readers/{id}',
    'POST /api/loans', 'GET /api/loans', 'GET /api/loans/{id}', 'POST /api/loans/{id}/return',
    'GET /api/stats/top-books', 'GET /api/stats/overdue-readers', 'GET /api/health',
  ].sort());
});

it('enables Try it out against this server and describes CSV as a required binary file', async () => {
  const { body } = await request(app).get('/docs/openapi.json').expect(200);
  expect(body.servers).toEqual([{ url: '/' }]);
  const upload = body.paths['/api/books/import'].post;
  expect(upload.requestBody.required).toBe(true);
  expect(upload.requestBody.content['multipart/form-data'].schema).toMatchObject({
    required: ['file'], properties: { file: { type: 'string', format: 'binary' } },
  });
  expect(upload.responses).toHaveProperty('413');
  const init = await request(app).get('/docs/swagger-ui-init.js').expect(200);
  expect(init.text).toContain('"tryItOutEnabled": true');
  expect(init.text).toContain('"url": "/docs/openapi.json"');
});

it('resolves every OpenAPI reference and provides an example for every successful JSON response', async () => {
  const { body } = await request(app).get('/docs/openapi.json').expect(200);
  const resolveReference = (reference) => reference.slice(2).split('/').reduce((value, key) => value?.[key], body);
  const visit = (value) => {
    if (!value || typeof value !== 'object') return;
    if (value.$ref) {
      expect(value.$ref).toMatch(/^#\//);
      expect(resolveReference(value.$ref)).toBeDefined();
    }
    Object.values(value).forEach(visit);
  };
  visit(body);
  for (const methods of Object.values(body.paths)) {
    for (const operation of Object.values(methods)) {
      expect(operation.summary).toMatch(/[А-Яа-яЁё]/);
      const success = Object.entries(operation.responses).filter(([code]) => code.startsWith('2'));
      expect(success.length).toBeGreaterThan(0);
      for (const [code, response] of success) {
        if (code === '204') continue;
        const resolved = response.$ref ? resolveReference(response.$ref) : response;
        expect(resolved.content['application/json'].example).toBeDefined();
      }
    }
  }
});

it('keeps Swagger and OpenAPI accessible when health reports a database failure', async () => {
  checkDatabaseConnection.mockRejectedValueOnce(new Error('Database unavailable'));
  await request(app).get('/api/health').expect(503, { status: 'error', database: 'disconnected' });
  await request(app).get('/docs/').expect(200).expect('Content-Type', /html/);
  const response = await request(app).get('/docs/openapi.json').expect(200);
  expect(response.body.openapi).toBe('3.0.3');
});
