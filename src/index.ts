import { readConfig } from './config.js';
import { openDb } from './db/index.js';
import { coingecko } from './rates.js';
import { createApp } from './server.js';
import { httpOrders, importBotprivat } from './import/botprivat.js';
import { httpDeals, syncDeals } from './ads.js';
import { httpPayments, syncVpn } from './vpn.js';
import { botApi, httpBotCall, startPolling } from './bot/api.js';
import { createBot } from './bot/index.js';

const config = readConfig();
const db = openDb(config.dbPath);
const app = createApp({ db, config, fetchRate: coingecko });

const server = app.listen(config.port, () => {
  console.log(`[finance] слушаю порт ${config.port}, база ${config.dbPath}`);
});

// Оплаты привата — раз в 5 минут. Сбой (ботприват перезапускается) не страшен:
// следующий проход заберёт то же с запасом назад, дублей не будет.
const bp = config.botprivat;
if (bp) {
  let running = false;
  const pull = async () => {
    if (running) return;
    running = true;
    try {
      const r = await importBotprivat(db, { fetchOrders: httpOrders(bp.url, bp.key), fetchRate: coingecko, since: bp.since });
      if (r.imported) console.log(`[import] оплат привата записано: ${r.imported}`);
      if (r.waiting.length) console.warn(`[import] часть оплат ждёт: ${r.waiting.join('; ')}`);
    } catch (err) {
      console.warn('[import] ботприват недоступен:', err instanceof Error ? err.message : err);
    } finally {
      running = false;
    }
  };
  setTimeout(pull, 10_000);
  setInterval(pull, 5 * 60_000);
  console.log(`[import] оплаты привата с ${new Date(bp.since + 3 * 3600_000).toISOString().slice(0, 10)} (МСК) из ${bp.url}`);
}

// Сделки рекламы — так же раз в 5 минут: у CPM сумма появляется, когда
// просмотры зафиксированы, сделки переносят и отменяют.
const an = config.analytics;
if (an) {
  let running = false;
  const pull = async () => {
    if (running) return;
    running = true;
    try {
      const r = await syncDeals(db, { fetchDeals: httpDeals(an.url, an.key), since: an.since });
      if (r.added) console.log(`[ads] новых сделок рекламы: ${r.added}`);
    } catch (err) {
      console.warn('[ads] tg-analytics недоступна:', err instanceof Error ? err.message : err);
    } finally {
      running = false;
    }
  };
  setTimeout(pull, 15_000);
  setInterval(pull, 5 * 60_000);
  console.log(`[ads] сделки рекламы из ${an.url}`);
}

// Оплаты VPN — из той же аналитики, раз в 5 минут.
const vpnProject = config.vpnProject;
if (an && vpnProject) {
  let running = false;
  const pull = async () => {
    if (running) return;
    running = true;
    try {
      const r = await syncVpn(db, { fetchPayments: httpPayments(an.url, an.key, vpnProject), fetchRate: coingecko, since: an.since });
      if (r.booked) console.log(`[vpn] оплат VPN записано: ${r.booked}`);
      if (r.imported && r.unsorted) console.log(`[vpn] без платёжки, ждут разбора: ${r.unsorted}`);
      if (r.waiting.length) console.warn(`[vpn] часть оплат ждёт: ${r.waiting.join('; ')}`);
    } catch (err) {
      console.warn('[vpn] tg-analytics недоступна:', err instanceof Error ? err.message : err);
    } finally {
      running = false;
    }
  };
  setTimeout(pull, 20_000);
  setInterval(pull, 5 * 60_000);
  console.log(`[vpn] оплаты VPN — проект «${vpnProject}» в ${an.url}`);
}

// Бот: быстрая запись операций, /balance, /debts и напоминание о долгах.
// Сбой бота сервер и импорт не роняет — опрос сам ловит ошибки и ждёт.
let poller: { stop: () => void } | null = null;
const reminderHour = config.reminderHour;
if (config.botPolling || reminderHour !== null) {
  const api = botApi(httpBotCall(config.botToken));
  const bot = createBot({ db, api, ownerIds: config.ownerIds, fetchRate: coingecko, publicUrl: config.publicUrl });
  if (config.botPolling) {
    poller = startPolling(api, bot.handleUpdate);
    console.log(`[bot] опрашиваю @${config.botUsername}`);
  } else {
    console.log('[bot] опрос бота выключен (BOT_POLLING=off)');
  }
  if (reminderHour !== null) {
    // Раз в минуту: настал ли час по Москве. Какой день уже напомнили — в базе,
    // так что перезапуск после этого часа второго напоминания не шлёт.
    setInterval(() => {
      bot.remind(reminderHour).catch((err) => console.warn('[bot] напоминание о долгах не вышло:', err instanceof Error ? err.message : err));
      bot.recurring(reminderHour).catch((err) => console.warn('[bot] регулярные расходы не разосланы:', err instanceof Error ? err.message : err));
    }, 60_000);
    console.log(`[bot] напоминание о долгах рекламы — в ${reminderHour}:00 МСК`);
  }
}

const stop = (signal: string) => {
  console.log(`[finance] ${signal}, останавливаюсь`);
  poller?.stop();
  server.close(() => {
    db.close();
    process.exit(0);
  });
};
process.once('SIGINT', () => stop('SIGINT'));
process.once('SIGTERM', () => stop('SIGTERM'));
