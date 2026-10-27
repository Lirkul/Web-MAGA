import { z } from 'zod';

export function text(minimum = 1, maximum) {
  let schema = z.string().trim().min(minimum);
  if (maximum !== undefined) schema = schema.max(maximum);
  return schema.refine((value) => !value.includes('\0'), 'Нулевые символы недопустимы');
}

export const positiveInteger = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);

export const integerQuery = z.string().regex(/^[1-9]\d*$/, 'Ожидается положительное целое число')
  .transform(Number).pipe(positiveInteger);

export const idParamsSchema = z.strictObject({ id: integerQuery });

export function listQuerySchema(filters = {}) {
  return z.strictObject({
    page: integerQuery.default(1),
    limit: integerQuery.pipe(z.number().max(100)).default(20),
    ...filters,
  }).refine(({ page, limit }) => Number.isSafeInteger((page - 1) * limit), {
    message: 'Слишком большое смещение страницы', path: ['page'],
  });
}

export const paginationSchema = listQuerySchema();

export const searchQuery = text(0).default('');
