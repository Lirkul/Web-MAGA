import cron from 'node-cron';

export function startOverdueJob(overdueService) {
  return cron.schedule('5 0 * * *', () => {
    try {
      return overdueService.run();
    } catch {
      // Сервис уже записал ошибку. Следующий ежедневный запуск остаётся запланированным.
      return undefined;
    }
  }, { name: 'overdue-loans', timezone: 'UTC', noOverlap: true });
}
