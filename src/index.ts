import { readConfig } from './config.js';
import { openDb } from './db/index.js';
import { coingecko } from './rates.js';
import { createApp } from './server.js';
import { httpOrders, importBotprivat } from './import/botprivat.js';

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

const stop = (signal: string) => {
  console.log(`[finance] ${signal}, останавливаюсь`);
  server.close(() => {
    db.close();
    process.exit(0);
  });
};
process.once('SIGINT', () => stop('SIGINT'));
process.once('SIGTERM', () => stop('SIGTERM'));
