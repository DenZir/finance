/**
 * Долги по людям (владелец, 2026-10-31): позиции из рекламы и приветки одного
 * человека — одним списком по дате. Заплатил меньше — старые закрыты целиком,
 * последняя частично; галочками — только выбранные; переплата — аванс, который
 * сам гасит следующие позиции; взаимозачёт закрывает встречные долги без
 * движения денег, но в итогах месяца; удалить часть оплаты — удалить всю
 * оплату; прежнее «Оплачено» (операция с точным номером) закрывает позицию
 * целиком, какой бы ни была сумма, — так при взаимозачёте вписывали разницу.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import Database from 'better-sqlite3';
import { migrate, openDb, type Db } from '../src/db/index.js';
import { MIGRATIONS } from '../src/db/migrations.js';
import { MICRO } from '../src/money.js';
import {
  addIncome, balances, categoryIdByCode, deleteOperation, listOperations, listWallets, monthRange, monthReport, projectIdByCode,
} from '../src/ledger.js';
import { adDebts, listDeals, payDeal, setWaiting, syncDeals, type AnalyticsDeal } from '../src/ads.js';
import { createWelcome, fixWelcome, listWelcome, payFix, welcomeDebts } from '../src/welcome.js';
import { closeDebt, debtTotals, deletePayment, listDebtItems, offsetPerson, payPerson, personDebt, personDebts } from '../src/debts.js';
import { backfillPeople, createPerson, listPeople } from '../src/people.js';
import { expectedSeries } from '../src/expected.js';
import { SESSION_COOKIE, createSession } from '../src/auth.js';
import { createApp } from '../src/server.js';

const T = Date.UTC(2026, 9, 31, 9);
const AT = Date.UTC(2026, 9, 20, 9);
const rub = (n: number) => Math.round(n * MICRO);
const deal = (ref: string, over: Partial<AnalyticsDeal> = {}): AnalyticsDeal => ({
  ref, kind: ref.startsWith('buy') ? 'buy' : 'sale', date: '2026-10-05', slot: 'evening', buyKind: 'post',
  status: 'done', amount: 1000, contact: 'Иван (@ivan)', channels: ['SATAN GAMES'], ...over,
});

/**
 * Иван: продажа поста 03.10 — 1 000, приветка 07.10 — 100 заявок по 5 = 500,
 * продажа сторис 10.10 — 700 (он нам 2 200); закуп у него 05.10 — 1 200 (мы ему).
 * Пётр: продажа 04.10 — 300. Неразобранная продажа Ивана 12.10 — 400.
 */
async function setup(): Promise<{ db: Db; ivan: number; petr: number; welcome: number; w: (name: string) => number }> {
  const db = openDb(':memory:');
  await syncDeals(db, {
    fetchDeals: async () => [
      deal('sale:1', { date: '2026-10-03' }),
      deal('sale:2', { date: '2026-10-10', amount: 700, slot: 'stories', channels: ['MARIN GAMES'] }),
      deal('buy:7', { date: '2026-10-05', amount: 1200 }),
      deal('sale:3', { date: '2026-10-04', amount: 300, contact: 'Пётр' }),
      deal('sale:9', { date: '2026-10-12', amount: 400 }),
    ],
    since: Date.UTC(2026, 9, 1),
  }, T);
  for (const ref of ['sale:1', 'sale:2', 'buy:7', 'sale:3']) setWaiting(db, ref, true, T);
  const welcome = createWelcome(db, { contact: '@ivan', price: '5', startedOn: '2026-10-01' }, T);
  fixWelcome(db, welcome, { value: '100', onDate: '2026-10-07' }, T);
  const people = listPeople(db);
  return {
    db, welcome,
    ivan: people.find((p) => p.username === 'ivan')!.id,
    petr: people.find((p) => p.name === 'Пётр')!.id,
    w: (name) => listWallets(db).find((x) => x.name === name)!.id,
  };
}

const item = (db: Db, ref: string) => listDebtItems(db).find((i) => i.ref === ref)!;
const brief = (db: Db, ref: string) => {
  const i = item(db, ref);
  return [i.state, i.paid, i.advance, i.remaining];
};

test('позиции человека: реклама и приветка вместе, по дате; неразобранное — не долг', async () => {
  const { db, ivan } = await setup();
  const p = personDebt(db, ivan);
  assert.deepEqual(p.items.map((i) => [i.ref, i.dir, i.what]), [
    ['sale:1', 'in', 'пост вечер · SATAN GAMES'],
    ['buy:7', 'out', 'пост вечер · SATAN GAMES'],
    ['fix:1', 'in', 'приветка · 100 заявок'],
    ['sale:2', 'in', 'сторисы · MARIN GAMES'],
  ]);
  assert.deepEqual([p.owedToUs, p.weOwe, p.advanceIn, p.advanceOut], [rub(2200), rub(1200), 0, 0]);
  assert.deepEqual(debtTotals(db), { owedToUs: rub(2500), weOwe: rub(1200), owedToUsCount: 4, weOweCount: 1, people: 2 });
  assert.deepEqual(personDebts(db).map((g) => g.name), ['Иван', 'Пётр'], 'больший долг — выше');
});

test('заплатил меньше: старые позиции целиком, последняя частично — по разным источникам', async () => {
  const { db, ivan, w } = await setup();
  const r = payPerson(db, ivan, { dir: 'in', walletId: w('Platega'), amount: rub(1700), rate: 1, at: AT }, T);
  assert.deepEqual(r, { paymentId: 1, paid: 3, partial: 'sale:2', advance: 0 });
  assert.deepEqual(brief(db, 'sale:1'), ['paid', rub(1000), 0, 0]);
  assert.deepEqual(brief(db, 'fix:1'), ['paid', rub(500), 0, 0]);
  assert.deepEqual(brief(db, 'sale:2'), ['partial', rub(200), 0, rub(500)], 'оплачено 200 из 700');
  assert.deepEqual(brief(db, 'buy:7'), ['open', 0, 0, rub(1200)], 'закуп — другое направление, не тронут');
  assert.equal(balances(db).get(w('Platega')), rub(1700), 'на кошелёк — ровно перевод, без комиссии');

  const ops = db.prepare('SELECT source, source_ref AS ref, category_id AS cat, gross_rub AS rub, fee_rub AS fee, payment_id AS pid FROM operations ORDER BY id').all();
  const cat = (code: string) => categoryIdByCode(db, code);
  assert.deepEqual(ops, [
    { source: 'ads', ref: 'sale:1@p1', cat: cat('ads_posts'), rub: rub(1000), fee: 0, pid: 1 },
    { source: 'welcome', ref: 'fix:1@p1', cat: cat('welcome'), rub: rub(500), fee: 0, pid: 1 },
    { source: 'ads', ref: 'sale:2@p1', cat: cat('ads_stories'), rub: rub(200), fee: 0, pid: 1 },
  ]);
  assert.equal(listOperations(db, 0, T)[0]!.note, 'Иван (@ivan) · сторисы · MARIN GAMES');

  // долги — по остатку: в плашках, в рекламе, в приветке и в «Если всё оплачено»
  assert.equal(personDebt(db, ivan).owedToUs, rub(500));
  assert.equal(adDebts(db).owedToUs, rub(800), 'реклама: 500 остатка сторис + 300 Петра');
  assert.equal(listDeals(db).find((d) => d.ref === 'sale:2')!.state, 'waiting');
  assert.equal(listDeals(db).find((d) => d.ref === 'sale:2')!.paid, rub(200));
  assert.deepEqual(welcomeDebts(db), []);
  assert.equal(listWelcome(db)[0]!.fixes[0]!.state, 'paid');
  const { from, to } = monthRange('2026-10');
  const stories = expectedSeries(db, from, to, 'day').find((b) => b.key === '2026-10-10')!;
  assert.equal(stories.gross, rub(500), 'частично оплаченное не считается дважды');

  // остаток в USDT: 5 USDT по 100 ₽ закрывают сторис
  assert.deepEqual(payPerson(db, ivan, { dir: 'in', walletId: w('CryptoBot'), amount: 5 * MICRO, rate: 100, at: AT }, T),
    { paymentId: 2, paid: 1, partial: null, advance: 0 });
  assert.deepEqual(brief(db, 'sale:2'), ['paid', rub(700), 0, 0]);
  assert.equal(personDebt(db, ivan).owedToUs, 0);
  assert.deepEqual(personDebt(db, ivan).payments.map((p) => [p.id, p.rub, p.parts.map((x) => [x.ref, x.rub])]), [
    [2, rub(500), [['sale:2', rub(500)]]],
    [1, rub(1700), [['sale:1', rub(1000)], ['fix:1', rub(500)], ['sale:2', rub(200)]]],
  ], 'история оплат — новые сверху, с разбивкой');
});

test('в валюте: доли по курсу, копейки округления — последней, на кошелёк ровно сумма', async () => {
  const { db, ivan, w } = await setup();
  const cb = w('CryptoBot');
  // 17 USDT по 97,5 = 1 657,50 ₽: 1 000 + 500 + 157,50
  payPerson(db, ivan, { dir: 'in', walletId: cb, amount: 17 * MICRO, rate: 97.5, at: AT }, T);
  assert.equal(balances(db).get(cb), 17 * MICRO);
  const gross = (db.prepare('SELECT SUM(gross_rub) AS s FROM operations').get() as { s: number }).s;
  assert.equal(gross, rub(1657.5));
  assert.deepEqual(brief(db, 'sale:2'), ['partial', rub(157.5), 0, rub(542.5)]);
});

test('галочками: только выбранные, по дате; неразобранную тоже можно — и она становится долгом', async () => {
  const { db, ivan, petr, w } = await setup();
  const pay = (refs: unknown, amount: number, dir = 'in') => payPerson(db, ivan, { dir, walletId: w('Platega'), amount: rub(amount), rate: 1, at: AT, refs }, T);
  assert.throws(() => pay(['sale:3'], 100), /не долг этого человека/);
  assert.throws(() => pay(['buy:7'], 100), /продажи и закупы — отдельно/);
  assert.throws(() => pay([], 100), /не выбрано/);
  assert.throws(() => pay(['sale:x'], 100), /не позиция/);

  assert.deepEqual(pay(['sale:2', 'fix:1'], 1000), { paymentId: 1, paid: 2, partial: 'sale:2', advance: 0 });
  assert.deepEqual(brief(db, 'fix:1'), ['paid', rub(500), 0, 0], 'выбранные — по дате: приветка 07.10 раньше сторис 10.10');
  assert.deepEqual(brief(db, 'sale:2'), ['partial', rub(500), 0, rub(200)]);
  assert.deepEqual(brief(db, 'sale:1'), ['open', 0, 0, rub(1000)], 'не выбранная не тронута, хотя старше');
  assert.throws(() => pay(['fix:1'], 100), /уже оплачено/);

  // неразобранная продажа 12.10 — оплачена наполовину: теперь ждём остаток
  assert.equal(listDeals(db).find((d) => d.ref === 'sale:9')!.state, 'open');
  pay(['sale:9'], 150);
  assert.equal(listDeals(db).find((d) => d.ref === 'sale:9')!.state, 'waiting');
  assert.deepEqual(brief(db, 'sale:9'), ['partial', rub(150), 0, rub(250)]);
  assert.equal(personDebt(db, petr).owedToUs, rub(300));
});

test('переплата — аванс: гасит следующую фиксацию сам, удалили оплату — всё вернулось', async () => {
  const { db, ivan, welcome, w } = await setup();
  const r = payPerson(db, ivan, { dir: 'in', walletId: w('Platega'), amount: rub(2500), rate: 1, at: AT }, T);
  assert.deepEqual(r, { paymentId: 1, paid: 3, partial: null, advance: rub(300) });
  const adv = db.prepare("SELECT source_ref AS ref, category_id AS cat, gross_rub AS rub, payment_id AS pid FROM operations WHERE source = 'advance'").get();
  assert.deepEqual(adv, { ref: 'p1', cat: categoryIdByCode(db, 'ads_stories'), rub: rub(300), pid: 1 }, 'вид — последней оплаченной позиции');
  assert.equal(personDebt(db, ivan).advanceIn, rub(300));
  assert.equal(balances(db).get(w('Platega')), rub(2500));

  // новая фиксация на 500: 300 покрыл аванс, ждём 200
  fixWelcome(db, welcome, { value: '+100', onDate: '2026-10-21' }, T);
  assert.deepEqual(brief(db, 'fix:2'), ['partial', 0, rub(300), rub(200)]);
  const p = personDebt(db, ivan);
  assert.deepEqual([p.owedToUs, p.advanceIn], [rub(200), 0]);
  assert.equal(listWelcome(db)[0]!.owed, rub(200));
  const { from, to } = monthRange('2026-10');
  assert.equal(expectedSeries(db, from, to, 'day').find((b) => b.key === '2026-10-21')!.gross, rub(200), 'покрытое авансом — не долг');
  assert.equal(personDebt(db, ivan).payments[0]!.advance, rub(300));

  // аванс сам по себе в закупы не идёт: другое направление
  assert.deepEqual(brief(db, 'buy:7'), ['open', 0, 0, rub(1200)]);

  // удаление любой операции оплаты — удаление всей оплаты, и аванс с ней
  const advOp = db.prepare("SELECT id FROM operations WHERE source = 'advance'").get() as { id: number };
  assert.equal(deleteOperation(db, advOp.id), true);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM operations').get() as { n: number }).n, 0);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM payments').get() as { n: number }).n, 0);
  assert.equal(balances(db).get(w('Platega')), undefined);
  assert.equal(personDebt(db, ivan).owedToUs, rub(2700));
});

test('удалить часть оплаты — удалить оплату целиком', async () => {
  const { db, ivan, w } = await setup();
  payPerson(db, ivan, { dir: 'in', walletId: w('Platega'), amount: rub(1700), rate: 1, at: AT }, T);
  const one = db.prepare("SELECT id FROM operations WHERE source_ref = 'fix:1@p1'").get() as { id: number };
  deleteOperation(db, one.id);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM operations').get() as { n: number }).n, 0, 'и продажи из той же оплаты');
  assert.deepEqual(brief(db, 'sale:1'), ['open', 0, 0, rub(1000)]);
  assert.equal(balances(db).get(w('Platega')), undefined);
  assert.equal(deletePayment(db, 1), false, 'уже удалена');

  payPerson(db, ivan, { dir: 'in', walletId: w('Platega'), amount: rub(100), rate: 1, at: AT }, T);
  assert.equal(deletePayment(db, 2), true);
  assert.equal(personDebt(db, ivan).payments.length, 0);
});

test('взаимозачёт: обе стороны на одну сумму, кошельки не двигаются, в итогах месяца — выручка и закуп', async () => {
  const { db, ivan, petr } = await setup();
  assert.throws(() => offsetPerson(db, petr, { at: AT }, T), /в обе стороны/);
  assert.throws(() => offsetPerson(db, ivan, { amount: rub(1300), at: AT }, T), /не больше 1.200.₽: столько вы должны ему/);

  assert.deepEqual(offsetPerson(db, ivan, { at: AT }, T), { paymentId: 1, amount: rub(1200), parts: 3 }, 'по умолчанию — меньший из долгов');
  assert.deepEqual(brief(db, 'buy:7'), ['paid', rub(1200), 0, 0]);
  assert.deepEqual(brief(db, 'sale:1'), ['paid', rub(1000), 0, 0]);
  assert.deepEqual(brief(db, 'fix:1'), ['partial', rub(200), 0, rub(300)]);
  const p = personDebt(db, ivan);
  assert.deepEqual([p.owedToUs, p.weOwe], [rub(1000), 0]);
  assert.deepEqual([p.payments[0]!.kind, p.payments[0]!.dir, p.payments[0]!.walletId, p.payments[0]!.rub], ['offset', 'both', null, rub(1200)]);

  assert.equal(balances(db).size, 0, 'ни одной проводки');
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM entries').get() as { n: number }).n, 0);
  const { from, to } = monthRange('2026-10');
  const r = monthReport(db, from, to);
  assert.deepEqual([r.totalIncome, r.totalExpense, r.net], [rub(1200), rub(1200), 0]);
  assert.equal(r.expense[0]!.categoryId, categoryIdByCode(db, 'ads_buy'));
  assert.equal(r.income[0]!.projectId, projectIdByCode(db, 'ads'));

  assert.throws(() => offsetPerson(db, ivan, { at: AT }, T), /в обе стороны/, 'встречного долга больше нет');
  // удалили — обе стороны снова ждут
  const op = listOperations(db, from, to).find((o) => o.kind === 'expense')!;
  assert.equal(op.paymentId, 1);
  deleteOperation(db, op.id);
  assert.deepEqual([personDebt(db, ivan).owedToUs, personDebt(db, ivan).weOwe], [rub(2200), rub(1200)]);
});

test('прежнее «Оплачено» с номером позиции закрывает её целиком, какой бы ни была сумма', async () => {
  const { db, ivan, w } = await setup();
  // раньше при взаимозачёте вписывали разницу: 300 за продажу на 1 000
  const base = { at: AT, walletId: w('Platega'), rate: 1, feePct: 0, projectId: projectIdByCode(db, 'ads') };
  addIncome(db, { ...base, amount: rub(300), categoryId: categoryIdByCode(db, 'ads_posts'), source: 'ads', sourceRef: 'sale:1' }, T);
  addIncome(db, { ...base, amount: rub(100), categoryId: categoryIdByCode(db, 'welcome'), source: 'welcome', sourceRef: 'fix:1' }, T);
  assert.deepEqual(brief(db, 'sale:1'), ['paid', rub(300), 0, 0]);
  assert.deepEqual(brief(db, 'fix:1'), ['paid', rub(100), 0, 0]);
  assert.equal(listDeals(db).find((d) => d.ref === 'sale:1')!.state, 'paid');
  assert.throws(() => payDeal(db, 'sale:1', { walletId: w('Platega'), amount: rub(700), rate: 1, at: AT }, T), /уже оплачена/);
  assert.throws(() => payFix(db, 1, { walletId: w('Platega'), amount: rub(400), rate: 1, at: AT }, T), /уже оплачена/);
  // и FIFO их не трогает
  payPerson(db, ivan, { dir: 'in', walletId: w('Platega'), amount: rub(100), rate: 1, at: AT }, T);
  assert.deepEqual(brief(db, 'sale:2'), ['partial', rub(100), 0, rub(600)]);
});

test('«Простить остаток»: позиция закрыта, долг меньше; отменили — снова ждём', async () => {
  const { db, ivan, w } = await setup();
  payDeal(db, 'sale:2', { walletId: w('Platega'), amount: rub(650), rate: 1, at: AT }, T);
  assert.deepEqual(brief(db, 'sale:2'), ['partial', rub(650), 0, rub(50)]);
  closeDebt(db, 'sale:2', true, T, 'скидка');
  assert.deepEqual(brief(db, 'sale:2'), ['closed', rub(650), 0, 0]);
  assert.equal(personDebt(db, ivan).owedToUs, rub(1500));
  const d = listDeals(db).find((x) => x.ref === 'sale:2')!;
  assert.deepEqual([d.state, d.closed, d.paid], ['paid', true, rub(650)]);
  closeDebt(db, 'sale:2', false, T);
  assert.deepEqual(brief(db, 'sale:2'), ['partial', rub(650), 0, rub(50)]);

  payDeal(db, 'sale:2', { walletId: w('Platega'), amount: rub(50), rate: 1, at: AT }, T);
  assert.throws(() => closeDebt(db, 'sale:2', true, T), /уже оплачена/);
  assert.throws(() => closeDebt(db, 'sale:99', true, T), /такой позиции нет/);
  assert.throws(() => closeDebt(db, 'x', true, T), /не позиция/);
});

test('миграция: люди из контактов, фиксации — в первую ссылку, прежние оплаты целы', () => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  // до миграции людей — по её содержимому, а не «последняя»: за ней идут новые
  const before = MIGRATIONS.findIndex((m) => m.includes('CREATE TABLE people ('));
  for (const m of MIGRATIONS.slice(0, before)) db.exec(m);
  db.pragma(`user_version = ${before}`);
  const ins = db.prepare(`INSERT INTO ad_deals (ref, kind, date, slot, contact, channels, amount, waiting_at, synced_at) VALUES (?, ?, '2026-10-05', 'evening', ?, '', ?, 1, 1)`);
  ins.run('sale:1', 'sale', 'Иван (@ivan)', rub(1000));
  ins.run('buy:2', 'buy', '@IVAN', rub(500));
  ins.run('sale:3', 'sale', '', rub(200));
  ins.run('sale:4', 'sale', 'Пётр', rub(300));
  db.prepare("INSERT INTO welcome_deals (contact, price, started_on, created_at) VALUES ('Иван (@ivan)', ?, '2026-10-01', 1), ('пётр', ?, '2026-10-02', 1)").run(rub(5), rub(4));
  const fix = db.prepare('INSERT INTO welcome_fixes (deal_id, on_date, total, count, amount, created_at) VALUES (?, ?, ?, ?, ?, 1)');
  fix.run(1, '2026-10-08', 100, 100, rub(500));
  fix.run(1, '2026-10-15', 340, 240, rub(1080));
  fix.run(2, '2026-10-09', 10, 10, rub(40));
  // прежнее «Оплачено» фиксации 1 — меньше её суммы
  db.prepare("INSERT INTO operations (kind, at, gross_rub, source, source_ref, created_at) VALUES ('income', 1, ?, 'welcome', 'fix:1', 1)").run(rub(450));

  migrate(db);
  assert.equal(backfillPeople(db, T), 5, 'три сделки и два размещения с контактом');
  assert.equal(backfillPeople(db, T), 0, 'второй раз — ничего');

  const people = listPeople(db);
  assert.deepEqual(people.map((p) => [p.name, p.username]), [['Иван', 'ivan'], ['Пётр', null]]);
  const deals = listDeals(db);
  const ivan = people[0]!.id;
  assert.deepEqual(deals.map((d) => [d.ref, d.personId]), [['buy:2', ivan], ['sale:1', ivan], ['sale:3', null], ['sale:4', people[1]!.id]]);

  const w = listWelcome(db);
  assert.deepEqual(w.map((d) => [d.personId, d.links.length, d.current.price, d.current.startedOn, d.total]), [
    [people[1]!.id, 1, rub(4), '2026-10-02', 10],
    [ivan, 1, rub(5), '2026-10-01', 340],
  ]);
  assert.ok(w.every((d) => d.fixes.every((f) => f.linkId === d.current.id)), 'все фиксации — в первую ссылку');
  assert.deepEqual(brief(db, 'fix:1'), ['paid', rub(450), 0, 0], 'прежняя оплата закрывает фиксацию целиком');
  assert.deepEqual(brief(db, 'fix:2'), ['open', 0, 0, rub(1080)]);

  const groups = personDebts(db);
  assert.deepEqual(groups.map((g) => [g.name, g.owedToUs, g.weOwe]), [
    ['Иван', rub(2080), rub(500)],
    ['Пётр', rub(340), 0],
    ['без контакта', rub(200), 0],
  ]);
});

test('API: люди, оплата, взаимозачёт, удаление оплаты, «Простить остаток»; ошибка — с кодом', async () => {
  const { db, ivan, welcome, w } = await setup();
  const app = createApp({ db, config: { botToken: '1:x', botUsername: 't', ownerIds: ['1'] }, fetchRate: async () => 100, now: () => T });
  const server = app.listen(0);
  try {
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const cookie = `${SESSION_COOKIE}=${createSession(db, '1', T)}`;
    const call = async (method: string, path: string, body?: unknown) => {
      const r = await fetch(`${url}${path}`, { method, headers: { cookie, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: r.status, body: await r.json() };
    };

    const list = await call('GET', '/api/people');
    assert.equal(list.status, 200);
    assert.deepEqual(Object.keys(list.body[0]), ['personId', 'name', 'username', 'owedToUs', 'weOwe', 'advanceIn', 'advanceOut', 'items', 'payments']);
    assert.deepEqual(Object.keys(list.body[0].items[0]), ['ref', 'personId', 'dir', 'source', 'date', 'what', 'categoryId', 'projectId', 'amount', 'paid', 'advance', 'remaining', 'state']);

    // USDT без курса — текущий курс, как в остальных ручках
    const paid = await call('POST', `/api/people/${ivan}/pay`, { dir: 'in', walletId: w('CryptoBot'), amount: '17', at: AT });
    assert.deepEqual(paid.body, { paymentId: 1, paid: 3, partial: 'sale:2', advance: 0 });
    const one = await call('GET', `/api/people/${ivan}`);
    assert.deepEqual(one.body.payments[0], {
      id: 1, kind: 'pay', dir: 'in', at: AT, walletId: w('CryptoBot'), amount: 17 * MICRO, rate: 100, note: '', rub: rub(1700),
      parts: [
        { ref: 'sale:1', what: 'пост вечер · SATAN GAMES', rub: rub(1000) },
        { ref: 'fix:1', what: 'приветка · 100 заявок', rub: rub(500) },
        { ref: 'sale:2', what: 'сторисы · MARIN GAMES', rub: rub(200) },
      ],
      advance: 0,
    });
    assert.equal((await call('POST', `/api/people/${ivan}/pay`, { dir: 'up', walletId: w('Platega'), amount: '1' })).status, 400);

    const off = await call('POST', `/api/people/${ivan}/offset`, { amount: '500', at: AT });
    assert.deepEqual(off.body, { paymentId: 2, amount: rub(500), parts: 2 });
    assert.equal((await call('DELETE', '/api/payments/2')).body.deleted, true);

    assert.deepEqual((await call('POST', '/api/debts/sale:2/close', { on: true })).body, { ok: true });
    assert.equal(item(db, 'sale:2').state, 'closed');

    const state = await call('GET', '/api/state');
    assert.deepEqual(state.body.debts, { owedToUs: rub(300), weOwe: rub(1200), owedToUsCount: 1, weOweCount: 1, people: 2 });

    // приветка: меньше прошлого — ошибка с кодом new_link; новая ссылка — счёт с нуля
    const lower = await call('POST', `/api/welcome/${welcome}/fix`, { value: '40', onDate: '2026-10-20' });
    assert.equal(lower.status, 400);
    assert.equal(lower.body.code, 'new_link');
    assert.match(lower.body.error, /было 100/);
    const link = await call('POST', `/api/welcome/${welcome}/links`, { startedOn: '2026-10-20', label: 'вторая' });
    assert.equal(link.status, 200);
    assert.deepEqual((await call('POST', `/api/welcome/${welcome}/fix`, { value: '40', onDate: '2026-10-20' })).body, { fixId: 2, linkId: link.body.id, count: 40, amount: rub(200), total: 40 });
    const wl = (await call('GET', '/api/welcome')).body[0];
    assert.deepEqual(wl.links.map((l: any) => [l.total, l.fixes]), [[100, 1], [40, 1]]);
    assert.equal(wl.current.id, link.body.id);
    assert.deepEqual(Object.keys(wl.fixes[1]), ['id', 'linkId', 'onDate', 'total', 'count', 'amount', 'paid', 'advance', 'remaining', 'state']);

    const bad = await call('POST', '/api/people/merge', { from: ivan, into: ivan });
    assert.deepEqual(bad.body, { error: 'это один и тот же человек' }, 'без кода — только текст');
    const created = await call('POST', '/api/people', { contact: 'Анна (@anna_k)' });
    assert.equal((await call('PATCH', `/api/people/${created.body.id}`, { name: 'Анна К.' })).status, 200);
    assert.deepEqual((await call('GET', `/api/people/${created.body.id}`)).body, {
      personId: created.body.id, name: 'Анна К.', username: 'anna_k', owedToUs: 0, weOwe: 0, advanceIn: 0, advanceOut: 0, items: [], payments: [],
    });
    assert.equal((await call('POST', '/api/ad-deals/sale:9/person', { personId: created.body.id })).status, 200);
    assert.equal(listDeals(db).find((d) => d.ref === 'sale:9')!.personId, created.body.id);
  } finally {
    server.close();
  }
});

/**
 * Список людей — все известные, и те, с кем пока в расчёте. Страница берёт из
 * него подсказки в приветке и выбор «Объединить с»: заведённого вручную без
 * позиций там не было, и склеить с ним дубль было нельзя.
 */
test('человек без позиций — в списке, с нулями', () => {
  const db = openDb(':memory:');
  const id = createPerson(db, 'Новый (@new_guy)');
  const g = personDebts(db).find((p) => p.personId === id)!;
  assert.deepEqual([g.name, g.username, g.owedToUs, g.weOwe, g.items.length], ['Новый', 'new_guy', 0, 0, 0]);
});
