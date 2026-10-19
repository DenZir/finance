/**
 * Учёт: комиссии, переводы, доля партнёра и итоги месяца — на числах владельца
 * (2026-10-19): Platega берёт 14 % с приёма, CryptoBot 3 %, вывод идёт через
 * Rapira, VPN — пополам с партнёром.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db/index.js';
import { MICRO, MoneyInputError, parseAmount } from '../src/money.js';
import {
  addAdjustment, addExpense, addIncome, addPayout, addTransfer, balances, createWallet, deleteOperation, listCategories,
  listOperations, listProjects, listWallets, monthRange, monthReport, partnerDebts,
} from '../src/ledger.js';

const rub = (n: number) => Math.round(n * MICRO);
const AT = Date.UTC(2026, 9, 19, 9); // 19.10, 12:00 МСК

function setup() {
  const db = openDb(':memory:');
  const wallet = (name: string) => listWallets(db).find((w) => w.name === name)!;
  const project = (name: string) => listProjects(db).find((p) => p.name === name)!;
  const category = (name: string) => listCategories(db).find((c) => c.name === name)!;
  return { db, wallet, project, category };
}

test('сумма из поля: пробелы разрядов, запятая, точка; мусор — понятный отказ', () => {
  assert.equal(parseAmount('10 000,50'), 10_000_500_000);
  assert.equal(parseAmount('9700'), 9_700_000_000);
  assert.equal(parseAmount('10.674028'), 10_674_028);
  assert.throws(() => parseAmount('-5'), MoneyInputError);
  assert.throws(() => parseAmount('0'), MoneyInputError);
  assert.throws(() => parseAmount('1,2345678'), MoneyInputError);
});

test('с самого начала: Platega 14 %, CryptoBot 3 %, проекты и виды доходов владельца', () => {
  const { wallet, project, category } = setup();
  assert.equal(wallet('Platega').feePct, 14);
  assert.equal(wallet('CryptoBot').feePct, 3);
  assert.equal(project('VPN').partnerPct, 50);
  for (const name of ['Приватка', 'Реклама — посты', 'Реклама — сторисы', 'Заявки с приветки', 'Партнёрская программа']) {
    assert.equal(category(name).kind, 'income', name);
  }
});

test('доход через Platega: на кошелёк — за вычетом 14 %, в отчёте — полная сумма и комиссия отдельно', () => {
  const { db, wallet, project, category } = setup();
  addIncome(db, { at: AT, walletId: wallet('Platega').id, amount: rub(299), rate: 1, projectId: project('Приватка MARIN').id, categoryId: category('Приватка').id });
  assert.equal(balances(db).get(wallet('Platega').id), rub(257.14));
  const r = monthReport(db, ...Object.values(monthRange('2026-10')) as [number, number]);
  assert.equal(r.totalIncome, rub(299));
  assert.equal(r.incomeFees, rub(41.86));
  assert.equal(r.net, rub(257.14));
});

/**
 * Вывод через Rapira: ставку Rapira владелец не знает, и не должен. Отправил
 * 10 000 ₽, пришло 100 USDT по 97 ₽ — 300 ₽ ушло на вывод, курс и наценку.
 */
test('вывод с Platega в CryptoBot: комиссия — разница между ушедшим и пришедшим', () => {
  const { db, wallet } = setup();
  const platega = wallet('Platega'), cryptobot = wallet('CryptoBot');
  addIncome(db, { at: AT, walletId: platega.id, amount: rub(20_000), feePct: 0, rate: 1 });
  addTransfer(db, { at: AT, fromWalletId: platega.id, amount: rub(10_000), fromRate: 1, toWalletId: cryptobot.id, toAmount: rub(100), toRate: 97 });
  const bal = balances(db);
  assert.equal(bal.get(platega.id), rub(10_000));
  assert.equal(bal.get(cryptobot.id), rub(100), '100 USDT — в валюте кошелька');
  const r = monthReport(db, ...Object.values(monthRange('2026-10')) as [number, number]);
  assert.equal(r.transferFees, rub(300));
  assert.equal(r.net, rub(20_000 - 300), 'перевод — не расход и не доход, только потеря на нём');
});

test('VPN пополам: партнёру — половина дохода за вычетом комиссии минус половина расходов, минус выплаченное', () => {
  const { db, wallet, project, category } = setup();
  const vpn = project('VPN').id;
  const cryptobot = wallet('CryptoBot');
  addIncome(db, { at: AT, walletId: wallet('Platega').id, amount: rub(5000), rate: 1, projectId: vpn, categoryId: category('VPN').id }); // 4300 после 14 %
  addExpense(db, { at: AT, walletId: cryptobot.id, amount: rub(20), rate: 97, projectId: vpn, categoryId: category('VPN — серверы и сервисы').id }); // 1940 ₽
  let debt = partnerDebts(db).find((d) => d.projectId === vpn)!;
  assert.equal(debt.owed, rub(2150 - 970));
  addPayout(db, { at: AT, walletId: wallet('Platega').id, amount: rub(1000), rate: 1, projectId: vpn });
  debt = partnerDebts(db).find((d) => d.projectId === vpn)!;
  assert.equal(debt.owed, rub(180));
  // выплата партнёру — его доля, а не расход владельца
  const r = monthReport(db, ...Object.values(monthRange('2026-10')) as [number, number]);
  assert.equal(r.totalExpense, rub(1940));
  assert.throws(() => addPayout(db, { at: AT, walletId: wallet('Platega').id, amount: rub(1), rate: 1, projectId: project('Реклама').id }), /нет партнёра/);
});

test('месяц — по Москве: 1-е число 00:30 МСК уже новый месяц', () => {
  const { from, to } = monthRange('2026-11');
  assert.equal(new Date(from).toISOString(), '2026-10-31T21:00:00.000Z');
  assert.equal(new Date(to).toISOString(), '2026-11-30T21:00:00.000Z');
  assert.throws(() => monthRange('2026-13'), MoneyInputError);
});

test('удалённая операция уносит свои проводки — баланс возвращается', () => {
  const { db, wallet } = setup();
  const id = addIncome(db, { at: AT, walletId: wallet('Platega').id, amount: rub(100), rate: 1 });
  assert.equal(listOperations(db, AT - 1, AT + 1).length, 1);
  assert.ok(deleteOperation(db, id));
  assert.equal(balances(db).get(wallet('Platega').id) ?? 0, 0);
});

test('свой кошелёк: валюта кодом, без названия — отказ; неверный вид дохода у расхода — отказ', () => {
  const { db, category, wallet } = setup();
  const id = createWallet(db, { name: 'Tonkeeper', currency: 'ton', kind: 'crypto' });
  assert.equal(listWallets(db).find((w) => w.id === id)!.currency, 'TON');
  assert.throws(() => createWallet(db, { name: ' ', currency: 'TON', kind: 'crypto' }), MoneyInputError);
  assert.throws(() => addExpense(db, { at: AT, walletId: wallet('Platega').id, amount: rub(1), rate: 1, categoryId: category('Приватка').id }), /вид дохода/);
  assert.equal(listOperations(db, 0, Date.now() * 2).length, 0, 'отказ не оставил полуоперации');
});

/**
 * «Остаток» — вписанный фактический баланс. Начальные остатки вносятся им, и в
 * доход месяца они не попадают: иначе 12 тысяч, лежавших на Platega до начала
 * учёта, выглядели бы выручкой.
 */
test('остаток ставит баланс на дату и не трогает отчёт', () => {
  const { db, wallet } = setup();
  const platega = wallet('Platega');
  addAdjustment(db, { at: AT, walletId: platega.id, balance: rub(12_340), rate: 1 });
  assert.equal(balances(db).get(platega.id), rub(12_340));
  const r = monthReport(db, ...Object.values(monthRange('2026-10')) as [number, number]);
  assert.equal(r.totalIncome, 0);
  assert.equal(r.net, 0);
  // сверка позже: насчитано больше, чем в кабинете, — поправка в минус
  addIncome(db, { at: AT + 1000, walletId: platega.id, amount: rub(1000), feePct: 0, rate: 1 });
  addAdjustment(db, { at: AT + 2000, walletId: platega.id, balance: rub(13_000), rate: 1 });
  assert.equal(balances(db).get(platega.id), rub(13_000));
  const ops = listOperations(db, AT - 1, AT + 3000);
  assert.equal(ops[0]!.kind, 'adjust');
  assert.equal(ops[0]!.entries[0]!.amount, rub(-340));
});

/**
 * Оплаты привата приходят импортом задним числом. Вписанный «на 19.10 было
 * 12 340 ₽» от этого не должен сдвинуться — пересчитывается поправка.
 */
test('операция задним числом не сдвигает вписанный остаток, а меняет поправку', () => {
  const { db, wallet } = setup();
  const platega = wallet('Platega');
  addAdjustment(db, { at: AT, walletId: platega.id, balance: rub(12_340), rate: 1 });
  addIncome(db, { at: AT - 3600_000, walletId: platega.id, amount: rub(1000), feePct: 0, rate: 1 }); // за час до сверки
  assert.equal(balances(db).get(platega.id), rub(12_340), 'на момент сверки — ровно вписанное');
  addIncome(db, { at: AT + 3600_000, walletId: platega.id, amount: rub(500), feePct: 0, rate: 1 }); // после сверки
  assert.equal(balances(db).get(platega.id), rub(12_840));
  // удалили поправку — баланс снова насчитанный
  const adj = listOperations(db, AT - 1, AT + 1).find((o) => o.kind === 'adjust')!;
  deleteOperation(db, adj.id);
  assert.equal(balances(db).get(platega.id), rub(1500));
});
