export async function insertLoan({ bookId, readerId }, client) {
  const { rows } = await client.query(`
    WITH issuance AS MATERIALIZED (SELECT clock_timestamp() AS loaned_at)
    INSERT INTO loans (book_id, reader_id, loaned_at, due_date)
    SELECT $1, $2, loaned_at, (loaned_at AT TIME ZONE 'UTC')::date + 14
    FROM issuance
    RETURNING id, book_id, reader_id, loaned_at,
              to_char(due_date, 'YYYY-MM-DD') AS due_date,
              returned_at, status, fine_amount::text AS fine_amount, created_at
  `, [bookId, readerId]);
  return rows[0];
}
