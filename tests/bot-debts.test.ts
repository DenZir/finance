/**
 * Долги по рекламе в боте: текст «Нам должны / Мы должны», напоминание раз в
 * день в 10:00 по Москве — и не второй раз после перезапуска.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db/index.js';
import { MICRO } from '../src/money.js';
import { setWaiting, syncDeals, type AdDealView, type AnalyticsDeal } from '../src/ads.js';
import { createBot } from '../src/bot/index.js';
import { BotApiError, botApi } from '../src/bot/api.js';
import { debtsText, lastReminderDay, reminderDue } from '../src/bot/debts.js';
import { readConfig } from '../src/config.js';
import { fakeTelegram, message, plain } from './fakes/telegram.js';

const rub = (n: number) => Math.round(n * MICRO);
const MSK = 3 * 3600_000;
/** ДД.10.2026, чч:мм по Москве → UTC мс */
const at = (day: number, h: number, min = 0) => Date.UTC(2026, 9, day, h, min) - MSK;

const view = (ref: string, over: Partial<AdDealView>): AdDealView => ({
  ref, kind: ref.startsWith('buy') ? 'buy' : 'sale', date: '2026-10-17', slot: 'evening', contact: '', channels: 'SATAN GAMES',
  amount: rub(1000), cancelled: false, state: 'waiting', opId: null, ...over,
});

test('текст долгов: группы, давние сверху, дни, сумма неизвестна; будущие и разобранные — нет', () => {
  const deals = [
    view('sale:3', { date: '2026-10-19', slot: 'n9', contact: 'Мария', amount: null }),
    view('sale:1', { date: '2026-10-17', slot: 'stories', contact: 'Иван (@ivan)', amount: rub(1500) }),
    view('sale:2', { date: '2026-10-18', contact: 'Пётр', amount: rub(800) }),
    view('sale:4', { date: '2026-10-20', contact: 'Будущий' }),
    view('sale:5', { contact: 'Отменили', cancelled: true }),
    view('sale:6', { contact: 'Бартер', state: 'barter' }),
    view('buy:1', { date: '2026-10-16', contact: 'Админ (@admin)', amount: rub(1200) }),
    view('buy:2', { contact: 'Не разобран', state: 'open' }),
    view('buy:3', { contact: 'Оплачен', state: 'paid', opId: 1 }),
  ];
  assert.equal(plain(debtsText(deals, '2026-10-19')!), [
    '💸 Нам должны 2 300 ₽ + ещё 1 без суммы',
    '• Иван (@ivan) — 1 500 ₽ · сторисы 17.10 · 2 дн.',
    '• Пётр — 800 ₽ · вечер 18.10 · 1 дн.',
    '• Мария — сумма ещё не известна · 9:00 19.10 · сегодня',
    '',
    '🧾 Мы должны 1 200 ₽',
    '• Админ (@admin) — 1 200 ₽ · вечер 16.10 · 3 дн.',
  ].join('\n'));

  assert.equal(
    plain(debtsText([view('buy:1', { contact: '', channels: 'MARIN GAMES', amount: null, slot: 'n17' })], '2026-10-17')!),
    '🧾 Мы должны сумма ещё не известна\n• MARIN GAMES — сумма ещё не известна · 17:00 17.10 · сегодня',
    'нет контакта — каналы; только закупы — без блока «Нам должны»'
  );
  assert.match(debtsText([view('sale:1', { contact: 'Ivan <b>&' })], '2026-10-19')!, /Ivan &lt;b&gt;&amp;/, 'контакт из аналитики экранирован');
  assert.equal(debtsText(deals.filter((d) => d.date > '2026-10-19' || d.state !== 'waiting' || d.cancelled), '2026-10-19'), null);
  assert.equal(debtsText([], '2026-10-19'), null);
});

test('пора ли напоминать: с 10:00 МСК, раз в сутки', () => {
  const day19 = at(19, 0);
  assert.equal(reminderDue(at(19, 9, 59), 10, null), false, 'до 10:00 — рано');
  assert.equal(reminderDue(at(19, 10), 10, null), true);
  assert.equal(reminderDue(at(19, 10), 10, at(18, 0)), true, 'вчера напоминали — сегодня снова');
  assert.equal(reminderDue(at(19, 10, 1), 10, day19), false, 'сегодня уже было');
  assert.equal(reminderDue(at(19, 23, 59), 10, day19), false);
  assert.equal(reminderDue(at(19, 15), 10, null), true, 'сервер поднялся после 10:00 и сегодня ещё не напоминал');
  assert.equal(reminderDue(at(20, 0, 30), 0, day19), true, 'час 0 — сразу после полуночи');
  assert.equal(at(19, 0), Date.UTC(2026, 9, 18, 21), 'полночь по Москве — 21:00 UTC накануне');
});

test('напоминание: в 10:00 — каждому владельцу с кнопкой, после перезапуска — не второй раз, назавтра — снова', async () => {
  const db = openDb(':memory:');
  const deal = (ref: string, over: Partial<AnalyticsDeal>): AnalyticsDeal => ({
    ref, kind: ref.startsWith('buy') ? 'buy' : 'sale', date: '2026-10-17', slot: 'stories', buyKind: 'post', status: 'done',
    amount: 1500, contact: 'Иван (@ivan)', channels: ['SATAN GAMES'], ...over,
  });
  await syncDeals(db, { fetchDeals: async () => [deal('sale:1', {}), deal('buy:1', { date: '2026-10-21', amount: 900 })], since: at(1, 0) }, at(19, 9));
  setWaiting(db, 'sale:1', true, at(19, 9));
  setWaiting(db, 'buy:1', true, at(19, 9));

  const tg = fakeTelegram();
  let now = at(19, 9, 59);
  const make = () => createBot({ db, api: tg.api, ownerIds: ['777000', '888000'], fetchRate: async () => null, publicUrl: 'https://dengi.routaterm.icu', now: () => now });
  let bot = make();

  assert.equal(await bot.remind(10), false, '09:59 — рано');
  now = at(19, 10);
  assert.equal(await bot.remind(10), true);
  assert.deepEqual(tg.calls.map((c) => c.params.chat_id), ['777000', '888000'], 'каждому владельцу');
  const sent = tg.calls[0]!;
  assert.equal(plain(sent.params.text), '💸 Нам должны 1 500 ₽\n• Иван (@ivan) — 1 500 ₽ · сторисы 17.10 · 2 дн.', 'закуп на 21.10 ещё не долг');
  assert.deepEqual(sent.params.reply_markup, { inline_keyboard: [[{ text: 'Открыть «Деньги»', url: 'https://dengi.routaterm.icu' }]] });
  assert.equal(lastReminderDay(db), at(19, 0), 'день — полночь по Москве, в import_state');

  now = at(19, 10, 1);
  assert.equal(await bot.remind(10), false);
  bot = make(); // перезапуск
  now = at(19, 11);
  assert.equal(await bot.remind(10), false, 'после перезапуска в тот же день — не второй раз');
  assert.equal(tg.calls.length, 2);

  now = at(20, 10);
  assert.equal(await bot.remind(10), true, 'назавтра — снова');
  assert.equal(tg.calls.length, 4);

  // долгов нет — ничего не шлём, но день отмечен: сделка, отмеченная днём, не
  // даст второго напоминания в тот же день
  setWaiting(db, 'sale:1', false, at(21, 9));
  setWaiting(db, 'buy:1', false, at(21, 9)); // 21.10 закуп вышел бы и стал долгом
  now = at(21, 10);
  assert.equal(await bot.remind(10), false);
  setWaiting(db, 'sale:1', true, at(21, 15));
  now = at(21, 15, 1);
  assert.equal(await bot.remind(10), false);
  assert.equal(tg.calls.length, 4);
});

test('напоминание не роняет сервер, если владелец не нажимал /start', async (t) => {
  const db = openDb(':memory:');
  await syncDeals(db, { fetchDeals: async () => [{ ref: 'sale:1', kind: 'sale', date: '2026-10-17', slot: 'day', buyKind: 'post', status: 'done', amount: 500, contact: 'Иван', channels: [] }], since: at(1, 0) }, at(19, 9));
  setWaiting(db, 'sale:1', true, at(19, 9));
  const warns: string[] = [];
  t.mock.method(console, 'warn', (...a: unknown[]) => warns.push(a.join(' ')));
  const api = botApi(async () => {
    throw new BotApiError('sendMessage', 400, 'Bad Request: chat not found');
  });
  const bot = createBot({ db, api, ownerIds: ['777000'], fetchRate: async () => null, now: () => at(19, 10) });
  assert.equal(await bot.remind(10), true);
  assert.equal(warns.length, 1);
  assert.match(warns[0]!, /не ушло 777000.*нажмите \/start/);
});

test('/debts — те же долги по запросу; пусто — «никто никому не должен»', async () => {
  const db = openDb(':memory:');
  const tg = fakeTelegram();
  const bot = createBot({ db, api: tg.api, ownerIds: ['777000'], fetchRate: async () => null, publicUrl: 'https://dengi.routaterm.icu', now: () => at(19, 12) });
  await bot.handleUpdate(message(777000, '/debts'));
  assert.equal(tg.calls.at(-1)!.params.text, 'Никто никому не должен.');
  await syncDeals(db, { fetchDeals: async () => [{ ref: 'buy:4', kind: 'buy', date: '2026-10-16', slot: 'evening', buyKind: 'post', status: 'done', amount: 1200, contact: 'Админ (@admin)', channels: [] }], since: at(1, 0) }, at(19, 9));
  setWaiting(db, 'buy:4', true, at(19, 9));
  await bot.handleUpdate(message(777000, '/debts'));
  const c = tg.calls.at(-1)!;
  assert.equal(plain(c.params.text), '🧾 Мы должны 1 200 ₽\n• Админ (@admin) — 1 200 ₽ · вечер 16.10 · 3 дн.');
  assert.equal(c.params.reply_markup.inline_keyboard[0][0].url, 'https://dengi.routaterm.icu');
});

test('REMINDER_HOUR и PUBLIC_URL: по умолчанию 10:00 и без кнопки; off, час, https', () => {
  const env = { BOT_TOKEN: '123456789:AAFakeTokenForTestsOnly_abcdefghijk', BOT_USERNAME: 'fin_test_bot', OWNER_TG_IDS: '777000' };
  assert.equal(readConfig(env).reminderHour, 10);
  assert.equal(readConfig(env).publicUrl, null);
  assert.equal(readConfig({ ...env, REMINDER_HOUR: 'off' }).reminderHour, null);
  assert.equal(readConfig({ ...env, REMINDER_HOUR: '9' }).reminderHour, 9);
  assert.equal(readConfig({ ...env, REMINDER_HOUR: '0' }).reminderHour, 0, '0 — полночь, а не «выключено»');
  for (const bad of ['24', '-1', '10:00', 'утром']) assert.throws(() => readConfig({ ...env, REMINDER_HOUR: bad }), /REMINDER_HOUR/, bad);
  assert.equal(readConfig({ ...env, PUBLIC_URL: 'https://dengi.routaterm.icu/' }).publicUrl, 'https://dengi.routaterm.icu');
  for (const bad of ['http://dengi.routaterm.icu', 'dengi.routaterm.icu', 'https://']) assert.throws(() => readConfig({ ...env, PUBLIC_URL: bad }), /PUBLIC_URL/, bad);
});
