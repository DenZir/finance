/**
 * Сделки рекламы из tg-analytics: сверка не задваивает и подхватывает поздние
 * суммы, «Оплачено» превращает сделку в доход или расход, «Бартер» — ни во что,
 * а висящие без решения дают «Нам должны» и «Мы должны».
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db/index.js';
import { MICRO } from '../src/money.js';
import { balances, deleteOperation, listCategories, listOperations, listWallets, monthRange, monthReport } from '../src/ledger.js';
import { adDebts, listDeals, payDeal, setBarter, syncDeals, type AnalyticsDeal } from '../src/ads.js';

const T = Date.UTC(2026, 9, 19, 9);
const SINCE = Date.UTC(2026, 9, 1) - 3 * 3600_000;
const rub = (n: number) => Math.round(n * MICRO);
const deal = (ref: string, over: Partial<AnalyticsDeal> = {}): AnalyticsDeal => ({
  ref, kind: ref.startsWith('buy') ? 'buy' : 'sale', date: '2026-10-05', slot: 'evening', buyKind: 'post',
  status: 'done', amount: 1000, contact: 'Иван (@ivan)', channels: ['SATAN GAMES'], ...over,
});

test('сверка, оплата, бартер и долги по рекламе', async () => {
  const db = openDb(':memory:');
  let list: AnalyticsDeal[] = [
    deal('sale:1', { amount: 1500, slot: 'stories', channels: ['SATAN GAMES', 'MARIN GAMES'] }),
    deal('sale:2', { amount: 800 }),
    deal('buy:7', { amount: 1200 }),
    deal('buy:8', { amount: null }),
    deal('sale:3', { status: 'cancel' }),
  ];
  const asked: string[] = [];
  const deps = { fetchDeals: async (since: string) => { asked.push(since); return list; }, since: SINCE };

  assert.deepEqual(await syncDeals(db, deps, T), { added: 5 });
  assert.deepEqual(await syncDeals(db, deps, T), { added: 0 }, 'повторная сверка не добавляет');
  assert.equal(asked[0], '2026-10-01', 'дата начала — по Москве');

  assert.deepEqual(adDebts(db), { owedToUs: rub(2300), weOwe: rub(1200), owedToUsCount: 2, weOweCount: 1, unknown: 1 },
    'отменённая не висит, CPM без суммы — отдельно');

  // CPM получил сумму, продажу 2 удалили в аналитике
  list = list.filter((d) => d.ref !== 'sale:2').map((d) => (d.ref === 'buy:8' ? { ...d, amount: 450 } : d));
  await syncDeals(db, deps, T);
  const byRef = (ref: string) => listDeals(db).find((d) => d.ref === ref)!;
  assert.equal(byRef('buy:8').amount, rub(450));
  assert.equal(byRef('sale:2').cancelled, true, 'удалённая в аналитике — отменена');
  assert.deepEqual(adDebts(db), { owedToUs: rub(1500), weOwe: rub(1650), owedToUsCount: 1, weOweCount: 2, unknown: 0 });

  const w = (name: string) => listWallets(db).find((x) => x.name === name)!.id;
  const at = Date.UTC(2026, 9, 6, 9);
  // продажа сторис оплачена в USDT: 15 USDT по 100 ₽, без комиссии
  payDeal(db, 'sale:1', { walletId: w('CryptoBot'), amount: 15 * MICRO, rate: 100, at }, T);
  assert.equal(balances(db).get(w('CryptoBot')), 15 * MICRO, 'реклама — перевод, комиссии приёма нет');
  assert.throws(() => payDeal(db, 'sale:1', { walletId: w('CryptoBot'), amount: MICRO, rate: 100, at }, T), /уже оплачена/);
  assert.throws(() => setBarter(db, 'sale:1', true, T), /уже оплачена/);

  // закуп оплачен с Platega, второй — бартер
  payDeal(db, 'buy:7', { walletId: w('Platega'), amount: rub(1200), rate: 1, at }, T);
  setBarter(db, 'buy:8', true, T);
  assert.equal(byRef('buy:8').state, 'barter');
  assert.deepEqual(adDebts(db), { owedToUs: 0, weOwe: 0, owedToUsCount: 0, weOweCount: 0, unknown: 0 });

  const cat = (id: number | null) => listCategories(db).find((c) => c.id === id)?.name;
  const { from, to } = monthRange('2026-10');
  const ops = listOperations(db, from, to);
  assert.deepEqual(ops.map((o) => [o.kind, cat(o.categoryId), o.grossRub, o.source]).sort(), [
    ['expense', 'Закуп рекламы', rub(1200), 'ads'],
    ['income', 'Реклама — сторисы', rub(1500), 'ads'],
  ]);
  assert.match(ops.find((o) => o.kind === 'income')!.note, /Продажа · Иван \(@ivan\) · SATAN GAMES, MARIN GAMES/);
  const r = monthReport(db, from, to);
  assert.equal(r.net, rub(300), 'бартер в отчёт не попадает');

  // удалили операцию — сделка снова ждёт
  deleteOperation(db, ops.find((o) => o.kind === 'expense')!.id);
  assert.equal(byRef('buy:7').state, 'open');
  assert.equal(adDebts(db).weOwe, rub(1200));

  setBarter(db, 'buy:8', false, T);
  assert.equal(byRef('buy:8').state, 'open');
});
