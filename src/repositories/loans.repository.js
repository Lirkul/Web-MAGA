const filters = `
  WHERE (@status IS NULL OR status = @status)
    AND (@bookId IS NULL OR bookId = @bookId)
    AND (@readerId IS NULL OR readerId = @readerId)
`;

export function createLoansRepository(database) {
  const find = database.prepare('SELECT * FROM loans WHERE id = ?');
  const count = database.prepare(`SELECT count(*) AS total FROM loans ${filters}`);
  const list = database.prepare(`SELECT * FROM loans ${filters}
    ORDER BY loanedAt DESC, id DESC LIMIT @limit OFFSET @offset`);
  const insert = database.prepare(`
    INSERT INTO loans (bookId, readerId, loanedAt, dueDate)
    VALUES (@bookId, @readerId, @loanedAt, @dueDate)
  `);
  const readerSummary = database.prepare(`
    SELECT count(*) AS outstandingCount,
      coalesce(max(CASE WHEN dueDate < @today THEN 1 ELSE 0 END), 0) AS hasOverdue
    FROM loans WHERE readerId = @readerId AND status IN ('ACTIVE', 'OVERDUE')
  `);
  const markReturned = database.prepare(`
    UPDATE loans SET status = 'RETURNED', returnedAt = @returnedAt, fineAmount = @fineAmount
    WHERE id = @id AND status IN ('ACTIVE', 'OVERDUE')
  `);

  return {
    findById: (id) => find.get(id),
    insert: (loan) => insert.run(loan).lastInsertRowid,
    readerSummary: (readerId, today) => readerSummary.get({ readerId, today }),
    markReturned: (id, returnedAt, fineAmount) => markReturned.run({ id, returnedAt, fineAmount }).changes,
    list: database.transaction(({ page, limit, status, bookId, readerId }) => {
      const bindings = { status: status ?? null, bookId: bookId ?? null, readerId: readerId ?? null };
      return {
        page, limit, total: count.get(bindings).total,
        items: list.all({ ...bindings, limit, offset: (page - 1) * limit }),
      };
    }),
  };
}
