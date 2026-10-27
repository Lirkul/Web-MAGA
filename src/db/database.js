import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { config } from '../config/index.js';

export function openDatabase(databasePath = config.databasePath) {
  mkdirSync(dirname(databasePath), { recursive: true });

  const database = new Database(databasePath);
  try {
    database.pragma('foreign_keys = ON');
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}
