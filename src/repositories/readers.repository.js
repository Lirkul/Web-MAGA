import { pool } from '../db/pool.js';
import { escapeLike } from './sql.js';

export async function insertReader({ fullName, email, registrationNumber }) {
  const { rows } = await pool.query(`
    INSERT INTO readers (full_name, email, registration_number)
    VALUES ($1, $2, $3) RETURNING *
  `, [fullName, email, registrationNumber]);
  return rows[0];
}

export async function findReaderById(id) {
  const { rows } = await pool.query('SELECT * FROM readers WHERE id = $1', [id]);
  return rows[0];
}

export async function findReaders({ search, status, page, limit }) {
  const conditions = [];
  const values = [];
  if (search) {
    values.push(`%${escapeLike(search)}%`);
    conditions.push('(full_name ILIKE $1 OR email ILIKE $1 OR registration_number ILIKE $1)');
  }
  if (status) {
    values.push(status);
    conditions.push(`status = $${values.length}`);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const countResult = await pool.query(`SELECT COUNT(*) AS total FROM readers ${where}`, values);
  const { rows } = await pool.query(`
    SELECT * FROM readers ${where} ORDER BY id ASC
    LIMIT $${values.length + 1} OFFSET $${values.length + 2}
  `, [...values, limit, (page - 1) * limit]);
  return { rows, total: Number(countResult.rows[0].total) };
}

export async function updateReaderFields(id, data) {
  const columns = {
    fullName: 'full_name', email: 'email', registrationNumber: 'registration_number', status: 'status',
  };
  const fields = Object.entries(columns).filter(([field]) => data[field] !== undefined);
  const values = fields.map(([field]) => data[field]);
  // Имена колонок заданы явно; пользовательские значения всегда параметризованы.
  const assignments = fields.map(([, column], index) => `${column} = $${index + 1}`);
  values.push(id);
  const { rows } = await pool.query(`
    UPDATE readers SET ${assignments.join(', ')}, updated_at = clock_timestamp()
    WHERE id = $${values.length} RETURNING *
  `, values);
  return rows[0];
}
