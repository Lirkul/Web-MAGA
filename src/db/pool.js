import pg from 'pg';

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  connectionTimeoutMillis: 3000,
});

pool.on('error', () => {
  console.error('PostgreSQL idle connection error');
});

export async function checkDatabaseConnection() {
  await pool.query('SELECT 1');
}
