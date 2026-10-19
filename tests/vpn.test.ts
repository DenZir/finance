/**
 * Оплаты VPN из tg-analytics: с платёжкой — сразу доход на кошелёк своего
 * кабинета с его комиссией, без платёжки — в «Разобрать»; ничего не задваивается
 * и не попадает в кабинеты привата.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db/index.js';
import { MICRO } from '../src/money.js';
import { balances, deleteOperation, listCategories, listOperations, listProjects, listWallets, monthRange, partnerDebts } from '../src/ledger.js';
import { listUnsorted, resolveVpn, syncVpn, type AnalyticsPayment } from '../src/vpn.js';

const T = Date.UTC(2026, 9, 19, 9);
const SINCE = Date.UTC(2026, 9, 1) - 3 * 3600_000;
const rub = (n: number) => Math.round(n * MICRO);
const pay = (id: number, amount: number, provider: string | null, at = '2026-10-10T10:00:00Z', type = 'payment'): AnalyticsPayment => ({ id, at, type, amount, provider });

test('оплаты VPN: платёжка из аналитики, разбор руками, без дублей', async () => {
  const db = openDb(':memory:');
  let all: AnalyticsPayment[] = [
    pay(1, 999, 'platega', '2026-09-20T10:00:00Z'), // до начала учёта
    pay(2, 300, 'platega'),
    pay(3, 200, 'CryptoBot', '2026-10-11T10:00:00Z', 'renewal'),
    pay(4, 150, null),
    pay(5, 100, 'yookassa'),
  ];
  const asked: number[] = [];
  const deps = {
    fetchPayments: async (after: number) => { asked.push(after); return { payments: all.filter((p) => p.id > after), more: false }; },
    fetchRate: async () => 100,
    since: SINCE,
  };

  const r1 = await syncVpn(db, deps, T);
  assert.deepEqual(r1, { imported: 4, booked: 2, unsorted: 2, waiting: [] }, 'до начала учёта не берётся; неизвестная платёжка — в разбор');
  const again = await syncVpn(db, deps, T);
  assert.deepEqual(again, { imported: 0, booked: 0, unsorted: 2, waiting: [] });
  assert.equal(asked[1], 5, 'второй раз — после последнего прочитанного номера');

  const w = (role: string) => listWallets(db).find((x) => x.role === role)!.id;
  const priv = (name: string) => listWallets(db).find((x) => x.name === name)!.id;
  assert.equal(balances(db).get(w('vpn:platega')), rub(276), '300 − 8 %');
  assert.equal(balances(db).get(w('vpn:cryptobot')), Math.round(2 * MICRO * 0.97), '200 ₽ = 2 USDT по 100, − 3 %');
  assert.equal(balances(db).get(priv('Platega')) ?? 0, 0, 'кабинеты привата не тронуты');
  assert.equal(balances(db).get(priv('CryptoBot')) ?? 0, 0);

  const { from, to } = monthRange('2026-10');
  const ops = listOperations(db, from, to);
  const vpnCat = listCategories(db).find((c) => c.name === 'VPN')!.id;
  const vpnProject = listProjects(db).find((p) => p.name === 'VPN')!.id;
  assert.ok(ops.every((o) => o.source === 'vpn' && o.categoryId === vpnCat && o.projectId === vpnProject));
  assert.deepEqual(ops.map((o) => [o.grossRub, o.feeRub, o.note]).sort(), [[rub(200), rub(6), 'продление'], [rub(300), rub(24), 'покупка']]);
  assert.equal(partnerDebts(db)[0]!.owed, rub((276 + 194) / 2), 'половина дохода без комиссий — партнёру');

  // разбор руками
  assert.deepEqual(listUnsorted(db).map((p) => p.ref), ['4', '5']);
  await assert.rejects(resolveVpn(db, ['4'], 'yookassa', deps.fetchRate, T), /Platega или CryptoBot/);
  await assert.rejects(resolveVpn(db, ['x'], 'platega', deps.fetchRate, T), /не оплата/);
  assert.deepEqual(await resolveVpn(db, ['4', '2', '99'], 'platega', deps.fetchRate, T), { done: 1, skipped: 2 }, 'записанная и неизвестная пропущены');
  assert.deepEqual(await resolveVpn(db, ['5'], 'skip', deps.fetchRate, T), { done: 1, skipped: 0 });
  assert.deepEqual(listUnsorted(db), []);
  assert.equal(balances(db).get(w('vpn:platega')), rub(276 + 138));

  // удалили операцию — следующая сверка запишет её заново: платёжка уже выбрана
  const op4 = listOperations(db, from, to).find((o) => o.grossRub === rub(150))!;
  deleteOperation(db, op4.id);
  assert.deepEqual(listUnsorted(db), [], 'не возвращается в разбор');
  assert.equal((await syncVpn(db, deps, T)).booked, 1);

  // новая оплата пришла позже со временем раньше прочитанной — номер всё равно больше
  all = [...all, pay(6, 50, 'platega', '2026-10-05T10:00:00Z')];
  assert.equal((await syncVpn(db, deps, T)).booked, 1);

  // нет курса — оплата ждёт, а не пропадает
  const db2 = openDb(':memory:');
  const r2 = await syncVpn(db2, { ...deps, fetchRate: async () => null }, T);
  assert.deepEqual(r2.waiting, ['нет курса USDT']);
  assert.equal((await syncVpn(db2, deps, T)).booked, 1, 'со следующей сверкой — записана');
});
