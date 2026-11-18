import { z } from 'zod';

const loanDaysSchema = z.string().regex(/^\d+$/).transform(Number)
  .pipe(z.number().int().min(1).max(2147483647));

export function getDefaultLoanDays() {
  const result = loanDaysSchema.safeParse(process.env.DEFAULT_LOAN_DAYS ?? '14');
  if (!result.success) throw new Error('DEFAULT_LOAN_DAYS должен быть положительным целым числом');
  return result.data;
}
