export function errorHandler(error, request, response, next) {
  if (response.headersSent) {
    return next(error);
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
