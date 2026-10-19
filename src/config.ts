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

  if (problems.length) throw new Error(`Настройки не заполнены:\n- ${problems.join('\n- ')}`);
  return { port, dbPath: env.DB_PATH || './data/finance.db', botToken, botUsername, ownerIds };
}
