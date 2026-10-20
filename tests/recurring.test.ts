/**
 * Регулярные расходы: состояние месяца, запись и пропуск, день в коротком
 * месяце, черновик в боте в свой день — один раз; правка суммы ответом.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db/index.js';
import { MICRO } from '../src/money.js';
import { balances, categoryIdByCode, deleteOperation, listWallets, partnerDebts, projectIdByCode } from '../src/ledger.js';
import { createRecurring, dueDateOf, dueForNotice, listRecurring, markNoticed, payRecurring, skipRecurring, updateRecurring } from '../src/recurring.js';
import { createBot } from '../src/bot/index.js';
import { fakeTelegram } from './fakes/telegram.js';

const usd = (n: number) => Math.round(n * MICRO);

test('регулярные: месяц, запись, пропуск', () => {
  const db = openDb(':memory:');
  const cb = listWallets(db).find((w) => w.name === 'CryptoBot')!.id;
  assert.throws(() => createRecurring(db, { name: '', walletId: cb, amount: '20', day: 5 }), /что за расход/);
  assert.throws(() => createRecurring(db, { name: 'Сервер', walletId: cb, amount: '20', day: 32 }), /от 1 до 31/);
  const srv = createRecurring(db, { name: 'Сервер Aeza', walletId: cb, amount: '20', day: 5, categoryId: categoryIdByCode(db, 'vpn_infra'), projectId: projectIdByCode(db, 'vpn') });
  const gpt = createRecurring(db, { name: 'ChatGPT', walletId: cb, amount: '20', currency: 'usd', day: 31 });

  assert.equal(dueDateOf(31, '2026-11'), '2026-11-30', 'в коротком месяце — последний день');
  assert.equal(dueDateOf(31, '2026-02'), '2026-02-28');
  let list = listRecurring(db, '2026-10', '2026-10-20');
  assert.deepEqual(list.map((r) => [r.name, r.currency, r.state, r.dueDate]), [['Сервер Aeza', 'USDT', 'due', '2026-10-05'], ['ChatGPT', 'USD', 'upcoming', '2026-10-31']]);

  // запись: расход проекта VPN — половина в долг партнёру со знаком минус
  const op = payRecurring(db, srv, '2026-10', { walletId: cb, amount: usd(20), rate: 90, at: Date.UTC(2026, 9, 5, 9) });
  assert.throws(() => payRecurring(db, srv, '2026-10', { walletId: cb, amount: usd(20), rate: 90, at: 1 }), /уже записан/);
  assert.throws(() => skipRecurring(db, srv, '2026-10', true), /уже записан/);
  assert.equal(balances(db).get(cb), -usd(20));
  assert.equal(partnerDebts(db)[0]!.owed, -usd(20) * 90 / 2);
  list = listRecurring(db, '2026-10', '2026-10-20');
  assert.equal(list[0]!.state, 'paid');

  // удалили операцию — месяц снова ждёт
  deleteOperation(db, op);
  assert.equal(listRecurring(db, '2026-10', '2026-10-20')[0]!.state, 'due');

  skipRecurring(db, srv, '2026-10', true);
  assert.equal(listRecurring(db, '2026-10', '2026-10-20')[0]!.state, 'skipped');
  skipRecurring(db, srv, '2026-10', false);

  // черновик — включённым, чей день настал, один раз в месяц
  assert.deepEqual(dueForNotice(db, '2026-10-20').map((r) => r.id), [srv]);
  markNoticed(db, srv, '2026-10');
  assert.deepEqual(dueForNotice(db, '2026-10-20'), []);
  assert.deepEqual(dueForNotice(db, '2026-11-05').map((r) => r.id), [srv], 'в новом месяце — снова');
  updateRecurring(db, gpt, { active: false });
  assert.deepEqual(dueForNotice(db, '2026-11-30').map((r) => r.id), [srv], 'выключенный не присылается');
});

test('регулярные в боте: черновик в свой день, правка суммы ответом, запись и пропуск', async () => {
  const db = openDb(':memory:');
  const OWNER = 111;
  let now = Date.UTC(2026, 9, 5, 6, 30); // 09:30 МСК
  const tg = fakeTelegram();
  const bot = createBot({ db, api: tg.api, ownerIds: [String(OWNER)], fetchRate: async (c) => ({ USDT: 90 } as Record<string, number>)[c] ?? null, now: () => now });
  const cb = listWallets(db).find((w) => w.name === 'CryptoBot')!.id;
  createRecurring(db, { name: 'Сервер Aeza', walletId: cb, amount: '20', day: 5, projectId: projectIdByCode(db, 'vpn') });
  const sends = () => tg.calls.filter((c) => c.method === 'sendMessage');

  assert.equal(await bot.recurring(10), 0, 'до 10:00 — рано');
  now = Date.UTC(2026, 9, 5, 7, 1); // 10:01 МСК
  assert.equal(await bot.recurring(10), 1);
  assert.equal(await bot.recurring(10), 0, 'второй раз не шлём');
  const draft = sends().at(-1)!;
  assert.match(String(draft.params.text), /Регулярный расход[\s\S]*Расход · 20 USDT[\s\S]*Сервер Aeza/);
  const msgId = 100; // первое сообщение фейка
  const kb = JSON.stringify(draft.params.reply_markup);
  assert.match(kb, /Пропустить в этом месяце/);

  // ответ «22 usdt» на черновик — правит его сумму
  await bot.handleUpdate({ update_id: 1, message: { message_id: 50, date: 0, chat: { id: OWNER, type: 'private' }, from: { id: OWNER }, text: '22 usdt', reply_to_message: { message_id: msgId } } });
  const edit = tg.calls.filter((c) => c.method === 'editMessageText').at(-1)!;
  assert.equal(edit.params.message_id, msgId);
  assert.match(String(edit.params.text), /Расход · 22 USDT/);

  // «Записать»
  const okData = (JSON.parse(kb).inline_keyboard as { text: string; callback_data: string }[][]).flat().find((b) => b.text.startsWith('✅'))!.callback_data;
  await bot.handleUpdate({ update_id: 2, callback_query: { id: 'q1', from: { id: OWNER }, message: { message_id: msgId, date: 0, chat: { id: OWNER, type: 'private' } }, data: okData } });
  assert.equal(balances(db).get(cb), -usd(22));
  assert.equal(listRecurring(db, '2026-10', '2026-10-05')[0]!.state, 'paid');

  // /regular — список месяца
  await bot.handleUpdate({ update_id: 3, message: { message_id: 51, date: 0, chat: { id: OWNER, type: 'private' }, from: { id: OWNER }, text: '/regular' } });
  assert.match(String(sends().at(-1)!.params.text), /Сервер Aeza — 20 USDT · ✅ записан/);

  // следующий месяц — «Пропустить»
  now = Date.UTC(2026, 10, 5, 8);
  await bot.recurring(10);
  const kb2 = JSON.parse(JSON.stringify(sends().at(-1)!.params.reply_markup)).inline_keyboard as { text: string; callback_data: string }[][];
  const skip = kb2.flat().find((b) => b.text.startsWith('⏭'))!.callback_data;
  await bot.handleUpdate({ update_id: 4, callback_query: { id: 'q2', from: { id: OWNER }, message: { message_id: sends().length, date: 0, chat: { id: OWNER, type: 'private' } }, data: skip } });
  assert.equal(listRecurring(db, '2026-11', '2026-11-05')[0]!.state, 'skipped');
});
