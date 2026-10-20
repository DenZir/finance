/**
 * Партнёрская программа: начисления копятся в долларах на счёте в её
 * миниапке, и новые покупки видно, только зайдя туда (владелец, 2026-10-20).
 * Поэтому учёт идёт не по покупкам, а по балансу: владелец вписывает, сколько
 * на счёте сейчас, а прирост с насчитанного — с учётом выводов и доходов,
 * внесённых руками, — становится доходом «Партнёрская программа».
 *
 * Вывод на крипту — обычный перевод с кошелька «Партнёрка»: комиссия сети —
 * разница между ушедшим и пришедшим, как у любого перевода.
 */
import type { Db } from './db/index.js';
import { MoneyInputError } from './money.js';
import { addIncome, categoryIdByCode, listWallets, type Wallet } from './ledger.js';

export const SOURCE = 'partner';
export const ROLE = 'partner';

export function partnerWallet(db: Db): Wallet | undefined {
  return listWallets(db).find((w) => !w.archived && w.role === ROLE);
}

/** Сколько на кошельке «Партнёрка» насчитано к моменту `at`. */
export function partnerCounted(db: Db, at: number): number {
  const w = partnerWallet(db);
  if (!w) return 0;
  return (
    db
      .prepare('SELECT COALESCE(SUM(e.amount), 0) AS s FROM entries e JOIN operations o ON o.id = e.op_id WHERE e.wallet_id = ? AND o.at <= ?')
      .get(w.id, at) as { s: number }
  ).s;
}

/**
 * «Сверить»: на счёте в миниапке `balance` (микро в валюте кошелька). Прирост
 * — доход; ноль — ничего нового. Меньше насчитанного — значит, не внесён вывод:
 * доходом со знаком минус это быть не может.
 */
export function partnerCheck(
  db: Db,
  input: { balance: number; at: number; rate: number },
  now = Date.now()
): { income: number; opId: number | null; currency: string } {
  const w = partnerWallet(db);
  if (!w) throw new MoneyInputError('нет кошелька «Партнёрка»');
  const counted = partnerCounted(db, input.at);
  const diff = input.balance - counted;
  const fmt = (micro: number) => (micro / 1_000_000).toLocaleString('ru-RU', { maximumFractionDigits: 2 });
  if (diff < 0) {
    throw new MoneyInputError(
      `на счёте меньше насчитанного (${fmt(counted)} ${w.currency}) на ${fmt(-diff)} ${w.currency} — внесите вывод: «Перевод» с «Партнёрки»`
    );
  }
  if (diff === 0) return { income: 0, opId: null, currency: w.currency };
  const opId = addIncome(db, {
    at: input.at,
    walletId: w.id,
    amount: diff,
    rate: input.rate,
    feePct: 0,
    categoryId: categoryIdByCode(db, 'partner'),
    note: `сверка: на счёте ${fmt(input.balance)} ${w.currency}`,
    source: SOURCE,
  }, now);
  return { income: diff, opId, currency: w.currency };
}
