import { config } from '../config/index.js';
import { utcDayNumber } from './dates.js';

export function calculateFine(dueDate, asOfDate, dailyFineKopecks = config.dailyFineKopecks) {
  if (!Number.isSafeInteger(dailyFineKopecks) || dailyFineKopecks < 0) {
    throw new RangeError('Тариф должен быть неотрицательным целым числом копеек');
  }

  const overdueDays = Math.max(0, utcDayNumber(asOfDate) - utcDayNumber(dueDate));
  const amount = overdueDays * dailyFineKopecks;
  if (!Number.isSafeInteger(amount)) {
    throw new RangeError('Сумма штрафа выходит за пределы безопасного целого числа');
  }
  return amount;
}
