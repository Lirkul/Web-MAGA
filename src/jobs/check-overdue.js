import { pool } from '../db/pool.js';
import { checkOverdueLoans } from '../services/loans.service.js';

try {
  const updated = await checkOverdueLoans();
  console.log(`Проверка просрочек завершена. Обновлено выдач: ${updated}`);
} catch {
  console.error('Ошибка проверки просроченных выдач');
  process.exitCode = 1;
} finally {
  await pool.end();
}
