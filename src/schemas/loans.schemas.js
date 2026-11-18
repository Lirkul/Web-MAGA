import { z } from 'zod';
import { paginatedQuerySchema, positiveInteger, positiveIntegerValue } from './common.schemas.js';

export const createLoanSchema = z.object({
  bookId: positiveIntegerValue,
  readerId: positiveIntegerValue,
  dueDate: z.iso.date({ error: 'Ожидается календарная дата YYYY-MM-DD' })
    .refine((value) => !value.startsWith('0000-'), 'Год должен быть не меньше 0001').optional(),
}).strict();

export const loanIdSchema = z.object({ id: positiveInteger }).strict();
export const returnLoanSchema = z.object({}).strict().optional();

export const listLoansSchema = paginatedQuerySchema({
  readerId: positiveInteger.optional(),
  bookId: positiveInteger.optional(),
  status: z.enum(['active', 'overdue', 'returned']).optional(),
});
