const loanColumns = `id, book_id, reader_id, loaned_at,
  to_char(due_date, 'YYYY-MM-DD') AS due_date,
  returned_at, status, fine_amount::text AS fine_amount, created_at`;

export async function insertLoan({ bookId, readerId }, client) {
  const { rows } = await client.query(`
    WITH issuance AS MATERIALIZED (SELECT clock_timestamp() AS loaned_at)
    INSERT INTO loans (book_id, reader_id, loaned_at, due_date)
    SELECT $1, $2, loaned_at, (loaned_at AT TIME ZONE 'UTC')::date + 14
    FROM issuance
    RETURNING ${loanColumns}
  `, [bookId, readerId]);
  return rows[0];
}

export async function findLoanBook(id, client) {
  const { rows } = await client.query('SELECT book_id FROM loans WHERE id = $1', [id]);
  return rows[0];
}

export async function lockLoanById(id, client) {
  const { rows } = await client.query('SELECT id, returned_at FROM loans WHERE id = $1 FOR UPDATE', [id]);
  return rows[0];
}

export async function markLoanReturned(id, finePerDay, client) {
  const { rows } = await client.query(`
    WITH return_time AS MATERIALIZED (SELECT clock_timestamp() AS instant)
    UPDATE loans SET
      returned_at = return_time.instant,
      status = 'returned',
      fine_amount = ROUND(
        GREATEST(0, (return_time.instant AT TIME ZONE 'UTC')::date - due_date)::numeric
        * $2::numeric, 2
      )
    FROM return_time WHERE loans.id = $1
    RETURNING ${loanColumns}
  `, [id, finePerDay]);
  return rows[0];
}
