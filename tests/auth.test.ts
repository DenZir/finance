/**
 * Вход через Telegram и API: пускает только владельца с настоящей подписью,
 * чужим и без сессии — отказ.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { openDb } from '../src/db/index.js';
import { checkTelegramLogin, createSession, SESSION_COOKIE } from '../src/auth.js';
import { createApp } from '../src/server.js';

const TOKEN = '123456789:AAFakeTokenForTestsOnly_abcdefghijk';
const OWNER = '777000';
const NOW_S = 1_792_400_000;

function signed(data: Record<string, string | number>, token = TOKEN) {
  const line = Object.entries(data).map(([k, v]) => `${k}=${v}`).sort().join('\n');
  const hash = crypto.createHmac('sha256', crypto.createHash('sha256').update(token).digest()).update(line).digest('hex');
  return { ...data, hash };
}

test('подпись Telegram: владелец — да; чужой, подделка, старый вход — нет', () => {
  const ok = checkTelegramLogin(signed({ id: OWNER, first_name: 'Den', auth_date: NOW_S }), TOKEN, [OWNER], NOW_S);
  assert.deepEqual(ok, { ok: true, tgId: OWNER });
  assert.equal(checkTelegramLogin(signed({ id: '42', auth_date: NOW_S }), TOKEN, [OWNER], NOW_S).ok, false);
  assert.equal(checkTelegramLogin({ ...signed({ id: OWNER, auth_date: NOW_S }), first_name: 'X' }, TOKEN, [OWNER], NOW_S).ok, false);
  assert.equal(checkTelegramLogin(signed({ id: OWNER, auth_date: NOW_S }, '1:other_token_000000000000000000000'), TOKEN, [OWNER], NOW_S).ok, false);
  assert.equal(checkTelegramLogin(signed({ id: OWNER, auth_date: NOW_S - 2 * 86400 }), TOKEN, [OWNER], NOW_S).ok, false);
});

test('API: без сессии 401; вход ставит сессию; операции пишутся; ошибки ввода — 400 с текстом', async () => {
  const db = openDb(':memory:');
  const app = createApp({ db, config: { botToken: TOKEN, botUsername: 'fin_test_bot', ownerIds: [OWNER] }, fetchRate: async () => null, now: () => NOW_S * 1000 });
  const srv = app.listen(0);
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  try {
    assert.equal((await fetch(`${base}/api/state`)).status, 401);

    const q = new URLSearchParams(Object.entries(signed({ id: OWNER, auth_date: NOW_S })).map(([k, v]) => [k, String(v)]));
    const login = await fetch(`${base}/auth/telegram?${q}`, { redirect: 'manual' });
    assert.equal(login.status, 302);
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
    assert.match(cookie, new RegExp(`^${SESSION_COOKIE}=`));

    const api = (p: string, init: RequestInit = {}) => fetch(`${base}${p}`, { ...init, headers: { cookie, 'content-type': 'application/json', ...(init.headers ?? {}) } });
    const state = await (await api('/api/state')).json();
    const platega = state.wallets.find((w: any) => w.name === 'Platega');
    const cryptobot = state.wallets.find((w: any) => w.name === 'CryptoBot');

    const ok = await api('/api/operations', { method: 'POST', body: JSON.stringify({ kind: 'income', walletId: platega.id, amount: '1 000' }) });
    assert.equal(ok.status, 200);
    const bad = await api('/api/operations', { method: 'POST', body: JSON.stringify({ kind: 'income', walletId: platega.id, amount: 'много' }) });
    assert.equal(bad.status, 400);
    assert.match((await bad.json()).error, /не сумма/);
    // курса USDT нет нигде — просим вписать, а не считаем по нулю
    const noRate = await api('/api/operations', { method: 'POST', body: JSON.stringify({ kind: 'expense', walletId: cryptobot.id, amount: '5' }) });
    assert.equal(noRate.status, 400);
    assert.match((await noRate.json()).error, /нет курса USDT/);
    const withRate = await api('/api/operations', { method: 'POST', body: JSON.stringify({ kind: 'expense', walletId: cryptobot.id, amount: '5', rate: '97,5' }) });
    assert.equal(withRate.status, 200);

    const after = await (await api('/api/state')).json();
    assert.equal(after.wallets.find((w: any) => w.name === 'Platega').balance, 860_000_000);
    assert.equal(after.totals.onProviders, 860_000_000, 'USDT без курса в рубли не пересчитать — в сумму не входит');

    // чужая сессия в базе не открывает API
    const foreign = createSession(db, '42', NOW_S * 1000);
    assert.equal((await fetch(`${base}/api/state`, { headers: { cookie: `${SESSION_COOKIE}=${foreign}` } })).status, 401);
  } finally {
    srv.close();
  }
});
