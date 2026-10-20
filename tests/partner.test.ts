/**
 * Партнёрка: учёт по балансу в миниапке — прирост с насчитанного становится
 * доходом, выводы и доходы, внесённые руками, не задваиваются; бот сверяет
 * командой /partner.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db/index.js';
import { MICRO } from '../src/money.js';
import { addIncome, addTransfer, balances, createWallet, listCategories, listOperations, monthRange } from '../src/ledger.js';
import { partnerCheck, partnerCounted, partnerWallet } from '../src/partner.js';

const T = Date.UTC(2026, 9, 20, 9);
const usd = (n: number) => Math.round(n * MICRO);

test('партнёрка: сверка по балансу, вывод, доход руками', () => {
  const db = openDb(':memory:');
  const w = partnerWallet(db)!;
  assert.deepEqual([w.name, w.currency, w.kind], ['Партнёрка', 'USD', 'provider']);

  // первая сверка: на счёте 120 $ — весь баланс доход
  assert.equal(partnerCheck(db, { balance: usd(120), at: T, rate: 95 }, T).income, usd(120));
  const op = listOperations(db, ...(Object.values(monthRange('2026-10')) as [number, number]))[0]!;
  assert.equal(listCategories(db).find((c) => c.id === op.categoryId)?.name, 'Партнёрская программа');
  assert.equal(op.grossRub, usd(120) * 95, '120 $ по 95 ₽');
  assert.equal(op.feeRub, 0);

  // вывели 100 $ на свой кошелёк, пришло 99 USDT — 1 $ комиссии сети
  const tk = createWallet(db, { name: 'Tonkeeper', currency: 'USDT', kind: 'crypto' }, T);
  addTransfer(db, { at: T + 1, fromWalletId: w.id, amount: usd(100), fromRate: 95, toWalletId: tk, toAmount: usd(99), toRate: 95 }, T);
  assert.equal(partnerCounted(db, T + 2), usd(20));

  // на счёте 45 $: после вывода осталось 20, значит новых 25
  assert.equal(partnerCheck(db, { balance: usd(45), at: T + 3, rate: 95 }, T).income, usd(25));
  // тот же баланс ещё раз — нового нет
  assert.deepEqual(partnerCheck(db, { balance: usd(45), at: T + 4, rate: 95 }, T), { income: 0, opId: null, currency: 'USD' });

  // доход, внесённый руками на «Партнёрку», следующая сверка не задваивает
  addIncome(db, { at: T + 5, walletId: w.id, amount: usd(10), rate: 95, feePct: 0 }, T);
  assert.equal(partnerCheck(db, { balance: usd(60), at: T + 6, rate: 95 }, T).income, usd(5));

  // на счёте меньше насчитанного — не внесён вывод
  assert.throws(() => partnerCheck(db, { balance: usd(30), at: T + 7, rate: 95 }, T), /меньше насчитанного .* на 30 USD — внесите вывод/);
  assert.equal(balances(db).get(w.id), usd(60));
});
