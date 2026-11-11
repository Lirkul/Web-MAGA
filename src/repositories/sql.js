export function escapeLike(value) {
  return value.replace(/[\\%_]/g, '\\$&');
}
