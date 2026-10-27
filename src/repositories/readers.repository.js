const filters = `
  WHERE (@q = '' OR instr(lower_unicode(fullName), @q) > 0
    OR instr(lower_unicode(email), @q) > 0
    OR instr(lower_unicode(registrationNumber), @q) > 0)
    AND (@status IS NULL OR status = @status)
`;

function parameters(reader) {
  return {
    fullName: reader.fullName, email: reader.email,
    registrationNumber: reader.registrationNumber, status: reader.status,
  };
}

export function createReadersRepository(database) {
  const find = database.prepare('SELECT * FROM readers WHERE id = ?');
  const count = database.prepare(`SELECT count(*) AS total FROM readers ${filters}`);
  const list = database.prepare(`SELECT * FROM readers ${filters}
    ORDER BY lower_unicode(fullName), id LIMIT @limit OFFSET @offset`);
  const insert = database.prepare(`
    INSERT INTO readers (fullName, email, registrationNumber, status)
    VALUES (@fullName, @email, @registrationNumber, @status)
  `);
  const update = database.prepare(`
    UPDATE readers SET fullName = @fullName, email = @email,
      registrationNumber = @registrationNumber, status = @status WHERE id = @id
  `);
  const hasLoans = database.prepare('SELECT 1 FROM loans WHERE readerId = ? LIMIT 1');
  const remove = database.prepare('DELETE FROM readers WHERE id = ?');
  const historyCount = database.prepare('SELECT count(*) AS total FROM loans WHERE readerId = ?');
  const history = database.prepare(`
    SELECT * FROM loans WHERE readerId = @readerId
    ORDER BY loanedAt DESC, id DESC LIMIT @limit OFFSET @offset
  `);

  return {
    findById: (id) => find.get(id),
    insert: (reader) => insert.run(parameters(reader)).lastInsertRowid,
    update: (id, reader) => update.run({ id, ...parameters(reader) }),
    hasLoans: (id) => Boolean(hasLoans.get(id)),
    remove: (id) => remove.run(id),
    list: database.transaction(({ page, limit, q, status }) => {
      const bindings = { q: q.toLowerCase(), status: status ?? null };
      return {
        page, limit, total: count.get(bindings).total,
        items: list.all({ ...bindings, limit, offset: (page - 1) * limit }),
      };
    }),
    history: database.transaction((readerId, { page, limit }) => ({
      page, limit, total: historyCount.get(readerId).total,
      items: history.all({ readerId, limit, offset: (page - 1) * limit }),
    })),
  };
}
