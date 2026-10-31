/**
 * «Приветка»: покупатель присылает заявки всего с начала — долг за новые с
 * прошлой фиксации по цене на момент фиксации; оплата — доход «Заявки с
 * приветки», неоплаченное — «Нам должны» и в напоминании бота.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db/index.js';
import { MICRO, MoneyInputError } from '../src/money.js';
import { balances, deleteOperation, listCategories, listOperations, listWallets, monthRange } from '../src/ledger.js';
import {
  createWelcome, deleteFix, deleteWelcome, deleteWelcomeLink, fixWelcome, listWelcome, newWelcomeLink, payFix, updateWelcome, welcomeDebts,
} from '../src/welcome.js';
import { debtsText } from '../src/bot/debts.js';

const T = Date.UTC(2026, 9, 20, 9);
const rub = (n: number) => Math.round(n * MICRO);

test('приветка: фиксации, долг, оплата', () => {
  const db = openDb(':memory:');
  assert.throws(() => createWelcome(db, { contact: '', price: 5, startedOn: '2026-10-01' }), /кто покупатель/);
  assert.throws(() => createWelcome(db, { contact: 'Иван', price: '0', startedOn: '2026-10-01' }), /цена за заявку/);
  const id = createWelcome(db, { contact: 'Иван (@ivan)', price: '5', startedOn: '2026-10-01' }, T);

  assert.deepEqual(fixWelcome(db, id, { total: 100, onDate: '2026-10-08' }, T), { fixId: 1, linkId: 1, count: 100, amount: rub(500), total: 100 });
  assert.throws(() => fixWelcome(db, id, { total: 90, onDate: '2026-10-15' }, T), /было 100/);
  assert.throws(() => fixWelcome(db, id, { total: 150, onDate: '2026-10-07' }, T), /не может быть раньше/);
  // цена с 5 до 4,5 — прошлая фиксация не пересчитывается
  updateWelcome(db, id, { price: '4,5' });
  assert.deepEqual(fixWelcome(db, id, { total: 340, onDate: '2026-10-15' }, T), { fixId: 2, linkId: 1, count: 240, amount: rub(1080), total: 340 });

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
  assert.equal(op.note, 'Иван (@ivan) · приветка · 100 заявок');
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

/**
 * Смена ссылки (владелец, 2026-10-31): покупатель сменил ссылку — его счётчик
 * заявок начался с нуля. Число меньше прошлого «всего» — не ошибка покупателя,
 * а повод спросить «Это новая ссылка?»: ошибка несёт код new_link. Число можно
 * вписать и приростом «+120». Цена новой ссылки — своя, по умолчанию прежняя.
 */
test('приветка: смена ссылки, «+N», цена ссылки, «меньше прошлого» — код new_link', () => {
  const db = openDb(':memory:');
  const id = createWelcome(db, { contact: 'Иван (@ivan)', price: '5', startedOn: '2026-10-01' }, T);
  assert.deepEqual(fixWelcome(db, id, { value: '200', onDate: '2026-10-05' }, T), { fixId: 1, linkId: 1, count: 200, amount: rub(1000), total: 200 });
  assert.deepEqual(fixWelcome(db, id, { value: '+120', onDate: '2026-10-08' }, T), { fixId: 2, linkId: 1, count: 120, amount: rub(600), total: 320 }, '+120 — прибавилось');
  assert.throws(() => fixWelcome(db, id, { value: 'сто', onDate: '2026-10-08' }, T), /всего по ссылке \(340\) или сколько прибавилось/);

  // покупатель прислал 40 — счётчик начался заново
  const err = (() => {
    try {
      fixWelcome(db, id, { value: '40', onDate: '2026-10-10' }, T);
    } catch (e) {
      return e;
    }
  })();
  assert.ok(err instanceof MoneyInputError);
  assert.equal(err.code, 'new_link');
  assert.match(err.message, /было 320/);

  assert.throws(() => newWelcomeLink(db, id, { startedOn: '2026-10-07' }, T), /прошлая фиксация — 2026-10-08/);
  const link = newWelcomeLink(db, id, { startedOn: '2026-10-10', label: 'вторая' }, T);
  let d = listWelcome(db)[0]!;
  assert.deepEqual([d.current.id, d.current.price, d.current.label, d.total, d.price], [link, rub(5), 'вторая', 0, rub(5)], 'цена — прежняя, счётчик с нуля');
  assert.deepEqual(fixWelcome(db, id, { value: '40', onDate: '2026-10-10' }, T), { fixId: 3, linkId: link, count: 40, amount: rub(200), total: 40 });
  assert.equal(welcomeDebts(db).find((x) => x.ref === 'fix:3')!.contact, 'Иван (@ivan)');

  // цена — у текущей ссылки, для следующих фиксаций
  updateWelcome(db, id, { price: '6' }, T);
  assert.deepEqual(fixWelcome(db, id, { value: '+10', onDate: '2026-10-12' }, T), { fixId: 4, linkId: link, count: 10, amount: rub(60), total: 50 });
  // третья ссылка со своей ценой; пустая и не единственная — удаляется, цена — прежней
  const third = newWelcomeLink(db, id, { startedOn: '2026-10-13', price: '7' }, T);
  assert.equal(listWelcome(db)[0]!.price, rub(7));
  assert.throws(() => deleteWelcomeLink(db, link), /есть фиксации/);
  deleteWelcomeLink(db, third);
  d = listWelcome(db)[0]!;
  assert.deepEqual([d.links.length, d.current.id, d.price], [2, link, rub(6)]);
  assert.deepEqual(d.links.map((l) => [l.total, l.fixes]), [[320, 2], [50, 2]]);
  assert.deepEqual(d.fixes.map((f) => f.linkId), [1, 1, link, link]);
  assert.equal(d.accrued, rub(1000 + 600 + 200 + 60));

  // пустая фиксация «+0» — без долга, но записана
  assert.deepEqual(fixWelcome(db, id, { value: '+0', onDate: '2026-10-14' }, T), { fixId: 5, linkId: link, count: 0, amount: 0, total: 50 });
  assert.equal(listWelcome(db)[0]!.fixes.at(-1)!.state, 'paid');
  assert.equal(welcomeDebts(db).length, 4);

  // единственную ссылку не удалить
  const solo = createWelcome(db, { contact: 'Пётр', price: '5', startedOn: '2026-10-01' }, T);
  assert.throws(() => deleteWelcomeLink(db, listWelcome(db).find((x) => x.id === solo)!.current.id), /единственная/);
});
