/**
 * Отметка сделки из аналитики (payMode, владелец 2026-11-01): «под оплату» и
 * «бартер» теперь ставят там, а сверка переносит их сюда — сделка сразу
 * становится долгом человека или бартером, без ручного разбора. Важно, чтобы:
 * - старые сделки без отметки (null или поля нет вовсе — сборка аналитики до
 *   2026-11-01) остались ровно как были: их владелец разбирает руками;
 * - смена отметки в аналитике переворачивала сделку при следующей сверке;
 * - сделку с деньгами отметка не переворачивала: оплату снимают только
 *   удалением операции, а «бартер» при оплате — расхождение, которое видно;
 * - ручные отметки не спорили с аналитикой: следующая сверка всё равно вернула
 *   бы её отметку, и владелец видел бы, как его клик молча откатился.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb, type Db } from '../src/db/index.js';
import { MICRO, MoneyInputError } from '../src/money.js';
import { listWallets } from '../src/ledger.js';
import { personDebts } from '../src/debts.js';
import { adDebts, bulkMark, listDeals, payDeal, setBarter, setWaiting, syncDeals, type AnalyticsDeal } from '../src/ads.js';

const T = Date.UTC(2026, 10, 1, 9);
const SINCE = Date.UTC(2026, 9, 1) - 3 * 3600_000;
const rub = (n: number) => Math.round(n * MICRO);
const deal = (ref: string, over: Partial<AnalyticsDeal> = {}): AnalyticsDeal => ({
  ref, kind: ref.startsWith('buy') ? 'buy' : 'sale', date: '2026-10-05', slot: 'evening', buyKind: 'post',
  status: 'done', amount: 1000, contact: 'Иван (@ivan)', channels: ['SATAN GAMES'], ...over,
});
const view = (db: Db, ref: string) => listDeals(db).find((d) => d.ref === ref)!;
const raw = (db: Db, ref: string) => db.prepare('SELECT waiting_at, barter_at, pay_mode FROM ad_deals WHERE ref = ?').get(ref) as { waiting_at: number | null; barter_at: number | null; pay_mode: string | null };
const ivanOwes = (db: Db) => personDebts(db).find((g) => g.username === 'ivan')?.items.filter((i) => i.remaining > 0).map((i) => i.ref).sort() ?? [];

test('отметка из аналитики: под оплату — долг, бартер — без денег, без отметки — не трогаем, оплату не переворачиваем', async () => {
  const db = openDb(':memory:');
  // сборка аналитики до 2026-11-01: поля payMode нет вовсе
  const old = deal('sale:3');
  delete old.payMode;
  let list: AnalyticsDeal[] = [
    deal('sale:1', { payMode: 'paid', amount: 1500 }),
    deal('buy:2', { payMode: 'barter', amount: 700 }),
    old,
    deal('sale:4', { payMode: null }),
    deal('sale:5', { payMode: null }),
    // незнакомое значение — не отметка
    deal('sale:6', { payMode: 'gift' as never }),
  ];
  const deps = { fetchDeals: async () => list, since: SINCE };
  const sync = (at: number) => syncDeals(db, deps, at);
  // sale:5 владелец успел разобрать руками до выкатки — бартер
  await sync(T - 3600_000);
  setBarter(db, 'sale:5', true, T - 3600_000);

  await sync(T);
  assert.equal(view(db, 'sale:1').state, 'waiting', 'paid → «Ждём оплату»');
  assert.equal(view(db, 'sale:1').payMode, 'paid');
  assert.equal(view(db, 'buy:2').state, 'barter', 'barter → «Бартер»');
  assert.deepEqual(ivanOwes(db), ['sale:1'], 'под оплату — сразу долг человека; бартер — нет');
  assert.equal(adDebts(db).owedToUs, rub(1500));
  for (const ref of ['sale:3', 'sale:4', 'sale:6']) {
    assert.equal(view(db, ref).state, 'open', `${ref}: без отметки — неразобранная, как была`);
    assert.equal(view(db, ref).payMode, null);
    assert.deepEqual(raw(db, ref), { waiting_at: null, barter_at: null, pay_mode: null });
  }
  assert.equal(view(db, 'sale:5').state, 'barter', 'ручная отметка старой сделки цела');

  // повторная сверка не сдвигает «с какого дня ждём»
  const since = raw(db, 'sale:1').waiting_at;
  await sync(T + 3600_000);
  assert.equal(raw(db, 'sale:1').waiting_at, since);

  // в аналитике передумали: продажа — бартер, закуп — под оплату
  list = list.map((d) => (d.ref === 'sale:1' ? { ...d, payMode: 'barter' } : d.ref === 'buy:2' ? { ...d, payMode: 'paid' } : d));
  await sync(T + 2 * 3600_000);
  assert.equal(view(db, 'sale:1').state, 'barter');
  assert.equal(view(db, 'buy:2').state, 'waiting');
  assert.deepEqual(ivanOwes(db), ['buy:2'], 'долг переехал вслед за отметкой');
  list = list.map((d) => (d.ref === 'sale:1' ? { ...d, payMode: 'paid' } : d));
  await sync(T + 3 * 3600_000);
  assert.equal(view(db, 'sale:1').state, 'waiting', 'и обратно');

  // ручные отметки — только у сделок без отметки аналитики
  for (const fn of [setBarter, setWaiting]) {
    for (const on of [true, false]) {
      assert.throws(() => fn(db, 'sale:1', on, T), (e: unknown) => e instanceof MoneyInputError && /ведётся в аналитике/.test(e.message));
    }
  }
  assert.deepEqual(bulkMark(db, ['sale:1', 'buy:2', 'sale:3', 'sale:4'], 'barter', T), { changed: 2, skipped: 2 }, 'размеченные аналитикой — пропущены');
  assert.equal(view(db, 'sale:1').state, 'waiting');
  assert.equal(view(db, 'sale:3').state, 'barter', 'старую — можно, как раньше');

  // оплата работает для любой сделки; частичная — деньги уже есть
  const cryptobot = listWallets(db).find((w) => w.name === 'CryptoBot')!.id;
  payDeal(db, 'sale:1', { walletId: cryptobot, amount: 5 * MICRO, rate: 100, at: T }, T);
  assert.equal(view(db, 'sale:1').paid, rub(500));
  // CPM без суммы под оплату, оплачен прежним «Оплачено» (точный номер сделки)
  list = [...list, deal('sale:7', { payMode: 'paid', amount: null })];
  await sync(T + 4 * 3600_000);
  assert.equal(view(db, 'sale:7').state, 'waiting');
  payDeal(db, 'sale:7', { walletId: cryptobot, amount: 3 * MICRO, rate: 100, at: T }, T);
  assert.equal(view(db, 'sale:7').state, 'paid');
  assert.equal(view(db, 'sale:1').conflict, null, 'под оплату и оплачена — расхождения нет');

  // аналитика говорит «бартер», а деньги уже записаны: не переворачиваем, показываем
  list = list.map((d) => (d.ref === 'sale:1' || d.ref === 'sale:7' ? { ...d, payMode: 'barter' } : d));
  await sync(T + 5 * 3600_000);
  const s1 = view(db, 'sale:1');
  assert.equal(s1.state, 'waiting', 'частично оплаченная осталась долгом с остатком');
  assert.equal(s1.remaining, rub(1000));
  assert.equal(s1.payMode, 'barter');
  assert.match(s1.conflict ?? '', /в аналитике — бартер, а здесь есть оплата/);
  assert.equal(view(db, 'sale:7').state, 'paid');
  assert.match(view(db, 'sale:7').conflict ?? '', /бартер/);
  assert.equal(raw(db, 'sale:1').barter_at, null, 'отметка бартера на сделку с деньгами не легла');
  assert.deepEqual(ivanOwes(db), ['buy:2', 'sale:1']);
  assert.equal(view(db, 'buy:2').conflict, null);
});
