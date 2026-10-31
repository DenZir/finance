/**
 * Долги в боте: текст «Нам должны / Мы должны» по людям (реклама и приветка),
 * напоминание раз в день в 10:00 по Москве — и не второй раз после перезапуска.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db/index.js';
import { MICRO } from '../src/money.js';
import { setWaiting, syncDeals, type AdDealView, type AnalyticsDeal } from '../src/ads.js';
import type { DebtItem, PersonDebts } from '../src/debts.js';
import { createWelcome, fixWelcome } from '../src/welcome.js';
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
  amount: null, cancelled: false, state: 'waiting', opId: null, paid: 0, remaining: 0, personId: null, closed: false, ...over,
});

const item = (ref: string, over: Partial<DebtItem>): DebtItem => ({
  ref, personId: null, dir: ref.startsWith('buy') ? 'out' : 'in', source: ref.startsWith('fix') ? 'welcome' : 'ads', date: '2026-10-17',
  what: 'сторисы · SATAN GAMES', categoryId: null, projectId: null, amount: rub(1000), paid: 0, advance: 0, remaining: rub(1000), state: 'open', ...over,
});

const person = (personId: number | null, name: string, username: string | null, items: DebtItem[], over: Partial<PersonDebts> = {}): PersonDebts => {
  const own = items.map((i) => ({ ...i, personId }));
  const sum = (dir: 'in' | 'out') => own.filter((i) => i.dir === dir).reduce((s, i) => s + i.remaining, 0);
  return { personId, name, username, owedToUs: sum('in'), weOwe: sum('out'), advanceIn: 0, advanceOut: 0, items: own, payments: [], ...over };
};

/**
 * Владелец, 2026-10-31: долги — по человеку, а не по сделке. У Ивана продажа
 * рекламы и фиксация приветки — одна строка «Иван — сумма» и позиции под ней;
 * частично оплаченная — остатком и «оплачено X из Y»; давние долги — выше.
 */
test('текст долгов: по людям, позиции из обоих источников, остатки, давние сверху', () => {
  const people = [
    person(1, 'Иван', 'ivan', [
      item('sale:1', { date: '2026-10-17', amount: rub(1500), remaining: rub(1500) }),
      item('fix:2', { date: '2026-10-18', what: 'приветка · 240 заявок', amount: rub(1700), paid: rub(1000), remaining: rub(700), state: 'partial' }),
      item('sale:8', { date: '2026-10-10', amount: rub(500), paid: rub(500), remaining: 0, state: 'paid' }),
    ]),
    person(2, 'Пётр', null, [item('sale:3', { date: '2026-10-16', what: 'пост вечер · MARIN', amount: rub(800), remaining: rub(800) })]),
    person(4, 'Админ', 'admin', [item('buy:1', { date: '2026-10-16', what: 'пост вечер · SATAN GAMES', amount: rub(1200), remaining: rub(1200) })]),
    person(null, 'без контакта', null, [item('sale:4', { date: '2026-10-18', what: 'пост день · CHANNEL', amount: rub(300), remaining: rub(300) })]),
  ];
  // CPM без суммы — не позиция долга, но и не теряется: под контактом из аналитики
  const deals = [
    view('sale:5', { date: '2026-10-19', slot: 'n9', channels: 'MARIN GAMES', contact: 'Мария', personId: 3 }),
    view('sale:6', { contact: 'С суммой', amount: rub(900) }), // уже есть в people позицией
    view('sale:7', { contact: 'Отменили', cancelled: true }),
    view('buy:2', { contact: 'Не разобран', state: 'open' }),
  ];
  assert.equal(plain(debtsText(people, '2026-10-19', deals)!), [
    '💸 Нам должны 3 300 ₽ + ещё 1 без суммы',
    '• Пётр — 800 ₽',
    '  – пост вечер · MARIN · 16.10 · 800 ₽ · 3 дн.',
    '• Иван (@ivan) — 2 200 ₽',
    '  – сторисы · SATAN GAMES · 17.10 · 1 500 ₽ · 2 дн.',
    '  – приветка · 240 заявок · 18.10 · 700 ₽, оплачено 1 000 из 1 700 ₽ · 1 дн.',
    '• без контакта — 300 ₽',
    '  – пост день · CHANNEL · 18.10 · 300 ₽ · 1 дн.',
    '• Мария — сумма ещё не известна',
    '  – пост 9:00 · MARIN GAMES · 19.10 · сумма ещё не известна · сегодня',
    '',
    '🧾 Мы должны 1 200 ₽',
    '• Админ (@admin) — 1 200 ₽',
    '  – пост вечер · SATAN GAMES · 16.10 · 1 200 ₽ · 3 дн.',
  ].join('\n'));

  assert.match(
    debtsText([person(1, 'Ivan <b>&', null, [item('sale:1', { what: 'пост · <i>' })])], '2026-10-19')!,
    /Ivan &lt;b&gt;&amp; [\s\S]*пост · &lt;i&gt;/,
    'имя и каналы из аналитики экранированы: parse_mode HTML'
  );
  assert.equal(debtsText([], '2026-10-19'), null);
});

/**
 * Напоминание — о том, что уже долг: реклама, которая ещё не вышла, — пока не
 * долг, хотя в personDebts она уже позиция. Её нет ни в строке, ни в сумме
 * человека, ни во взаимозачёте.
 */
test('текст долгов: будущие позиции не в счёт — ни в сумме человека, ни во взаимозачёте', () => {
  const people = [
    person(1, 'Иван', 'ivan', [
      item('sale:1', { date: '2026-10-17', amount: rub(1500), remaining: rub(1500) }),
      item('sale:2', { date: '2026-10-25', amount: rub(900), remaining: rub(900) }),
      item('buy:3', { date: '2026-10-22', amount: rub(400), remaining: rub(400) }),
    ]),
  ];
  assert.equal(plain(debtsText(people, '2026-10-19')!), '💸 Нам должны 1 500 ₽\n• Иван (@ivan) — 1 500 ₽\n  – сторисы · SATAN GAMES · 17.10 · 1 500 ₽ · 2 дн.');
  assert.equal(debtsText(people, '2026-10-16'), null, 'ничего ещё не наступило — напоминать не о чем');
  assert.equal(
    debtsText([], '2026-10-19', [view('sale:5', { date: '2026-10-20', contact: 'Мария' })]),
    null,
    'CPM на завтра — тоже ещё не долг'
  );
});

/**
 * Аванс и взаимозачёт — то, что владелец делает на странице, но узнать о них
 * должен из напоминания: «у Олега наш аванс» и «с Иваном можно закрыть
 * встречные долги без денег».
 */
test('текст долгов: аванс, взаимозачёт по встречным долгам, CPM у своего человека', () => {
  const people = [
    person(1, 'Иван', 'ivan', [
      item('sale:1', { date: '2026-10-15', amount: rub(1500), remaining: rub(1500) }),
      item('buy:2', { date: '2026-10-16', what: 'пост утро · IVAN CH', amount: rub(500), remaining: rub(500) }),
    ]),
    person(2, 'Олег', null, [item('buy:4', { date: '2026-10-17', what: 'пост ночь · OLEG', amount: rub(700), remaining: rub(700) })], { advanceIn: rub(300) }),
    person(3, 'Сергей', null, [item('sale:6', { date: '2026-10-18', amount: rub(250), remaining: rub(250) })], { advanceOut: rub(100) }),
  ];
  const deals = [view('buy:9', { date: '2026-10-18', slot: 'stories', channels: 'OLEG', contact: 'Олег', personId: 2 })];
  assert.equal(plain(debtsText(people, '2026-10-19', deals)!), [
    '💸 Нам должны 1 750 ₽',
    '• Иван (@ivan) — 1 500 ₽ · можно взаимозачёт на 500 ₽',
    '  – сторисы · SATAN GAMES · 15.10 · 1 500 ₽ · 4 дн.',
    '• Сергей — 250 ₽ · наш аванс 100 ₽',
    '  – сторисы · SATAN GAMES · 18.10 · 250 ₽ · 1 дн.',
    '',
    '🧾 Мы должны 1 200 ₽ + ещё 1 без суммы',
    '• Иван (@ivan) — 500 ₽ · можно взаимозачёт на 500 ₽',
    '  – пост утро · IVAN CH · 16.10 · 500 ₽ · 3 дн.',
    '• Олег — 700 ₽ + 1 без суммы · его аванс 300 ₽',
    '  – пост ночь · OLEG · 17.10 · 700 ₽ · 2 дн.',
    '  – сторисы · OLEG · 18.10 · сумма ещё не известна · 1 дн.',
  ].join('\n'));

  // без контакта платить можно, только указав человека: взаимозачёта у такой группы нет
  const orphans = person(null, 'без контакта', null, [item('sale:1', { remaining: rub(100), amount: rub(100) }), item('buy:2', { remaining: rub(100), amount: rub(100) })]);
  assert.doesNotMatch(debtsText([orphans], '2026-10-19')!, /взаимозачёт/);
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
  assert.equal(plain(sent.params.text), '💸 Нам должны 1 500 ₽\n• Иван (@ivan) — 1 500 ₽\n  – сторисы · SATAN GAMES · 17.10 · 1 500 ₽ · 2 дн.', 'закуп на 21.10 ещё не долг');
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
  assert.equal(plain(c.params.text), '🧾 Мы должны 1 200 ₽\n• Админ (@admin) — 1 200 ₽\n  – пост вечер · 16.10 · 1 200 ₽ · 3 дн.');
  assert.equal(c.params.reply_markup.inline_keyboard[0][0].url, 'https://dengi.routaterm.icu');

  // Тот же человек в приветке — тот же человек в долгах: фиксация встаёт под
  // его строку рядом с закупом, и бот подсказывает взаимозачёт.
  const w = createWelcome(db, { contact: '@admin', price: '5', startedOn: '2026-10-01' }, at(19, 9));
  fixWelcome(db, w, { total: 100, onDate: '2026-10-18' }, at(19, 9));
  await bot.handleUpdate(message(777000, '/debts'));
  assert.equal(plain(tg.calls.at(-1)!.params.text), [
    '💸 Нам должны 500 ₽',
    '• Админ (@admin) — 500 ₽ · можно взаимозачёт на 500 ₽',
    '  – приветка · 100 заявок · 18.10 · 500 ₽ · 1 дн.',
    '',
    '🧾 Мы должны 1 200 ₽',
    '• Админ (@admin) — 1 200 ₽ · можно взаимозачёт на 500 ₽',
    '  – пост вечер · 16.10 · 1 200 ₽ · 3 дн.',
  ].join('\n'));
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
