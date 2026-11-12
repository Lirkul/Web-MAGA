import cron from 'node-cron';
import { checkOverdueLoans } from '../services/loans.service.js';

export function startOverdueJob() {
  const schedule = process.env.CRON_SCHEDULE ?? '5 0 * * *';
  if (!cron.validate(schedule)) throw new Error('Некорректный CRON_SCHEDULE');

  const task = cron.schedule(schedule, async () => {
    try {
      const updated = await checkOverdueLoans();
      console.log(`[CRON] Проверка просрочек завершена. Обновлено выдач: ${updated}`);
    } catch {
      console.error('[CRON] Ошибка проверки просроченных выдач');
    }
  }, { timezone: 'UTC', noOverlap: true });

  console.log(`[CRON] Проверка просрочек запланирована: ${schedule} (UTC)`);
  return task;
}
