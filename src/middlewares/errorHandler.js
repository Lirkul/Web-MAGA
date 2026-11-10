import { ApiError } from '../errors/ApiError.js';

export function errorHandler(error, req, res, next) {
  if (res.headersSent) return next(error);

  if (error?.type === 'entity.parse.failed' && error.status === 400) {
    error = new ApiError(400, 'INVALID_JSON', 'Некорректный JSON');
  }

  if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
    return res.status(error.status).json({
      error: {
        code: error.code,
        message: error.message,
        details: error.details,
      },
    });
  }

  return res.status(500).json({
    error: {
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Внутренняя ошибка сервера',
      details: [],
    },
  });
}
