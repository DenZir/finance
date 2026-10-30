/**
 * «Если всё оплачено»: долги из «Нам должны» и «Мы должны» — по дню места или
 * фиксации, с тем видом и проектом, что получит оплата. Неразобранные, бартер,
 * отменённые и CPM без суммы — не долг; оплаченное уходит из ожидаемого в доход
 * на то же место, а не задваивается.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db/index.js';
import { MICRO } from '../src/money.js';
import { categoryIdByCode, incomeSeries, listWallets, monthRange, projectIdByCode } from '../src/ledger.js';
import { payDeal, setBarter, setWaiting, syncDeals, type AnalyticsDeal } from '../src/ads.js';
import { createWelcome, fixWelcome } from '../src/welcome.js';
import { expectedSeries } from '../src/expected.js';

const T = Date.UTC(2026, 9, 30, 9);
const rub = (n: number) => Math.round(n * MICRO);
const deal = (ref: string, over: Partial<AnalyticsDeal> = {}): AnalyticsDeal => ({
  ref, kind: ref.startsWith('buy') ? 'buy' : 'sale', date: '2026-10-05', slot: 'evening', buyKind: 'post',
  status: 'done', amount: 1000, contact: 'Иван (@ivan)', channels: ['SATAN GAMES'], ...over,
});

test('ожидаемое: долги как будто оплачены', async () => {
  const db = openDb(':memory:');
  const list = [
    deal('sale:1', { amount: 1500 }),
    deal('sale:2', { amount: 700, slot: 'stories', date: '2026-10-05' }),
    deal('sale:3', { amount: 400, date: '2026-10-31' }), // последний день месяца — ещё октябрь
    deal('sale:4', { amount: 900, date: '2026-11-01' }), // уже ноябрь
    deal('sale:5', { amount: null }), // CPM без суммы
    deal('sale:6', { amount: 300 }), // бартер
    deal('sale:7', { amount: 200 }), // не разобрана
    deal('sale:8', { amount: 100, status: 'cancel' }),
    deal('buy:1', { amount: 1200, date: '2026-10-07' }),
  ];
  await syncDeals(db, { fetchDeals: async () => list, since: Date.UTC(2026, 9, 1) }, T);
  for (const ref of ['sale:1', 'sale:2', 'sale:3', 'sale:4', 'sale:5', 'sale:8', 'buy:1']) setWaiting(db, ref, true, T);
  setBarter(db, 'sale:6', true, T);
  const welcome = createWelcome(db, { contact: 'Пётр', price: '5', startedOn: '2026-10-01' }, T);
  fixWelcome(db, welcome, { total: 100, onDate: '2026-10-10' }, T);
  fixWelcome(db, welcome, { total: 100, onDate: '2026-10-12' }, T); // без новых заявок — долга нет

  const cat = (code: string) => categoryIdByCode(db, code);
  const ads = projectIdByCode(db, 'ads');
  const row = (key: string, kind: 'income' | 'expense', code: string, gross: number) =>
    ({ key, kind, categoryId: cat(code), projectId: ads, gross: rub(gross), fee: 0, expected: true });
  const { from, to } = monthRange('2026-10');
  assert.deepEqual(expectedSeries(db, from, to, 'day'), [
    row('2026-10-05', 'income', 'ads_posts', 1500),
    row('2026-10-05', 'income', 'ads_stories', 700),
    row('2026-10-07', 'expense', 'ads_buy', 1200),
    row('2026-10-10', 'income', 'welcome', 500),
    row('2026-10-31', 'income', 'ads_posts', 400),
  ]);
  assert.deepEqual(expectedSeries(db, monthRange('2026-01').from, monthRange('2026-12').to, 'month'), [
    row('2026-10', 'expense', 'ads_buy', 1200),
    row('2026-10', 'income', 'ads_posts', 1900),
    row('2026-10', 'income', 'ads_stories', 700),
    row('2026-10', 'income', 'welcome', 500),
    row('2026-11', 'income', 'ads_posts', 900),
  ]);

  // оплатили — из ожидаемого в доход того же дня, вида и проекта
  const w = listWallets(db).find((x) => x.name === 'Platega')!.id;
  payDeal(db, 'sale:1', { walletId: w, amount: rub(1500), rate: 1, at: Date.UTC(2026, 9, 5, 12) }, T);
  assert.equal(expectedSeries(db, from, to, 'day').find((r) => r.categoryId === cat('ads_posts') && r.key === '2026-10-05'), undefined);
  const paid = incomeSeries(db, from, to, 'day').find((r) => r.key === '2026-10-05')!;
  assert.deepEqual([paid.categoryId, paid.projectId, paid.gross], [cat('ads_posts'), ads, rub(1500)]);
});
