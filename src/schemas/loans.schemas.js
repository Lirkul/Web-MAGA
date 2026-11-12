import { z } from 'zod';
import { positiveInteger, positiveIntegerValue } from './common.schemas.js';

export const createLoanSchema = z.object({
  bookId: positiveIntegerValue,
  readerId: positiveIntegerValue,
}).strict();

export const loanIdSchema = z.object({ id: positiveInteger }).strict();
export const returnLoanSchema = z.object({}).strict().optional();
