import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
const envPath = resolve(projectRoot, '.env');

if (existsSync(envPath)) {
  loadEnvFile(envPath);
}

function integerSetting(name, fallback, minimum, maximum = Number.MAX_SAFE_INTEGER) {
  const value = Number(process.env[name] ?? fallback);

  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} должен быть целым числом от ${minimum} до ${maximum}`);
  }

  return value;
}

const databasePath = process.env.DATABASE_PATH ?? './data/library.sqlite';
if (!databasePath.trim()) {
  throw new Error('DATABASE_PATH не должен быть пустым');
}

export const config = {
  port: integerSetting('PORT', 3000, 1, 65535),
  databasePath: resolve(projectRoot, databasePath),
  dailyFineKopecks: integerSetting('DAILY_FINE_KOPECKS', 1000, 0),
  maxActiveLoans: integerSetting('MAX_ACTIVE_LOANS', 5, 1),
  defaultLoanDays: integerSetting('DEFAULT_LOAN_DAYS', 14, 1),
};
