/**
 * Отметка сделок рекламы списком: «Ждём оплату», «Бартер» и «Не разобрана» на
 * многих сразу — так же, как по одной, а оплаченные и неизвестные пропускаются,
 * а не роняют весь список. Долги идут следом за отметками.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { openDb } from '../src/db/index.js';
import { MICRO, MoneyInputError } from '../src/money.js';
import { balances, listWallets, monthRange, monthReport } from '../src/ledger.js';
import { SESSION_COOKIE, createSession } from '../src/auth.js';
import { createApp } from '../src/server.js';
import { adDebts, bulkMark, listDeals, payDeal, payDeals, syncDeals, type AnalyticsDeal, type BulkAction } from '../src/ads.js';

const T = Date.UTC(2026, 9, 19, 9);
const SINCE = Date.UTC(2026, 9, 1) - 3 * 3600_000;
const rub = (n: number) => Math.round(n * MICRO);
const deal = (ref: string, amount: number | null): AnalyticsDeal => ({
  ref, kind: ref.startsWith('buy') ? 'buy' : 'sale', date: '2026-10-05', slot: 'evening', buyKind: 'post',
  status: 'done', amount, contact: 'Иван (@ivan)', channels: ['SATAN GAMES'],
});

test('отметка списком: ждём оплату, бартер, не разобрана; оплаченные и чужие — мимо; долги следом', async () => {
  const db = openDb(':memory:');
  const list = [deal('sale:1', 1500), deal('sale:2', 800), deal('sale:3', null), deal('buy:7', 1200), deal('buy:8', 300)];
  await syncDeals(db, { fetchDeals: async () => list, since: SINCE }, T);
  const state = (ref: string) => listDeals(db).find((d) => d.ref === ref)!.state;
  const cryptobot = listWallets(db).find((w) => w.name === 'CryptoBot')!.id;
  payDeal(db, 'buy:8', { walletId: cryptobot, amount: 3 * MICRO, rate: 100, at: T }, T);

  // все неразобранные разом, вместе с оплаченной и несуществующей
  assert.deepEqual(bulkMark(db, ['sale:1', 'sale:2', 'sale:3', 'buy:7', 'buy:8', 'sale:99'], 'waiting', T), { changed: 4, skipped: 2 });
  assert.equal(state('buy:8'), 'paid', 'оплаченная осталась оплаченной');
  assert.deepEqual(adDebts(db), { owedToUs: rub(2300), weOwe: rub(1200), owedToUsCount: 3, weOweCount: 1, unknown: 1, unsorted: 0 });

  // повтор той же отметки ничего не меняет и не считается отмеченным; дубли — одна сделка
  assert.deepEqual(bulkMark(db, ['sale:1', 'sale:1'], 'waiting', T), { changed: 0, skipped: 0 });

  // бартер снимает «ждём оплату», как по одной
  assert.deepEqual(bulkMark(db, ['sale:2', 'buy:7'], 'barter', T), { changed: 2, skipped: 0 });
  assert.equal(state('sale:2'), 'barter');
  assert.deepEqual(adDebts(db), { owedToUs: rub(1500), weOwe: 0, owedToUsCount: 2, weOweCount: 0, unknown: 1, unsorted: 0 });

  // «Не разобрана» снимает и ожидание, и бартер
  assert.deepEqual(bulkMark(db, ['sale:1', 'sale:2', 'buy:8'], 'unsort', T), { changed: 2, skipped: 1 });
  assert.equal(state('sale:1'), 'open');
  assert.equal(state('sale:2'), 'open');
  assert.deepEqual(adDebts(db), { owedToUs: 0, weOwe: 0, owedToUsCount: 1, weOweCount: 0, unknown: 1, unsorted: 2 });

  // мусор на входе — понятный отказ, и ничего не записано
  const before = JSON.stringify(listDeals(db));
  assert.throws(() => bulkMark(db, [], 'waiting', T), /не выбрано/);
  assert.throws(() => bulkMark(db, ['sale:1', 'sale:x'], 'waiting', T), /«sale:x» — не сделка/);
  assert.throws(() => bulkMark(db, [1] as unknown as string[], 'waiting', T), MoneyInputError);
  assert.throws(() => bulkMark(db, 'sale:1' as unknown as string[], 'waiting', T), /не выбрано/);
  assert.throws(() => bulkMark(db, Array.from({ length: 501 }, (_, i) => `sale:${i}`), 'waiting', T), /не больше 500/);
  assert.throws(() => bulkMark(db, ['sale:1'], 'paid' as BulkAction, T), /неизвестная отметка/);
  assert.equal(JSON.stringify(listDeals(db)), before);

  // через API: ответ — сколько отмечено и пропущено, ошибка ввода — 400 с текстом
  const app = createApp({ db, config: { botToken: '1:x', botUsername: 'fin_test_bot', ownerIds: ['777'] }, fetchRate: async () => null, now: () => T });
  const srv = app.listen(0);
  const cookie = `${SESSION_COOKIE}=${createSession(db, '777', T)}`;
  const post = (body: unknown) =>
    fetch(`http://127.0.0.1:${(srv.address() as AddressInfo).port}/api/ad-deals/bulk`, {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
  try {
    const ok = await post({ refs: ['sale:1', 'buy:8'], action: 'barter' });
    assert.deepEqual(await ok.json(), { changed: 1, skipped: 1 });
    const bad = await post({ refs: 'sale:1', action: 'barter' });
    assert.equal(bad.status, 400);
    assert.match((await bad.json()).error, /не выбрано/);
  } finally {
    srv.close();
  }
});

// Человек заплатил одним переводом за все свои места (владелец, 2026-10-22).
test('«Оплатить всё»: одна сумма делится по ценам мест, каждое — оплачено; без суммы и чужое — мимо', async () => {
  const db = openDb(':memory:');
  const list = [deal('sale:1', 1000), deal('sale:2', 2000), deal('sale:3', null), deal('sale:4', 500), deal('buy:7', 1200)];
  await syncDeals(db, { fetchDeals: async () => list, since: SINCE }, T);
  bulkMark(db, ['sale:1', 'sale:2'], 'waiting', T);
  bulkMark(db, ['sale:4'], 'barter', T);
  const cryptobot = listWallets(db).find((w) => w.name === 'CryptoBot')!.id;
  const platega = listWallets(db).find((w) => w.name === 'Platega')!.id;
  const state = (ref: string) => listDeals(db).find((d) => d.ref === ref)!.state;

  assert.throws(() => payDeals(db, ['sale:1', 'buy:7'], { walletId: platega, amount: rub(100), rate: 1, at: T }, T), /продажи и закупы — отдельно/);
  assert.throws(() => payDeals(db, ['sale:3', 'sale:4'], { walletId: platega, amount: rub(100), rate: 1, at: T }, T), /оплачивать нечего/);
  assert.throws(() => payDeals(db, [], { walletId: platega, amount: rub(100), rate: 1, at: T }, T), /не выбрано/);
  assert.throws(() => payDeals(db, ['x'], { walletId: platega, amount: rub(100), rate: 1, at: T }, T), /не сделка/);

  // за 3 000 пришло 2 900 — скидка делится по ценам: 966,66 и 1 933,34
  assert.deepEqual(payDeals(db, ['sale:1', 'sale:2', 'sale:3', 'sale:4', 'sale:99'], { walletId: platega, amount: rub(2_900), rate: 1, at: T }, T), { paid: 2, skipped: 3 });
  assert.deepEqual(['sale:1', 'sale:2', 'sale:3', 'sale:4'].map(state), ['paid', 'paid', 'open', 'barter']);
  const { from, to } = monthRange('2026-10');
  const ops = db.prepare("SELECT source_ref AS ref, gross_rub AS rub FROM operations WHERE source = 'ads' ORDER BY ref").all();
  assert.deepEqual(ops, [{ ref: 'sale:1', rub: rub(966.67) }, { ref: 'sale:2', rub: rub(1_933.33) }]);
  assert.equal(balances(db).get(platega), rub(2_900), 'на кошелёк — ровно перевод');
  assert.equal(monthReport(db, from, to).totalIncome, rub(2_900));
  assert.deepEqual(adDebts(db).owedToUs, 0);

  // закупы — на кошелёк в USDT по курсу; повторная оплата уже оплаченного — мимо
  assert.deepEqual(payDeals(db, ['buy:7', 'sale:1'], { walletId: cryptobot, amount: rub(12), rate: 100, at: T }, T), { paid: 1, skipped: 1 });
  assert.equal(balances(db).get(cryptobot), -rub(12));
});

test('«Оплатить всё» через API', async () => {
  const db = openDb(':memory:');
  await syncDeals(db, { fetchDeals: async () => [deal('sale:1', 1000), deal('sale:2', 500)], since: SINCE }, T);
  const app = createApp({ db, config: { botToken: '1:' + 'x'.repeat(35), botUsername: 't', ownerIds: ['1'] }, fetchRate: async () => 100, now: () => T });
  const server = app.listen(0);
  try {
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const cookie = `${SESSION_COOKIE}=${createSession(db, '1', T)}`;
    const post = (body: unknown) => fetch(`${url}/api/ad-deals/pay-many`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const platega = listWallets(db).find((w) => w.name === 'Platega')!.id;
    const r = await post({ refs: ['sale:1', 'sale:2'], walletId: platega, amount: '1 500', at: T });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { paid: 2, skipped: 0 });
    const again = await post({ refs: ['sale:1'], walletId: platega, amount: '10', at: T });
    assert.equal(again.status, 400);
    assert.match((await again.json()).error, /оплачивать нечего/);
  } finally {
    server.close();
  }
});
