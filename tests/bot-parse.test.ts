/**
 * Строка быстрой записи: сумма, валюта, доход или расход, заметка — и по ней
 * вид, проект и кошелёк. Ошибка здесь — запись не на тот кошелёк или не в ту
 * валюту, поэтому разобраны все формы, которыми владелец пишет суммы.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MICRO } from '../src/money.js';
import { guessCategory, parseQuick, projectOf } from '../src/bot/parse.js';
import { pickWallet } from '../src/bot/draft.js';
import type { Wallet } from '../src/ledger.js';

const m = (n: number) => Math.round(n * MICRO);

test('примеры владельца: вид, сумма, валюта и заметка', () => {
  assert.deepEqual(parseQuick('сервер 20 usdt'), { kind: 'expense', amount: m(20), currency: 'USDT', note: 'сервер' });
  assert.deepEqual(parseQuick('20$ хостинг'), { kind: 'expense', amount: m(20), currency: 'USDT', note: 'хостинг' });
  assert.deepEqual(parseQuick('хостинг 1 500 ₽'), { kind: 'expense', amount: m(1500), currency: 'RUB', note: 'хостинг' });
  assert.deepEqual(parseQuick('+1500 сторис'), { kind: 'income', amount: m(1500), currency: null, note: 'сторис' });
  assert.deepEqual(parseQuick('доход 300 приватка'), { kind: 'income', amount: m(300), currency: null, note: 'приватка' });
  assert.deepEqual(parseQuick('20,5 ton'), { kind: 'expense', amount: m(20.5), currency: 'TON', note: '' });
});

test('разряды пробелом и неразрывным пробелом, дробь запятой и точкой', () => {
  assert.equal(parseQuick('хостинг 1 500 ₽')?.amount, m(1500), 'неразрывный пробел — так копируются суммы из банка');
  assert.equal(parseQuick('домен 1 500,50 руб')?.amount, m(1500.5));
  assert.equal(parseQuick('10 000 сервер')?.amount, m(10_000));
  assert.equal(parseQuick('0.001 btc')?.amount, m(0.001));
  assert.equal(parseQuick('20,5 ton')?.amount, m(20.5));
  // «2 сервера» — не «2 тысячи с чем-то»: пробел разрядов только между тройками
  assert.deepEqual(parseQuick('2 сервера 40 usdt'), { kind: 'expense', amount: m(40), currency: 'USDT', note: '2 сервера' });
  // чисел несколько — сумма та, что с валютой
  assert.deepEqual(parseQuick('домен на 2 года 15 usdt'), { kind: 'expense', amount: m(15), currency: 'USDT', note: 'домен на 2 года' });
});

test('валюта: слова, знаки, регистр; «рубашка» и «tonight» — не валюта', () => {
  const cur = (s: string) => parseQuick(s)?.currency;
  for (const s of ['20 ₽', '20₽', '20 р', '20р', '20 р.', '20 руб', '20 руб.', '20 рублей', '20 рубля', '20 RUB']) assert.equal(cur(s), 'RUB', s);
  for (const s of ['20$', '$20', '$ 20', '20 usdt', '20 USDT', '20 usd', '20 долл', '20 долларов']) assert.equal(cur(s), 'USDT', s);
  assert.equal(cur('20 TON'), 'TON');
  assert.equal(cur('5 trx'), 'TRX');
  assert.equal(cur('0,01 Btc'), 'BTC');
  assert.equal(cur('eth 0,5'), 'ETH', 'валюта может стоять и отдельно от суммы');
  assert.equal(cur('usdt 20 сервер'), 'USDT');
  assert.deepEqual(parseQuick('20 рублей за рубашку'), { kind: 'expense', amount: m(20), currency: 'RUB', note: 'за рубашку' });
  assert.deepEqual(parseQuick('20 tonight'), { kind: 'expense', amount: m(20), currency: null, note: 'tonight' });
  assert.equal(cur('сервер 20'), null, 'не названа — валюта кошелька');
});

test('доход: «+», «доход», «пришло», «получил»; иначе расход', () => {
  assert.equal(parseQuick('+ 300 приватка')?.kind, 'income');
  assert.deepEqual(parseQuick('пришло 500 ₽ за пост'), { kind: 'income', amount: m(500), currency: 'RUB', note: 'за пост' });
  assert.deepEqual(parseQuick('Получил 1000 рефералка'), { kind: 'income', amount: m(1000), currency: null, note: 'рефералка' });
  assert.deepEqual(parseQuick('-20 сервер'), { kind: 'expense', amount: m(20), currency: null, note: 'сервер' });
  assert.deepEqual(parseQuick('расход 20 usdt vps'), { kind: 'expense', amount: m(20), currency: 'USDT', note: 'vps' });
});

test('без суммы — null: бот ответит подсказкой, а не запишет мусор', () => {
  for (const s of ['привет', '', '   ', 'сервер usdt', 'cx22', '0 usdt', '1,2345678 ton', '99999999999999 ₽']) assert.equal(parseQuick(s), null, JSON.stringify(s));
  assert.equal(parseQuick('cx22 сервер 10')?.amount, m(10), 'цифры внутри слова — не сумма');
});

test('вид и проект по словам заметки', () => {
  const g = (kind: 'income' | 'expense', note: string) => guessCategory(kind, note);
  for (const w of ['сервер', 'Хостинг', 'VPS', 'впн', 'vpn сервис', 'домен', 'прокси']) {
    assert.deepEqual(g('expense', w), { category: 'VPN — серверы и сервисы', project: 'VPN' }, w);
  }
  for (const w of ['подписка', 'сервисы', 'Claude', 'chatgpt plus']) assert.deepEqual(g('expense', w), { category: 'Сервисы и подписки', project: null }, w);
  for (const w of ['закуп', 'реклама у Ивана']) assert.deepEqual(g('expense', w), { category: 'Закуп рекламы', project: 'Реклама' }, w);
  assert.deepEqual(g('expense', 'кофе'), { category: 'Прочее', project: null });

  assert.deepEqual(g('income', 'сторис'), { category: 'Реклама — сторисы', project: 'Реклама' });
  assert.deepEqual(g('income', 'пост'), { category: 'Реклама — посты', project: 'Реклама' });
  assert.deepEqual(g('income', 'реклама'), { category: 'Реклама — посты', project: 'Реклама' });
  assert.deepEqual(g('income', 'приветка'), { category: 'Заявки с приветки', project: null });
  assert.deepEqual(g('income', 'заявки'), { category: 'Заявки с приветки', project: null });
  assert.deepEqual(g('income', 'партнёрка'), { category: 'Партнёрская программа', project: null });
  assert.deepEqual(g('income', 'рефералка'), { category: 'Партнёрская программа', project: null });
  assert.deepEqual(g('income', 'приватка'), { category: 'Приватка', project: 'Приватка MARIN' });
  assert.deepEqual(g('income', 'vpn'), { category: 'VPN', project: 'VPN' });
  assert.deepEqual(g('income', ''), { category: 'Прочее', project: null });

  assert.equal(projectOf('expense', 'Закуп рекламы'), 'Реклама');
  assert.equal(projectOf('income', 'Реклама — сторисы'), 'Реклама');
  assert.equal(projectOf('expense', 'Прочее'), null);
});

test('кошелёк: USDT и без валюты — CryptoBot; рубли — первый рублёвый; архивные не в счёт', () => {
  const w = (id: number, name: string, currency: string, archived = false, role: string | null = null): Wallet => ({ id, name, currency, kind: 'provider', feePct: 0, archived, role });
  const wallets = [w(9, 'CryptoBot VPN', 'USDT', false, 'vpn:cryptobot'), w(1, 'Platega', 'RUB'), w(2, 'Tonkeeper', 'USDT'), w(3, 'CryptoBot', 'USDT'), w(4, 'Tonkeeper TON', 'TON'), w(5, 'Старый', 'TRX', true)];
  assert.equal(pickWallet(wallets, 'USDT')?.name, 'CryptoBot', 'USDT — на CryptoBot, даже если он не первый; кабинет VPN сам не выбирается');
  assert.equal(pickWallet(wallets, null)?.name, 'CryptoBot');
  assert.equal(pickWallet(wallets, 'RUB')?.name, 'Platega');
  assert.equal(pickWallet(wallets, 'TON')?.name, 'Tonkeeper TON');
  assert.equal(pickWallet(wallets, 'TRX')?.name, 'CryptoBot', 'кошелька в валюте нет (архивный не в счёт) — CryptoBot, сумма пересчитается');
  const noCryptobot = wallets.filter((x) => x.name !== 'CryptoBot');
  assert.equal(pickWallet(noCryptobot, 'USDT')?.name, 'Tonkeeper');
  assert.equal(pickWallet(noCryptobot, null)?.name, 'Platega', 'без CryptoBot — первый кошелёк');
  assert.equal(pickWallet([], null), null);
});
