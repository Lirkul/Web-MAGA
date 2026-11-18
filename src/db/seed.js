const books = [
  ['Чистый код', ['Роберт Мартин'], '9780132350884', 2008, 'Программирование', 5],
  ['Совершенный код', ['Стив Макконнелл'], '9780735619678', 2004, 'Программирование', 3],
];

export async function seedDatabase(pool) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let imported = 0;
    for (const book of books) {
      const { rowCount } = await client.query(`
        INSERT INTO books (title, authors, isbn, publication_year, genre, total_copies)
        VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (isbn) DO NOTHING
      `, book);
      imported += rowCount;
    }
    const { rowCount: readers } = await client.query(`
      INSERT INTO readers (full_name, email, registration_number)
      VALUES ($1, $2, $3) ON CONFLICT DO NOTHING
    `, ['Демонстрационный читатель', 'demo.reader@example.com', 'DEMO-001']);
    await client.query('COMMIT');
    return { books: imported, readers };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
