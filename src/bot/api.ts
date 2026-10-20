/**
 * Bot API — свой маленький клиент на встроенном fetch: боту нужны четыре
 * метода, и тащить ради них библиотеку незачем.
 *
 * Токен — в адресе каждого запроса, поэтому ни адрес, ни тело апдейта в журнал
 * не попадают: ошибки несут только метод, код и описание Telegram.
 */

export interface TgUser {
  id: number;
  first_name?: string;
  username?: string;
}

export interface TgChat {
  id: number;
  type: string;
}

export interface TgMessage {
  message_id: number;
  date: number;
  chat: TgChat;
  from?: TgUser;
  text?: string;
  /** ответ на сообщение бота — так правят сумму черновика */
  reply_to_message?: { message_id: number };
}

export interface TgCallbackQuery {
  id: string;
  from: TgUser;
  message?: TgMessage;
  data?: string;
}

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  callback_query?: TgCallbackQuery;
}

export interface Button {
  text: string;
  callback_data?: string;
  url?: string;
}
export type Keyboard = Button[][];

export class BotApiError extends Error {
  constructor(
    readonly method: string,
    readonly code: number,
    readonly description: string,
    readonly retryAfter: number | null = null
  ) {
    super(`${method}: ${code} ${description}`);
  }
}

/** Один вызов Bot API. Подменяется в тестах: Telegram в них не трогается. */
export type BotCall = (method: string, params: Record<string, unknown>, opts?: { signal?: AbortSignal; timeoutMs?: number }) => Promise<unknown>;

export function httpBotCall(token: string, fetchImpl: typeof fetch = fetch): BotCall {
  const base = `https://api.telegram.org/bot${token}/`;
  // сообщение сетевой ошибки может нести адрес запроса, а с ним и токен
  const scrub = (s: string) => s.split(token).join('***');
  return async (method, params, opts = {}) => {
    const timeout = AbortSignal.timeout(opts.timeoutMs ?? 15_000);
    let res: Response;
    try {
      res = await fetchImpl(base + method, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(params),
        signal: opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout,
      });
    } catch (err) {
      // «fetch failed» без причины ничего не говорит — код сети (ECONNREFUSED…) лежит в cause
      const code = (err as { cause?: { code?: unknown } })?.cause?.code;
      const why = `${err instanceof Error ? err.message : String(err)}${typeof code === 'string' ? ` (${code})` : ''}`;
      throw new Error(`${method}: ${scrub(why)}`);
    }
    const body = (await res.json().catch(() => null)) as
      | { ok?: boolean; result?: unknown; error_code?: number; description?: string; parameters?: { retry_after?: number } }
      | null;
    if (!body || body.ok !== true) {
      throw new BotApiError(method, body?.error_code ?? res.status, scrub(body?.description ?? `HTTP ${res.status}`), body?.parameters?.retry_after ?? null);
    }
    return body.result;
  };
}

export interface BotApi {
  getUpdates(offset: number, timeoutS: number, signal?: AbortSignal): Promise<TgUpdate[]>;
  sendMessage(chatId: number | string, text: string, keyboard?: Keyboard): Promise<TgMessage>;
  /** без клавиатуры — кнопки у сообщения снимаются */
  editMessageText(chatId: number, messageId: number, text: string, keyboard?: Keyboard): Promise<void>;
  answerCallbackQuery(id: string, text?: string, alert?: boolean): Promise<void>;
}

/**
 * Все тексты бота — HTML: жирная строка суммы. Всё, что пришло от людей
 * (заметка, контакт из аналитики), экранируется в text.ts#esc.
 */
export function botApi(call: BotCall): BotApi {
  const markup = (keyboard?: Keyboard) => (keyboard?.length ? { reply_markup: { inline_keyboard: keyboard } } : {});
  return {
    getUpdates: async (offset, timeoutS, signal) =>
      (await call(
        'getUpdates',
        { offset, timeout: timeoutS, allowed_updates: ['message', 'callback_query'] },
        // длинный опрос висит timeoutS секунд — ждать ответа надо дольше
        { signal, timeoutMs: (timeoutS + 15) * 1000 }
      )) as TgUpdate[],
    sendMessage: async (chatId, text, keyboard) =>
      (await call('sendMessage', {
        chat_id: chatId, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true }, ...markup(keyboard),
      })) as TgMessage,
    editMessageText: async (chatId, messageId, text, keyboard) => {
      await call('editMessageText', {
        chat_id: chatId, message_id: messageId, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true }, ...markup(keyboard),
      });
    },
    answerCallbackQuery: async (id, text, alert) => {
      await call('answerCallbackQuery', { callback_query_id: id, ...(text ? { text } : {}), ...(alert ? { show_alert: true } : {}) });
    },
  };
}

export const describe = (err: unknown) => (err instanceof Error ? err.message : String(err));

const POLL_TIMEOUT_S = 50;
/** 409 — у бота webhook или его опрашивает другой процесс (сервер, пока dev-сервер на ноутбуке): ждём, а не крутимся. */
const CONFLICT_PAUSE_MS = 60_000;
const MAX_PAUSE_MS = 5 * 60_000;

export type Sleep = (ms: number, signal: AbortSignal) => Promise<void>;

const sleep: Sleep = (ms, signal) =>
  new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });

/**
 * Длинный опрос getUpdates. Апдейты обрабатываются по одному: владелец один, а
 * нажатия по порядку не дают дважды записать черновик. Ничего не бросает —
 * сбой бота не должен ронять сервер и импорт.
 */
export function startPolling(
  api: BotApi,
  onUpdate: (u: TgUpdate) => Promise<void>,
  opts: { sleep?: Sleep } = {}
): { stop: () => void; done: Promise<void> } {
  const ctrl = new AbortController();
  const wait = opts.sleep ?? sleep;
  const done = (async () => {
    let offset = 0;
    let conflict = false;
    let failures = 0;
    while (!ctrl.signal.aborted) {
      let updates: TgUpdate[];
      try {
        updates = await api.getUpdates(offset, POLL_TIMEOUT_S, ctrl.signal);
      } catch (err) {
        if (ctrl.signal.aborted) break;
        if (err instanceof BotApiError && err.code === 409) {
          if (!conflict) console.warn(`[bot] опрос бота занят (409: ${err.description}) — жду; на ноутбуке поставьте BOT_POLLING=off`);
          conflict = true;
          await wait(CONFLICT_PAUSE_MS, ctrl.signal);
          continue;
        }
        if (err instanceof BotApiError && (err.code === 401 || err.code === 404)) {
          console.error('[bot] Telegram не принял BOT_TOKEN — опрос бота остановлен');
          break;
        }
        failures++;
        const pause = err instanceof BotApiError && err.retryAfter ? err.retryAfter * 1000 : Math.min(5000 * 2 ** (failures - 1), MAX_PAUSE_MS);
        if (failures === 1 || failures % 10 === 0) console.warn(`[bot] getUpdates не прошёл (${failures} раз подряд): ${describe(err)}`);
        await wait(pause, ctrl.signal);
        continue;
      }
      if (conflict) console.log('[bot] опрос бота снова идёт');
      conflict = false;
      failures = 0;
      for (const u of updates) {
        offset = Math.max(offset, u.update_id + 1);
        try {
          await onUpdate(u);
        } catch (err) {
          console.error('[bot] апдейт не обработан:', describe(err));
        }
      }
    }
  })().catch((err) => console.error('[bot] опрос бота упал:', describe(err)));
  return { stop: () => ctrl.abort(), done };
}
