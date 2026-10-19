/**
 * Вход через Telegram (Login Widget) и сессии.
 *
 * Виджет отдаёт данные пользователя с подписью: HMAC-SHA256 от строк
 * «ключ=значение» по алфавиту, ключ — SHA-256 токена бота. Подделать её без
 * токена нельзя; кроме подписи проверяем свежесть (сутки) и что это владелец.
 */
import crypto from 'node:crypto';
import type { Db } from './db/index.js';

const AUTH_MAX_AGE_S = 24 * 3600;
export const SESSION_MS = 30 * 24 * 3600 * 1000;
export const SESSION_COOKIE = 'fin_session';

export type LoginCheck = { ok: true; tgId: string } | { ok: false; reason: string };

export function checkTelegramLogin(
  data: Record<string, unknown>,
  botToken: string,
  ownerIds: readonly string[],
  nowS = Math.floor(Date.now() / 1000)
): LoginCheck {
  const hash = typeof data.hash === 'string' ? data.hash : '';
  if (!/^[0-9a-f]{64}$/.test(hash)) return { ok: false, reason: 'нет подписи' };

  const fields = Object.entries(data)
    .filter(([k, v]) => k !== 'hash' && v !== undefined && v !== null && typeof v !== 'object')
    .map(([k, v]) => `${k}=${String(v)}`)
    .sort();
  const secret = crypto.createHash('sha256').update(botToken).digest();
  const expected = crypto.createHmac('sha256', secret).update(fields.join('\n')).digest('hex');
  if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(hash))) return { ok: false, reason: 'подпись не сходится' };

  const authDate = Number(data.auth_date);
  if (!Number.isFinite(authDate) || nowS - authDate > AUTH_MAX_AGE_S) return { ok: false, reason: 'вход устарел — нажмите кнопку ещё раз' };

  const tgId = String(data.id ?? '');
  if (!ownerIds.includes(tgId)) return { ok: false, reason: 'этот аккаунт не владелец' };
  return { ok: true, tgId };
}

export function createSession(db: Db, tgId: string, now = Date.now()): string {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions (token, tg_id, expires_at) VALUES (?, ?, ?)').run(token, tgId, now + SESSION_MS);
  // заодно чистим протухшие — таблица не растёт
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now);
  return token;
}

/** Владелец сессии, если она жива и он всё ещё в списке. */
export function sessionUser(db: Db, token: string | undefined, ownerIds: readonly string[], now = Date.now()): string | null {
  if (!token || !/^[0-9a-f]{64}$/.test(token)) return null;
  const row = db.prepare('SELECT tg_id, expires_at FROM sessions WHERE token = ?').get(token) as { tg_id: string; expires_at: number } | undefined;
  if (!row || row.expires_at < now || !ownerIds.includes(row.tg_id)) return null;
  return row.tg_id;
}

export function dropSession(db: Db, token: string | undefined): void {
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}
