/**
 * Доход и расходы по дням и по месяцам: день — по Москве, разбивка по виду и
 * проекту, до комиссии и комиссия отдельно.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db/index.js';
import { MICRO } from '../src/money.js';
import { addExpense, addIncome, incomeSeries, listCategories, listProjects, listWallets, monthRange } from '../src/ledger.js';

const rub = (n: number) => Math.round(n * MICRO);

test('доход по дням и месяцам', () => {
  const db = openDb(':memory:');
  const w = listWallets(db).find((x) => x.name === 'Platega')!.id;
  const cat = (n: string) => listCategories(db).find((c) => c.name === n)!.id;
  const prj = (n: string) => listProjects(db).find((p) => p.name === n)!.id;
  // 20.10 23:30 МСК = 20:30 UTC — ещё 20-е; 21.10 00:30 МСК = 20.10 21:30 UTC — уже 21-е
  addIncome(db, { at: Date.UTC(2026, 9, 20, 20, 30), walletId: w, amount: rub(1000), rate: 1, categoryId: cat('Приватка'), projectId: prj('Приватка MARIN') });
  addIncome(db, { at: Date.UTC(2026, 9, 20, 21, 30), walletId: w, amount: rub(500), rate: 1, categoryId: cat('Приватка'), projectId: prj('Приватка MARIN') });
  addIncome(db, { at: Date.UTC(2026, 9, 20, 10), walletId: w, amount: rub(300), rate: 1, feePct: 8, categoryId: cat('VPN'), projectId: prj('VPN') });
  addIncome(db, { at: Date.UTC(2026, 9, 20, 11), walletId: w, amount: rub(200), rate: 1, categoryId: cat('VPN'), projectId: prj('VPN') });
  addExpense(db, { at: Date.UTC(2026, 9, 20, 12), walletId: w, amount: rub(50), rate: 1 });
  addIncome(db, { at: Date.UTC(2026, 8, 30, 22), walletId: w, amount: rub(70), rate: 1 }); // 01.10 01:00 МСК

  const { from, to } = monthRange('2026-10');
  assert.deepEqual(incomeSeries(db, from, to, 'day'), [
    { key: '2026-10-01', kind: 'income', categoryId: null, projectId: null, gross: rub(70), fee: rub(9.8) },
    { key: '2026-10-20', kind: 'expense', categoryId: null, projectId: null, gross: rub(50), fee: 0 },
    { key: '2026-10-20', kind: 'income', categoryId: cat('Приватка'), projectId: prj('Приватка MARIN'), gross: rub(1000), fee: rub(140) },
    { key: '2026-10-20', kind: 'income', categoryId: cat('VPN'), projectId: prj('VPN'), gross: rub(500), fee: rub(24 + 28) },
    { key: '2026-10-21', kind: 'income', categoryId: cat('Приватка'), projectId: prj('Приватка MARIN'), gross: rub(500), fee: rub(70) },
  ]);
  const year = incomeSeries(db, monthRange('2026-01').from, monthRange('2026-12').to, 'month');
  assert.deepEqual(year.map((r) => [r.key, r.kind, r.gross]), [['2026-10', 'expense', rub(50)], ['2026-10', 'income', rub(70)], ['2026-10', 'income', rub(1500)], ['2026-10', 'income', rub(500)]]);
});
