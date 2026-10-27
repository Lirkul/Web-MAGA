import { z } from 'zod';
import { listQuerySchema, searchQuery, text } from './common.schemas.js';

const readerFields = {
  fullName: text(2, 200),
  email: text().transform((value) => value.toLowerCase()).pipe(z.email()),
  registrationNumber: text(),
  status: z.enum(['ACTIVE', 'BLOCKED']),
};

export const createReaderSchema = z.strictObject({
  ...readerFields, status: readerFields.status.default('ACTIVE'),
});

export const updateReaderSchema = z.strictObject(readerFields).partial()
  .refine((body) => Object.keys(body).length > 0, 'Передайте хотя бы одно изменяемое поле');

export const readersQuerySchema = listQuerySchema({
  q: searchQuery,
  status: readerFields.status.optional(),
});
