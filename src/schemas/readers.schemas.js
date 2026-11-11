import { z } from 'zod';
import { paginatedQuerySchema, positiveInteger } from './common.schemas.js';

const requiredText = z.string().trim().min(1, 'Поле не должно быть пустым');
const status = z.enum(['active', 'blocked']);

export const createReaderSchema = z.object({
  fullName: requiredText,
  email: z.string().trim().toLowerCase().email('Некорректный формат email'),
  registrationNumber: requiredText,
}).strict();

export const updateReaderSchema = createReaderSchema.extend({ status }).partial()
  .refine((data) => Object.keys(data).length > 0, 'Укажите хотя бы одно поле для изменения');

export const readerIdSchema = z.object({ id: positiveInteger }).strict();

export const listReadersSchema = paginatedQuerySchema({
  search: requiredText.optional(),
  status: status.optional(),
});
