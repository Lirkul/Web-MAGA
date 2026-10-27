import { z } from 'zod';
import { listQuerySchema, positiveInteger, searchQuery, text } from './common.schemas.js';

const isbnSchema = z.string().transform((value) => value.replace(/[\s-]/g, '').toUpperCase())
  .pipe(z.string().regex(/^(?:\d{13}|\d{9}[\dX])$/, 'ISBN должен содержать 13 цифр или 10 знаков (последний может быть X)'));

const bookFields = {
  title: text(1, 255),
  authors: z.array(text()).min(1),
  isbn: isbnSchema,
  publishedYear: z.number().int().min(1450).refine(
    (year) => year <= new Date().getUTCFullYear() + 1,
    'Год издания не может быть больше следующего года',
  ),
  genre: text(1, 100),
  totalCopies: positiveInteger,
  isArchived: z.boolean(),
};

export const createBookSchema = z.strictObject({
  ...bookFields, isArchived: bookFields.isArchived.default(false),
});

export const updateBookSchema = z.strictObject(bookFields).partial()
  .refine((body) => Object.keys(body).length > 0, 'Передайте хотя бы одно изменяемое поле');

export const booksQuerySchema = listQuerySchema({
  q: searchQuery,
  genre: text(1, 100).optional(),
  author: text().optional(),
  availableOnly: z.enum(['true', 'false']).transform((value) => value === 'true').default(false),
});
