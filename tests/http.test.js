import express from 'express';
import request from 'supertest';
import { z } from 'zod';
import { beforeEach, expect, it, vi } from 'vitest';
import app from '../src/app.js';
import { checkDatabaseConnection } from '../src/db/pool.js';
import { ApiError } from '../src/errors/ApiError.js';
import { errorHandler } from '../src/middlewares/errorHandler.js';
import { validate } from '../src/middlewares/validate.js';

vi.mock('../src/db/pool.js', () => ({ checkDatabaseConnection: vi.fn() }));

beforeEach(() => {
  vi.resetAllMocks();
});

// Вспомогательные маршруты существуют только в этом тестовом приложении.
function createTestApp(registerRoutes) {
  const testApp = express();
  testApp.use(express.json());
  registerRoutes(testApp);
  testApp.use(errorHandler);
  return testApp;
}

const bodySchema = z.object({
  email: z.string().email('Некорректный формат email'),
  age: z.number().int().optional(),
});

function createValidationApp(schema = bodySchema) {
  return createTestApp((testApp) => {
    testApp.post('/validate', validate(schema), (req, res) => {
      res.json({ validated: req.validated, original: req.body });
    });
  });
}

const internalErrorBody = {
  error: { code: 'INTERNAL_SERVER_ERROR', message: 'Внутренняя ошибка сервера', details: [] },
};

it.each([
  ['badRequest', 400, 'BAD_REQUEST'],
  ['notFound', 404, 'NOT_FOUND'],
  ['conflict', 409, 'CONFLICT'],
])('ApiError.%s creates an Error with public status, code and details', (method, status, code) => {
  const details = [{ path: 'email', message: 'Проверьте email' }];
  const error = ApiError[method]('Ошибка запроса', details);
  expect(error).toBeInstanceOf(Error);
  expect(error).toMatchObject({ name: 'ApiError', status, code, message: 'Ошибка запроса', details });
  expect(ApiError[method]().details).toEqual([]);
});

it('passes valid body data to the next handler', async () => {
  const response = await request(createValidationApp()).post('/validate').send({ email: 'reader@example.com', age: 20 });
  expect(response.status).toBe(200);
  expect(response.body.validated.body).toEqual({ email: 'reader@example.com', age: 20 });
});

it.each([
  ['a missing required field', {}, 'email'],
  ['an incorrect field type', { email: 'reader@example.com', age: '20' }, 'age'],
])('returns 400 for %s', async (_name, data, path) => {
  const response = await request(createValidationApp()).post('/validate').send(data);
  expect(response.status).toBe(400);
  expect(response.body).toEqual({
    error: {
      code: 'VALIDATION_ERROR',
      message: 'Некорректные данные запроса',
      details: [{ path, message: expect.any(String) }],
    },
  });
});

it('returns readable Zod messages and all invalid field paths', async () => {
  const response = await request(createValidationApp()).post('/validate').send({ email: 'invalid', age: '20' });
  expect(response.status).toBe(400);
  expect(response.body.error.details).toEqual([
    { path: 'email', message: 'Некорректный формат email' },
    { path: 'age', message: expect.any(String) },
  ]);
});

it('formats nested field and array paths', async () => {
  const schema = z.object({ contacts: z.array(bodySchema) });
  const response = await request(createValidationApp(schema)).post('/validate').send({ contacts: [{ email: 'invalid' }] });
  expect(response.status).toBe(400);
  expect(response.body.error.details).toEqual([
    { path: 'contacts.0.email', message: 'Некорректный формат email' },
  ]);
});

it('keeps the original body when Zod transforms values or strips unknown keys', async () => {
  const schema = z.object({ name: z.string().trim() });
  const data = { name: ' Reader ', extra: 'keep original' };
  const response = await request(createValidationApp(schema)).post('/validate').send(data);
  expect(response.status).toBe(200);
  expect(response.body).toEqual({ validated: { body: { name: 'Reader' } }, original: data });
});

function createParametersApp() {
  return createTestApp((testApp) => {
    testApp.get('/validate/:id',
      validate(z.object({ id: z.coerce.number().int().positive() }), 'params'),
      validate(z.object({ page: z.coerce.number().int().positive().default(1) }), 'query'),
      (req, res) => res.json({ validated: req.validated, params: req.params, query: req.query }));
  });
}

it('validates path and query together without overwriting original strings', async () => {
  const response = await request(createParametersApp()).get('/validate/7?page=2&extra=original');
  expect(response.status).toBe(200);
  expect(response.body).toEqual({
    validated: { params: { id: 7 }, query: { page: 2 } },
    params: { id: '7' }, query: { page: '2', extra: 'original' },
  });
});

it.each([
  ['/validate/wrong?page=2', 'id'],
  ['/validate/7?page=wrong', 'page'],
])('rejects invalid path or query in %s', async (url, path) => {
  const response = await request(createParametersApp()).get(url);
  expect(response.status).toBe(400);
  expect(response.body.error.code).toBe('VALIDATION_ERROR');
  expect(response.body.error.details).toEqual([{ path, message: expect.any(String) }]);
});

it('supports asynchronous Zod refinements', async () => {
  const schema = z.object({ name: z.string().refine(async (value) => value === 'allowed', 'Недопустимое имя') });
  const response = await request(createValidationApp(schema)).post('/validate').send({ name: 'denied' });
  expect(response.status).toBe(400);
  expect(response.body.error.details).toEqual([{ path: 'name', message: 'Недопустимое имя' }]);
});

it('reports a missing request body at the root path', async () => {
  const response = await request(createValidationApp()).post('/validate');
  expect(response.status).toBe(400);
  expect(response.body.error.details).toEqual([{ path: 'body', message: expect.any(String) }]);
});

it('rejects an invalid validation source as a configuration error', () => {
  expect(() => validate(bodySchema, 'headers')).toThrow(TypeError);
});

it.each(['{"email":', 'null', '"text"'])('returns 400 JSON errors before route matching: %s', async (body) => {
  const response = await request(app).post('/not-found').set('Content-Type', 'application/json').send(body);
  expect(response.status).toBe(400);
  expect(response.headers['content-type']).toMatch(/application\/json/);
  expect(response.body).toEqual({ error: { code: 'INVALID_JSON', message: 'Некорректный JSON', details: [] } });
});

it('returns a JSON 404 for unknown production routes', async () => {
  const response = await request(app).get('/api/not-found');
  expect(response.status).toBe(404);
  expect(response.body).toEqual({ error: { code: 'NOT_FOUND', message: 'Эндпоинт не найден', details: [] } });
});

it.each([
  ['badRequest', 400, 'BAD_REQUEST'],
  ['notFound', 404, 'NOT_FOUND'],
  ['conflict', 409, 'CONFLICT'],
])('serializes a public %s error', async (method, status, code) => {
  const testApp = createTestApp((routes) => {
    routes.get('/error', () => { throw ApiError[method]('Понятное сообщение', [{ path: 'email', message: 'Подробности' }]); });
  });
  const response = await request(testApp).get('/error');
  expect(response.status).toBe(status);
  expect(response.body).toEqual({ error: { code, message: 'Понятное сообщение', details: [{ path: 'email', message: 'Подробности' }] } });
});

it.each(['development', 'production'])('hides unexpected error details in %s', async (environment) => {
  const testApp = createTestApp((routes) => {
    routes.set('env', environment);
    routes.get('/error', () => {
      const error = new Error('SELECT secret FROM internal_table; password=private');
      error.status = 409;
      error.code = '23505';
      error.query = 'private SQL';
      throw error;
    });
  });
  const response = await request(testApp).get('/error');
  expect(response.status).toBe(500);
  expect(response.body).toEqual(internalErrorBody);
});

it('also hides messages and details of an explicit ApiError with status 500', async () => {
  const testApp = createTestApp((routes) => {
    routes.get('/error', () => { throw new ApiError(500, 'PRIVATE_CODE', 'private SQL', [{ query: 'private SQL' }]); });
  });
  const response = await request(testApp).get('/error');
  expect(response.status).toBe(500);
  expect(response.body).toEqual(internalErrorBody);
});

it('handles rejected asynchronous routes', async () => {
  const testApp = createTestApp((routes) => {
    routes.get('/error', async () => { throw new Error('private failure'); });
  });
  const response = await request(testApp).get('/error');
  expect(response.status).toBe(500);
  expect(response.body).toEqual(internalErrorBody);
});

it('delegates errors when response headers have already been sent', () => {
  const error = new Error('already sent');
  const next = vi.fn();
  errorHandler(error, {}, { headersSent: true }, next);
  expect(next).toHaveBeenCalledWith(error);
});

it('preserves the successful health response', async () => {
  checkDatabaseConnection.mockResolvedValue(undefined);
  const response = await request(app).get('/api/health');
  expect(response.status).toBe(200);
  expect(response.body).toEqual({ status: 'ok', database: 'connected' });
  expect(checkDatabaseConnection).toHaveBeenCalledOnce();
});

it('preserves the unavailable database health response without leaking errors', async () => {
  checkDatabaseConnection.mockRejectedValue(new Error('private database connection details'));
  const response = await request(app).get('/api/health');
  expect(response.status).toBe(503);
  expect(response.body).toEqual({ status: 'error', database: 'disconnected' });
});
