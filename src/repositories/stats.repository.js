import { pool } from '../db/pool.js';

export async function findTopBooks({ from, to }) {
  const { rows } = await pool.query(`
    SELECT b.id AS book_id, b.title, b.authors, b.isbn, COUNT(*) AS loans_count
    FROM loans l JOIN books b ON b.id = l.book_id
    WHERE l.loaned_at >= ($1::date::timestamp AT TIME ZONE 'UTC')
      AND l.loaned_at < (($2::date + 1)::timestamp AT TIME ZONE 'UTC')
    GROUP BY b.id
    ORDER BY loans_count DESC, b.id ASC
    LIMIT 5
  `, [from, to]);
  return rows;
}

const overdueReadersSummary = `
  SELECT reader_id, COUNT(*) AS overdue_loans_count,
    MIN(due_date) AS oldest_due_date,
    (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date - MIN(due_date) AS max_days_overdue
  FROM loans
  WHERE returned_at IS NULL AND due_date < (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date
  GROUP BY reader_id
`;

export async function findOverdueReaders({ page, limit }) {
  const countResult = await pool.query(`
    SELECT COUNT(*) AS total FROM (${overdueReadersSummary}) overdue
  `);
  const { rows } = await pool.query(`
    SELECT r.id AS reader_id, r.full_name, r.email, r.registration_number, r.status,
      overdue.overdue_loans_count,
      to_char(overdue.oldest_due_date, 'YYYY-MM-DD') AS oldest_due_date,
      overdue.max_days_overdue
    FROM (${overdueReadersSummary}) overdue
    JOIN readers r ON r.id = overdue.reader_id
    ORDER BY overdue.overdue_loans_count DESC, overdue.max_days_overdue DESC, r.id ASC
    LIMIT $1 OFFSET $2
  `, [limit, (page - 1) * limit]);
  return { rows, total: Number(countResult.rows[0].total) };
}
