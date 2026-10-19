/**
 * Подделка Bot API: записывает вызовы и отвечает, как Telegram, — Telegram в
 * тестах не трогается.
 */
import { botApi, type BotCall, type Button, type TgUpdate } from '../../src/bot/api.js';

export interface Call {
  method: string;
  params: Record<string, any>;
}

export function fakeTelegram() {
  const calls: Call[] = [];
  let nextMessageId = 100;
  const call: BotCall = async (method, params) => {
    calls.push({ method, params });
    if (method === 'sendMessage') return { message_id: nextMessageId++, date: 0, chat: { id: params.chat_id, type: 'private' }, text: params.text };
    return true;
  };
  return { calls, call, api: botApi(call) };
}

/** Текст без разметки и с обычными пробелами — так его видит владелец. */
export const plain = (html: string) => html.replace(/<[^>]+>/g, '').replace(/ /g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

export const buttons = (c: Call): Button[] => (c.params.reply_markup?.inline_keyboard ?? []).flat();

/** callback_data кнопки, чья надпись содержит label. */
export function button(c: Call, label: string): string {
  const b = buttons(c).find((x) => x.text.includes(label));
  if (!b?.callback_data) throw new Error(`нет кнопки «${label}» среди: ${buttons(c).map((x) => x.text).join(', ')}`);
  return b.callback_data;
}

let updateId = 1;

export const message = (fromId: number, text: string, chatType = 'private'): TgUpdate => ({
  update_id: updateId++,
  message: { message_id: updateId, date: 0, chat: { id: chatType === 'private' ? fromId : -100500, type: chatType }, from: { id: fromId }, text },
});

export const press = (fromId: number, messageId: number, data: string): TgUpdate => ({
  update_id: updateId++,
  callback_query: { id: `cq${updateId}`, from: { id: fromId }, data, message: { message_id: messageId, date: 0, chat: { id: fromId, type: 'private' } } },
});
