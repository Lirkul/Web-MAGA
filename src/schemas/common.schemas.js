import { z } from 'zod';

export const positiveInteger = z.string()
  .regex(/^\d+$/, 'Ожидается положительное целое число')
  .transform(Number)
  .pipe(z.number().int().positive().max(Number.MAX_SAFE_INTEGER));

export function paginatedQuerySchema(filters) {
  return z.object({
    ...filters,
    page: positiveInteger.default(1),
    limit: positiveInteger.pipe(z.number().max(100)).default(10),
  }).strict().refine(({ page, limit }) => Number.isSafeInteger((page - 1) * limit), {
    path: ['page'], message: 'Слишком большой номер страницы',
  });
}
