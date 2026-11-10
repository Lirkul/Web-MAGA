import { ApiError } from '../errors/ApiError.js';

export function validate(schema, source = 'body') {
  if (!['body', 'params', 'query'].includes(source)) {
    throw new TypeError('Validation source must be body, params or query');
  }

  return async (req, res, next) => {
    const result = await schema.safeParseAsync(req[source]);
    if (!result.success) {
      return next(new ApiError(
        400,
        'VALIDATION_ERROR',
        'Некорректные данные запроса',
        result.error.issues.map((issue) => ({
          path: issue.path.length ? issue.path.join('.') : source,
          message: issue.message,
        })),
      ));
    }

    req.validated = { ...req.validated, [source]: result.data };
    next();
  };
}
