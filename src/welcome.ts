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
 *
 * С 2026-10-31 (владелец):
 * - фиксация — позиция долга человека (debts.ts): оплачивается частями, авансом
 *   или взаимозачётом, вместе с его рекламой; оплаты — с source_ref
 *   'fix:<id>@p<оплата>'. Прежние 'fix:<id>' закрывают фиксацию целиком;
 * - покупатель может сменить ссылку — счётчик заявок у него начинается с нуля.
 *   Поэтому у размещения ссылки (welcome_links), у каждой своя цена, а число в
 *   фиксации — всего по текущей ссылке. Владелец вписывает «всего» (340) или
 *   «прибавилось» (+120).
 */
import type { Db } from './db/index.js';
import { MICRO, MoneyInputError } from './money.js';
import { getPerson, personFor, personLabel } from './people.js';
import { listDebtItems, payPerson, type DebtState, type PayResult } from './debts.js';

export const SOURCE = 'welcome';
const fixRef = (id: number) => `fix:${id}`;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export interface WelcomeFix {
  id: number;
  linkId: number | null;
  onDate: string;
  /** заявок всего по своей ссылке, как прислал покупатель */
  total: number;
  /** новых с прошлой фиксации по этой ссылке */
  count: number;
  /** ₽-микро за новые: count × цена ссылки на тот момент */
  amount: number;
  /** ₽-микро оплачено операциями фиксации */
  paid: number;
  /** ₽-микро покрыто авансом покупателя */
  advance: number;
  /** ₽-микро ещё ждём */
  remaining: number;
  /** без новых заявок — paid: платить не за что */
  state: DebtState;
}

export interface WelcomeLink {
  id: number;
  startedOn: string;
  /** ₽-микро за заявку */
  price: number;
  label: string;
  /** заявок всего по ссылке — по последней фиксации */
  total: number;
  /** сколько фиксаций по ссылке */
  fixes: number;
}

export interface WelcomeDeal {
  id: number;
  personId: number | null;
  contact: string;
  /** ₽-микро за заявку — цена текущей ссылки */
  price: number;
  startedOn: string;
  stoppedOn: string | null;
  note: string;
  /** всего по текущей ссылке */
  total: number;
  accrued: number;
  /** оплачено и покрыто авансом */
  paidSum: number;
  /** ещё ждём — по позициям, с авансом */
  owed: number;
  /** по порядку; текущая — последняя */
  links: WelcomeLink[];
  current: WelcomeLink;
  fixes: WelcomeFix[];
}

function parsePrice(v: unknown): number {
  const s = String(v ?? '').replace(/[\s ]/g, '').replace(',', '.');
  if (!/^\d+(\.\d{1,2})?$/.test(s) || Number(s) <= 0) throw new MoneyInputError('цена за заявку — число рублей, например 5 или 4,5');
  return Math.round(Number(s) * MICRO);
}

function parseDate(v: unknown, what: string): string {
  const s = String(v ?? '');
  if (!DATE.test(s)) throw new MoneyInputError(`${what} — дата в виде 2026-10-20`);
  return s;
}

/** Покупатель: выбранный человек или контакт — тогда человек находится или заводится (people.ts). */
function buyer(db: Db, input: Record<string, unknown>, now: number): number {
  if (input.personId !== undefined && input.personId !== null && input.personId !== '') {
    const id = Number(input.personId);
    if (!Number.isInteger(id) || id <= 0) throw new MoneyInputError('не выбран покупатель');
    return getPerson(db, id).id;
  }
  const id = personFor(db, input.contact, now);
  if (id === null) throw new MoneyInputError('кто покупатель — имя или @username');
  return id;
}

export function listWelcome(db: Db): WelcomeDeal[] {
  const deals = db.prepare('SELECT * FROM welcome_deals ORDER BY stopped_on IS NOT NULL, started_on DESC, id DESC').all() as any[];
  const links = db.prepare('SELECT * FROM welcome_links ORDER BY id').all() as any[];
  const fixes = db.prepare('SELECT * FROM welcome_fixes ORDER BY on_date, id').all() as any[];
  const people = new Map((db.prepare('SELECT * FROM people').all() as any[]).map((p) => [p.id, p]));
  const items = new Map(listDebtItems(db).filter((i) => i.source === SOURCE).map((i) => [i.ref, i]));
  return deals.map((d) => {
    const own: WelcomeFix[] = fixes
      .filter((f) => f.deal_id === d.id)
      .map((f) => {
        const it = items.get(fixRef(f.id));
        return {
          id: f.id, linkId: f.link_id ?? null, onDate: f.on_date, total: f.total, count: f.count, amount: f.amount,
          paid: it?.paid ?? 0, advance: it?.advance ?? 0, remaining: it?.remaining ?? 0, state: it?.state ?? 'paid',
        };
      });
    const dealLinks: WelcomeLink[] = links
      .filter((l) => l.deal_id === d.id)
      .map((l) => {
        const lf = own.filter((f) => f.linkId === l.id);
        return { id: l.id, startedOn: l.started_on, price: l.price, label: l.label, total: lf.at(-1)?.total ?? 0, fixes: lf.length };
      });
    // ссылка есть у каждого размещения (миграция, createWelcome); на всякий случай — из самого размещения
    const current = dealLinks.at(-1) ?? { id: 0, startedOn: d.started_on, price: d.price, label: '', total: 0, fixes: 0 };
    const person = d.person_id == null ? null : people.get(d.person_id);
    const accrued = own.reduce((s, f) => s + f.amount, 0);
    return {
      id: d.id, personId: d.person_id ?? null, contact: person ? personLabel({ name: person.name, username: person.username }) : d.contact,
      price: current.price, startedOn: d.started_on, stoppedOn: d.stopped_on ?? null, note: d.note,
      total: current.total, accrued,
      paidSum: own.reduce((s, f) => s + Math.min(f.amount, f.paid + f.advance), 0),
      owed: own.reduce((s, f) => s + f.remaining, 0),
      links: dealLinks, current, fixes: own,
    };
  });
}

function getDeal(db: Db, id: number): WelcomeDeal {
  const d = listWelcome(db).find((x) => x.id === id);
  if (!d) throw new MoneyInputError('такого размещения нет');
  return d;
}

/** Размещение и его первая ссылка — с того же дня и по той же цене. */
export function createWelcome(db: Db, input: Record<string, unknown>, now = Date.now()): number {
  const price = parsePrice(input.price);
  const startedOn = parseDate(input.startedOn, 'с какого дня');
  const note = String(input.note ?? '').trim().slice(0, 500);
  return db.transaction(() => {
    const personId = buyer(db, input, now);
    const id = Number(
      db.prepare('INSERT INTO welcome_deals (contact, person_id, price, started_on, note, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(personLabel(getPerson(db, personId)), personId, price, startedOn, note, now).lastInsertRowid
    );
    db.prepare("INSERT INTO welcome_links (deal_id, started_on, price, label, created_at) VALUES (?, ?, ?, '', ?)").run(id, startedOn, price, now);
    return id;
  })();
}

/**
 * Правка: покупатель (personId или contact), цена — текущей ссылки, для
 * следующих фиксаций (прошлые посчитаны по старой), заметка; «Остановить» /
 * «Возобновить».
 */
export function updateWelcome(db: Db, id: number, input: Record<string, unknown>, now = Date.now()): void {
  const d = getDeal(db, id);
  db.transaction(() => {
    if (input.personId !== undefined || input.contact !== undefined) {
      const personId = buyer(db, input, now);
      db.prepare('UPDATE welcome_deals SET person_id = ?, contact = ? WHERE id = ?').run(personId, personLabel(getPerson(db, personId)), id);
    }
    if (input.price !== undefined) {
      const price = parsePrice(input.price);
      db.prepare('UPDATE welcome_deals SET price = ? WHERE id = ?').run(price, id);
      if (d.current.id) db.prepare('UPDATE welcome_links SET price = ? WHERE id = ?').run(price, d.current.id);
    }
    db.prepare('UPDATE welcome_deals SET note = ?, stopped_on = ? WHERE id = ?').run(
      input.note === undefined ? d.note : String(input.note).trim().slice(0, 500),
      input.stoppedOn === undefined ? d.stoppedOn : input.stoppedOn === null ? null : parseDate(input.stoppedOn, 'день остановки'),
      id
    );
  })();
}

/**
 * Текущая ссылка размещения; если ссылок нет (размещение старше ссылок и миграция
 * его не застала) — заводится из самого размещения.
 */
function currentLink(db: Db, d: WelcomeDeal, now: number): WelcomeLink {
  if (d.current.id) return d.current;
  const id = Number(
    db.prepare("INSERT INTO welcome_links (deal_id, started_on, price, label, created_at) VALUES (?, ?, ?, '', ?)").run(d.id, d.startedOn, d.price, now).lastInsertRowid
  );
  return { ...d.current, id };
}

/**
 * Фиксация: покупатель прислал число заявок — «всего по текущей ссылке» (340)
 * или «прибавилось» (+120); прежнее поле total — как «всего». Долг — за новые с
 * прошлой фиксации по этой ссылке, по её цене. Меньше прошлого «всего» не
 * бывает: заявки не убывают — значит, покупатель сменил ссылку, и счётчик
 * начался заново. Тогда ошибка с кодом new_link: страница предложит завести
 * новую ссылку и зафиксировать число на ней. +0 — фиксация без долга.
 */
export function fixWelcome(
  db: Db,
  id: number,
  input: Record<string, unknown>,
  now = Date.now()
): { fixId: number; linkId: number; count: number; amount: number; total: number } {
  const d = getDeal(db, id);
  const prev = d.current.total;
  const s = String(input.value ?? input.total ?? '').replace(/[\s ]/g, '');
  const plus = /^\+(\d+)$/.exec(s);
  if (!plus && !/^\d+$/.test(s)) throw new MoneyInputError('заявок — всего по ссылке (340) или сколько прибавилось (+120)');
  const total = plus ? prev + Number(plus[1]) : Number(s);
  if (!Number.isSafeInteger(total)) throw new MoneyInputError('слишком много заявок');
  if (total < prev) {
    throw new MoneyInputError(`по этой ссылке в прошлый раз было ${prev} — всего не может стать меньше. Покупатель сменил ссылку?`, 'new_link');
  }
  const onDate = parseDate(input.onDate, 'день фиксации');
  const last = d.fixes.at(-1);
  if (last && onDate < last.onDate) throw new MoneyInputError(`прошлая фиксация — ${last.onDate}, новая не может быть раньше`);
  if (onDate < d.current.startedOn) throw new MoneyInputError(`ссылка — с ${d.current.startedOn}, фиксация не может быть раньше`);
  const count = total - prev;
  const amount = count * d.current.price;
  return db.transaction(() => {
    const link = currentLink(db, d, now);
    const info = db
      .prepare('INSERT INTO welcome_fixes (deal_id, link_id, on_date, total, count, amount, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, link.id, onDate, total, count, amount, now);
    return { fixId: Number(info.lastInsertRowid), linkId: link.id, count, amount, total };
  })();
}

/**
 * «Новая ссылка»: покупатель сменил ссылку — счётчик заявок с нуля. Цена по
 * умолчанию — прежняя; другая — для фиксаций по новой ссылке. Не раньше
 * последней фиксации: она посчитана по прежней ссылке.
 */
export function newWelcomeLink(db: Db, dealId: number, input: Record<string, unknown>, now = Date.now()): number {
  const d = getDeal(db, dealId);
  const startedOn = parseDate(input.startedOn, 'с какого дня ссылка');
  const last = d.fixes.at(-1);
  if (last && startedOn < last.onDate) throw new MoneyInputError(`прошлая фиксация — ${last.onDate}, новая ссылка не может начаться раньше`);
  if (startedOn < d.current.startedOn) throw new MoneyInputError(`текущая ссылка — с ${d.current.startedOn}, новая не может начаться раньше`);
  const price = input.price === undefined || input.price === null || input.price === '' ? d.current.price : parsePrice(input.price);
  const label = String(input.label ?? '').trim().slice(0, 60);
  return db.transaction(() => {
    const id = Number(
      db.prepare('INSERT INTO welcome_links (deal_id, started_on, price, label, created_at) VALUES (?, ?, ?, ?, ?)').run(dealId, startedOn, price, label, now).lastInsertRowid
    );
    db.prepare('UPDATE welcome_deals SET price = ? WHERE id = ?').run(price, dealId);
    return id;
  })();
}

/** Ссылку, заведённую по ошибке: без фиксаций и не единственную. */
export function deleteWelcomeLink(db: Db, linkId: number): void {
  const link = db.prepare('SELECT * FROM welcome_links WHERE id = ?').get(linkId) as any;
  if (!link) throw new MoneyInputError('такой ссылки нет');
  if (db.prepare('SELECT 1 FROM welcome_fixes WHERE link_id = ?').get(linkId)) throw new MoneyInputError('по ссылке есть фиксации — сначала удалите их');
  const others = db.prepare('SELECT * FROM welcome_links WHERE deal_id = ? AND id != ? ORDER BY id').all(link.deal_id, linkId) as any[];
  if (!others.length) throw new MoneyInputError('это единственная ссылка размещения');
  db.transaction(() => {
    db.prepare('DELETE FROM welcome_links WHERE id = ?').run(linkId);
    db.prepare('UPDATE welcome_deals SET price = ? WHERE id = ?').run(others.at(-1).price, link.deal_id);
  })();
}

/** Удалить можно только последнюю и без оплат: следующие посчитаны от неё. */
export function deleteFix(db: Db, fixId: number): void {
  const deal = listWelcome(db).find((d) => d.fixes.some((f) => f.id === fixId));
  if (!deal) throw new MoneyInputError('такой фиксации нет');
  const fix = deal.fixes.find((f) => f.id === fixId)!;
  if (deal.fixes.at(-1)!.id !== fixId) throw new MoneyInputError('удалить можно только последнюю фиксацию');
  if (fix.paid > 0) throw new MoneyInputError('фиксация оплачена — сначала удалите оплату');
  db.transaction(() => {
    db.prepare('DELETE FROM debt_closures WHERE ref = ?').run(fixRef(fixId));
    db.prepare('DELETE FROM welcome_fixes WHERE id = ?').run(fixId);
  })();
}

/** Размещение удаляется, пока по нему ничего не оплачено. */
export function deleteWelcome(db: Db, id: number): void {
  const d = getDeal(db, id);
  if (d.fixes.some((f) => f.paid > 0)) throw new MoneyInputError('по размещению есть оплаты — сначала удалите их');
  db.transaction(() => {
    for (const f of d.fixes) db.prepare('DELETE FROM debt_closures WHERE ref = ?').run(fixRef(f.id));
    db.prepare('DELETE FROM welcome_fixes WHERE deal_id = ?').run(id);
    db.prepare('DELETE FROM welcome_links WHERE deal_id = ?').run(id);
    db.prepare('DELETE FROM welcome_deals WHERE id = ?').run(id);
  })();
}

/**
 * «Оплачено» по одной фиксации: доход «Заявки с приветки» на кошелёк, без
 * комиссии — это перевод, как у рекламы. Оплата у покупателя по этой позиции
 * (payPerson): меньше — частично, больше — в аванс.
 */
export function payFix(
  db: Db,
  fixId: number,
  input: { walletId: number; amount: number; rate: number; at: number; note?: unknown },
  now = Date.now()
): PayResult {
  const deal = listWelcome(db).find((d) => d.fixes.some((f) => f.id === fixId));
  if (!deal) throw new MoneyInputError('такой фиксации нет');
  const fix = deal.fixes.find((f) => f.id === fixId)!;
  if (!fix.amount) throw new MoneyInputError('новых заявок не было — платить не за что');
  if (fix.remaining <= 0) throw new MoneyInputError(fix.state === 'closed' ? 'остаток по фиксации прощён' : 'эта фиксация уже оплачена');
  if (deal.personId === null) throw new MoneyInputError('у размещения нет покупателя — укажите человека');
  return payPerson(db, deal.personId, { ...input, dir: 'in', refs: [fixRef(fixId)] }, now);
}

export interface WelcomeDebt {
  ref: string;
  personId: number | null;
  contact: string;
  /** ₽-микро за фиксацию целиком */
  amount: number;
  /** ₽-микро ещё ждём */
  remaining: number;
  count: number;
  onDate: string;
}

/** Фиксации, по которым ещё ждём, — тоже «Нам должны». */
export function welcomeDebts(db: Db): WelcomeDebt[] {
  return listWelcome(db).flatMap((d) =>
    d.fixes
      .filter((f) => f.remaining > 0)
      .map((f) => ({ ref: fixRef(f.id), personId: d.personId, contact: d.contact, amount: f.amount, remaining: f.remaining, count: f.count, onDate: f.onDate }))
  );
}
