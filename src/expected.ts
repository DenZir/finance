/**
 * «Если всё оплачено» в блоке «Доход» на обзоре (владелец, 2026-10-30): долги,
 * которых ещё нет на кошельках, как будто их уже заплатили, — сколько вышло бы за
 * месяц, когда все рассчитаются.
 *
 * Долг здесь — ровно то, что в «Нам должны» и «Мы должны»: сделки рекламы с
 * отметкой «Ждём оплату» и неоплаченные фиксации приветки. Неразобранные сделки
 * не в счёт — они могли быть бартером. CPM без суммы — тоже: считать нечего.
 * День — день места или фиксации, вид и проект — те же, что получит операция при
 * «Оплачено» (payDeal, payFix), чтобы после оплаты сумма осталась на своём месте.
 * Комиссии нет: реклама и приветка оплачиваются переводом.
 *
 * С 2026-10-31 долг — позиции долга по людям (debts.ts), и в счёт идёт их
 * остаток, а не полная сумма: оплаченная часть уже лежит в доходе того же дня, и
 * полная сумма посчиталась бы дважды. Покрытое авансом и прощённое — тоже не
 * долг.
 */
import type { Db } from './db/index.js';
import { projectIdByCode, type IncomeBucket } from './ledger.js';
import { listDebtItems } from './debts.js';

export type ExpectedBucket = IncomeBucket & { expected: true };

/** ГГГГ-ММ-ДД по Москве. */
const mskDate = (ms: number) => new Date(ms + 3 * 3600_000).toISOString().slice(0, 10);

export function expectedSeries(db: Db, from: number, to: number, by: 'day' | 'month'): ExpectedBucket[] {
  const first = mskDate(from);
  const end = mskDate(to); // начало следующего периода — не входит
  const project = projectIdByCode(db, 'ads');
  const items = listDebtItems(db)
    .filter((i) => i.remaining > 0)
    .map((i) => ({ date: i.date, kind: i.dir === 'out' ? ('expense' as const) : ('income' as const), categoryId: i.categoryId, amount: i.remaining }));

  const buckets = new Map<string, ExpectedBucket>();
  for (const it of items) {
    if (it.date < first || it.date >= end) continue;
    const key = by === 'day' ? it.date : it.date.slice(0, 7);
    const id = `${key}|${it.kind}|${it.categoryId}`;
    const b = buckets.get(id) ?? { key, kind: it.kind, categoryId: it.categoryId, projectId: project, gross: 0, fee: 0, expected: true };
    b.gross += it.amount;
    buckets.set(id, b);
  }
  return [...buckets.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0));
}
