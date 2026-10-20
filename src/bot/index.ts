/**
 * Бот «Денег» — тот же, через который входят на страницу. Отвечает только
 * владельцу (OWNER_TG_IDS) и только в личке: остальным — молча ничего, чтобы
 * чужой не узнал даже, что бот что-то умеет.
 *
 * Строка вроде «сервер 20 usdt» — черновик операции с кнопками; /balance —
 * остатки; /debts и напоминание раз в день — долги по рекламе и приветке;
 * /partner — сверка партнёрки по балансу.
 */
import type { Db } from '../db/index.js';
import type { RateFetcher } from '../rates.js';
import { listDeals } from '../ads.js';
import { describe, BotApiError, type BotApi, type Keyboard, type TgCallbackQuery, type TgMessage, type TgUpdate } from './api.js';
import { QuickEntry, type Outcome } from './draft.js';
import { balanceText } from './balance.js';
import { debtsText, lastReminderDay, markReminderDay, reminderDue } from './debts.js';
import { welcomeDebts } from '../welcome.js';
import { amount, esc, mskDayStart, mskIso, rub } from './text.js';
import { partnerCheck, partnerCounted, partnerWallet } from '../partner.js';
import { currentRate } from '../rates.js';
import { MoneyInputError, parseAmount, toRub } from '../money.js';

export interface BotDeps {
  db: Db;
  api: BotApi;
  ownerIds: readonly string[];
  fetchRate: RateFetcher;
  /** адрес страницы для кнопки «Открыть «Деньги»»; null — без кнопки */
  publicUrl?: string | null;
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
  'Валюта: ₽, $ или usdt, ton, trx, btc, eth. Не указана — рубли (на CryptoBot пересчитаются в USDT).',
  'Вид, проект, кошелёк и дату можно поправить кнопками до записи.',
  '',
  '/balance — остатки кошельков',
  '/debts — кто кому должен: реклама и приветка',
  '/partner 125 — сколько сейчас на счёте партнёрки, $: прирост станет доходом',
].join('\n');

const NO_AMOUNT = `Не нашёл сумму. Например: «${EXAMPLES[0]}» или «${EXAMPLES[3]}».\n/help — подробнее`;

export function createBot(deps: BotDeps) {
  const { db, api, fetchRate } = deps;
  const now = deps.now ?? Date.now;
  const quick = new QuickEntry({ db, fetchRate, now });
  const isOwner = (id: number | undefined) => id !== undefined && deps.ownerIds.includes(String(id));

  const send = (chatId: number, text: string, keyboard?: Keyboard) => api.sendMessage(chatId, text, keyboard);
  const openPage: Keyboard | undefined = deps.publicUrl ? [[{ text: 'Открыть «Деньги»', url: deps.publicUrl }]] : undefined;
  const debtsNow = () => debtsText(listDeals(db), mskIso(now()), welcomeDebts(db));

  async function command(chatId: number, cmd: string, args: string): Promise<void> {
    switch (cmd) {
      case 'partner':
        await send(chatId, await partnerReply(args));
        return;
      case 'start':
      case 'help':
        await send(chatId, HELP);
        return;
      case 'balance':
        await send(chatId, await balanceText(db, fetchRate, now()));
        return;
      case 'debts': {
        const text = debtsNow();
        await send(chatId, text ?? 'Никто никому не должен.', text ? openPage : undefined);
        return;
      }
      default:
        await send(chatId, NO_AMOUNT);
    }
  }

  /** /partner 125 — сверка партнёрки по балансу в миниапке (partner.ts). */
  async function partnerReply(args: string): Promise<string> {
    const w = partnerWallet(db);
    if (!w) return 'Кошелька «Партнёрка» нет.';
    const counted = partnerCounted(db, now());
    if (!args) return `Партнёрка: насчитано ${amount(counted, w.currency)}.\nЗайдите в миниапку и пришлите, сколько на счёте сейчас: /partner 125`;
    try {
      const balance = parseAmount(args.replace(/\$|usd/gi, '').trim(), { allowZero: true });
      const rate = await currentRate(db, w.currency, fetchRate, now());
      if (rate === null) return `Нет курса ${w.currency} — сверьте на странице, вписав курс.`;
      const r = partnerCheck(db, { balance, at: now(), rate }, now());
      return r.income
        ? `Записано: доход «Партнёрская программа» +${amount(r.income, w.currency)} (≈ ${rub(toRub(r.income, rate))}).`
        : 'Нового дохода нет — на счёте столько же, сколько насчитано.';
    } catch (err) {
      if (err instanceof MoneyInputError) return esc(err.message);
      throw err;
    }
  }

  async function onMessage(msg: TgMessage): Promise<void> {
    if (msg.chat.type !== 'private' || !isOwner(msg.from?.id) || typeof msg.text !== 'string') return;
    const text = msg.text.trim();
    const m = /^\/([a-z_]+)(?:@\w+)?(?:\s+([\s\S]*))?$/i.exec(text);
    if (m) return command(msg.chat.id, m[1]!.toLowerCase(), (m[2] ?? '').trim());
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

    /**
     * Напоминание о долгах рекламы — раз в день, в hour по Москве. Зовётся раз в
     * минуту; true — напоминание отправлено.
     */
    async remind(hour: number): Promise<boolean> {
      const t = now();
      if (!reminderDue(t, hour, lastReminderDay(db))) return false;
      // День отмечается до отправки и когда долгов нет: иначе сделка, отмеченная
      // «Ждём оплату» в 15:00, дала бы второе напоминание в 15:01.
      markReminderDay(db, mskDayStart(t));
      const text = debtsNow();
      if (!text) return false;
      for (const owner of deps.ownerIds) {
        try {
          await api.sendMessage(owner, text, openPage);
        } catch (err) {
          // бот не может написать первым: владелец должен один раз нажать /start
          const hint = err instanceof BotApiError && (err.code === 403 || /chat not found/i.test(err.description)) ? ' — нажмите /start в боте' : '';
          console.warn(`[bot] напоминание о долгах не ушло ${owner}: ${describe(err)}${hint}`);
        }
      }
      return true;
    },
  };
}
