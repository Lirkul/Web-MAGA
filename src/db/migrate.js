import { readdirSync, readFileSync } from 'node:fs';

const migrationsDirectory = new URL('./migrations/', import.meta.url);

export function migrateDatabase(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      appliedAt TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    ) STRICT;
  `);

  const findMigration = database.prepare('SELECT name FROM schema_migrations WHERE name = ?');
  const recordMigration = database.prepare('INSERT INTO schema_migrations (name) VALUES (?)');
  const files = readdirSync(migrationsDirectory).filter((name) => name.endsWith('.sql')).sort();
  let applied = 0;

  for (const name of files) {
    const sql = readFileSync(new URL(name, migrationsDirectory), 'utf8');

    // Схема и запись о миграции сохраняются вместе либо полностью откатываются.
    database.transaction(() => {
      if (findMigration.get(name)) return;
      database.exec(sql);
      recordMigration.run(name);
      applied += 1;
    }).immediate();
  }

  return applied;
}
