import { z } from 'zod';
import { paginatedQuerySchema, positiveInteger, positiveIntegerValue } from './common.schemas.js';

export const createLoanSchema = z.object({
  bookId: positiveIntegerValue,
  readerId: positiveIntegerValue,
}).strict();

export const loanIdSchema = z.object({ id: positiveInteger }).strict();
export const returnLoanSchema = z.object({}).strict().optional();

export const listLoansSchema = paginatedQuerySchema({
  readerId: positiveInteger.optional(),
  bookId: positiveInteger.optional(),
  status: z.enum(['active', 'overdue', 'returned']).optional(),
});
