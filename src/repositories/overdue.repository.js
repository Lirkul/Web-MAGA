export function createOverdueRepository(database) {
  const findOverdue = database.prepare(`
    SELECT id, dueDate, status, fineAmount FROM loans
    WHERE status IN ('ACTIVE', 'OVERDUE') AND dueDate < ?
    ORDER BY id
  `);
  const update = database.prepare(`
    UPDATE loans SET status = 'OVERDUE', fineAmount = @fineAmount
    WHERE id = @id AND status IN ('ACTIVE', 'OVERDUE') AND dueDate < @asOfDate
  `);

  return {
    findOverdue: (asOfDate) => findOverdue.all(asOfDate),
    update: (id, fineAmount, asOfDate) => update.run({ id, fineAmount, asOfDate }).changes,
  };
}
