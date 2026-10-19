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

  // Импорт оплат привата: адрес ботприватa, его FINANCE_API_KEY и с какой даты
  // брать оплаты. Дата обязательна — на неё же вносятся начальные остатки.
  let botprivat: Config['botprivat'] = null;
  const bpUrl = (env.BOTPRIVAT_URL ?? '').trim().replace(/\/$/, '');
  const bpKey = (env.BOTPRIVAT_KEY ?? '').trim();
  if (bpUrl || bpKey) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec((env.IMPORT_SINCE ?? '').trim());
    if (!/^https?:\/\//.test(bpUrl)) problems.push('BOTPRIVAT_URL — адрес ботприватa, например http://127.0.0.1:30003');
    if (bpKey.length < 32) problems.push('BOTPRIVAT_KEY — его FINANCE_API_KEY (32+ знаков)');
    if (!m) problems.push('IMPORT_SINCE — с какой даты брать оплаты, ГГГГ-ММ-ДД');
    // полночь по Москве
    else botprivat = { url: bpUrl, key: bpKey, since: Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) - 3 * 3600_000 };
  }

  if (problems.length) throw new Error(`Настройки не заполнены:\n- ${problems.join('\n- ')}`);
  return { port, dbPath: env.DB_PATH || './data/finance.db', botToken, botUsername, ownerIds, botprivat };
}
