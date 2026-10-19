/**
 * Бот: строка → черновик → кнопки → запись в учёт → «Отменить». Bot API
 * подменён записывающей подделкой. Отвечает бот только владельцу в личке.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db/index.js';
import { MICRO } from '../src/money.js';
import { addExpense, addIncome, listCategories, listOperations, listProjects, listWallets } from '../src/ledger.js';
import { createBot } from '../src/bot/index.js';
import { BotApiError, botApi, httpBotCall, startPolling, type BotCall, type TgUpdate } from '../src/bot/api.js';
import { readConfig } from '../src/config.js';
import { button, buttons, fakeTelegram, message, plain, press, type Call } from './fakes/telegram.js';

const OWNER = 777000;
const T = Date.UTC(2026, 9, 19, 9); // 19.10, 12:00 МСК
const rub = (n: number) => Math.round(n * MICRO);
const rates: Record<string, number> = { USDT: 82 };

function setup() {
  const db = openDb(':memory:');
  const tg = fakeTelegram();
  let now = T;
  const bot = createBot({ db, api: tg.api, ownerIds: [String(OWNER)], fetchRate: async (c) => rates[c] ?? null, now: () => now });
  const last = (method: string): Call => {
    const c = tg.calls.filter((x) => x.method === method).at(-1);
    assert.ok(c, `не было ${method}`);
    return c;
  };
  return {
    db, tg, bot, last,
    setNow: (ms: number) => (now = ms),
    wallet: (name: string) => listWallets(db).find((w) => w.name === name)!.id,
    category: (kind: string, name: string) => listCategories(db).find((c) => c.kind === kind && c.name === name)!.id,
    project: (name: string) => listProjects(db).find((p) => p.name === name)!.id,
    ops: () => listOperations(db, 0, T + 10 * 86400_000),
  };
}

test('черновик → «Расход ⇄ Доход» → вид → вчера → «Записать» → «Отменить»', async () => {
  const s = setup();
  await s.bot.handleUpdate(message(OWNER, 'сервер 20 usdt'));
  const draft = s.last('sendMessage');
  assert.equal(draft.params.chat_id, OWNER);
  assert.equal(draft.params.parse_mode, 'HTML');
  assert.equal(plain(draft.params.text), [
    'Расход · 20 USDT ≈ 1 640 ₽',
    'Кошелёк: CryptoBot',
    'Вид: VPN — серверы и сервисы',
    'Проект: VPN',
    'Дата: 19.10, сегодня',
    'Заметка: сервер',
  ].join('\n'));
  for (const b of buttons(draft)) assert.ok(Buffer.byteLength(b.callback_data ?? '') <= 64, `callback_data «${b.callback_data}» длиннее 64 байт`);
  const msgId = 100;

  await s.bot.handleUpdate(press(OWNER, msgId, button(draft, 'Расход ⇄ Доход')));
  let edit = s.last('editMessageText');
  assert.equal(edit.params.message_id, msgId, 'выбор правит то же сообщение');
  assert.match(plain(edit.params.text), /^Доход · 20 USDT ≈ 1 640 ₽\n.*\nВид: Прочее\nПроект: —/);
  assert.equal(s.last('answerCallbackQuery').params.callback_query_id.startsWith('cq'), true, 'на каждое нажатие — ответ');

  // «Вид» → список видов дохода с «‹ Назад» → «Реклама — посты»: проект подставился сам
  await s.bot.handleUpdate(press(OWNER, msgId, button(edit, 'Вид')));
  edit = s.last('editMessageText');
  const labels = buttons(edit).map((b) => b.text);
  assert.ok(labels.includes('Реклама — посты') && labels.includes('✓ Прочее') && labels.includes('‹ Назад'), labels.join(', '));
  assert.ok(!labels.includes('Закуп рекламы'), 'у дохода — только виды дохода');
  await s.bot.handleUpdate(press(OWNER, msgId, button(edit, 'Реклама — посты')));
  edit = s.last('editMessageText');
  assert.match(plain(edit.params.text), /Вид: Реклама — посты\nПроект: Реклама/);

  await s.bot.handleUpdate(press(OWNER, msgId, button(edit, 'Вчера')));
  edit = s.last('editMessageText');
  assert.match(plain(edit.params.text), /Дата: 18\.10, вчера/);
  assert.ok(buttons(edit).some((b) => b.text === 'Сегодня'));

  await s.bot.handleUpdate(press(OWNER, msgId, button(edit, 'Записать')));
  const saved = s.last('editMessageText');
  assert.match(plain(saved.params.text), /^✅ Записано\nДоход · 20 USDT ≈ 1 640 ₽\nКошелёк: CryptoBot\nВид: Реклама — посты\nПроект: Реклама\nДата: 18\.10\nЗаметка: сервер$/);
  assert.equal(s.last('answerCallbackQuery').params.text, 'Записано');

  const [op] = s.ops();
  assert.ok(op);
  assert.equal(op.kind, 'income');
  assert.equal(op.source, 'bot');
  assert.equal(op.at, Date.UTC(2026, 9, 18, 9), 'вчера, полдень по Москве');
  assert.equal(op.categoryId, s.category('income', 'Реклама — посты'));
  assert.equal(op.projectId, s.project('Реклама'));
  assert.equal(op.grossRub, rub(1640));
  assert.equal(op.feeRub, 0, 'доход из бота — перевод, без комиссии CryptoBot');
  assert.deepEqual(op.entries, [{ walletId: s.wallet('CryptoBot'), amount: 20 * MICRO, rub: rub(1640) }]);
  assert.equal(op.note, 'сервер');

  // второе нажатие «Записать» не задваивает
  await s.bot.handleUpdate(press(OWNER, msgId, button(edit, 'Записать')));
  assert.equal(s.last('answerCallbackQuery').params.text, 'Уже записано');
  assert.equal(s.ops().length, 1);

  await s.bot.handleUpdate(press(OWNER, msgId, button(saved, 'Отменить')));
  assert.match(plain(s.last('editMessageText').params.text), /^↩️ Отменено — операция удалена\nДоход · 20 USDT/);
  assert.equal(s.ops().length, 0, '«Отменить» удалил операцию');
  await s.bot.handleUpdate(press(OWNER, msgId, button(saved, 'Отменить')));
  assert.equal(s.last('answerCallbackQuery').params.text, 'Операции уже нет');
});

test('«Отменить» не трогает операцию, записанную не ботом', async () => {
  const s = setup();
  const id = addExpense(s.db, { at: T, walletId: s.wallet('Platega'), amount: rub(100), rate: 1 });
  await s.bot.handleUpdate(press(OWNER, 100, `u:${id}`));
  assert.equal(s.last('answerCallbackQuery').params.show_alert, true);
  assert.equal(s.ops().length, 1);
  assert.equal(s.tg.calls.filter((c) => c.method === 'editMessageText').length, 0);
});

test('«1 500 ₽» на CryptoBot: пересчёт в USDT до центов, в отчёт — ровно 1 500 ₽', async () => {
  const s = setup();
  await s.bot.handleUpdate(message(OWNER, 'хостинг 1 500 ₽'));
  const draft = s.last('sendMessage');
  assert.match(plain(draft.params.text), /^Расход · 1 500 ₽\nКошелёк: Platega\n/, 'рубли — на рублёвый кошелёк');
  await s.bot.handleUpdate(press(OWNER, 100, button(draft, 'Кошелёк')));
  const list = s.last('editMessageText');
  assert.deepEqual(buttons(list).map((b) => b.text), ['✓ Platega · RUB', 'CryptoBot · USDT', '‹ Назад']);
  await s.bot.handleUpdate(press(OWNER, 100, button(list, 'CryptoBot')));
  const edit = s.last('editMessageText');
  assert.match(plain(edit.params.text), /^Расход · 1 500 ₽ ≈ 18,29 USDT\nКошелёк: CryptoBot\n/);
  await s.bot.handleUpdate(press(OWNER, 100, button(edit, 'Записать')));
  const [op] = s.ops();
  assert.ok(op);
  assert.equal(op.grossRub, rub(1500));
  assert.deepEqual(op.entries, [{ walletId: s.wallet('CryptoBot'), amount: -rub(18.29), rub: -rub(1500) }]);
  assert.equal(op.categoryId, s.category('expense', 'VPN — серверы и сервисы'));
  assert.equal(op.projectId, s.project('VPN'));
});

test('нет курса — черновик говорит об этом, «Записать» не пишет', async () => {
  const s = setup();
  await s.bot.handleUpdate(message(OWNER, '3 ton'));
  const draft = s.last('sendMessage');
  assert.match(plain(draft.params.text), /^Расход · 3 TON\nКошелёк: CryptoBot\n[\s\S]*⚠️ нет курса TON/);
  await s.bot.handleUpdate(press(OWNER, 100, button(draft, 'Записать')));
  assert.equal(s.last('answerCallbackQuery').params.show_alert, true);
  assert.equal(s.ops().length, 0);
});

test('устаревший черновик, «Отмена», мусор вместо суммы', async () => {
  const s = setup();
  await s.bot.handleUpdate(message(OWNER, '+300 приватка'));
  const draft = s.last('sendMessage');
  assert.match(plain(draft.params.text), /^Доход · 300 USDT ≈ 24 600 ₽\nКошелёк: CryptoBot\nВид: Приватка\nПроект: Приватка MARIN/);
  s.setNow(T + 25 * 3600_000);
  await s.bot.handleUpdate(press(OWNER, 100, button(draft, 'Записать')));
  assert.equal(s.last('answerCallbackQuery').params.text, 'Черновик устарел — пришлите заново');
  await s.bot.handleUpdate(press(OWNER, 100, 'q:deadbeef:ok'));
  assert.equal(s.last('answerCallbackQuery').params.text, 'Черновик устарел — пришлите заново', 'после перезапуска черновиков в памяти нет');

  await s.bot.handleUpdate(message(OWNER, '20 vps'));
  await s.bot.handleUpdate(press(OWNER, 101, button(s.last('sendMessage'), 'Отмена')));
  assert.equal(s.last('editMessageText').params.text, 'Отменено — ничего не записано.');
  assert.equal(s.last('editMessageText').params.reply_markup, undefined, 'кнопки сняты');
  assert.equal(s.ops().length, 0);

  await s.bot.handleUpdate(message(OWNER, `20 usdt ${'очень длинная заметка '.repeat(100)}`));
  assert.ok(s.last('sendMessage').params.text.length < 1000, 'заметка обрезана до 500 знаков — черновик влезает в сообщение');

  await s.bot.handleUpdate(message(OWNER, 'привет'));
  assert.match(s.last('sendMessage').params.text, /Не нашёл сумму/);
  await s.bot.handleUpdate(message(OWNER, '/start'));
  assert.match(s.last('sendMessage').params.text, /сервер 20 usdt[\s\S]*\+1500 сторис/);
});

test('чужим и в группах бот молчит', async () => {
  const s = setup();
  await s.bot.handleUpdate(message(42, 'сервер 20 usdt'));
  await s.bot.handleUpdate(message(42, '/balance'));
  await s.bot.handleUpdate(message(OWNER, 'сервер 20 usdt', 'group'));
  await s.bot.handleUpdate(press(42, 100, 'q:deadbeef:ok'));
  assert.deepEqual(s.tg.calls, []);
});

test('/balance: остатки в валюте и ≈ ₽, итоги, долг партнёру', async () => {
  const s = setup();
  addIncome(s.db, { at: T, walletId: s.wallet('Platega'), amount: rub(1000), feePct: 0, rate: 1 });
  addIncome(s.db, { at: T, walletId: s.wallet('CryptoBot'), amount: rub(10), feePct: 0, rate: 82, projectId: s.project('VPN') });
  await s.bot.handleUpdate(message(OWNER, '/balance@fin_test_bot'));
  assert.equal(plain(s.last('sendMessage').params.text), [
    'Остатки',
    'Platega — 1 000 ₽',
    'CryptoBot — 10 USDT ≈ 820 ₽',
    '',
    'На платёжках: 1 820 ₽',
    'На кошельках: 0 ₽',
    'Должен партнёру · VPN: 410 ₽',
  ].join('\n'));
});

test('опрос: 409 — одно предупреждение и пауза, а не цикл; потом апдейты идут дальше', async (t) => {
  const warns: string[] = [];
  t.mock.method(console, 'warn', (...a: unknown[]) => warns.push(a.join(' ')));
  t.mock.method(console, 'log', () => {});
  const conflict = () => new BotApiError('getUpdates', 409, 'Conflict: terminated by other getUpdates request');
  const script: (TgUpdate[] | Error)[] = [conflict(), conflict(), conflict(), [{ update_id: 7 }, { update_id: 8 }], new Error('fetch failed')];
  const offsets: number[] = [];
  const pauses: number[] = [];
  const handled: number[] = [];
  let poller: ReturnType<typeof startPolling> | null = null;
  const call: BotCall = async (method, params) => {
    assert.equal(method, 'getUpdates');
    offsets.push(params.offset as number);
    const next = script.shift();
    if (!next) {
      poller!.stop();
      return [];
    }
    if (next instanceof Error) throw next;
    return next;
  };
  poller = startPolling(botApi(call), async (u) => {
    handled.push(u.update_id);
    if (u.update_id === 7) throw new Error('сбой обработки');
  }, { sleep: async (ms) => void pauses.push(ms) });
  t.mock.method(console, 'error', () => {});
  await poller.done;
  assert.equal(warns.filter((w) => w.includes('409')).length, 1, '409 — предупреждение один раз');
  assert.deepEqual(pauses, [60_000, 60_000, 60_000, 5000], 'после 409 — пауза в минуту, после сбоя сети — 5 с');
  assert.deepEqual(handled, [7, 8], 'сбой одного апдейта не мешает следующему');
  assert.deepEqual(offsets, [0, 0, 0, 0, 9, 9], 'обработанные подтверждаются offset-ом');
});

test('HTTP-клиент: ошибка Telegram — код и описание, токена в сообщениях нет', async () => {
  const token = '123456789:AAFakeTokenForTestsOnly_abcdefghijk';
  const asked: string[] = [];
  const ok = httpBotCall(token, (async (url: string) => {
    asked.push(url);
    return new Response(JSON.stringify({ ok: true, result: { message_id: 5 } }));
  }) as typeof fetch);
  assert.deepEqual(await ok('sendMessage', { chat_id: 1, text: 'x' }), { message_id: 5 });
  assert.equal(asked[0], `https://api.telegram.org/bot${token}/sendMessage`);

  const conflict = httpBotCall(token, (async () =>
    new Response(JSON.stringify({ ok: false, error_code: 409, description: 'Conflict: can\'t use getUpdates method while webhook is active' }), { status: 409 })) as typeof fetch);
  await assert.rejects(conflict('getUpdates', {}), (err: unknown) => err instanceof BotApiError && err.code === 409 && /webhook/.test(err.description));

  const down = httpBotCall(token, (async (url: string) => {
    throw new Error(`connect ECONNREFUSED ${url}`);
  }) as typeof fetch);
  await assert.rejects(down('getUpdates', {}), (err: unknown) => err instanceof Error && !err.message.includes(token) && err.message.includes('***'));
});

test('BOT_POLLING: по умолчанию включён, 0/off — выключен, мусор — ошибка настройки', () => {
  const env = { BOT_TOKEN: '123456789:AAFakeTokenForTestsOnly_abcdefghijk', BOT_USERNAME: 'fin_test_bot', OWNER_TG_IDS: '777000' };
  assert.equal(readConfig(env).botPolling, true);
  assert.equal(readConfig({ ...env, BOT_POLLING: 'on' }).botPolling, true);
  assert.equal(readConfig({ ...env, BOT_POLLING: '0' }).botPolling, false);
  assert.equal(readConfig({ ...env, BOT_POLLING: 'OFF' }).botPolling, false);
  assert.throws(() => readConfig({ ...env, BOT_POLLING: 'maybe' }), /BOT_POLLING/);
});
