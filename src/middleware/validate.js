export function validate(schema, source = 'body') {
  return (request, response, next) => {
    // Express 5 предоставляет query через getter, поэтому исходный запрос не меняем.
    response.locals[source] = schema.parse(request[source]);
    next();
  };
}
