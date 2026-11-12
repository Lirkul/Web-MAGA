import { z } from 'zod';

const finePerDaySchema = z.string().trim().regex(/^\d+(?:\.\d+)?$/);

export function getFinePerDay() {
  const result = finePerDaySchema.safeParse(process.env.FINE_PER_DAY ?? '10');
  if (!result.success) {
    throw new Error('FINE_PER_DAY должен быть неотрицательным десятичным числом с точкой');
  }
  return result.data;
}
