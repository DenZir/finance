/**
 * Настройки из окружения. Проверяются один раз при старте: о пустом токене бота
 * лучше узнать сразу, чем когда не получится войти.
 */
import 'dotenv/config';

export interface Config {
  port: number;
  dbPath: string;
  botToken: string;
  botUsername: string;
  ownerIds: string[];
  /** импорт оплат привата; null — выключен */
  botprivat: { url: string; key: string; since: number } | null;
  /** сделки рекламы из tg-analytics; null — выключены */
  analytics: { url: string; key: string; since: number } | null;
  /** имя проекта VPN в tg-analytics — оплаты VPN оттуда; null — выключены */
  vpnProject: string | null;
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const problems: string[] = [];
  const port = Number(env.PORT || 30010);
  if (!Number.isInteger(port) || port <= 0) problems.push('PORT — не число');

  const botToken = (env.BOT_TOKEN ?? '').trim();
  if (!/^\d+:[\w-]{30,}$/.test(botToken)) problems.push('BOT_TOKEN — нужен токен бота из @BotFather');
  const botUsername = (env.BOT_USERNAME ?? '').trim().replace(/^@/, '');
  if (!/^\w{5,}$/.test(botUsername)) problems.push('BOT_USERNAME — имя бота без @');
  const ownerIds = (env.OWNER_TG_IDS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!ownerIds.length || ownerIds.some((id) => !/^\d+$/.test(id))) problems.push('OWNER_TG_IDS — Telegram ID владельца, цифрами');

  // Импорт оплат привата и сделок рекламы: адрес сервиса, его ключ и с какой
  // даты брать. Дата обязательна — на неё же вносятся начальные остатки.
  const since = () => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec((env.IMPORT_SINCE ?? '').trim());
    if (!m) {
      if (!problems.some((p) => p.startsWith('IMPORT_SINCE'))) problems.push('IMPORT_SINCE — с какой даты брать оплаты и сделки, ГГГГ-ММ-ДД');
      return null;
    }
    // полночь по Москве
    return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) - 3 * 3600_000;
  };
  const source = (urlVar: string, keyVar: string, what: string, keyWhat: string) => {
    const url = (env[urlVar] ?? '').trim().replace(/\/$/, '');
    const key = (env[keyVar] ?? '').trim();
    if (!url && !key) return null;
    if (!/^https?:\/\//.test(url)) problems.push(`${urlVar} — адрес ${what}`);
    if (key.length < 32) problems.push(`${keyVar} — ${keyWhat} (32+ знаков)`);
    const from = since();
    return from === null ? null : { url, key, since: from };
  };
  const botprivat = source('BOTPRIVAT_URL', 'BOTPRIVAT_KEY', 'ботприватa, например http://127.0.0.1:30003', 'его FINANCE_API_KEY');
  const analytics = source('ANALYTICS_URL', 'ANALYTICS_KEY', 'tg-analytics, например http://127.0.0.1:3000', 'его FINANCE_KEY');

  // Оплаты VPN берутся из той же аналитики тем же ключом — нужно только имя проекта.
  const vpnProject = (env.VPN_PROJECT ?? '').trim() || null;
  if (vpnProject && !(env.ANALYTICS_URL ?? '').trim()) problems.push('VPN_PROJECT — оплаты VPN берутся из tg-analytics: заполните ANALYTICS_URL и ANALYTICS_KEY');

  if (problems.length) throw new Error(`Настройки не заполнены:\n- ${problems.join('\n- ')}`);
  return { port, dbPath: env.DB_PATH || './data/finance.db', botToken, botUsername, ownerIds, botprivat, analytics, vpnProject };
}
