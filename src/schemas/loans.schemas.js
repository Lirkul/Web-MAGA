import { z } from 'zod';
import { positiveIntegerValue } from './common.schemas.js';

export const createLoanSchema = z.object({
  bookId: positiveIntegerValue,
  readerId: positiveIntegerValue,
}).strict();
