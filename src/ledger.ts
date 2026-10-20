/**
 * Учёт: кошельки, операции и проводки, балансы и отчёты.
 *
 * Все записи — только здесь. Операция и её проводки пишутся одной транзакцией:
 * перевод, у которого списание записалось, а зачисление нет, — это деньги,
 * которые исчезли из учёта.
 */
import type { Db } from './db/index.js';
import { MoneyInputError, pctOf, toRub } from './money.js';

export type WalletKind = 'provider' | 'crypto' | 'card' | 'cash';
export const WALLET_KINDS: readonly WalletKind[] = ['provider', 'crypto', 'card', 'cash'];
export type OpKind = 'income' | 'expense' | 'transfer' | 'payout' | 'adjust';

export interface Wallet {
  id: number;
  name: string;
  currency: string;
  kind: WalletKind;
  feePct: number;
  archived: boolean;
  /** для импорта: vpn:platega, vpn:cryptobot; null — обычный кошелёк */
  role: string | null;
}

export interface Project {
  id: number;
  name: string;
  partnerPct: number;
}

export interface Category {
  id: number;
  kind: 'income' | 'expense';
  name: string;
}

export function listWallets(db: Db): Wallet[] {
  return (db.prepare('SELECT * FROM wallets ORDER BY archived, id').all() as any[]).map((w) => ({
    id: w.id, name: w.name, currency: w.currency, kind: w.kind, feePct: w.fee_pct, archived: w.archived === 1, role: w.role ?? null,
  }));
}

export function getWallet(db: Db, id: number): Wallet {
  const w = listWallets(db).find((x) => x.id === id);
  if (!w) throw new MoneyInputError('такого кошелька нет');
  return w;
}

export function listProjects(db: Db): Project[] {
  return (db.prepare('SELECT * FROM projects WHERE archived = 0 ORDER BY id').all() as any[]).map((p) => ({ id: p.id, name: p.name, partnerPct: p.partner_pct }));
}

export function listCategories(db: Db): Category[] {
  return (db.prepare('SELECT * FROM categories WHERE archived = 0 ORDER BY kind, id').all() as any[]).map((c) => ({ id: c.id, kind: c.kind, name: c.name }));
}

const CURRENCY = /^[A-Z]{2,6}$/;

export function createWallet(db: Db, input: { name: string; currency: string; kind: WalletKind; feePct?: number }, now = Date.now()): number {
  const name = input.name.trim();
  const currency = input.currency.trim().toUpperCase();
  if (!name) throw new MoneyInputError('у кошелька нет названия');
  if (!CURRENCY.test(currency)) throw new MoneyInputError('валюта — код вроде RUB, USDT, TON');
  if (!WALLET_KINDS.includes(input.kind)) throw new MoneyInputError('неизвестный вид кошелька');
  const info = db
    .prepare('INSERT INTO wallets (name, currency, kind, fee_pct, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(name, currency, input.kind, input.feePct ?? 0, now);
  return Number(info.lastInsertRowid);
}

export function updateWallet(db: Db, id: number, patch: { name?: string; feePct?: number; archived?: boolean }): void {
  getWallet(db, id);
  if (patch.name !== undefined) {
    if (!patch.name.trim()) throw new MoneyInputError('у кошелька нет названия');
    db.prepare('UPDATE wallets SET name = ? WHERE id = ?').run(patch.name.trim(), id);
  }
  if (patch.feePct !== undefined) db.prepare('UPDATE wallets SET fee_pct = ? WHERE id = ?').run(patch.feePct, id);
  if (patch.archived !== undefined) db.prepare('UPDATE wallets SET archived = ? WHERE id = ?').run(patch.archived ? 1 : 0, id);
}

function checkRef(db: Db, table: 'projects' | 'categories', id: number | null | undefined, kind?: 'income' | 'expense'): number | null {
  if (id == null) return null;
  const row = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id) as any;
  if (!row) throw new MoneyInputError(table === 'projects' ? 'такого проекта нет' : 'такого вида нет');
  if (kind && row.kind !== kind) throw new MoneyInputError(kind === 'income' ? 'это вид расхода, а не дохода' : 'это вид дохода, а не расхода');
  return id;
}

interface OpBase {
  at: number;
  projectId?: number | null;
  note?: string;
  source?: string;
  sourceRef?: string | null;
}

function insertOp(db: Db, kind: OpKind, base: OpBase, categoryId: number | null, grossRub: number, feeRub: number, now: number): number {
  const info = db
    .prepare(
      `INSERT INTO operations (kind, at, project_id, category_id, note, gross_rub, fee_rub, source, source_ref, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(kind, base.at, base.projectId ?? null, categoryId, (base.note ?? '').trim(), grossRub, feeRub, base.source ?? 'manual', base.sourceRef ?? null, now);
  return Number(info.lastInsertRowid);
}

function insertEntry(db: Db, opId: number, walletId: number, amount: number, rub: number): void {
  db.prepare('INSERT INTO entries (op_id, wallet_id, amount, rub) VALUES (?, ?, ?, ?)').run(opId, walletId, amount, rub);
}

/**
 * Пересчитывает поправки «Остатка» по порядку: каждая — разница между вписанным
 * остатком и тем, что насчитано на тот момент (операции до него включительно и
 * предыдущие поправки). Зовётся после любой записи: оплата, импортированная
 * задним числом, иначе сдвинула бы вписанный остаток.
 */
export function recomputeAdjustments(db: Db): void {
  const adjusts = db
    .prepare(
      `SELECT o.id, o.at, o.target, o.rate, e.id AS entryId, e.wallet_id AS walletId
       FROM operations o JOIN entries e ON e.op_id = o.id
       WHERE o.kind = 'adjust' ORDER BY o.at, o.id`
    )
    .all() as { id: number; at: number; target: number; rate: number | null; entryId: number; walletId: number }[];
  const before = db.prepare(
    `SELECT COALESCE(SUM(e.amount), 0) AS s FROM entries e JOIN operations o ON o.id = e.op_id
     WHERE e.wallet_id = ? AND e.id != ?
       AND ((o.kind != 'adjust' AND o.at <= ?) OR (o.kind = 'adjust' AND (o.at < ? OR (o.at = ? AND o.id < ?))))`
  );
  const update = db.prepare('UPDATE entries SET amount = ?, rub = ? WHERE id = ?');
  for (const a of adjusts) {
    const counted = (before.get(a.walletId, a.entryId, a.at, a.at, a.at, a.id) as { s: number }).s;
    const diff = a.target - counted;
    update.run(diff, toRub(diff, a.rate ?? 1), a.entryId);
  }
}

/**
 * Доход: сумма, которую заплатил покупатель, и комиссия платёжки с неё. На
 * кошелёк ложится сумма за вычетом комиссии — ровно то, что платёжка покажет у
 * себя. Комиссия по умолчанию — ставка кошелька (Platega 14 %, CryptoBot 3 %).
 */
export function addIncome(
  db: Db,
  input: OpBase & {
    walletId: number;
    amount: number;
    feePct?: number;
    rate: number;
    categoryId?: number | null;
    /** точная сумма в ₽, если она известна (цена заказа), а в валюту кошелька пересчитано по курсу */
    grossRub?: number;
  },
  now = Date.now()
): number {
  const wallet = getWallet(db, input.walletId);
  const feePct = input.feePct ?? wallet.feePct;
  const fee = pctOf(input.amount, feePct);
  const net = input.amount - fee;
  const grossRub = input.grossRub ?? toRub(input.amount, input.rate);
  const feeRub = input.grossRub === undefined ? toRub(fee, input.rate) : pctOf(input.grossRub, feePct);
  return db.transaction(() => {
    const id = insertOp(db, 'income', input, checkRef(db, 'categories', input.categoryId, 'income'), grossRub, feeRub, now);
    checkRef(db, 'projects', input.projectId);
    insertEntry(db, id, wallet.id, net, grossRub - feeRub);
    recomputeAdjustments(db);
    return id;
  })();
}

/** Расход с кошелька. У проекта с партнёром его доля расхода сама уменьшит долг перед ним (partnerDebts). */
export function addExpense(
  db: Db,
  input: OpBase & { walletId: number; amount: number; rate: number; categoryId?: number | null },
  now = Date.now()
): number {
  const wallet = getWallet(db, input.walletId);
  const rub = toRub(input.amount, input.rate);
  return db.transaction(() => {
    const id = insertOp(db, 'expense', input, checkRef(db, 'categories', input.categoryId, 'expense'), rub, 0, now);
    checkRef(db, 'projects', input.projectId);
    insertEntry(db, id, wallet.id, -input.amount, -rub);
    recomputeAdjustments(db);
    return id;
  })();
}

/**
 * Перевод, вывод или обмен: сколько ушло с одного кошелька и сколько пришло на
 * другой. Комиссию вписывать не нужно — это разница между ушедшим и пришедшим
 * в рублях: так в неё попадают и 3 % вывода, и наценка Rapira, и курс, сколько
 * бы они ни менялись (владелец, 2026-10-19).
 */
export function addTransfer(
  db: Db,
  input: OpBase & { fromWalletId: number; amount: number; fromRate: number; toWalletId: number; toAmount: number; toRate: number },
  now = Date.now()
): number {
  if (input.fromWalletId === input.toWalletId) throw new MoneyInputError('перевод самому себе');
  const from = getWallet(db, input.fromWalletId);
  const to = getWallet(db, input.toWalletId);
  const outRub = toRub(input.amount, input.fromRate);
  const inRub = toRub(input.toAmount, input.toRate);
  return db.transaction(() => {
    const id = insertOp(db, 'transfer', input, null, outRub, outRub - inRub, now);
    insertEntry(db, id, from.id, -input.amount, -outRub);
    insertEntry(db, id, to.id, input.toAmount, inRub);
    recomputeAdjustments(db);
    return id;
  })();
}

/** Выплата партнёру его доли по проекту — уменьшает долг перед ним. */
export function addPayout(
  db: Db,
  input: OpBase & { walletId: number; amount: number; rate: number; projectId: number },
  now = Date.now()
): number {
  const wallet = getWallet(db, input.walletId);
  const project = listProjects(db).find((p) => p.id === input.projectId);
  if (!project) throw new MoneyInputError('такого проекта нет');
  if (!project.partnerPct) throw new MoneyInputError(`у проекта «${project.name}» нет партнёра`);
  const rub = toRub(input.amount, input.rate);
  return db.transaction(() => {
    const id = insertOp(db, 'payout', input, null, rub, 0, now);
    insertEntry(db, id, wallet.id, -input.amount, -rub);
    recomputeAdjustments(db);
    return id;
  })();
}

/**
 * «Остаток»: сколько на кошельке на самом деле на этот момент — по кабинету
 * платёжки или кошелька. Разница с насчитанным ложится поправкой, которая не
 * доход и не расход: начальные остатки и сверка не трогают отчёт.
 */
export function addAdjustment(
  db: Db,
  input: { at: number; walletId: number; balance: number; rate: number; note?: string },
  now = Date.now()
): number {
  const wallet = getWallet(db, input.walletId);
  if (input.balance < 0) throw new MoneyInputError('остаток не бывает отрицательным');
  return db.transaction(() => {
    const id = insertOp(db, 'adjust', { at: input.at, note: input.note }, null, 0, 0, now);
    db.prepare('UPDATE operations SET target = ?, rate = ? WHERE id = ?').run(input.balance, input.rate, id);
    insertEntry(db, id, wallet.id, 0, 0);
    recomputeAdjustments(db);
    return id;
  })();
}

export function deleteOperation(db: Db, id: number): boolean {
  return db.transaction(() => {
    const deleted = db.prepare('DELETE FROM operations WHERE id = ?').run(id).changes > 0;
    if (deleted) recomputeAdjustments(db);
    return deleted;
  })();
}

export interface OperationRow {
  id: number;
  kind: OpKind;
  at: number;
  projectId: number | null;
  categoryId: number | null;
  note: string;
  grossRub: number;
  feeRub: number;
  source: string;
  /** у «Остатка» — вписанный остаток, микро в валюте кошелька */
  target: number | null;
  entries: { walletId: number; amount: number; rub: number }[];
}

export function listOperations(db: Db, from: number, to: number): OperationRow[] {
  const ops = db.prepare('SELECT * FROM operations WHERE at >= ? AND at < ? ORDER BY at DESC, id DESC').all(from, to) as any[];
  if (!ops.length) return [];
  const entries = db
    .prepare(`SELECT * FROM entries WHERE op_id IN (${ops.map(() => '?').join(',')}) ORDER BY id`)
    .all(...ops.map((o) => o.id)) as any[];
  return ops.map((o) => ({
    id: o.id, kind: o.kind, at: o.at, projectId: o.project_id, categoryId: o.category_id, note: o.note,
    grossRub: o.gross_rub, feeRub: o.fee_rub, source: o.source, target: o.target ?? null,
    entries: entries.filter((e) => e.op_id === o.id).map((e) => ({ walletId: e.wallet_id, amount: e.amount, rub: e.rub })),
  }));
}

/** Остаток каждого кошелька в его валюте — сумма проводок. */
export function balances(db: Db): Map<number, number> {
  const rows = db.prepare('SELECT wallet_id AS id, SUM(amount) AS sum FROM entries GROUP BY wallet_id').all() as { id: number; sum: number }[];
  return new Map(rows.map((r) => [r.id, r.sum]));
}

/**
 * Сколько владелец должен партнёру по каждому проекту с партнёром: доля от
 * дохода за вычетом комиссий, минус доля расходов, минус уже выплаченное.
 * Отрицательное — партнёр должен владельцу.
 */
export function partnerDebts(db: Db): { projectId: number; name: string; pct: number; income: number; expense: number; paid: number; owed: number }[] {
  return listProjects(db)
    .filter((p) => p.partnerPct > 0)
    .map((p) => {
      const sum = (kind: OpKind, col: string) =>
        (db.prepare(`SELECT COALESCE(SUM(${col}), 0) AS s FROM operations WHERE project_id = ? AND kind = ?`).get(p.id, kind) as { s: number }).s;
      const income = sum('income', 'gross_rub - fee_rub');
      const expense = sum('expense', 'gross_rub');
      const paid = sum('payout', 'gross_rub');
      const owed = pctOf(income, p.partnerPct) - pctOf(expense, p.partnerPct) - paid;
      return { projectId: p.id, name: p.name, pct: p.partnerPct, income, expense, paid, owed };
    });
}

export interface MonthReport {
  income: { categoryId: number | null; projectId: number | null; rub: number }[];
  expense: { categoryId: number | null; projectId: number | null; rub: number }[];
  incomeFees: number;
  transferFees: number;
  totalIncome: number;
  totalExpense: number;
  net: number;
}

/**
 * Итоги периода в рублях: доход по видам и проектам (до комиссий), комиссии
 * платёжек и потери при выводе отдельно, расходы. Чистыми — доход минус всё это.
 * Выплаты партнёру не расход: это его доля, а не трата.
 */
export function monthReport(db: Db, from: number, to: number): MonthReport {
  const group = (kind: OpKind) =>
    (db
      .prepare(
        `SELECT category_id AS categoryId, project_id AS projectId, SUM(gross_rub) AS rub
         FROM operations WHERE kind = ? AND at >= ? AND at < ? GROUP BY category_id, project_id ORDER BY rub DESC`
      )
      .all(kind, from, to) as { categoryId: number | null; projectId: number | null; rub: number }[]);
  const feeSum = (kind: OpKind) =>
    (db.prepare('SELECT COALESCE(SUM(fee_rub), 0) AS s FROM operations WHERE kind = ? AND at >= ? AND at < ?').get(kind, from, to) as { s: number }).s;
  const income = group('income');
  const expense = group('expense');
  const incomeFees = feeSum('income');
  const transferFees = feeSum('transfer');
  const totalIncome = income.reduce((s, r) => s + r.rub, 0);
  const totalExpense = expense.reduce((s, r) => s + r.rub, 0);
  return { income, expense, incomeFees, transferFees, totalIncome, totalExpense, net: totalIncome - incomeFees - transferFees - totalExpense };
}

/** Начало месяца по Москве (UTC+3, без перехода на летнее время) и начало следующего, в UTC мс. */
export function monthRange(month: string): { from: number; to: number } {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m) throw new MoneyInputError('месяц — в виде 2026-10');
  const y = Number(m[1]), mo = Number(m[2]);
  if (mo < 1 || mo > 12) throw new MoneyInputError('месяц — в виде 2026-10');
  const MSK = 3 * 3600_000;
  return { from: Date.UTC(y, mo - 1, 1) - MSK, to: Date.UTC(y, mo, 1) - MSK };
}

export type MonthTotals = Pick<MonthReport, 'totalIncome' | 'incomeFees' | 'transferFees' | 'totalExpense' | 'net'> & { month: string };

export interface YearReport {
  year: number;
  /** январь…декабрь по Москве; месяцы без операций, в том числе будущие, — нули */
  months: MonthTotals[];
  /** весь год — по видам и проектам, как итоги месяца */
  total: MonthReport;
}

/**
 * Итоги года: каждый месяц — тем же monthReport, что и «Итоги месяца», а не
 * разбивкой годовых операций, чтобы строка месяца в году совпадала с его
 * собственной страницей до копейки. Всегда двенадцать месяцев: у текущего года
 * будущие просто пустые.
 */
export function yearReport(db: Db, year: number): YearReport {
  if (!Number.isInteger(year) || year < 2000 || year > 2100) throw new MoneyInputError('год — от 2000 до 2100');
  const months = Array.from({ length: 12 }, (_, i): MonthTotals => {
    const month = `${year}-${String(i + 1).padStart(2, '0')}`;
    const { from, to } = monthRange(month);
    const { totalIncome, incomeFees, transferFees, totalExpense, net } = monthReport(db, from, to);
    return { month, totalIncome, incomeFees, transferFees, totalExpense, net };
  });
  const total = monthReport(db, monthRange(`${year}-01`).from, monthRange(`${year}-12`).to);
  return { year, months, total };
}

export interface IncomeBucket {
  /** ГГГГ-ММ-ДД (по дням) или ГГГГ-ММ (по месяцам), по Москве */
  key: string;
  categoryId: number | null;
  projectId: number | null;
  /** ₽-микро до комиссии */
  gross: number;
  /** ₽-микро комиссии платёжки */
  fee: number;
}

/**
 * Доход периода по дням (или месяцам) × вид × проект — для графика и ленты
 * дней. Страница сама складывает по виду или по проекту, до комиссий или
 * чистыми, и считает долю владельца в проекте с партнёром.
 */
export function incomeSeries(db: Db, from: number, to: number, by: 'day' | 'month'): IncomeBucket[] {
  // день по Москве: UTC+3 без перехода на летнее время
  const fmt = by === 'day' ? '%Y-%m-%d' : '%Y-%m';
  return db
    .prepare(
      `SELECT strftime('${fmt}', (at + 10800000) / 1000, 'unixepoch') AS key, category_id AS categoryId, project_id AS projectId,
              SUM(gross_rub) AS gross, SUM(fee_rub) AS fee
       FROM operations WHERE kind = 'income' AND at >= ? AND at < ?
       GROUP BY key, category_id, project_id ORDER BY key`
    )
    .all(from, to) as IncomeBucket[];
}
