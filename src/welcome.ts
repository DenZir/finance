/**
 * «Приветка»: ссылка покупателя в приветке владельца, оплата за заявки.
 *
 * Сколько заявок пришло, видит только покупатель — у себя в канале. Раз в
 * какое-то время он присылает число, всего с начала размещения (владелец,
 * 2026-10-20); только тогда становится известно, сколько он должен. Каждая
 * такая «фиксация» — долг за новые заявки с прошлой: заявки × цена. После неё
 * владелец решает, лить дальше или остановить.
 *
 * Оплаченная фиксация — операция с source 'welcome' и source_ref 'fix:<id>',
 * отдельного флага нет: удалили операцию — фиксация снова ждёт оплату.
 */
import type { Db } from './db/index.js';
import { MICRO, MoneyInputError } from './money.js';
import { addIncome, getWallet, listCategories, listProjects } from './ledger.js';

export const SOURCE = 'welcome';
const fixRef = (id: number) => `fix:${id}`;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export interface WelcomeFix {
  id: number;
  onDate: string;
  /** заявок всего с начала, как прислал покупатель */
  total: number;
  /** новых с прошлой фиксации */
  count: number;
  /** ₽-микро за новые: count × цена на тот момент */
  amount: number;
  paid: boolean;
}

export interface WelcomeDeal {
  id: number;
  contact: string;
  /** ₽-микро за заявку */
  price: number;
  startedOn: string;
  stoppedOn: string | null;
  note: string;
  total: number;
  accrued: number;
  paidSum: number;
  owed: number;
  fixes: WelcomeFix[];
}

function parseContact(v: unknown): string {
  const s = String(v ?? '').trim().slice(0, 100);
  if (!s) throw new MoneyInputError('кто покупатель — имя или @username');
  return s;
}

function parsePrice(v: unknown): number {
  const s = String(v ?? '').replace(/[\s ]/g, '').replace(',', '.');
  if (!/^\d+(\.\d{1,2})?$/.test(s) || Number(s) <= 0) throw new MoneyInputError('цена за заявку — число рублей, например 5 или 4,5');
  return Math.round(Number(s) * MICRO);
}

function parseDate(v: unknown, what: string): string {
  const s = String(v ?? '');
  if (!DATE.test(s)) throw new MoneyInputError(`${what} — дата в виде 2026-10-20`);
  return s;
}

export function listWelcome(db: Db): WelcomeDeal[] {
  const deals = db.prepare('SELECT * FROM welcome_deals ORDER BY stopped_on IS NOT NULL, started_on DESC, id DESC').all() as any[];
  const fixes = db
    .prepare(
      `SELECT f.*, o.id AS op_id FROM welcome_fixes f
       LEFT JOIN operations o ON o.source = '${SOURCE}' AND o.source_ref = 'fix:' || f.id
       ORDER BY f.on_date, f.id`
    )
    .all() as any[];
  return deals.map((d) => {
    const own: WelcomeFix[] = fixes
      .filter((f) => f.deal_id === d.id)
      .map((f) => ({ id: f.id, onDate: f.on_date, total: f.total, count: f.count, amount: f.amount, paid: !!f.op_id || f.amount === 0 }));
    const accrued = own.reduce((s, f) => s + f.amount, 0);
    const paidSum = own.filter((f) => f.paid).reduce((s, f) => s + f.amount, 0);
    return {
      id: d.id, contact: d.contact, price: d.price, startedOn: d.started_on, stoppedOn: d.stopped_on ?? null, note: d.note,
      total: own.length ? own[own.length - 1]!.total : 0,
      accrued, paidSum, owed: accrued - paidSum, fixes: own,
    };
  });
}

function getDeal(db: Db, id: number): WelcomeDeal {
  const d = listWelcome(db).find((x) => x.id === id);
  if (!d) throw new MoneyInputError('такого размещения нет');
  return d;
}

export function createWelcome(db: Db, input: Record<string, unknown>, now = Date.now()): number {
  const info = db
    .prepare('INSERT INTO welcome_deals (contact, price, started_on, note, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(parseContact(input.contact), parsePrice(input.price), parseDate(input.startedOn, 'с какого дня'), String(input.note ?? '').trim().slice(0, 500), now);
  return Number(info.lastInsertRowid);
}

/** Правка: имя, цена (для следующих фиксаций — прошлые посчитаны по старой), заметка; «Остановить» / «Возобновить». */
export function updateWelcome(db: Db, id: number, input: Record<string, unknown>): void {
  const d = getDeal(db, id);
  db.prepare('UPDATE welcome_deals SET contact = ?, price = ?, note = ?, stopped_on = ? WHERE id = ?').run(
    input.contact === undefined ? d.contact : parseContact(input.contact),
    input.price === undefined ? d.price : parsePrice(input.price),
    input.note === undefined ? d.note : String(input.note).trim().slice(0, 500),
    input.stoppedOn === undefined ? d.stoppedOn : input.stoppedOn === null ? null : parseDate(input.stoppedOn, 'день остановки'),
    id
  );
}

/**
 * Фиксация: покупатель прислал, сколько заявок всего с начала. Долг — за новые
 * с прошлой фиксации. Меньше прошлого числа не бывает: заявки не убывают, а
 * долг со знаком минус ничего бы не значил.
 */
export function fixWelcome(db: Db, id: number, input: Record<string, unknown>, now = Date.now()): { fixId: number; count: number; amount: number } {
  const d = getDeal(db, id);
  const total = Number(String(input.total ?? '').replace(/[\s ]/g, ''));
  if (!Number.isInteger(total) || total < 0) throw new MoneyInputError('заявок всего — целое число');
  if (total < d.total) throw new MoneyInputError(`в прошлый раз было ${d.total} — всего не может стать меньше`);
  const onDate = parseDate(input.onDate, 'день фиксации');
  const last = d.fixes[d.fixes.length - 1];
  if (last && onDate < last.onDate) throw new MoneyInputError(`прошлая фиксация — ${last.onDate}, новая не может быть раньше`);
  const count = total - d.total;
  const amount = count * d.price;
  const info = db
    .prepare('INSERT INTO welcome_fixes (deal_id, on_date, total, count, amount, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, onDate, total, count, amount, now);
  return { fixId: Number(info.lastInsertRowid), count, amount };
}

/** Удалить можно только последнюю и неоплаченную: следующие посчитаны от неё. */
export function deleteFix(db: Db, fixId: number): void {
  const deal = listWelcome(db).find((d) => d.fixes.some((f) => f.id === fixId));
  if (!deal) throw new MoneyInputError('такой фиксации нет');
  const fix = deal.fixes.find((f) => f.id === fixId)!;
  if (deal.fixes[deal.fixes.length - 1]!.id !== fixId) throw new MoneyInputError('удалить можно только последнюю фиксацию');
  if (fix.paid && fix.amount > 0) throw new MoneyInputError('фиксация оплачена — сначала удалите операцию оплаты');
  db.prepare('DELETE FROM welcome_fixes WHERE id = ?').run(fixId);
}

/** Размещение удаляется, пока по нему ничего не оплачено. */
export function deleteWelcome(db: Db, id: number): void {
  const d = getDeal(db, id);
  if (d.fixes.some((f) => f.paid && f.amount > 0)) throw new MoneyInputError('по размещению есть оплаты — сначала удалите их операции');
  db.transaction(() => {
    db.prepare('DELETE FROM welcome_fixes WHERE deal_id = ?').run(id);
    db.prepare('DELETE FROM welcome_deals WHERE id = ?').run(id);
  })();
}

/** «Оплачено»: доход «Заявки с приветки» на кошелёк, без комиссии — это перевод, как у рекламы. */
export function payFix(
  db: Db,
  fixId: number,
  input: { walletId: number; amount: number; rate: number; at: number },
  now = Date.now()
): number {
  const deal = listWelcome(db).find((d) => d.fixes.some((f) => f.id === fixId));
  if (!deal) throw new MoneyInputError('такой фиксации нет');
  const fix = deal.fixes.find((f) => f.id === fixId)!;
  if (fix.paid) throw new MoneyInputError(fix.amount ? 'эта фиксация уже оплачена' : 'новых заявок не было — платить не за что');
  getWallet(db, input.walletId);
  return addIncome(db, {
    at: input.at,
    walletId: input.walletId,
    amount: input.amount,
    rate: input.rate,
    feePct: 0,
    categoryId: listCategories(db).find((c) => c.kind === 'income' && c.name === 'Заявки с приветки')?.id ?? null,
    projectId: listProjects(db).find((p) => p.name === 'Реклама')?.id ?? null,
    note: `Приветка · ${deal.contact} · ${fix.count} заявок`,
    source: SOURCE,
    sourceRef: fixRef(fixId),
  }, now);
}

export interface WelcomeDebt {
  contact: string;
  amount: number;
  count: number;
  onDate: string;
}

/** Неоплаченные фиксации — тоже «Нам должны». */
export function welcomeDebts(db: Db): WelcomeDebt[] {
  return listWelcome(db).flatMap((d) =>
    d.fixes.filter((f) => !f.paid).map((f) => ({ contact: d.contact, amount: f.amount, count: f.count, onDate: f.onDate }))
  );
}
