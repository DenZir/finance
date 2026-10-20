/**
 * «Приветка»: покупатель присылает заявки всего с начала — долг за новые с
 * прошлой фиксации по цене на момент фиксации; оплата — доход «Заявки с
 * приветки», неоплаченное — «Нам должны» и в напоминании бота.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db/index.js';
import { MICRO } from '../src/money.js';
import { balances, deleteOperation, listCategories, listOperations, listWallets, monthRange } from '../src/ledger.js';
import { createWelcome, deleteFix, deleteWelcome, fixWelcome, listWelcome, payFix, updateWelcome, welcomeDebts } from '../src/welcome.js';
import { debtsText } from '../src/bot/debts.js';

const T = Date.UTC(2026, 9, 20, 9);
const rub = (n: number) => Math.round(n * MICRO);

test('приветка: фиксации, долг, оплата', () => {
  const db = openDb(':memory:');
  assert.throws(() => createWelcome(db, { contact: '', price: 5, startedOn: '2026-10-01' }), /кто покупатель/);
  assert.throws(() => createWelcome(db, { contact: 'Иван', price: '0', startedOn: '2026-10-01' }), /цена за заявку/);
  const id = createWelcome(db, { contact: 'Иван (@ivan)', price: '5', startedOn: '2026-10-01' }, T);

  assert.deepEqual(fixWelcome(db, id, { total: 100, onDate: '2026-10-08' }, T), { fixId: 1, count: 100, amount: rub(500) });
  assert.throws(() => fixWelcome(db, id, { total: 90, onDate: '2026-10-15' }, T), /было 100/);
  assert.throws(() => fixWelcome(db, id, { total: 150, onDate: '2026-10-07' }, T), /не может быть раньше/);
  // цена с 5 до 4,5 — прошлая фиксация не пересчитывается
  updateWelcome(db, id, { price: '4,5' });
  assert.deepEqual(fixWelcome(db, id, { total: 340, onDate: '2026-10-15' }, T), { fixId: 2, count: 240, amount: rub(1080) });

  const d = listWelcome(db)[0]!;
  assert.deepEqual([d.total, d.accrued, d.paidSum, d.owed], [340, rub(1580), 0, rub(1580)]);
  assert.deepEqual(welcomeDebts(db).map((x) => [x.amount, x.count]), [[rub(500), 100], [rub(1080), 240]]);

  // долг — в напоминании бота, рядом с рекламой
  assert.match(debtsText([], '2026-10-20', welcomeDebts(db))!, /Нам должны 1.580.₽[\s\S]*Иван \(@ivan\) — 500.₽ · приветка, 100 заявок на 08\.10 · 12 дн\./);

  // оплата первой фиксации в USDT
  const cb = listWallets(db).find((w) => w.name === 'CryptoBot')!.id;
  payFix(db, 1, { walletId: cb, amount: 5 * MICRO, rate: 100, at: Date.UTC(2026, 9, 10) }, T);
  assert.throws(() => payFix(db, 1, { walletId: cb, amount: MICRO, rate: 100, at: T }, T), /уже оплачена/);
  assert.equal(balances(db).get(cb), 5 * MICRO, 'без комиссии');
  const op = listOperations(db, ...(Object.values(monthRange('2026-10')) as [number, number]))[0]!;
  assert.equal(listCategories(db).find((c) => c.id === op.categoryId)?.name, 'Заявки с приветки');
  assert.equal(op.note, 'Приветка · Иван (@ivan) · 100 заявок');
  assert.equal(listWelcome(db)[0]!.owed, rub(1080));

  // удалить можно только последнюю неоплаченную; оплаченную — после удаления операции
  assert.throws(() => deleteFix(db, 1), /только последнюю/);
  deleteFix(db, 2);
  assert.throws(() => deleteFix(db, 1), /оплачена/);
  assert.throws(() => deleteWelcome(db, id), /есть оплаты/);
  deleteOperation(db, op.id);
  assert.equal(listWelcome(db)[0]!.owed, rub(500), 'удалили операцию — фиксация снова ждёт оплату');

  // ноль новых заявок — фиксация есть, долга нет
  fixWelcome(db, id, { total: 100, onDate: '2026-10-20' }, T);
  assert.equal(welcomeDebts(db).length, 1);
  assert.throws(() => payFix(db, 3, { walletId: cb, amount: MICRO, rate: 100, at: T }, T), /платить не за что/);

  // остановить и возобновить
  updateWelcome(db, id, { stoppedOn: '2026-10-20' });
  assert.equal(listWelcome(db)[0]!.stoppedOn, '2026-10-20');
  updateWelcome(db, id, { stoppedOn: null });
  assert.equal(listWelcome(db)[0]!.stoppedOn, null);

  deleteWelcome(db, id);
  assert.deepEqual(listWelcome(db), []);
});
