export class ApiError extends Error {
  constructor(status, code, message, details = []) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }

  static badRequest(message = 'Некорректные данные запроса', details = []) {
    return new ApiError(400, 'BAD_REQUEST', message, details);
  }

  static notFound(message = 'Ресурс не найден', details = []) {
    return new ApiError(404, 'NOT_FOUND', message, details);
  }

  static conflict(message = 'Конфликт данных', details = []) {
    return new ApiError(409, 'CONFLICT', message, details);
  }
}
