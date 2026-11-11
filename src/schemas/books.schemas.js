import { z } from 'zod';

const text = z.string().trim().transform((value) => value.replace(/\s+/g, ' '));
const requiredText = text.pipe(z.string().min(1, 'Поле не должно быть пустым'));

function isValidIsbn(value) {
  if (/^\d{9}[\dX]$/.test(value)) {
    const sum = [...value].reduce((total, digit, index) =>
      total + (digit === 'X' ? 10 : Number(digit)) * (10 - index), 0);
    return sum % 11 === 0;
  }
  if (/^97[89]\d{10}$/.test(value)) {
    const sum = [...value].reduce((total, digit, index) =>
      total + Number(digit) * (index % 2 === 0 ? 1 : 3), 0);
    return sum % 10 === 0;
  }
  return false;
}

const bookSchema = z.object({
  title: requiredText,
  authors: z.array(requiredText).min(1, 'Укажите хотя бы одного автора'),
  isbn: z.string()
    .transform((value) => value.replace(/[-\s]/g, '').toUpperCase())
    .refine(isValidIsbn, 'Некорректный ISBN-10 или ISBN-13'),
  publicationYear: z.number().int().positive()
    .refine((value) => value <= new Date().getUTCFullYear() + 1, 'Год не должен быть позже следующего календарного года')
    .optional(),
  genre: text.optional(),
  totalCopies: z.number().int().min(0).max(2147483647),
}).strict();

export const createBookSchema = bookSchema.extend({
  totalCopies: bookSchema.shape.totalCopies.default(0),
});

export const updateBookSchema = bookSchema.partial().extend({
  publicationYear: bookSchema.shape.publicationYear.nullable(),
  genre: bookSchema.shape.genre.nullable(),
}).refine((data) => Object.keys(data).length > 0, 'Укажите хотя бы одно поле для изменения');

const positiveInteger = z.string()
  .regex(/^\d+$/, 'Ожидается положительное целое число')
  .transform(Number)
  .pipe(z.number().int().positive().max(Number.MAX_SAFE_INTEGER));

export const bookIdSchema = z.object({ id: positiveInteger }).strict();

export const listBooksSchema = z.object({
  search: requiredText.optional(),
  genre: requiredText.optional(),
  page: positiveInteger.default(1),
  limit: positiveInteger.pipe(z.number().max(100)).default(10),
}).strict().refine(({ page, limit }) => Number.isSafeInteger((page - 1) * limit), {
  path: ['page'], message: 'Слишком большой номер страницы',
});
