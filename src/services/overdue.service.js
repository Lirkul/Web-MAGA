import { config } from '../config/index.js';
import { createOverdueRepository } from '../repositories/overdue.repository.js';
import { utcDate, utcDayNumber } from '../utils/dates.js';
import { calculateFine } from '../utils/fines.js';

export function createOverdueService(database, { now = () => new Date(), settings = config, logger = console } = {}) {
  const overdue = createOverdueRepository(database);
  const updateLoans = database.transaction((asOfDate) => {
    const loans = overdue.findOverdue(asOfDate);
    let updated = 0;
    for (const loan of loans) {
      const fineAmount = calculateFine(loan.dueDate, asOfDate, settings.dailyFineKopecks);
      if (loan.status !== 'OVERDUE' || loan.fineAmount !== fineAmount) {
        updated += overdue.update(loan.id, fineAmount, asOfDate);
      }
    }
    return { asOfDate, processed: loans.length, updated };
  }).immediate;

  return {
    run(asOfDate = utcDate(now())) {
      logger.info('[overdue] Проверка начата', { asOfDate });
      try {
        utcDayNumber(asOfDate);
        const result = updateLoans(asOfDate);
        logger.info('[overdue] Проверка завершена', result);
        return result;
      } catch (error) {
        logger.error('[overdue] Ошибка проверки', { asOfDate, error });
        throw error;
      }
    },
  };
}
