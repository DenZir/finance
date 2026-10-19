import { readConfig } from './config.js';
import { openDb } from './db/index.js';
import { coingecko } from './rates.js';
import { createApp } from './server.js';

const config = readConfig();
const db = openDb(config.dbPath);
const app = createApp({ db, config, fetchRate: coingecko });

const server = app.listen(config.port, () => {
  console.log(`[finance] слушаю порт ${config.port}, база ${config.dbPath}`);
});

const stop = (signal: string) => {
  console.log(`[finance] ${signal}, останавливаюсь`);
  server.close(() => {
    db.close();
    process.exit(0);
  });
};
process.once('SIGINT', () => stop('SIGINT'));
process.once('SIGTERM', () => stop('SIGTERM'));
