import { ZodError } from 'zod';
import { HttpError } from '../utils/errors.js';

const uniqueConflicts = [
  ['books.isbn', 'ISBN_CONFLICT', 'Книга с таким ISBN уже существует'],
  ['readers.email', 'EMAIL_CONFLICT', 'Читатель с таким email уже существует'],
  ['readers.registrationNumber', 'REGISTRATION_NUMBER_CONFLICT', 'Регистрационный номер уже занят'],
];

export function errorHandler(error, request, response, next) {
  if (response.headersSent) {
    return next(error);
  }

  if (error instanceof ZodError) {
    return response.status(400).json({
      error: {
        code: 'VALIDATION_ERROR', message: 'Некорректные входные данные',
        details: { issues: error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })) },
      },
    });
  }

  if (error instanceof HttpError) {
    return response.status(error.status).json({
      error: { code: error.code, message: error.message, details: error.details },
    });
  }

  if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
    const conflict = uniqueConflicts.find(([column]) => error.message.includes(column));
    if (conflict) {
      return response.status(409).json({
        error: { code: conflict[1], message: conflict[2], details: {} },
      });
    }
  }

  if (error.type === 'entity.parse.failed') {
    return response.status(400).json({
      error: { code: 'INVALID_JSON', message: 'Некорректный JSON', details: {} },
    });
  }

  if (error.type === 'entity.too.large') {
    return response.status(413).json({
      error: { code: 'PAYLOAD_TOO_LARGE', message: 'Тело запроса слишком большое', details: {} },
    });
  }

  console.error(error);
  response.status(500).json({
    error: { code: 'INTERNAL_ERROR', message: 'Внутренняя ошибка сервера', details: {} },
  });
}
