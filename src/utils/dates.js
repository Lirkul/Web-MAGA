export function utcDate(date) {
  return date.toISOString().slice(0, 10);
}

export function addUtcDays(date, days) {
  const result = new Date(`${date}T00:00:00.000Z`);
  result.setUTCDate(result.getUTCDate() + days);
  return utcDate(result);
}

export function utcDayNumber(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new RangeError('Ожидается календарная дата YYYY-MM-DD');
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || utcDate(date) !== value) {
    throw new RangeError('Указана несуществующая календарная дата');
  }
  return date.getTime() / 86400000;
}
