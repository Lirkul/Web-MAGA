export function utcDate(date) {
  return date.toISOString().slice(0, 10);
}

export function addUtcDays(date, days) {
  const result = new Date(`${date}T00:00:00.000Z`);
  result.setUTCDate(result.getUTCDate() + days);
  return utcDate(result);
}
