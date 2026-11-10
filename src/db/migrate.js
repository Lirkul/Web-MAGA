import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultDirectory = fileURLToPath(new URL('./migrations/', import.meta.url));

export async function runMigrations(pool, directory = defaultDirectory) {
  const files = (await readdir(directory))
    .filter((file) => /^\d{3}_[a-z0-9_]+\.sql$/.test(file))
    .sort();
  const client = await pool.connect();

  try {
    // Один процесс миграций за раз, включая ручной запуск во время старта API.
    await client.query("SELECT pg_advisory_lock(hashtext('web-maga-schema-migrations'))");
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    const { rows } = await client.query('SELECT filename FROM schema_migrations');
    const applied = new Set(rows.map((row) => row.filename));

    for (const file of files) {
      if (applied.has(file)) continue;

      const sql = await readFile(join(directory, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
      console.log(`Applied migration: ${file}`);
    }
    console.log('Database migrations are up to date');
  } finally {
    try {
      await client.query("SELECT pg_advisory_unlock(hashtext('web-maga-schema-migrations'))");
    } finally {
      client.release();
    }
  }
}
