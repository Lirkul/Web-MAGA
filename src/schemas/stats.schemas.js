import { z } from 'zod';
import { paginatedQuerySchema } from './common.schemas.js';

const calendarDate = z.iso.date({ error: 'Ожидается календарная дата YYYY-MM-DD' })
  .refine((value) => !value.startsWith('0000-'), 'Год должен быть не меньше 0001');

export const topBooksSchema = z.object({
  from: calendarDate,
  to: calendarDate,
}).strict().refine(({ from, to }) => from <= to, {
  path: ['to'], message: 'Конец периода должен быть не раньше начала',
});

export const overdueReadersSchema = paginatedQuerySchema({});
