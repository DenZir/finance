/**
 * Люди: с кем владелец рассчитывается за рекламу и приветку (владелец,
 * 2026-10-31). Один человек бывает должен из разных источников сразу — продал
 * ему пост, купил у него сторис, его ссылка в приветке, — и долг считается по
 * человеку целиком (debts.ts).
 *
 * Узнаётся человек по @username: имя в аналитике и в приветке пишут как
 * придётся («Иван», «Ваня (@ivan)»), а username у него один. Без username — по
 * имени, но только среди тех, у кого username неизвестен: «Иван» без @ и
 * «Иван (@ivan_2)» — не обязательно один человек. Ошибся — владелец объединит.
 */
import type { Db } from './db/index.js';
import { MoneyInputError } from './money.js';

export interface Person {
  id: number;
  name: string;
  /** без @, в нижнем регистре; null — неизвестен */
  username: string | null;
  createdAt: number;
}

/** Правила Telegram: 5–32 знака, но у старых аккаунтов бывают и четыре — не отвергаем. */
const USERNAME = /^[A-Za-z0-9_]{4,32}$/;
const USERNAME_IN = /(?:https?:\/\/)?(?:@|t\.me\/)([A-Za-z0-9_]{4,32})(?![A-Za-z0-9_])/;
const NAME_MAX = 100;

/**
 * Контакт как его пишут люди → имя и username. «Иван (@ivan)» → Иван / ivan;
 * «@Ivan» → «@Ivan» / ivan (имени нет — показываем username как написан);
 * «Иван» → Иван / null; пусто — человека нет.
 */
export function parseContact(input: unknown): { name: string; username: string | null } | null {
  const s = String(input ?? '').replace(/\s+/g, ' ').trim();
  if (!s) return null;
  const m = USERNAME_IN.exec(s);
  if (!m) return { name: s.slice(0, NAME_MAX), username: null };
  const name = s
    .replace(m[0], '')
    .replace(/\(\s*\)|\[\s*\]/g, '')
    .replace(/^[\s,;:·|—–-]+|[\s,;:·|—–-]+$/g, '')
    .trim();
  return { name: (name || `@${m[1]}`).slice(0, NAME_MAX), username: m[1]!.toLowerCase() };
}

/** Как показывать человека и что писать в welcome_deals.contact: «Иван (@ivan)», «@ivan», «Иван». */
export function personLabel(p: { name: string; username: string | null }): string {
  if (!p.username) return p.name;
  return p.name.toLowerCase() === `@${p.username}` ? p.name : `${p.name} (@${p.username})`;
}

const row = (r: any): Person => ({ id: r.id, name: r.name, username: r.username ?? null, createdAt: r.created_at });

export function listPeople(db: Db): Person[] {
  return (db.prepare('SELECT * FROM people ORDER BY name COLLATE NOCASE, id').all() as any[]).map(row);
}

export function getPerson(db: Db, id: number): Person {
  const r = db.prepare('SELECT * FROM people WHERE id = ?').get(id);
  if (!r) throw new MoneyInputError('такого человека нет');
  return row(r);
}

/**
 * Человек по контакту: по username, без него — по имени без учёта регистра
 * среди людей без username; не нашёлся — заводится. Пустой контакт — null.
 */
export function personFor(db: Db, contact: unknown, now = Date.now()): number | null {
  const c = parseContact(contact);
  if (!c) return null;
  if (c.username) {
    const found = db.prepare('SELECT id FROM people WHERE username = ?').get(c.username) as { id: number } | undefined;
    if (found) return found.id;
  } else {
    // lower() в SQLite знает только латиницу, а имена — по-русски
    const name = c.name.toLowerCase();
    const found = (db.prepare('SELECT id, name FROM people WHERE username IS NULL ORDER BY id').all() as { id: number; name: string }[])
      .find((p) => p.name.toLowerCase() === name);
    if (found) return found.id;
  }
  return Number(db.prepare('INSERT INTO people (name, username, created_at) VALUES (?, ?, ?)').run(c.name, c.username, now).lastInsertRowid);
}

/** «+ Человек» руками: тот же поиск, что и для сделок, — знакомый не задвоится. */
export function createPerson(db: Db, contact: unknown, now = Date.now()): number {
  const id = personFor(db, contact, now);
  if (id === null) throw new MoneyInputError('кто это — имя или @username');
  return id;
}

function parseUsername(v: unknown): string | null {
  const s = String(v ?? '').trim().replace(/^@/, '').replace(/^(?:https?:\/\/)?t\.me\//, '');
  if (!s) return null;
  if (!USERNAME.test(s)) throw new MoneyInputError(`«${s.slice(0, 40)}» — не username: латиница, цифры и _, от 4 до 32 знаков`);
  return s.toLowerCase();
}

/** Приветка показывает contact из своей строки — держим его в согласии с человеком. */
function syncWelcomeContact(db: Db, personId: number): void {
  db.prepare('UPDATE welcome_deals SET contact = ? WHERE person_id = ?').run(personLabel(getPerson(db, personId)), personId);
}

/** Поправить имя или @. Username, который уже у другого, — повод объединить, а не переписать. */
export function renamePerson(db: Db, id: number, patch: { name?: unknown; username?: unknown }): void {
  const p = getPerson(db, id);
  const name = patch.name === undefined ? p.name : String(patch.name).replace(/\s+/g, ' ').trim().slice(0, NAME_MAX);
  if (!name) throw new MoneyInputError('нужно имя');
  const username = patch.username === undefined ? p.username : parseUsername(patch.username);
  if (username) {
    const other = db.prepare('SELECT * FROM people WHERE username = ? AND id != ?').get(username, id);
    if (other) throw new MoneyInputError(`@${username} уже у «${row(other).name}» — объедините их`);
  }
  db.transaction(() => {
    db.prepare('UPDATE people SET name = ?, username = ? WHERE id = ?').run(name, username, id);
    syncWelcomeContact(db, id);
  })();
}

/**
 * Объединить: сделки, размещения и оплаты from переходят к into, from
 * удаляется. Username from достаётся into, если у того его не было. Одной
 * транзакцией — иначе половина долгов осталась бы у удалённого.
 */
export function mergePeople(db: Db, fromId: number, intoId: number): void {
  if (fromId === intoId) throw new MoneyInputError('это один и тот же человек');
  const from = getPerson(db, fromId);
  const into = getPerson(db, intoId);
  db.transaction(() => {
    for (const table of ['ad_deals', 'welcome_deals', 'payments']) {
      db.prepare(`UPDATE ${table} SET person_id = ? WHERE person_id = ?`).run(intoId, fromId);
    }
    db.prepare('DELETE FROM people WHERE id = ?').run(fromId);
    if (!into.username && from.username) db.prepare('UPDATE people SET username = ? WHERE id = ?').run(from.username, intoId);
    syncWelcomeContact(db, intoId);
  })();
}

/**
 * Люди из уже записанных контактов — после миграции, где они появились, и для
 * всего, что пришло без человека. Трогает только person_id IS NULL: человека,
 * которого владелец поправил руками, не переназначает. Сколько назначено.
 */
export function backfillPeople(db: Db, now = Date.now()): number {
  return db.transaction(() => {
    let n = 0;
    for (const table of ['ad_deals', 'welcome_deals'] as const) {
      const key = table === 'ad_deals' ? 'ref' : 'id';
      const rows = db.prepare(`SELECT ${key} AS k, contact FROM ${table} WHERE person_id IS NULL AND contact != ''`).all() as { k: string | number; contact: string }[];
      const set = db.prepare(`UPDATE ${table} SET person_id = ? WHERE ${key} = ?`);
      for (const r of rows) {
        const id = personFor(db, r.contact, now);
        if (id === null) continue;
        set.run(id, r.k);
        n++;
      }
    }
    return n;
  })();
}
