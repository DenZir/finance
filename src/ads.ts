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
 *
 * С 2026-10-31 долг считается по человеку (debts.ts): сделка — позиция его
 * долга, оплата бывает частичной, а «Оплачено» здесь — оплата у человека по
 * одной этой позиции. Человек сделки — по контакту из аналитики (people.ts).
 *
 * С 2026-11-01 отметку «под оплату / бартер» ставят в аналитике (payMode), и
 * сверка переносит её сюда; руками здесь размечаются только старые сделки без
 * неё. Оплаты это не касается: деньги записываются здесь, как и раньше.
 */
import type { Db } from './db/index.js';
import { MICRO, MoneyInputError } from './money.js';
import { addExpense, addIncome, categoryIdByCode, getWallet, projectIdByCode } from './ledger.js';
import { getPerson, personFor } from './people.js';
import { listDebtItems, paidByRef, payPerson, type PayResult } from './debts.js';

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
  /**
   * Отметка из аналитики: paid — под оплату («Ждём оплату»), barter — бартер,
   * null — не поставлена (все старые сделки). Сборки аналитики до 2026-11-01
   * поля не присылают — это то же, что null.
   */
  payMode?: PayMode | null;
}

export type PayMode = 'barter' | 'paid';

/** Отметка аналитики как есть или null: незнакомое значение — не отметка, а не повод уронить сверку. */
export function parsePayMode(v: unknown): PayMode | null {
  return v === 'barter' || v === 'paid' ? v : null;
}

/** Отказ ручной отметке сделки, которую размечает аналитика. */
const ANALYTICS_MARK = 'отметка бартер/под оплату ведётся в аналитике';

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
 *
 * Отметка аналитики (payMode) запоминается и ставит состояние: paid — «Ждём
 * оплату», barter — «Бартер»; при каждой сверке, так что смена в аналитике
 * переворачивает сделку. Без отметки сделка не трогается: старые владелец
 * разбирает руками (просил их не трогать, 2026-11-01). Сделку, по которой уже
 * есть деньги, отметка не переворачивает — оплату снимают только удалением
 * операции; бартер при оплате показывается расхождением (listDeals, conflict).
 */
export async function syncDeals(db: Db, deps: { fetchDeals: FetchDeals; since: number }, now = Date.now()): Promise<{ added: number }> {
  const deals = await deps.fetchDeals(mskDate(deps.since));
  const known = new Set((db.prepare('SELECT ref FROM ad_deals').all() as { ref: string }[]).map((r) => r.ref));
  const upsert = db.prepare(
    `INSERT INTO ad_deals (ref, kind, date, slot, contact, channels, amount, cancelled, pay_mode, synced_at)
     VALUES (@ref, @kind, @date, @slot, @contact, @channels, @amount, @cancelled, @payMode, @now)
     ON CONFLICT(ref) DO UPDATE SET date = excluded.date, slot = excluded.slot, contact = excluded.contact,
       channels = excluded.channels, amount = excluded.amount, cancelled = excluded.cancelled,
       pay_mode = excluded.pay_mode, synced_at = excluded.synced_at`
  );
  // COALESCE — чтобы «с какого дня ждём» не сдвигалось каждой сверкой
  const markWaiting = db.prepare('UPDATE ad_deals SET waiting_at = COALESCE(waiting_at, ?), barter_at = NULL WHERE ref = ?');
  const markBarter = db.prepare('UPDATE ad_deals SET barter_at = COALESCE(barter_at, ?), waiting_at = NULL WHERE ref = ?');
  let added = 0;
  db.transaction(() => {
    const paid = paidByRef(db);
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
        payMode: parsePayMode(d.payMode),
        now,
      });
      const mode = parsePayMode(d.payMode);
      if (mode === null || paid.has(d.ref)) continue;
      (mode === 'paid' ? markWaiting : markBarter).run(now, d.ref);
    }
    // Удалённые в аналитике: их просто нет в ответе за тот же период.
    const seen = new Set(deals.map((d) => d.ref));
    const stale = db.prepare('SELECT ref FROM ad_deals WHERE date >= ? AND cancelled = 0').all(mskDate(deps.since)) as { ref: string }[];
    const cancel = db.prepare('UPDATE ad_deals SET cancelled = 1, synced_at = ? WHERE ref = ?');
    for (const r of stale) if (!seen.has(r.ref)) cancel.run(now, r.ref);
    // Человек — новым сделкам и тем, у кого его ещё нет; назначенного (владелец
    // мог поправить руками) не трогаем, даже если контакт в аналитике сменился.
    const unassigned = db.prepare("SELECT ref, contact FROM ad_deals WHERE person_id IS NULL AND contact != ''").all() as { ref: string; contact: string }[];
    const assign = db.prepare('UPDATE ad_deals SET person_id = ? WHERE ref = ?');
    for (const r of unassigned) {
      const id = personFor(db, r.contact, now);
      if (id !== null) assign.run(id, r.ref);
    }
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
  /**
   * open — не разобрана; waiting — ждём оплату (в том числе остаток после
   * частичной); paid — оплачена целиком, покрыта авансом или остаток прощён;
   * barter — без денег
   */
  state: 'open' | 'waiting' | 'paid' | 'barter';
  /** прежняя операция «Оплачено» с номером сделки, иначе последняя часть оплаты */
  opId: number | null;
  /** ₽-микро, оплачено операциями этой сделки (аванс не входит) */
  paid: number;
  /** ₽-микро, ещё ждём; 0 — не долг */
  remaining: number;
  personId: number | null;
  /** остаток прощён («Простить остаток») */
  closed: boolean;
  /** отметка из аналитики; null — размечается руками здесь */
  payMode: PayMode | null;
  /** отметка аналитики расходится с тем, что записано здесь, — владельцу проверить */
  conflict: string | null;
}

/**
 * Сделки с состоянием по правилам позиций долга (debts.ts): сделка, по которой
 * ещё что-то ждём, — waiting, даже если отметку «Ждём оплату» сняли после
 * частичной оплаты: часть денег уже пришла, это не неразобранная сделка.
 */
export function listDeals(db: Db): AdDealView[] {
  const rows = db.prepare('SELECT * FROM ad_deals ORDER BY date, ref').all() as any[];
  const items = new Map(listDebtItems(db).filter((i) => i.source === SOURCE).map((i) => [i.ref, i]));
  const paid = paidByRef(db);
  return rows.map((r) => {
    const item = items.get(r.ref);
    const p = paid.get(r.ref);
    // не позиция, а оплата есть — отменённая или CPM без суммы, оплаченные прежним «Оплачено»
    const state: AdDealView['state'] = item ? (item.remaining > 0 ? 'waiting' : 'paid') : p ? 'paid' : r.barter_at ? 'barter' : r.waiting_at ? 'waiting' : 'open';
    return {
      ref: r.ref, kind: r.kind, date: r.date, slot: r.slot, contact: r.contact, channels: r.channels,
      amount: r.amount ?? null, cancelled: !!r.cancelled, state,
      opId: p ? p.exactOpId ?? p.lastOpId : null,
      paid: p?.paid ?? 0,
      remaining: item?.remaining ?? 0,
      personId: r.person_id ?? null,
      closed: item?.state === 'closed',
      payMode: parsePayMode(r.pay_mode),
      // бартер по аналитике, а деньги здесь записаны: сверка оплату не снимает
      conflict: r.pay_mode === 'barter' && p ? 'в аналитике — бартер, а здесь есть оплата: проверьте' : null,
    };
  });
}

/**
 * Долги — сделки с отметкой «Ждём оплату», по тому, что ещё не оплачено:
 * частично оплаченная — оставшимся. Продажи — нам должны, закупы — мы должны.
 * Неразобранные считаются отдельно, чтобы не выдавать за долг то, что могло
 * быть бартером или оплачено ещё до начала учёта. Сделки без суммы (CPM ждёт
 * просмотров) в сумму не входят.
 */
export function adDebts(db: Db): { owedToUs: number; weOwe: number; owedToUsCount: number; weOweCount: number; unknown: number; unsorted: number } {
  const live = listDeals(db).filter((d) => !d.cancelled);
  const owed = live.filter((d) => d.remaining > 0);
  const sum = (kind: 'buy' | 'sale') => owed.filter((d) => d.kind === kind).reduce((s, d) => s + d.remaining, 0);
  const count = (kind: 'buy' | 'sale') => owed.filter((d) => d.kind === kind).length + live.filter((d) => d.kind === kind && d.state === 'waiting' && d.amount === null).length;
  return {
    owedToUs: sum('sale'), weOwe: sum('buy'),
    owedToUsCount: count('sale'), weOweCount: count('buy'),
    unknown: live.filter((d) => d.state === 'waiting' && d.amount === null).length,
    unsorted: live.filter((d) => d.state === 'open').length,
  };
}

function getDeal(db: Db, ref: string): AdDealView {
  const d = listDeals(db).find((x) => x.ref === ref);
  if (!d) throw new MoneyInputError('такой сделки нет');
  return d;
}

/** Сделка без человека оплачивается только после того, как владелец его укажет. */
function dealPerson(d: AdDealView): number {
  if (d.personId === null) throw new MoneyInputError('у сделки нет контакта — укажите человека');
  return d.personId;
}

/**
 * «Оплачено» по одной сделке: сколько пришло (продажа) или ушло (закуп) на этом
 * кошельке, в его валюте, — оплата у человека по этой позиции (payPerson).
 * Меньше суммы сделки — оплачена частично, остаток ждём (владелец, 2026-10-31;
 * раньше при взаимозачёте вписывали разницу — теперь для этого «Взаимозачёт»).
 * Больше — переплата уходит в аванс человека. Комиссии нет: за рекламу платят
 * переводом на CryptoBot, а не через приём платёжки (владелец, 2026-10-19).
 */
export function payDeal(
  db: Db,
  ref: string,
  input: { walletId: number; amount: number; rate: number; at: number; note?: unknown },
  now = Date.now()
): PayResult | { paymentId: null; opId: number; paid: number; partial: null; advance: number } {
  const d = getDeal(db, ref);
  if (d.state === 'paid') throw new MoneyInputError('эта сделка уже оплачена');
  if (d.amount === null || d.cancelled) return { paymentId: null, opId: payWhole(db, d, input, now), paid: 1, partial: null, advance: 0 };
  const personId = dealPerson(d);
  return db.transaction(() => {
    // оплатили — значит, не бартер
    db.prepare('UPDATE ad_deals SET barter_at = NULL WHERE ref = ?').run(ref);
    return payPerson(db, personId, { ...input, dir: d.kind === 'sale' ? 'in' : 'out', refs: [ref] }, now);
  })();
}

/**
 * Сделка, которая не позиция долга, — CPM без суммы или отменённая в аналитике,
 * а деньги за неё пришли: прежнее «Оплачено» — одна операция с номером сделки,
 * закрывающая её целиком. Делить по позициям тут нечего: суммы, с которой
 * сравнивать, нет.
 */
function payWhole(db: Db, d: AdDealView, input: { walletId: number; amount: number; rate: number; at: number }, now: number): number {
  getWallet(db, input.walletId);
  const base = {
    at: input.at, walletId: input.walletId, amount: input.amount, rate: input.rate, projectId: projectIdByCode(db, 'ads'),
    note: [d.kind === 'sale' ? 'Продажа' : 'Закуп', d.contact, d.channels].filter(Boolean).join(' · '), source: SOURCE, sourceRef: d.ref,
  };
  return db.transaction(() => {
    db.prepare('UPDATE ad_deals SET barter_at = NULL WHERE ref = ?').run(d.ref);
    return d.kind === 'sale'
      ? addIncome(db, { ...base, feePct: 0, categoryId: categoryIdByCode(db, d.slot === 'stories' ? 'ads_stories' : 'ads_posts') }, now)
      : addExpense(db, { ...base, categoryId: categoryIdByCode(db, 'ads_buy') }, now);
  })();
}

/** «Бартер» и отмена этой отметки. Оплаченную сначала распаровывают удалением оплаты. */
export function setBarter(db: Db, ref: string, on: boolean, now = Date.now()): void {
  const d = getDeal(db, ref);
  if (d.payMode) throw new MoneyInputError(ANALYTICS_MARK);
  if (on && d.state === 'paid') throw new MoneyInputError('сделка уже оплачена — удалите операцию, если это был бартер');
  if (on && d.paid > 0) throw new MoneyInputError('сделка оплачена частично — удалите оплату, если это был бартер');
  db.prepare(on ? 'UPDATE ad_deals SET barter_at = ?, waiting_at = NULL WHERE ref = ?' : 'UPDATE ad_deals SET barter_at = ? WHERE ref = ?').run(on ? now : null, ref);
}

/**
 * «Ждём оплату» и отмена отметки. Оплата её не снимает: удалили операцию —
 * сделка снова ждёт оплату, а не возвращается в неразобранные.
 */
export function setWaiting(db: Db, ref: string, on: boolean, now = Date.now()): void {
  const d = getDeal(db, ref);
  if (d.payMode) throw new MoneyInputError(ANALYTICS_MARK);
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
 * не входит. Сделки с отметкой аналитики тоже пропускаются: её ставят там.
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
      // оплаченные и частично оплаченные: деньги уже были, отметкой их не снять;
      // размеченные аналитикой: следующая сверка всё равно вернула бы её отметку
      if (!d || d.state === 'paid' || d.paid > 0 || d.payMode) {
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

/**
 * «Оплатить всё» у человека: одним переводом за несколько мест (владелец,
 * 2026-10-22). Сумма — сколько пришло или ушло на самом деле. С 2026-10-31 она
 * не делится по ценам, а закрывает места по порядку даты: самые старые целиком,
 * последнее — частично, остаток ждём (payPerson по выбранным). Места без суммы,
 * оплаченные, бартер, отменённые и неизвестные пропускаются; продажи и закупы
 * вместе нельзя — деньги идут в разные стороны; места разных людей — тоже.
 */
export function payDeals(
  db: Db,
  refs: unknown,
  input: { walletId: number; amount: number; rate: number; at: number },
  now = Date.now()
): PayResult & { skipped: number } {
  if (!Array.isArray(refs) || refs.length === 0) throw new MoneyInputError('не выбрано ни одной сделки');
  if (refs.length > BULK_MAX) throw new MoneyInputError(`за раз — не больше ${BULK_MAX} сделок`);
  for (const ref of refs) {
    if (typeof ref !== 'string' || !REF.test(ref)) throw new MoneyInputError(`«${String(ref).slice(0, 40)}» — не сделка`);
  }
  if (!(input.amount > 0)) throw new MoneyInputError('сумма больше нуля');
  const byRef = new Map(listDeals(db).map((d) => [d.ref, d]));
  const unique = [...new Set(refs as string[])];
  const payable = unique
    .map((ref) => byRef.get(ref))
    .filter((d): d is AdDealView => !!d && (d.state === 'open' || d.state === 'waiting') && !d.cancelled && d.amount !== null && d.amount > 0);
  if (!payable.length) throw new MoneyInputError('оплачивать нечего: у выбранных мест нет суммы или они уже разобраны');
  if (new Set(payable.map((d) => d.kind)).size > 1) throw new MoneyInputError('продажи и закупы — отдельно: деньги идут в разные стороны');
  const people = new Set(payable.map(dealPerson));
  if (people.size > 1) throw new MoneyInputError('места разных людей — оплачивайте у каждого отдельно');
  const r = payPerson(db, [...people][0]!, { ...input, dir: payable[0]!.kind === 'sale' ? 'in' : 'out', refs: payable.map((d) => d.ref) }, now);
  return { ...r, skipped: unique.length - payable.length };
}

/** Владелец поправил, чья сделка: контакт в аналитике не тот или человека не узнали. */
export function setDealPerson(db: Db, ref: string, personId: number): void {
  getDeal(db, ref);
  getPerson(db, personId);
  db.prepare('UPDATE ad_deals SET person_id = ? WHERE ref = ?').run(personId, ref);
}
