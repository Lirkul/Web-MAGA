import { pool } from '../db/pool.js';

const selectBooks = `
  SELECT b.*, b.total_copies - COUNT(l.id) AS available_copies
  FROM books b
  LEFT JOIN loans l ON l.book_id = b.id AND l.returned_at IS NULL
`;

function escapeLike(value) {
  return value.replace(/[\\%_]/g, '\\$&');
}

export async function insertBook({ title, authors, isbn, publicationYear, genre, totalCopies }) {
  const { rows } = await pool.query(`
    INSERT INTO books (title, authors, isbn, publication_year, genre, total_copies)
    VALUES ($1, $2, $3, $4, $5, $6)
    RETURNING *, total_copies AS available_copies
  `, [title, authors, isbn, publicationYear ?? null, genre ?? null, totalCopies]);
  return rows[0];
}

export async function findBookById(id, client = pool) {
  const { rows } = await client.query(`${selectBooks} WHERE b.id = $1 GROUP BY b.id`, [id]);
  return rows[0];
}

export async function findBooks({ search, isbnSearch, genre, page, limit }) {
  const conditions = [];
  const values = [];
  if (search) {
    values.push(`%${escapeLike(search)}%`, `%${escapeLike(isbnSearch || search)}%`);
    conditions.push(`(
      b.title ILIKE $1
      OR EXISTS (SELECT 1 FROM unnest(b.authors) AS author(value) WHERE author.value ILIKE $1)
      OR b.isbn ILIKE $2
    )`);
  }
  if (genre) {
    values.push(genre);
    conditions.push(`lower(b.genre) = lower($${values.length})`);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const countResult = await pool.query(`SELECT COUNT(*) AS total FROM books b ${where}`, values);
  const { rows } = await pool.query(`
    ${selectBooks} ${where}
    GROUP BY b.id ORDER BY b.id ASC
    LIMIT $${values.length + 1} OFFSET $${values.length + 2}
  `, [...values, limit, (page - 1) * limit]);
  return { rows, total: Number(countResult.rows[0].total) };
}

export async function lockBookById(id, client) {
  const { rows } = await client.query('SELECT id FROM books WHERE id = $1 FOR UPDATE', [id]);
  return rows[0];
}

export async function countUnreturnedLoans(id, client) {
  const { rows } = await client.query(
    'SELECT COUNT(*) AS count FROM loans WHERE book_id = $1 AND returned_at IS NULL', [id],
  );
  return Number(rows[0].count);
}

export async function updateBookFields(id, data, client) {
  const columns = {
    title: 'title', authors: 'authors', isbn: 'isbn',
    publicationYear: 'publication_year', genre: 'genre', totalCopies: 'total_copies',
  };
  const fields = Object.entries(columns).filter(([field]) => data[field] !== undefined);
  const values = fields.map(([field]) => data[field]);
  // Имена колонок берутся только из списка выше; значения передаются параметрами.
  const assignments = fields.map(([, column], index) => `${column} = $${index + 1}`);
  values.push(id);
  await client.query(`
    UPDATE books SET ${assignments.join(', ')}, updated_at = clock_timestamp()
    WHERE id = $${values.length}
  `, values);
}

export async function hasBookLoans(id) {
  const { rows } = await pool.query(
    'SELECT EXISTS (SELECT 1 FROM loans WHERE book_id = $1) AS has_loans', [id],
  );
  return rows[0].has_loans;
}

export async function deleteBookById(id) {
  const { rows } = await pool.query('DELETE FROM books WHERE id = $1 RETURNING id', [id]);
  return rows[0];
}
