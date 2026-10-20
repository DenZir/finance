/**
 * Регулярные расходы: серверы, подписки — то, что уходит каждый месяц.
 *
 * Сами они не записываются: сумма бывает другой (курс, тариф), а иногда платёж
 * пропускают. В свой день бот присылает готовый черновик, и расход ложится в
 * учёт только по «Записать» (владелец, 2026-10-20). Записанный месяц — операция
 * с source 'recurring' и source_ref '<id>:<ГГГГ-ММ>'; удалили её — месяц снова
 * ждёт. «Пропустить» запоминается отдельно.
 */
import type { Db } from './db/index.js';
import { MoneyInputError, parseAmount } from './money.js';
import { addExpense, addPartnerExpense, getWallet, listProjects } from './ledger.js';

export const SOURCE = 'recurring';
const MONTH = /^\d{4}-\d{2}$/;
export const refOf = (id: number, month: string) => `${id}:${month}`;

export interface Recurring {
  id: number;
  name: string;
  /** микро в валюте `currency` */
  amount: number;
  currency: string;
  /** с какого кошелька; null — платит партнёр */
  walletId: number | null;
  /** 'partner' — расход оплачивает партнёр из своих денег (владелец, 2026-10-20) */
  paidBy: 'partner' | null;
  categoryId: number | null;
  projectId: number | null;
  /** какого числа; в коротком месяце — его последний день */
  day: number;
  active: boolean;
}

export interface RecurringMonth extends Recurring {
  /** ГГГГ-ММ-ДД — день платежа в этом месяце */
  dueDate: string;
  /** paid — записан; skipped — пропущен; due — день настал, ждёт; upcoming — ещё не настал */
  state: 'paid' | 'skipped' | 'due' | 'upcoming';
  opId: number | null;
}

const row = (r: any): Recurring => ({
  id: r.id, name: r.name, amount: r.amount, currency: r.currency, walletId: r.wallet_id ?? null, paidBy: r.paid_by === 'partner' ? 'partner' : null,
  categoryId: r.category_id ?? null, projectId: r.project_id ?? null, day: r.day, active: r.active === 1,
});

export function dueDateOf(day: number, month: string): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${month}-${String(Math.min(day, last)).padStart(2, '0')}`;
}

/** Все регулярные с состоянием в месяце `month`; `today` — ГГГГ-ММ-ДД по Москве. */
export function listRecurring(db: Db, month: string, today: string): RecurringMonth[] {
  if (!MONTH.test(month)) throw new MoneyInputError('месяц — в виде 2026-10');
  const items = (db.prepare('SELECT * FROM recurring ORDER BY active DESC, day, id').all() as any[]).map(row);
  const paid = new Map(
    (db.prepare(`SELECT id, source_ref FROM operations WHERE source = '${SOURCE}' AND source_ref LIKE ?`).all(`%:${month}`) as { id: number; source_ref: string }[])
      .map((o) => [o.source_ref, o.id])
  );
  const skipped = new Set((db.prepare('SELECT recurring_id FROM recurring_skips WHERE month = ?').all(month) as { recurring_id: number }[]).map((s) => s.recurring_id));
  return items.map((r) => {
    const dueDate = dueDateOf(r.day, month);
    const opId = paid.get(refOf(r.id, month)) ?? null;
    const state = opId ? 'paid' : skipped.has(r.id) ? 'skipped' : dueDate <= today ? 'due' : 'upcoming';
    return { ...r, dueDate, state, opId };
  });
}

function fields(db: Db, input: Record<string, unknown>, current?: Recurring) {
  const pick = <T>(k: string, parse: (v: unknown) => T, fallback: T | undefined): T => {
    if (input[k] === undefined) {
      if (fallback === undefined) throw new MoneyInputError(`не заполнено: ${k}`);
      return fallback;
    }
    return parse(input[k]);
  };
  const name = pick('name', (v) => {
    const s = String(v ?? '').trim().slice(0, 100);
    if (!s) throw new MoneyInputError('что за расход — например, «Сервер Aeza»');
    return s;
  }, current?.name);
  // кто платит: партнёр — без кошелька, но только в проекте с партнёром
  const paidBy: 'partner' | null = input.paidBy === undefined ? current?.paidBy ?? null : input.paidBy === 'partner' ? 'partner' : null;
  const walletId = paidBy === 'partner'
    ? null
    : pick('walletId', (v) => getWallet(db, Number(v)).id, current?.walletId ?? undefined);
  const currency = pick('currency', (v) => {
    const s = String(v ?? '').trim().toUpperCase();
    return s || (walletId === null ? 'RUB' : getWallet(db, walletId).currency);
  }, current?.currency ?? (walletId === null ? 'RUB' : getWallet(db, walletId).currency));
  if (!/^[A-Z]{2,6}$/.test(currency)) throw new MoneyInputError('валюта — код вроде RUB, USD, USDT');
  const amount = pick('amount', (v) => parseAmount(v), current?.amount);
  const day = pick('day', (v) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1 || n > 31) throw new MoneyInputError('какого числа — от 1 до 31');
    return n;
  }, current?.day);
  const optRef = (table: 'categories' | 'projects') => (v: unknown) => {
    if (v === null || v === '' || v === undefined) return null;
    const id = Number(v);
    if (!db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(id)) throw new MoneyInputError(table === 'categories' ? 'такого вида нет' : 'такого проекта нет');
    return id;
  };
  const categoryId = input.categoryId === undefined ? current?.categoryId ?? null : optRef('categories')(input.categoryId);
  const projectId = input.projectId === undefined ? current?.projectId ?? null : optRef('projects')(input.projectId);
  if (paidBy === 'partner' && !listProjects(db).find((p) => p.id === projectId)?.partnerPct) {
    throw new MoneyInputError('платит партнёр — выберите проект с партнёром');
  }
  return { name, walletId, currency, amount, day, categoryId, projectId, paidBy };
}

export function createRecurring(db: Db, input: Record<string, unknown>, now = Date.now()): number {
  const f = fields(db, input);
  return Number(
    db.prepare('INSERT INTO recurring (name, amount, currency, wallet_id, category_id, project_id, day, paid_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(f.name, f.amount, f.currency, f.walletId, f.categoryId, f.projectId, f.day, f.paidBy, now).lastInsertRowid
  );
}

function getRecurring(db: Db, id: number): Recurring {
  const r = db.prepare('SELECT * FROM recurring WHERE id = ?').get(id);
  if (!r) throw new MoneyInputError('такого регулярного расхода нет');
  return row(r);
}

export function updateRecurring(db: Db, id: number, input: Record<string, unknown>): void {
  const cur = getRecurring(db, id);
  const f = fields(db, input, cur);
  const active = input.active === undefined ? cur.active : !!input.active;
  db.prepare('UPDATE recurring SET name = ?, amount = ?, currency = ?, wallet_id = ?, category_id = ?, project_id = ?, day = ?, paid_by = ?, active = ? WHERE id = ?')
    .run(f.name, f.amount, f.currency, f.walletId, f.categoryId, f.projectId, f.day, f.paidBy, active ? 1 : 0, id);
}

/** Удаление не трогает записанные расходы — это уже прошлое. */
export function deleteRecurring(db: Db, id: number): void {
  getRecurring(db, id);
  db.transaction(() => {
    db.prepare('DELETE FROM recurring_skips WHERE recurring_id = ?').run(id);
    db.prepare('DELETE FROM recurring_notices WHERE recurring_id = ?').run(id);
    db.prepare('DELETE FROM recurring WHERE id = ?').run(id);
  })();
}

/**
 * «Записать»: расход месяца — сумма в валюте кошелька (страница и бот уже
 * пересчитали, если валюта расхода другая). Вид, проект и заметка — из
 * регулярного; расход проекта с партнёром уменьшит долг перед ним. Платит
 * партнёр — расход без кошелька, сумма в `currency` (по умолчанию — валюта
 * регулярного), и владелец остаётся должен ему её за вычетом его доли.
 */
export function payRecurring(
  db: Db,
  id: number,
  month: string,
  input: { walletId: number | null; amount: number; rate: number; at: number; currency?: string },
  now = Date.now()
): number {
  if (!MONTH.test(month)) throw new MoneyInputError('месяц — в виде 2026-10');
  const r = getRecurring(db, id);
  if (db.prepare('SELECT 1 FROM operations WHERE source = ? AND source_ref = ?').get(SOURCE, refOf(id, month))) {
    throw new MoneyInputError(`«${r.name}» за этот месяц уже записан`);
  }
  const base = { at: input.at, amount: input.amount, rate: input.rate, categoryId: r.categoryId, projectId: r.projectId, note: r.name, source: SOURCE, sourceRef: refOf(id, month) };
  return db.transaction(() => {
    db.prepare('DELETE FROM recurring_skips WHERE recurring_id = ? AND month = ?').run(id, month);
    if (r.paidBy === 'partner') return addPartnerExpense(db, { ...base, currency: input.currency ?? r.currency }, now);
    if (input.walletId == null) throw new MoneyInputError('с какого кошелька?');
    return addExpense(db, { ...base, walletId: input.walletId }, now);
  })();
}

export function skipRecurring(db: Db, id: number, month: string, on: boolean, now = Date.now()): void {
  if (!MONTH.test(month)) throw new MoneyInputError('месяц — в виде 2026-10');
  const r = getRecurring(db, id);
  if (on && db.prepare('SELECT 1 FROM operations WHERE source = ? AND source_ref = ?').get(SOURCE, refOf(id, month))) {
    throw new MoneyInputError(`«${r.name}» за этот месяц уже записан — удалите операцию, если платежа не было`);
  }
  if (on) db.prepare('INSERT OR IGNORE INTO recurring_skips (recurring_id, month, at) VALUES (?, ?, ?)').run(id, month, now);
  else db.prepare('DELETE FROM recurring_skips WHERE recurring_id = ? AND month = ?').run(id, month);
}

/**
 * Кому сегодня пора прислать черновик: включённые, чей день в этом месяце
 * настал, ещё не записаны, не пропущены и черновик по ним в этом месяце не
 * отправлялся. Отметку ставит markNoticed — до отправки, как у напоминания.
 */
export function dueForNotice(db: Db, today: string): RecurringMonth[] {
  const month = today.slice(0, 7);
  const sent = new Set((db.prepare('SELECT recurring_id FROM recurring_notices WHERE month = ?').all(month) as { recurring_id: number }[]).map((s) => s.recurring_id));
  return listRecurring(db, month, today).filter((r) => r.active && r.state === 'due' && !sent.has(r.id));
}

export function markNoticed(db: Db, id: number, month: string): void {
  db.prepare('INSERT OR IGNORE INTO recurring_notices (recurring_id, month) VALUES (?, ?)').run(id, month);
}
