/**
 * Долги по людям (владелец, 2026-10-31): позиции из всех источников сразу —
 * реклама (продажи и закупы) и приветка, — оплаты частями, аванс с переплаты и
 * взаимозачёт встречных долгов.
 *
 * Позиция — то, за что платят: сделка рекламы «Ждём оплату» или фиксация
 * приветки. Сколько по ней оплачено, нигде не хранится — это сумма операций с её
 * номером: прежние (source_ref = 'sale:5', одна операция закрывала сделку
 * целиком) и новые части оплат ('sale:5@p12'). Удалили оплату — позиция снова
 * ждёт ровно на эту сумму.
 *
 * Решения владельца:
 * - заплатил меньше, чем должен, — закрываются самые старые позиции целиком,
 *   последняя частично («оплачено 1 000 из 1 700»), остаток висит долгом;
 *   галочками можно выбрать, какие позиции оплачены, — тогда по ним, по дате;
 * - переплата — аванс человека: сам гасит его следующие позиции того же
 *   направления. Аванс — операция, а что он покрыл, считается, а не хранится:
 *   удалили позицию или оплату — аванс перераспределится сам;
 * - он должен нам и мы ему (бартер — не долг) — взаимозачёт закрывает обе
 *   стороны на одну сумму без движения денег;
 * - «Простить остаток» — скидка или недоплата, которую уже не ждут.
 */
import type { Db } from './db/index.js';
import { MoneyInputError, toRub } from './money.js';
import { addExpense, addIncome, addOffsetOp, categoryIdByCode, getWallet, projectIdByCode } from './ledger.js';
import { getPerson, listPeople, personLabel } from './people.js';
import { rub as fmtRub } from './bot/text.js';

export { deletePayment } from './ledger.js';

export type DebtDir = 'in' | 'out';
export type DebtState = 'open' | 'partial' | 'paid' | 'closed';

export interface DebtItem {
  /** sale:5 | buy:7 | fix:3 */
  ref: string;
  personId: number | null;
  /** in — он нам (продажа, приветка); out — мы ему (закуп) */
  dir: DebtDir;
  source: 'ads' | 'welcome';
  /** день места или фиксации, ГГГГ-ММ-ДД */
  date: string;
  /** «сторисы · MARIN GAMES», «пост вечер · SATAN GAMES», «приветка · 120 заявок · ссылка 2» */
  what: string;
  categoryId: number | null;
  projectId: number | null;
  /** ₽-микро */
  amount: number;
  /** ₽-микро: операции этой позиции */
  paid: number;
  /** ₽-микро: покрыто авансом человека (считается, не хранится) */
  advance: number;
  /** amount − paid − advance, не меньше 0; у оплаченной прежним правилом и прощённой — 0 */
  remaining: number;
  /** closed — остаток прощён */
  state: DebtState;
}

export interface PaymentView {
  id: number;
  kind: 'pay' | 'offset';
  dir: DebtDir | 'both';
  at: number;
  walletId: number | null;
  /** микро в валюте кошелька; у взаимозачёта — ₽-микро */
  amount: number;
  rate: number;
  note: string;
  /** ₽-микро: сколько пришло или ушло; у взаимозачёта — закрыто с каждой стороны */
  rub: number;
  parts: { ref: string; what: string; rub: number }[];
  /** ₽-микро ушло в аванс */
  advance: number;
}

export interface PersonDebts {
  /** null — позиции без контакта */
  personId: number | null;
  name: string;
  username: string | null;
  /** Σ remaining позиций «он нам» */
  owedToUs: number;
  /** Σ remaining позиций «мы ему» */
  weOwe: number;
  /** остаток аванса, ещё ничего не покрывший */
  advanceIn: number;
  advanceOut: number;
  /** обе стороны, по дате */
  items: DebtItem[];
  /** новые сверху */
  payments: PaymentView[];
}

export const DEBT_REF = /^(sale|buy|fix):\d+$/;
const REFS_MAX = 500;
const NO_CONTACT = 'без контакта';

/** Места — как на странице и в боте. */
const SLOT_NAMES: Record<string, string> = { morning: 'утро', day: 'день', evening: 'вечер', night: 'ночь', n9: '9:00', n17: '17:00' };

const sourceOf = (ref: string): 'ads' | 'welcome' => (ref.startsWith('fix:') ? 'welcome' : 'ads');
const byDate = (a: { date: string; ref: string }, b: { date: string; ref: string }) =>
  a.date.localeCompare(b.date) || a.ref.localeCompare(b.ref, 'en', { numeric: true });

function requests(n: number): string {
  const d = n % 10, h = n % 100;
  return `${n} ${d === 1 && h !== 11 ? 'заявка' : d >= 2 && d <= 4 && (h < 12 || h > 14) ? 'заявки' : 'заявок'}`;
}

export interface PaidInfo {
  /** ₽-микро всех операций позиции */
  paid: number;
  /** есть прежняя операция с точным номером — позиция закрыта целиком, какая бы ни была сумма */
  exact: boolean;
  exactOpId: number | null;
  lastOpId: number;
}

/**
 * Оплачено по номерам позиций. Прежняя операция (source_ref = 'sale:5') — это
 * «Оплачено» до частичных оплат: тогда при взаимозачёте с тем же человеком
 * приходила разница, и сумма операции бывала меньше сделки, а сделка всё равно
 * закрыта. Поэтому она закрывает позицию целиком; новые части — только на свою сумму.
 */
export function paidByRef(db: Db): Map<string, PaidInfo> {
  const rows = db
    .prepare("SELECT id, source, source_ref AS ref, gross_rub AS rub FROM operations WHERE source IN ('ads', 'welcome') AND source_ref IS NOT NULL ORDER BY id")
    .all() as { id: number; source: string; ref: string; rub: number }[];
  const map = new Map<string, PaidInfo>();
  for (const r of rows) {
    const at = r.ref.indexOf('@');
    const ref = at < 0 ? r.ref : r.ref.slice(0, at);
    if (!DEBT_REF.test(ref) || sourceOf(ref) !== r.source) continue;
    const p = map.get(ref) ?? { paid: 0, exact: false, exactOpId: null, lastOpId: r.id };
    p.paid += r.rub;
    p.lastOpId = r.id;
    if (at < 0) {
      p.exact = true;
      p.exactOpId = r.id;
    }
    map.set(ref, p);
  }
  return map;
}

/** Позиция и признак «сделка ещё не разобрана» — такие платятся только галочкой. */
type Raw = DebtItem & { unsorted: boolean };

/**
 * Позиции до аванса. Реклама — сделки не отменённые, с суммой, не бартер, с
 * «Ждём оплату» или уже с оплатой; неразобранные — только если unsorted (их
 * можно оплатить, выбрав галочкой, как раньше «Оплачено» на любой сделке).
 * Приветка — фиксации с суммой.
 */
function rawItems(db: Db, unsorted: boolean): Raw[] {
  const paid = paidByRef(db);
  const closed = new Set((db.prepare('SELECT ref FROM debt_closures').all() as { ref: string }[]).map((r) => r.ref));
  const cat = { ads_posts: categoryIdByCode(db, 'ads_posts'), ads_stories: categoryIdByCode(db, 'ads_stories'), ads_buy: categoryIdByCode(db, 'ads_buy'), welcome: categoryIdByCode(db, 'welcome') };
  const project = projectIdByCode(db, 'ads');
  const items: Raw[] = [];
  const push = (base: Omit<Raw, 'paid' | 'advance' | 'remaining' | 'state' | 'projectId'>) => {
    const p = paid.get(base.ref);
    const sum = p?.paid ?? 0;
    const state: DebtState = p?.exact || sum >= base.amount ? 'paid' : closed.has(base.ref) ? 'closed' : sum > 0 ? 'partial' : 'open';
    // поля — в порядке DebtItem: так их видит страница в ответе API
    items.push({
      ref: base.ref, personId: base.personId, dir: base.dir, source: base.source, date: base.date, what: base.what,
      categoryId: base.categoryId, projectId: project, amount: base.amount, paid: sum, advance: 0,
      remaining: state === 'paid' || state === 'closed' ? 0 : base.amount - sum, state, unsorted: base.unsorted,
    });
  };

  const deals = db.prepare('SELECT * FROM ad_deals WHERE cancelled = 0 AND amount > 0 AND barter_at IS NULL').all() as any[];
  for (const d of deals) {
    const sorted = d.waiting_at !== null || paid.has(d.ref);
    if (!sorted && !unsorted) continue;
    const place = d.slot === 'stories' ? 'сторисы' : `пост ${SLOT_NAMES[d.slot] ?? d.slot}`;
    push({
      ref: d.ref, personId: d.person_id ?? null, dir: d.kind === 'sale' ? 'in' : 'out', source: 'ads', date: d.date,
      what: [place, d.channels].filter(Boolean).join(' · '),
      categoryId: d.kind === 'buy' ? cat.ads_buy : d.slot === 'stories' ? cat.ads_stories : cat.ads_posts,
      amount: d.amount, unsorted: !sorted,
    });
  }

  const links = db.prepare('SELECT id, deal_id, label FROM welcome_links ORDER BY deal_id, id').all() as { id: number; deal_id: number; label: string }[];
  const fixes = db
    .prepare(`SELECT f.id, f.on_date, f.count, f.amount, f.link_id, d.id AS deal_id, d.person_id
              FROM welcome_fixes f JOIN welcome_deals d ON d.id = f.deal_id WHERE f.amount > 0`)
    .all() as any[];
  for (const f of fixes) {
    const own = links.filter((l) => l.deal_id === f.deal_id);
    const i = own.findIndex((l) => l.id === f.link_id);
    const link = own.length > 1 && i >= 0 ? ` · ссылка ${own[i]!.label || i + 1}` : '';
    push({
      ref: `fix:${f.id}`, personId: f.person_id ?? null, dir: 'in', source: 'welcome', date: f.on_date,
      what: `приветка · ${requests(f.count)}${link}`, categoryId: cat.welcome, amount: f.amount, unsorted: false,
    });
  }
  return items.sort(byDate);
}

const poolKey = (personId: number, dir: DebtDir) => `${personId}|${dir}`;

/**
 * Позиции с авансом. Пул аванса человека по направлению гасит его открытые
 * позиции по порядку даты — только в расчёте: поле advance у позиции и остаток
 * пула. Неразобранные сделки аванс не трогает: они ещё не долг.
 */
function compute(db: Db, unsorted = false): { items: Raw[]; advanceLeft: Map<string, number> } {
  const items = rawItems(db, unsorted);
  const pools = db
    .prepare(`SELECT p.person_id AS personId, p.dir, SUM(o.gross_rub) AS rub FROM operations o JOIN payments p ON p.id = o.payment_id
              WHERE o.source = 'advance' GROUP BY p.person_id, p.dir`)
    .all() as { personId: number; dir: DebtDir; rub: number }[];
  const left = new Map(pools.map((p) => [poolKey(p.personId, p.dir), p.rub]));
  for (const it of items) {
    if (it.unsorted || it.personId === null || it.remaining <= 0) continue;
    const key = poolKey(it.personId, it.dir);
    const pool = left.get(key) ?? 0;
    if (pool <= 0) continue;
    const take = Math.min(pool, it.remaining);
    left.set(key, pool - take);
    it.advance = take;
    it.remaining -= take;
    it.state = it.remaining === 0 ? 'paid' : 'partial';
  }
  return { items, advanceLeft: left };
}

const strip = ({ unsorted: _u, ...it }: Raw): DebtItem => it;

/** Все позиции долга, по дате. */
export function listDebtItems(db: Db): DebtItem[] {
  return compute(db).items.map(strip);
}

/** Оплаты и взаимозачёты — с разбивкой по позициям; новые сверху. */
export function listPayments(db: Db, personId?: number): PaymentView[] {
  return paymentRows(db, personId).map(({ personId: _p, ...v }) => v);
}

function paymentRows(db: Db, personId?: number): (PaymentView & { personId: number })[] {
  const rows = (personId === undefined
    ? db.prepare('SELECT * FROM payments ORDER BY at DESC, id DESC').all()
    : db.prepare('SELECT * FROM payments WHERE person_id = ? ORDER BY at DESC, id DESC').all(personId)) as any[];
  if (!rows.length) return [];
  const ops = db
    .prepare(`SELECT payment_id AS pid, source, source_ref AS ref, gross_rub AS rub, note FROM operations
              WHERE payment_id IN (${rows.map(() => '?').join(',')}) ORDER BY id`)
    .all(...rows.map((r) => r.id)) as { pid: number; source: string; ref: string | null; rub: number; note: string }[];
  const whatOf = new Map(rawItems(db, true).map((it) => [it.ref, it.what]));
  return rows.map((p) => {
    const own = ops.filter((o) => o.pid === p.id);
    const parts = own
      .filter((o) => o.source !== 'advance')
      .map((o) => {
        const ref = (o.ref ?? '').split('@')[0]!;
        return { ref, what: whatOf.get(ref) ?? o.note, rub: o.rub };
      });
    return {
      personId: p.person_id,
      id: p.id, kind: p.kind, dir: p.dir, at: p.at, walletId: p.wallet_id ?? null, amount: p.amount, rate: p.rate, note: p.note,
      rub: p.kind === 'offset' ? p.amount : toRub(p.amount, p.rate),
      parts,
      advance: own.filter((o) => o.source === 'advance').reduce((s, o) => s + o.rub, 0),
    };
  });
}

function group(
  person: { id: number | null; name: string; username: string | null },
  items: DebtItem[],
  payments: PaymentView[],
  advanceLeft: Map<string, number>
): PersonDebts {
  const sum = (dir: DebtDir) => items.filter((i) => i.dir === dir).reduce((s, i) => s + i.remaining, 0);
  return {
    personId: person.id, name: person.name, username: person.username,
    owedToUs: sum('in'), weOwe: sum('out'),
    advanceIn: person.id === null ? 0 : advanceLeft.get(poolKey(person.id, 'in')) ?? 0,
    advanceOut: person.id === null ? 0 : advanceLeft.get(poolKey(person.id, 'out')) ?? 0,
    items, payments,
  };
}

/**
 * Долги по людям: у кого есть позиции, аванс или оплаты. Сначала те, у кого
 * долг (больший выше), потом по имени. Позиции без контакта — своей группой
 * «без контакта» (personId null): платить по ним — указав человека.
 */
export function personDebts(db: Db): PersonDebts[] {
  const { items, advanceLeft } = compute(db);
  const payments = paymentRows(db);
  const groups: PersonDebts[] = [];
  for (const p of listPeople(db)) {
    const own = payments.filter((x) => x.personId === p.id).map(({ personId: _p, ...v }) => v);
    const g = group(p, items.filter((i) => i.personId === p.id).map(strip), own, advanceLeft);
    if (g.items.length || g.payments.length || g.advanceIn || g.advanceOut) groups.push(g);
  }
  const orphans = items.filter((i) => i.personId === null).map(strip);
  if (orphans.length) groups.push(group({ id: null, name: NO_CONTACT, username: null }, orphans, [], advanceLeft));
  const debt = (g: PersonDebts) => g.owedToUs + g.weOwe;
  return groups.sort((a, b) => Number(debt(b) > 0) - Number(debt(a) > 0) || debt(b) - debt(a) || a.name.localeCompare(b.name, 'ru'));
}

/** Один человек — даже без позиций и оплат (только что заведённый). */
export function personDebt(db: Db, personId: number): PersonDebts {
  const p = getPerson(db, personId);
  const { items, advanceLeft } = compute(db);
  return group(p, items.filter((i) => i.personId === p.id).map(strip), listPayments(db, p.id), advanceLeft);
}

/** Для плашек и меню: сколько должны в обе стороны, сколько позиций и людей с долгом. */
export function debtTotals(db: Db): { owedToUs: number; weOwe: number; owedToUsCount: number; weOweCount: number; people: number } {
  const open = compute(db).items.filter((i) => i.remaining > 0);
  const side = (dir: DebtDir) => open.filter((i) => i.dir === dir);
  return {
    owedToUs: side('in').reduce((s, i) => s + i.remaining, 0),
    weOwe: side('out').reduce((s, i) => s + i.remaining, 0),
    owedToUsCount: side('in').length,
    weOweCount: side('out').length,
    people: new Set(open.filter((i) => i.personId !== null).map((i) => i.personId)).size,
  };
}

function parseDir(v: unknown): DebtDir {
  if (v !== 'in' && v !== 'out') throw new MoneyInputError('кто платит — он вам (in) или вы ему (out)');
  return v;
}

function parseRefs(v: unknown): string[] {
  if (!Array.isArray(v) || !v.length) throw new MoneyInputError('не выбрано ни одной позиции');
  if (v.length > REFS_MAX) throw new MoneyInputError(`за раз — не больше ${REFS_MAX} позиций`);
  for (const r of v) if (typeof r !== 'string' || !DEBT_REF.test(r)) throw new MoneyInputError(`«${String(r).slice(0, 40)}» — не позиция`);
  return [...new Set(v as string[])];
}

const parseNote = (v: unknown) => String(v ?? '').trim().slice(0, 500);

/** Деньги по позициям по порядку: каждой — сколько осталось, последней — сколько хватило. */
function distribute(items: readonly Raw[], total: number): { parts: { item: Raw; rub: number }[]; left: number } {
  const parts: { item: Raw; rub: number }[] = [];
  let left = total;
  for (const item of items) {
    if (left <= 0) break;
    const rub = Math.min(left, item.remaining);
    if (rub <= 0) continue;
    parts.push({ item, rub });
    left -= rub;
  }
  return { parts, left };
}

const opNote = (who: string, what: string, note: string) => [who, what, note].filter(Boolean).join(' · ');

export interface PayInput {
  dir: unknown;
  walletId: number;
  /** микро в валюте кошелька */
  amount: number;
  rate: number;
  at: number;
  /** выбранные галочками позиции; нет — все его позиции этого направления, самые старые первыми */
  refs?: unknown;
  note?: unknown;
}

export interface PayResult {
  paymentId: number;
  /** позиций, получивших деньги (вместе с частичной) */
  paid: number;
  /** позиция, оплаченная частично; null — все закрыты целиком */
  partial: string | null;
  /** ₽-микро ушло в аванс */
  advance: number;
}

/**
 * «Оплачено» у человека: сколько пришло (in) или ушло (out) на кошельке, в его
 * валюте. Рубли идут по позициям по порядку даты; не хватило — последняя
 * оплачена частично, остаток висит долгом; осталось — аванс. На каждую позицию
 * — своя операция (доход её вида или «Закуп рекламы»), сумма в валюте кошелька
 * — доля рублей по курсу, копейки округления — последней. Комиссии нет: за
 * рекламу и приветку платят переводом (владелец, 2026-10-19). Всё — одной
 * транзакцией: оплата, записанная наполовину, — деньги, которых нет в учёте.
 */
export function payPerson(db: Db, personId: number, input: PayInput, now = Date.now()): PayResult {
  const person = getPerson(db, personId);
  const dir = parseDir(input.dir);
  const wallet = getWallet(db, input.walletId);
  if (!Number.isSafeInteger(input.amount) || input.amount <= 0) throw new MoneyInputError('сумма больше нуля');
  if (!(input.rate > 0)) throw new MoneyInputError('нет курса');
  const total = toRub(input.amount, input.rate);
  if (total <= 0) throw new MoneyInputError('сумма меньше копейки');
  const refs = input.refs === undefined || input.refs === null ? null : parseRefs(input.refs);
  const note = parseNote(input.note);
  const who = personLabel(person);

  return db.transaction(() => {
    const { items } = compute(db, refs !== null);
    let targets: Raw[];
    if (refs) {
      targets = refs.map((ref) => {
        const it = items.find((i) => i.ref === ref);
        if (!it || it.personId !== personId) throw new MoneyInputError(`«${ref}» — не долг этого человека`);
        if (it.dir !== dir) throw new MoneyInputError('продажи и закупы — отдельно: деньги идут в разные стороны');
        if (it.remaining <= 0) throw new MoneyInputError(`«${it.what}» уже оплачено`);
        return it;
      });
      targets.sort(byDate);
    } else {
      targets = items.filter((i) => !i.unsorted && i.personId === personId && i.dir === dir && i.remaining > 0);
    }
    const { parts, left } = distribute(targets, total);

    const paymentId = Number(
      db.prepare("INSERT INTO payments (person_id, kind, dir, at, wallet_id, amount, rate, note, created_at) VALUES (?, 'pay', ?, ?, ?, ?, ?, ?, ?)")
        .run(personId, dir, input.at, wallet.id, input.amount, input.rate, note, now).lastInsertRowid
    );
    const project = projectIdByCode(db, 'ads');
    const lastCat = parts.at(-1)?.item.categoryId ?? categoryIdByCode(db, dir === 'in' ? 'welcome' : 'ads_buy');
    const ops = [
      ...parts.map((p) => ({ rub: p.rub, categoryId: p.item.categoryId, source: p.item.source as string, sourceRef: `${p.item.ref}@p${paymentId}`, note: opNote(who, p.item.what, note) })),
      ...(left > 0 ? [{ rub: left, categoryId: lastCat, source: 'advance', sourceRef: `p${paymentId}`, note: opNote(who, 'аванс', note) }] : []),
    ];
    let amountLeft = input.amount;
    ops.forEach((op, i) => {
      const amount = i === ops.length - 1 ? amountLeft : Math.round(op.rub / input.rate);
      if (amount < 0) throw new MoneyInputError('сумма слишком мала, чтобы разделить её между позициями');
      amountLeft -= amount;
      const base = {
        at: input.at, walletId: wallet.id, amount, rate: input.rate, grossRub: op.rub, projectId: project, categoryId: op.categoryId,
        note: op.note, source: op.source, sourceRef: op.sourceRef, paymentId,
      };
      if (dir === 'in') addIncome(db, { ...base, feePct: 0 }, now);
      else addExpense(db, base, now);
    });

    // Частично оплаченная сделка, которую ещё не разобрали, — теперь долг: остаток ждут.
    const wait = db.prepare('UPDATE ad_deals SET waiting_at = ? WHERE ref = ? AND waiting_at IS NULL');
    for (const p of parts) if (p.item.source === 'ads' && p.rub < p.item.remaining) wait.run(now, p.item.ref);

    const partial = parts.find((p) => p.rub < p.item.remaining)?.item.ref ?? null;
    return { paymentId, paid: parts.length, partial, advance: left };
  })();
}

/**
 * Взаимозачёт: он должен владельцу (продажа, приветка), владелец ему (закуп) —
 * обе стороны закрываются на одну сумму без движения денег. По умолчанию — на
 * меньший из двух долгов, больше него нельзя. По позициям каждой стороны — как
 * оплата, самые старые первыми. Операции без проводок (ledger.addOffsetOp):
 * кошельки не меняются, а выручка и закуп в итогах — как были на самом деле.
 */
export function offsetPerson(
  db: Db,
  personId: number,
  input: { amount?: number | null; at: number; note?: unknown },
  now = Date.now()
): { paymentId: number; amount: number; parts: number } {
  const person = getPerson(db, personId);
  const note = parseNote(input.note);
  const who = personLabel(person);
  return db.transaction(() => {
    const own = compute(db).items.filter((i) => i.personId === personId && i.remaining > 0);
    const ins = own.filter((i) => i.dir === 'in');
    const outs = own.filter((i) => i.dir === 'out');
    const owedToUs = ins.reduce((s, i) => s + i.remaining, 0);
    const weOwe = outs.reduce((s, i) => s + i.remaining, 0);
    if (!owedToUs || !weOwe) throw new MoneyInputError('взаимозачёт — когда долги в обе стороны: он должен вам, и вы ему');
    const max = Math.min(owedToUs, weOwe);
    const amount = input.amount ?? max;
    if (!Number.isSafeInteger(amount) || amount <= 0) throw new MoneyInputError('сумма больше нуля');
    if (amount > max) throw new MoneyInputError(`взаимозачёт — не больше ${fmtRub(max)}: столько ${owedToUs <= weOwe ? 'он должен вам' : 'вы должны ему'}`);

    const paymentId = Number(
      db.prepare("INSERT INTO payments (person_id, kind, dir, at, wallet_id, amount, rate, note, created_at) VALUES (?, 'offset', 'both', ?, NULL, ?, 1, ?, ?)")
        .run(personId, input.at, amount, note, now).lastInsertRowid
    );
    const project = projectIdByCode(db, 'ads');
    let count = 0;
    for (const [side, kind] of [[ins, 'income'], [outs, 'expense']] as const) {
      for (const p of distribute(side, amount).parts) {
        addOffsetOp(db, kind, {
          at: input.at, grossRub: p.rub, categoryId: p.item.categoryId, projectId: project, note: opNote(who, p.item.what, note || 'взаимозачёт'),
          source: p.item.source, sourceRef: `${p.item.ref}@p${paymentId}`, paymentId,
        }, now);
        count++;
      }
    }
    return { paymentId, amount, parts: count };
  })();
}

/**
 * «Простить остаток»: позиция закрыта, хотя оплачена не вся — скидка или
 * недоплата, которую уже не ждут. on = false — снова ждём остаток.
 */
export function closeDebt(db: Db, ref: string, on: boolean, now = Date.now(), note: unknown = ''): void {
  if (typeof ref !== 'string' || !DEBT_REF.test(ref)) throw new MoneyInputError(`«${String(ref).slice(0, 40)}» — не позиция`);
  if (!on) {
    db.prepare('DELETE FROM debt_closures WHERE ref = ?').run(ref);
    return;
  }
  const it = compute(db).items.find((i) => i.ref === ref);
  if (!it) throw new MoneyInputError('такой позиции нет');
  if (it.state === 'paid') throw new MoneyInputError('позиция уже оплачена');
  db.prepare('INSERT INTO debt_closures (ref, at, note) VALUES (?, ?, ?) ON CONFLICT(ref) DO UPDATE SET at = excluded.at, note = excluded.note')
    .run(ref, now, parseNote(note));
}
