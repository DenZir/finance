/**
 * База: SQLite-файл, миграции по порядку — номер последней лежит в user_version.
 * Готовую миграцию не правят, только дописывают новую в конец.
 */
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { MIGRATIONS } from './migrations.js';

export type Db = Database.Database;

export function openDb(file: string): Db {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  // каскадное удаление проводок вместе с операцией без этого молча не работает
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  migrate(db);
  return db;
}

export function migrate(db: Db): void {
  const applied = db.pragma('user_version', { simple: true }) as number;
  if (applied > MIGRATIONS.length) {
    throw new Error(`база новее кода: применено миграций ${applied}, а код знает ${MIGRATIONS.length}`);
  }
  for (let i = applied; i < MIGRATIONS.length; i++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[i]!);
      db.pragma(`user_version = ${i + 1}`);
    })();
  }
}
