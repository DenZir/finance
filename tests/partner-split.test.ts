/**
 * Расходы VPN оплачивает то владелец, то партнёр, а разницу потом докидывают
 * (владелец, 2026-10-20). Долг партнёру = его доля дохода − его доля всех
 * расходов + что он оплатил сам − что ему докинули + что он докинул. Без
 * расходов партнёра расчёт выходил в чью-то пользу: на примере ниже партнёр
 * недополучал 1 500 ₽.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { migrate, openDb } from '../src/db/index.js';
import { MIGRATIONS } from '../src/db/migrations.js';
import { MICRO } from '../src/money.js';
import {
  addExpense, addIncome, addPartnerExpense, addPayin, addPayout, balances, categoryIdByCode, listOperations, listProjects,
  listWallets, monthRange, monthReport, partnerDebts, partnerSettlement, projectIdByCode,
} from '../src/ledger.js';
import { createRecurring, listRecurring, payRecurring, updateRecurring } from '../src/recurring.js';
import { createBot } from '../src/bot/index.js';
import { fakeTelegram } from './fakes/telegram.js';

const rub = (n: number) => Math.round(n * MICRO);
const AT = Date.UTC(2026, 9, 19, 9); // 19.10, 12:00 МСК
const OCT = Object.values(monthRange('2026-10')) as [number, number];

function setup() {
  const db = openDb(':memory:');
  const wallet = (name: string) => listWallets(db).find((w) => w.name === name)!;
  const vpn = projectIdByCode(db, 'vpn')!;
  const infra = categoryIdByCode(db, 'vpn_infra');
  const debt = () => partnerDebts(db).find((d) => d.projectId === vpn)!;
  return { db, wallet, vpn, infra, debt };
}

test('пример владельца: доход 20 000, он платил 2 000, партнёр 3 000 — партнёру 10 500, у обоих по 7 500', () => {
  const { db, wallet, vpn, infra, debt } = setup();
  const pl = wallet('Platega').id;
  addIncome(db, { at: AT, walletId: pl, amount: rub(20_000), rate: 1, feePct: 0, projectId: vpn, categoryId: categoryIdByCode(db, 'vpn') });
  addExpense(db, { at: AT, walletId: pl, amount: rub(2_000), rate: 1, projectId: vpn, categoryId: infra });
  const op = addPartnerExpense(db, { at: AT, amount: rub(3_000), currency: 'rub', rate: 1, projectId: vpn, categoryId: infra, note: 'сервер и домен' });

  const d = debt();
  assert.deepEqual([d.income, d.expenseOwner, d.expensePartner, d.incomeShare, d.expenseShare], [rub(20_000), rub(2_000), rub(3_000), rub(10_000), rub(2_500)]);
  assert.equal(d.owed, rub(10_500));
  // расход партнёра — не с кошелька владельца, но в расходах проекта и в «Чистыми»
  assert.equal(balances(db).get(pl), rub(18_000));
  const r = monthReport(db, ...OCT);
  assert.equal(r.totalExpense, rub(5_000));
  assert.equal(r.net, rub(15_000));
  const row = listOperations(db, ...OCT).find((o) => o.id === op)!;
  assert.deepEqual([row.kind, row.paidBy, row.paidAmount, row.paidCurrency, row.entries.length], ['expense', 'partner', rub(3_000), 'RUB', 0]);

  // владелец докинул — долг закрыт; у него 18 000 − 10 500 = 7 500, у партнёра 10 500 − 3 000 = 7 500
  addPayout(db, { at: AT, walletId: pl, amount: rub(10_500), rate: 1, projectId: vpn });
  assert.equal(debt().owed, 0);
  assert.equal(balances(db).get(pl), rub(7_500));
});

test('партнёр должен владельцу — «От партнёра»: деньги на кошелёк, долг закрыт, не доход', () => {
  const { db, wallet, vpn, infra, debt } = setup();
  const pl = wallet('Platega').id;
  addIncome(db, { at: AT, walletId: pl, amount: rub(1_000), rate: 1, feePct: 0, projectId: vpn });
  addExpense(db, { at: AT, walletId: pl, amount: rub(3_000), rate: 1, projectId: vpn, categoryId: infra });
  assert.equal(debt().owed, -rub(1_000), '500 доли дохода − 1 500 доли расхода');
  addPayin(db, { at: AT, walletId: pl, amount: rub(1_000), rate: 1, projectId: vpn, note: 'разница за октябрь' });
  assert.equal(debt().owed, 0);
  assert.equal(balances(db).get(pl), -rub(1_000));
  const r = monthReport(db, ...OCT);
  assert.equal(r.totalIncome, rub(1_000), 'поступление от партнёра — не доход');
  assert.throws(() => addPayin(db, { at: AT, walletId: pl, amount: rub(1), rate: 1, projectId: projectIdByCode(db, 'ads')! }), /нет партнёра/);
});

test('расход партнёра: в его валюте, в рублях по курсу; только в проекте с партнёром', () => {
  const { db, vpn, infra, debt } = setup();
  addPartnerExpense(db, { at: AT, amount: rub(20), currency: 'USD', rate: 90, projectId: vpn, categoryId: infra });
  assert.equal(debt().expensePartner, rub(1_800));
  assert.equal(debt().owed, rub(1_800 - 900), 'вернуть ему его расход за вычетом его половины');
  assert.throws(() => addPartnerExpense(db, { at: AT, amount: rub(1), currency: 'RUB', rate: 1, projectId: projectIdByCode(db, 'ads') }), /нет партнёра/);
  assert.throws(() => addPartnerExpense(db, { at: AT, amount: rub(1), currency: 'RUB', rate: 1, projectId: null }), /проект с партнёром/);
  assert.throws(() => addPartnerExpense(db, { at: AT, amount: rub(1), currency: 'рубли', rate: 1, projectId: vpn }), /валюта/);
});

test('расшифровка по месяцам: набежало за месяц и долг на его конец; операции расчёта', () => {
  const { db, wallet, vpn, infra } = setup();
  const pl = wallet('Platega').id;
  const sep = Date.UTC(2026, 8, 15, 9);
  addIncome(db, { at: sep, walletId: pl, amount: rub(10_000), rate: 1, feePct: 0, projectId: vpn });
  addPartnerExpense(db, { at: sep, amount: rub(1_000), currency: 'RUB', rate: 1, projectId: vpn, categoryId: infra });
  addPayout(db, { at: Date.UTC(2026, 8, 30, 9), walletId: pl, amount: rub(4_000), rate: 1, projectId: vpn });
  addIncome(db, { at: AT, walletId: pl, amount: rub(2_000), rate: 1, feePct: 0, projectId: vpn });
  const s = partnerSettlement(db, vpn);
  assert.deepEqual(s.months.map((m) => [m.month, m.accrued, m.owed]), [
    ['2026-09', rub(5_000 - 500 + 1_000), rub(5_500 - 4_000)],
    ['2026-10', rub(1_000), rub(2_500)],
  ]);
  assert.equal(s.owed, rub(2_500), 'итог месяцев сходится с общим долгом');
  assert.deepEqual(s.ops.map((o: any) => o.kind), ['payout', 'expense']);
});

test('миграция: регулярные пересобраны без потерь — пропуски, отметки, счётчик номеров', () => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  const at = MIGRATIONS.findIndex((m) => m.includes('CREATE TABLE recurring_tmp'));
  for (const m of MIGRATIONS.slice(0, at)) db.exec(m);
  db.pragma(`user_version = ${at}`);
  const w = listWallets(db)[0]!.id;
  const add = db.prepare('INSERT INTO recurring (name, amount, currency, wallet_id, day, created_at) VALUES (?, 1, ?, ?, 5, 1)');
  add.run('Сервер', 'USDT', w);
  add.run('Удалённый', 'RUB', w);
  db.prepare('DELETE FROM recurring WHERE id = 2').run();
  db.prepare("INSERT INTO recurring_skips (recurring_id, month, at) VALUES (1, '2026-09', 1)").run();
  db.prepare("INSERT INTO recurring_notices (recurring_id, month) VALUES (1, '2026-10')").run();
  migrate(db);
  assert.deepEqual(db.prepare('SELECT id, name, wallet_id AS w, paid_by AS p FROM recurring').all(), [{ id: 1, name: 'Сервер', w, p: null }]);
  assert.deepEqual(db.pragma('foreign_key_check'), []);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM recurring_skips').get() as { n: number }).n, 1);
  assert.equal(Number(add.run('Новый', 'RUB', w).lastInsertRowid), 3, 'номер удалённого не достаётся новому');
  assert.throws(() => db.prepare("INSERT INTO recurring_skips (recurring_id, month, at) VALUES (99, '2026-10', 1)").run(), /FOREIGN KEY/);
});

test('регулярный, который платит партнёр: без кошелька, только в проекте с партнёром; «Записать» — его расход', () => {
  const { db, vpn, infra, debt } = setup();
  assert.throws(() => createRecurring(db, { name: 'Домен', paidBy: 'partner', amount: '10', currency: 'USD', day: 3, projectId: projectIdByCode(db, 'ads') }), /проект с партнёром/);
  const id = createRecurring(db, { name: 'Сервер у партнёра', paidBy: 'partner', amount: '20', currency: 'usd', day: 3, projectId: vpn, categoryId: infra });
  const r = listRecurring(db, '2026-10', '2026-10-20').find((x) => x.id === id)!;
  assert.deepEqual([r.walletId, r.paidBy, r.currency, r.state], [null, 'partner', 'USD', 'due']);
  payRecurring(db, id, '2026-10', { walletId: null, amount: rub(20), rate: 90, at: AT });
  assert.equal(debt().expensePartner, rub(1_800));
  assert.equal(listRecurring(db, '2026-10', '2026-10-20').find((x) => x.id === id)!.state, 'paid');
  // снова плачу я — нужен кошелёк
  assert.throws(() => updateRecurring(db, id, { paidBy: 'me' }), /не заполнено: walletId/);
  updateRecurring(db, id, { paidBy: 'me', walletId: listWallets(db).find((w) => w.name === 'CryptoBot')!.id });
  assert.equal(listRecurring(db, '2026-10', '2026-10-20').find((x) => x.id === id)!.paidBy, null);
});

test('бот: черновик регулярного расхода партнёра — без кошелька и проекта, «Записать» — его расход', async () => {
  const { db, vpn, infra, debt } = setup();
  const OWNER = 111;
  const now = Date.UTC(2026, 9, 3, 7, 30); // 10:30 МСК
  const tg = fakeTelegram();
  const bot = createBot({ db, api: tg.api, ownerIds: [String(OWNER)], fetchRate: async (c) => ({ USD: 90 } as Record<string, number>)[c] ?? null, now: () => now });
  createRecurring(db, { name: 'Сервер у партнёра', paidBy: 'partner', amount: '20', currency: 'USD', day: 3, projectId: vpn, categoryId: infra });
  assert.equal(await bot.recurring(10), 1);
  const draft = tg.calls.filter((c) => c.method === 'sendMessage').at(-1)!;
  assert.match(String(draft.params.text), /20 USD ≈ 1[\s ]800 ₽[\s\S]*Кошелёк: платит партнёр/);
  const buttons = (JSON.parse(JSON.stringify(draft.params.reply_markup)).inline_keyboard as { text: string; callback_data: string }[][]).flat();
  assert.ok(!buttons.some((b) => b.text === 'Кошелёк' || b.text === 'Проект'), 'кошелька нет, проект задан в регулярном');
  await bot.handleUpdate({ update_id: 1, callback_query: { id: 'q1', from: { id: OWNER }, message: { message_id: 100, date: 0, chat: { id: OWNER, type: 'private' } }, data: buttons.find((b) => b.text.startsWith('✅'))!.callback_data } });
  assert.equal(debt().expensePartner, rub(1_800));
  assert.match(String(tg.calls.filter((c) => c.method === 'editMessageText').at(-1)!.params.text), /Записано[\s\S]*Кошелёк: платит партнёр/);
  assert.ok(listProjects(db).find((p) => p.id === vpn)!.partnerPct > 0);
});
