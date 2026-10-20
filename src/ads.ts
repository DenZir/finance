/**
 * Реклама: закупы и продажи из tg-analytics (GET /api/ads/finance).
 *
 * Аналитика знает сделку и её сумму, но не знает, заплатили ли за неё и куда:
 * часть рекламы оплачивается, часть идёт бартером (владелец, 2026-10-19). Это
 * решает владелец здесь, по каждой сделке:
 * - «Оплачено» на кошелёк — продажа становится доходом «Реклама — посты» или
 *   «— сторисы», закуп — расходом «Закуп рекламы». Операция помнит сделку
 *   (source 'ads', source_ref = ref), удалить её — сделка снова ждёт;
 * - «Бартер» — денег не было: в выручку и остатки не идёт.
 * Пока решения нет, продажа — «Нам должны», закуп — «Мы должны».
 */
import type { Db } from './db/index.js';
import { MICRO, MoneyInputError } from './money.js';
import { addExpense, addIncome, categoryIdByCode, getWallet, projectIdByCode } from './ledger.js';

export const SOURCE = 'ads';

export interface AnalyticsDeal {
  ref: string;
  kind: 'buy' | 'sale';
  date: string;
  slot: string;
  buyKind: string;
  status: string;
  amount: number | null;
  contact: string;
  channels: string[];
}

export type FetchDeals = (since: string) => Promise<AnalyticsDeal[]>;

export function httpDeals(url: string, key: string): FetchDeals {
  return async (since) => {
    const res = await fetch(`${url}/api/ads/finance?since=${since}`, {
      headers: { 'x-api-key': key },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`tg-analytics ответил ${res.status}`);
    const body = (await res.json()) as { deals?: AnalyticsDeal[] };
    if (!Array.isArray(body.deals)) throw new Error('tg-analytics ответил без списка сделок');
    return body.deals;
  };
}

/** Номер сделки, как его отдаёт аналитика: buy:12 / sale:5. */
const REF = /^(buy|sale):\d+$/;

/** ГГГГ-ММ-ДД по Москве. */
const mskDate = (ms: number) => new Date(ms + 3 * 3600_000).toISOString().slice(0, 10);

/**
 * Сверка с аналитикой: новые сделки добавляются, известные получают свежие
 * сумму, дату и статус. Сделка, которой в ответе больше нет (удалили), —
 * отменённая: решение по ней не трогается, но ждать её перестают.
 */
export async function syncDeals(db: Db, deps: { fetchDeals: FetchDeals; since: number }, now = Date.now()): Promise<{ added: number }> {
  const deals = await deps.fetchDeals(mskDate(deps.since));
  const known = new Set((db.prepare('SELECT ref FROM ad_deals').all() as { ref: string }[]).map((r) => r.ref));
  const upsert = db.prepare(
    `INSERT INTO ad_deals (ref, kind, date, slot, contact, channels, amount, cancelled, synced_at)
     VALUES (@ref, @kind, @date, @slot, @contact, @channels, @amount, @cancelled, @now)
     ON CONFLICT(ref) DO UPDATE SET date = excluded.date, slot = excluded.slot, contact = excluded.contact,
       channels = excluded.channels, amount = excluded.amount, cancelled = excluded.cancelled, synced_at = excluded.synced_at`
  );
  let added = 0;
  db.transaction(() => {
    for (const d of deals) {
      if (!REF.test(d.ref) || (d.kind !== 'buy' && d.kind !== 'sale')) continue;
      if (!known.has(d.ref)) added++;
      upsert.run({
        ref: d.ref,
        kind: d.kind,
        date: String(d.date),
        slot: String(d.slot),
        contact: String(d.contact ?? ''),
        channels: (d.channels ?? []).join(', '),
        amount: typeof d.amount === 'number' && Number.isFinite(d.amount) ? Math.round(d.amount * MICRO) : null,
        cancelled: d.status === 'cancel' ? 1 : 0,
        now,
      });
    }
    // Удалённые в аналитике: их просто нет в ответе за тот же период.
    const seen = new Set(deals.map((d) => d.ref));
    const stale = db.prepare('SELECT ref FROM ad_deals WHERE date >= ? AND cancelled = 0').all(mskDate(deps.since)) as { ref: string }[];
    const cancel = db.prepare('UPDATE ad_deals SET cancelled = 1, synced_at = ? WHERE ref = ?');
    for (const r of stale) if (!seen.has(r.ref)) cancel.run(now, r.ref);
  })();
  return { added };
}

export interface AdDealView {
  ref: string;
  kind: 'buy' | 'sale';
  date: string;
  slot: string;
  contact: string;
  channels: string;
  amount: number | null;
  cancelled: boolean;
  /** open — не разобрана; waiting — ждём оплату; paid — есть операция; barter — без денег */
  state: 'open' | 'waiting' | 'paid' | 'barter';
  opId: number | null;
}

export function listDeals(db: Db): AdDealView[] {
  const rows = db
    .prepare(
      `SELECT d.*, o.id AS op_id FROM ad_deals d
       LEFT JOIN operations o ON o.source = '${SOURCE}' AND o.source_ref = d.ref
       ORDER BY d.date, d.ref`
    )
    .all() as any[];
  return rows.map((r) => ({
    ref: r.ref, kind: r.kind, date: r.date, slot: r.slot, contact: r.contact, channels: r.channels,
    amount: r.amount ?? null, cancelled: !!r.cancelled,
    state: r.op_id ? 'paid' : r.barter_at ? 'barter' : r.waiting_at ? 'waiting' : 'open',
    opId: r.op_id ?? null,
  }));
}

/**
 * Долги — только сделки с отметкой «Ждём оплату»: продажи — нам должны, закупы —
 * мы должны. Неразобранные считаются отдельно, чтобы не выдавать за долг то,
 * что могло быть бартером или оплачено ещё до начала учёта. Сделки без суммы
 * (CPM ждёт просмотров) в сумму не входят.
 */
export function adDebts(db: Db): { owedToUs: number; weOwe: number; owedToUsCount: number; weOweCount: number; unknown: number; unsorted: number } {
  const live = listDeals(db).filter((d) => !d.cancelled);
  const waiting = live.filter((d) => d.state === 'waiting');
  const sum = (kind: 'buy' | 'sale') => waiting.filter((d) => d.kind === kind && d.amount !== null).reduce((s, d) => s + d.amount!, 0);
  const count = (kind: 'buy' | 'sale') => waiting.filter((d) => d.kind === kind).length;
  return {
    owedToUs: sum('sale'), weOwe: sum('buy'),
    owedToUsCount: count('sale'), weOweCount: count('buy'),
    unknown: waiting.filter((d) => d.amount === null).length,
    unsorted: live.filter((d) => d.state === 'open').length,
  };
}

function getDeal(db: Db, ref: string): AdDealView {
  const d = listDeals(db).find((x) => x.ref === ref);
  if (!d) throw new MoneyInputError('такой сделки нет');
  return d;
}

const dealNote = (d: AdDealView) =>
  [d.kind === 'sale' ? 'Продажа' : 'Закуп', d.contact, d.channels].filter(Boolean).join(' · ');

/**
 * «Оплачено»: сколько пришло (продажа) или ушло (закуп) на этом кошельке, в его
 * валюте. Сумма — не обязательно сумма сделки: при взаимозачёте с тем же
 * человеком приходит разница. Комиссии нет: за рекламу платят переводом на
 * CryptoBot, а не через приём платёжки (владелец, 2026-10-19).
 */
export function payDeal(
  db: Db,
  ref: string,
  input: { walletId: number; amount: number; rate: number; at: number },
  now = Date.now()
): number {
  const d = getDeal(db, ref);
  if (d.state === 'paid') throw new MoneyInputError('эта сделка уже оплачена');
  getWallet(db, input.walletId);
  const project = projectIdByCode(db, 'ads');
  const base = { at: input.at, walletId: input.walletId, amount: input.amount, rate: input.rate, projectId: project, note: dealNote(d), source: SOURCE, sourceRef: ref };
  return db.transaction(() => {
    db.prepare('UPDATE ad_deals SET barter_at = NULL WHERE ref = ?').run(ref);
    return d.kind === 'sale'
      ? addIncome(db, { ...base, feePct: 0, categoryId: categoryIdByCode(db, d.slot === 'stories' ? 'ads_stories' : 'ads_posts') }, now)
      : addExpense(db, { ...base, categoryId: categoryIdByCode(db, 'ads_buy') }, now);
  })();
}

/** «Бартер» и отмена этой отметки. Оплаченную сначала распаровывают удалением операции. */
export function setBarter(db: Db, ref: string, on: boolean, now = Date.now()): void {
  const d = getDeal(db, ref);
  if (on && d.state === 'paid') throw new MoneyInputError('сделка уже оплачена — удалите операцию, если это был бартер');
  db.prepare(on ? 'UPDATE ad_deals SET barter_at = ?, waiting_at = NULL WHERE ref = ?' : 'UPDATE ad_deals SET barter_at = ? WHERE ref = ?').run(on ? now : null, ref);
}

/**
 * «Ждём оплату» и отмена отметки. Оплата её не снимает: удалили операцию —
 * сделка снова ждёт оплату, а не возвращается в неразобранные.
 */
export function setWaiting(db: Db, ref: string, on: boolean, now = Date.now()): void {
  const d = getDeal(db, ref);
  if (on && d.state === 'paid') throw new MoneyInputError('сделка уже оплачена');
  db.prepare(on ? 'UPDATE ad_deals SET waiting_at = ?, barter_at = NULL WHERE ref = ?' : 'UPDATE ad_deals SET waiting_at = ? WHERE ref = ?').run(on ? now : null, ref);
}

export type BulkAction = 'waiting' | 'barter' | 'unsort';
const BULK_ACTIONS: readonly BulkAction[] = ['waiting', 'barter', 'unsort'];
/** Неразобранных у владельца под сотню; предел — чтобы запрос не тянул таблицу без конца. */
const BULK_MAX = 500;

/**
 * Отметка списком: «Ждём оплату», «Бартер» или «Не разобрана» на многих сделках
 * разом — восемь десятков неразобранных по одной не разобрать (владелец,
 * 2026-10-19). Каждая — как отметка по одной (setWaiting / setBarter), и всё
 * одной транзакцией, чтобы «Нам должны» не сошлись наполовину. Оплаченные и
 * неизвестные пропускаются, а не роняют список: оплату снимают удалением
 * операции. Сделка, уже стоящая в этом состоянии, не трогается и в «Отмечено»
 * не входит.
 */
export function bulkMark(db: Db, refs: readonly string[], action: BulkAction, now = Date.now()): { changed: number; skipped: number } {
  if (!BULK_ACTIONS.includes(action)) throw new MoneyInputError('неизвестная отметка');
  if (!Array.isArray(refs) || refs.length === 0) throw new MoneyInputError('не выбрано ни одной сделки');
  if (refs.length > BULK_MAX) throw new MoneyInputError(`за раз — не больше ${BULK_MAX} сделок`);
  for (const ref of refs) {
    if (typeof ref !== 'string' || !REF.test(ref)) throw new MoneyInputError(`«${String(ref).slice(0, 40)}» — не сделка`);
  }
  const target = action === 'unsort' ? 'open' : action;
  const mark = db.prepare('UPDATE ad_deals SET waiting_at = ?, barter_at = ? WHERE ref = ?');
  return db.transaction(() => {
    const byRef = new Map(listDeals(db).map((d) => [d.ref, d]));
    let changed = 0;
    let skipped = 0;
    for (const ref of new Set(refs)) {
      const d = byRef.get(ref);
      if (!d || d.state === 'paid') {
        skipped++;
        continue;
      }
      if (d.state === target) continue;
      mark.run(action === 'waiting' ? now : null, action === 'barter' ? now : null, ref);
      changed++;
    }
    return { changed, skipped };
  })();
}
