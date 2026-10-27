import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { config } from '../config/index.js';

export function openDatabase(databasePath = config.databasePath) {
  mkdirSync(dirname(databasePath), { recursive: true });

  const database = new Database(databasePath);
  try {
    database.pragma('foreign_keys = ON');
    // Встроенный lower() SQLite не меняет регистр кириллицы.
    database.function('lower_unicode', { deterministic: true }, (value) => value.toLowerCase());
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}
