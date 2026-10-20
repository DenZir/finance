/**
 * Оплаты VPN из tg-analytics: с платёжкой — сразу доход на кошелёк своего
 * кабинета с его комиссией, без платёжки — в «Разобрать»; ничего не задваивается
 * и не попадает в кабинеты привата.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { migrate, openDb } from '../src/db/index.js';
import { MIGRATIONS } from '../src/db/migrations.js';
import { MICRO } from '../src/money.js';
import { balances, deleteOperation, listCategories, listOperations, listProjects, listWallets, monthRange, partnerDebts } from '../src/ledger.js';
import { listSkipped, listUnsorted, resolveVpn, restoreVpn, syncVpn, type AnalyticsPayment } from '../src/vpn.js';

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
  await assert.rejects(resolveVpn(db, ['4'], 'yookassa', deps.fetchRate, T), /Platega, CryptoBot, Parity или Lolzteam/);
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

test('Parity (рубли) и Lolzteam (доллары): свои кабинеты VPN со своей комиссией, в том числе при разборе руками', async () => {
  const db = openDb(':memory:');
  const deps = {
    fetchPayments: async (after: number) => ({
      more: false,
      // card_ru — прежнее имя parity: такие оплаты ложатся на тот же кошелёк
      payments: [pay(1, 1000, 'parity'), pay(2, 1000, 'LOLZTEAM'), pay(3, 500, null), pay(4, 1000, 'card_ru')].filter((p) => p.id > after),
    }),
    fetchRate: async () => 100,
    since: SINCE,
  };
  assert.deepEqual(await syncVpn(db, deps, T), { imported: 4, booked: 3, unsorted: 1, waiting: [] });
  const w = (role: string) => listWallets(db).find((x) => x.role === role)!;
  assert.equal(w('vpn:parity').name, 'Parity VPN');
  assert.equal(w('vpn:parity').currency, 'RUB');
  assert.equal(w('vpn:lolzteam').currency, 'USD');
  assert.equal(balances(db).get(w('vpn:parity').id), rub(900 + 900), '1000 − 10 % дважды: parity и прежний card_ru');
  assert.equal(balances(db).get(w('vpn:lolzteam').id), rub(9.3), '1000 ₽ = 10 $ по 100, − 7 %; регистр платёжки не важен');
  assert.deepEqual(await resolveVpn(db, ['3'], 'lolzteam', deps.fetchRate, T), { done: 1, skipped: 0 });
  assert.equal(balances(db).get(w('vpn:lolzteam').id), rub(9.3 + 4.65));
  const op = listOperations(db, ...(Object.values(monthRange('2026-10')) as [number, number])).find((o) => o.entries[0]?.walletId === w('vpn:lolzteam').id && o.grossRub === rub(1000))!;
  assert.deepEqual([op.grossRub, op.feeRub], [rub(1000), rub(70)], 'в отчёте — рубли оплаты и 7 % комиссии');
});

test('Lolzteam с уже записанными рублёвыми оплатами валюту не меняет', () => {
  // как было бы, если до обновления оплаты успели лечь на рублёвый Lolzteam VPN
  // база до обновления: применены миграции по рублёвый Lolzteam включительно
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  const lolzUsd = MIGRATIONS.findIndex((m) => m.includes("SET currency = 'USD'"));
  for (const m of MIGRATIONS.slice(0, lolzUsd)) db.exec(m);
  db.pragma(`user_version = ${lolzUsd}`);
  const id = listWallets(db).find((x) => x.role === 'vpn:lolzteam')!.id;
  db.prepare("INSERT INTO operations (kind, at, created_at) VALUES ('income', 1, 1)").run();
  db.prepare('INSERT INTO entries (op_id, wallet_id, amount, rub) VALUES (last_insert_rowid(), ?, ?, ?)').run(id, rub(300), rub(300));
  migrate(db);
  assert.equal(listWallets(db).find((x) => x.role === 'vpn:lolzteam')!.currency, 'RUB');
});

test('card_ru → parity: кошелёк «Карта резерв VPN» и прочитанные, но не записанные оплаты переходят на новое имя', async () => {
  // база до обновления: кошелёк с ролью vpn:card_ru и оплата, прочитанная из
  // аналитики с card_ru, но ещё не записанная (не было курса и т. п.)
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  const rename = MIGRATIONS.findIndex((m) => m.includes("role = 'vpn:parity'"));
  for (const m of MIGRATIONS.slice(0, rename)) db.exec(m);
  db.pragma(`user_version = ${rename}`);
  const id = listWallets(db).find((x) => x.role === 'vpn:card_ru')!.id;
  db.prepare("INSERT INTO vpn_payments (ref, at, type, amount, provider, synced_at) VALUES ('7', ?, 'payment', ?, 'card_ru', 1)").run(Date.parse('2026-10-10T10:00:00Z'), rub(1000));
  migrate(db);
  const w = listWallets(db).find((x) => x.id === id)!;
  assert.deepEqual([w.role, w.name, w.feePct], ['vpn:parity', 'Parity VPN', 10]);
  assert.deepEqual(await syncVpn(db, { fetchPayments: async () => ({ more: false, payments: [] }), fetchRate: async () => 100, since: SINCE }, T), { imported: 0, booked: 1, unsorted: 0, waiting: [] });
  assert.equal(balances(db).get(id), rub(900), 'та же оплата — на тот же кошелёк, 1000 − 10 %');
});

// Крестик «Не учитывать» нажали по ошибке — раньше обратно никак (владелец, 2026-10-20).
test('«Не учитывать» возвращается: без платёжки — в «Разобрать», с платёжкой — сразу доход', async () => {
  const db = openDb(':memory:');
  const deps = {
    fetchPayments: async (after: number) => ({ payments: [pay(1, 150, null), pay(2, 300, null), pay(3, 400, null)].filter((p) => p.id > after), more: false }),
    fetchRate: async () => 100,
    since: SINCE,
  };
  await syncVpn(db, deps, T);
  assert.deepEqual(await resolveVpn(db, ['1', '2'], 'skip', deps.fetchRate, T), { done: 2, skipped: 0 });
  // платёжку оплаты 2 бот сказал позже, чем её отметили
  db.prepare("UPDATE vpn_payments SET provider = 'platega' WHERE ref = '2'").run();
  assert.deepEqual(listSkipped(db).map((p) => [p.ref, p.provider]), [['1', null], ['2', 'platega']]);
  assert.deepEqual(listUnsorted(db).map((p) => p.ref), ['3']);

  await assert.rejects(restoreVpn(db, [], deps.fetchRate, T), /не выбрано/);
  await assert.rejects(restoreVpn(db, ['x'], deps.fetchRate, T), /не оплата/);
  assert.deepEqual(await restoreVpn(db, ['1', '2', '3', '99'], deps.fetchRate, T), { done: 2, booked: 1, skipped: 2, waiting: [] }, 'не отмеченная и неизвестная пропущены');
  assert.deepEqual(listSkipped(db), []);
  assert.deepEqual(listUnsorted(db).map((p) => p.ref), ['1', '3'], 'без платёжки — снова в разборе');
  const platega = listWallets(db).find((x) => x.role === 'vpn:platega')!.id;
  assert.equal(balances(db).get(platega), rub(276), '300 − 8 %');
  assert.equal((await syncVpn(db, deps, T)).booked, 0, 'сверка не задваивает');
  assert.equal(balances(db).get(platega), rub(276));

  // кошелька нет — отметка снята, а записать доходом можно будет следующей сверкой
  await resolveVpn(db, ['3'], 'skip', deps.fetchRate, T);
  db.prepare("UPDATE vpn_payments SET provider = 'parity' WHERE ref = '3'").run();
  db.prepare("UPDATE wallets SET archived = 1 WHERE role = 'vpn:parity'").run();
  const r = await restoreVpn(db, ['3'], deps.fetchRate, T);
  assert.deepEqual([r.done, r.booked], [1, 0]);
  assert.match(r.waiting[0]!, /vpn:parity/);
  assert.deepEqual(listSkipped(db), []);
});
