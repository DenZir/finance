/**
 * Бот «Денег» — тот же, через который входят на страницу. Отвечает только
 * владельцу (OWNER_TG_IDS) и только в личке: остальным — молча ничего, чтобы
 * чужой не узнал даже, что бот что-то умеет.
 *
 * Строка вроде «сервер 20 usdt» — черновик операции с кнопками; /balance —
 * остатки.
 */
import type { Db } from '../db/index.js';
import type { RateFetcher } from '../rates.js';
import { describe, BotApiError, type BotApi, type Keyboard, type TgCallbackQuery, type TgMessage, type TgUpdate } from './api.js';
import { QuickEntry, type Outcome } from './draft.js';
import { balanceText } from './balance.js';

export interface BotDeps {
  db: Db;
  api: BotApi;
  ownerIds: readonly string[];
  fetchRate: RateFetcher;
  now?: () => number;
}

const EXAMPLES = ['сервер 20 usdt', '20$ хостинг', 'хостинг 1 500 ₽', '+1500 сторис', 'доход 300 приватка', '20,5 ton'];

export const HELP = [
  'Пришлите расход или доход одной строкой — я соберу операцию, вы подтвердите кнопкой.',
  '',
  'Например:',
  ...EXAMPLES.map((e) => `• ${e}`),
  '',
  'Расход — по умолчанию; доход — с «+» в начале или со словом «доход», «пришло», «получил».',
  'Валюта: ₽, $ или usdt, ton, trx, btc, eth. Не указана — в валюте кошелька (CryptoBot — USDT).',
  'Вид, проект, кошелёк и дату можно поправить кнопками до записи.',
  '',
  '/balance — остатки кошельков',
].join('\n');

const NO_AMOUNT = `Не нашёл сумму. Например: «${EXAMPLES[0]}» или «${EXAMPLES[3]}».\n/help — подробнее`;

export function createBot(deps: BotDeps) {
  const { db, api, fetchRate } = deps;
  const now = deps.now ?? Date.now;
  const quick = new QuickEntry({ db, fetchRate, now });
  const isOwner = (id: number | undefined) => id !== undefined && deps.ownerIds.includes(String(id));

  const send = (chatId: number, text: string, keyboard?: Keyboard) => api.sendMessage(chatId, text, keyboard);

  async function command(chatId: number, cmd: string): Promise<void> {
    switch (cmd) {
      case 'start':
      case 'help':
        await send(chatId, HELP);
        return;
      case 'balance':
        await send(chatId, await balanceText(db, fetchRate, now()));
        return;
      default:
        await send(chatId, NO_AMOUNT);
    }
  }

  async function onMessage(msg: TgMessage): Promise<void> {
    if (msg.chat.type !== 'private' || !isOwner(msg.from?.id) || typeof msg.text !== 'string') return;
    const text = msg.text.trim();
    const cmd = /^\/([a-z_]+)(?:@\w+)?(?:\s|$)/i.exec(text)?.[1];
    if (cmd) return command(msg.chat.id, cmd.toLowerCase());
    const out = await quick.start(text);
    await send(msg.chat.id, out?.text ?? NO_AMOUNT, out?.keyboard);
  }

  async function onCallback(q: TgCallbackQuery): Promise<void> {
    const msg = q.message;
    if (!isOwner(q.from.id) || !msg || msg.chat.type !== 'private' || !q.data) return;
    let out: Outcome;
    try {
      out = await quick.press(q.data);
    } catch (err) {
      console.error('[bot] нажатие не обработано:', describe(err));
      out = { answer: 'Не вышло — подробности в журнале сервера', alert: true };
    }
    try {
      if (out.text !== undefined) await api.editMessageText(msg.chat.id, msg.message_id, out.text, out.keyboard);
    } catch (err) {
      // двойное нажатие: сообщение уже такое — не ошибка
      if (!(err instanceof BotApiError && /message is not modified/i.test(err.description))) {
        console.warn('[bot] сообщение не обновилось:', describe(err));
      }
    }
    await api.answerCallbackQuery(q.id, out.answer, out.alert);
  }

  return {
    async handleUpdate(u: TgUpdate): Promise<void> {
      if (u.message) await onMessage(u.message);
      else if (u.callback_query) await onCallback(u.callback_query);
    },
  };
}
