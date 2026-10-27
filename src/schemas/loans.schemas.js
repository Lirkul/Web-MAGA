import { z } from 'zod';
import { integerQuery, listQuerySchema, positiveInteger } from './common.schemas.js';

export const createLoanSchema = z.strictObject({
  bookId: positiveInteger,
  readerId: positiveInteger,
  dueDate: z.iso.date().optional(),
});

export const loansQuerySchema = listQuerySchema({
  status: z.enum(['ACTIVE', 'OVERDUE', 'RETURNED']).optional(),
  bookId: integerQuery.optional(),
  readerId: integerQuery.optional(),
});

// Возврат не принимает от клиента статус, время возврата или сумму штрафа.
export const returnLoanSchema = z.strictObject({}).optional();
