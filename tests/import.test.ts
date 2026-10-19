/**
 * Импорт оплат привата из ботприватa: каждая оплата — доход с комиссией своей
 * платёжки, ровно один раз, сколько бы раз импорт ни прошёл.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db/index.js';
import { MICRO } from '../src/money.js';
import { balances, listOperations, listWallets, monthRange, monthReport } from '../src/ledger.js';
import { importBotprivat, type PaidOrder } from '../src/import/botprivat.js';

const T = Date.UTC(2026, 9, 19, 9);
const SINCE = Date.UTC(2026, 9, 1) - 3 * 3600_000;
const rub = (n: number) => Math.round(n * MICRO);

function source(orders: PaidOrder[]) {
  const asked: number[] = [];
  return { asked, fetchOrders: async (since: number) => { asked.push(since); return { orders: orders.filter((o) => (o.paidAt ?? 0) >= since), more: false }; } };
}

test('оплаты Platega и CryptoBot ложатся доходом «Приватка» с комиссией платёжки, повторный импорт не задваивает', async () => {
  const db = openDb(':memory:');
  const orders: PaidOrder[] = [
    { orderId: 'p1', provider: 'platega', amount: 299, paidAt: T, tariffName: '1 месяц' },
    { orderId: 'c1', provider: 'cryptobot', amount: 300, paidAt: T + 60_000, tariffName: '1 месяц' },
    { orderId: 'old', provider: 'platega', amount: 999, paidAt: SINCE - 1, tariffName: 'до начала учёта' },
  ];
  const src = source(orders);
  const deps = { fetchOrders: src.fetchOrders, fetchRate: async () => 100, since: SINCE };

  assert.deepEqual(await importBotprivat(db, deps, T), { imported: 2, waiting: [] });
  assert.deepEqual(await importBotprivat(db, deps, T), { imported: 0, waiting: [] });
  assert.equal(src.asked[1], T + 60_000 - 10 * 60_000, 'второй раз — с последней оплаты с запасом, а не с начала');

  const w = (name: string) => listWallets(db).find((x) => x.name === name)!.id;
  assert.equal(balances(db).get(w('Platega')), rub(257.14)); // 299 − 14 %
  assert.equal(balances(db).get(w('CryptoBot')), rub(2.91)); // 300 ₽ = 3 USDT по 100, − 3 %
  const r = monthReport(db, ...Object.values(monthRange('2026-10')) as [number, number]);
  assert.equal(r.totalIncome, rub(599), 'выручка — ровно цены заказов');
  assert.equal(r.incomeFees, rub(41.86 + 9));
  const ops = listOperations(db, SINCE, T + 3600_000);
  assert.ok(ops.every((o) => o.source === 'botprivat' && o.note === '1 месяц'));
});

test('нет курса или кошелька платёжки — оплата ждёт следующего прохода, а не пропадает', async () => {
  const db = openDb(':memory:');
  const orders: PaidOrder[] = [
    { orderId: 'c1', provider: 'cryptobot', amount: 300, paidAt: T, tariffName: '1 месяц' },
    { orderId: 'x1', provider: 'yookassa', amount: 100, paidAt: T, tariffName: '1 месяц' },
  ];
  const src = source(orders);
  const r1 = await importBotprivat(db, { fetchOrders: src.fetchOrders, fetchRate: async () => null, since: SINCE }, T);
  assert.equal(r1.imported, 0);
  assert.deepEqual(r1.waiting.sort(), ['нет кошелька платёжки «yookassa»', 'нет курса USDT']);
  const r2 = await importBotprivat(db, { fetchOrders: src.fetchOrders, fetchRate: async () => 100, since: SINCE }, T);
  assert.equal(r2.imported, 1);
});

/**
 * Оплата CryptoBot ждёт курса, а оплата Platega часом позже уже записана.
 * Следующий проход обязан вернуться к ждущей, а не начать после поздней.
 */
test('ждущая оплата не теряется, когда более поздние уже записаны', async () => {
  const db = openDb(':memory:');
  const orders: PaidOrder[] = [
    { orderId: 'c1', provider: 'cryptobot', amount: 300, paidAt: T, tariffName: '1 месяц' },
    { orderId: 'p1', provider: 'platega', amount: 299, paidAt: T + 3600_000, tariffName: '1 месяц' },
  ];
  const src = source(orders);
  let rate: number | null = null;
  const deps = { fetchOrders: src.fetchOrders, fetchRate: async () => rate, since: SINCE };
  assert.equal((await importBotprivat(db, deps, T)).imported, 1);
  rate = 100;
  assert.equal((await importBotprivat(db, deps, T)).imported, 1, 'c1 подобран вторым проходом');
  assert.equal(src.asked[1], T - 10 * 60_000);
  assert.equal((await importBotprivat(db, deps, T)).imported, 0);
  assert.equal(src.asked[2], T + 3600_000 - 10 * 60_000, 'когда ждать нечего — курсор дошёл до последней');
});
