/**
 * Курсы валют к рублю.
 *
 * Берутся с CoinGecko (без ключа) и запоминаются в базе: последнего известного
 * курса хватает и когда сайт недоступен, а в операции всегда можно вписать свой
 * — курс Rapira отличается от биржевого, и для вывода точнее вписать его.
 */
import type { Db } from './db/index.js';

const COINGECKO_IDS: Record<string, string> = {
  USDT: 'tether',
  TON: 'the-open-network',
  TRX: 'tron',
  BTC: 'bitcoin',
  ETH: 'ethereum',
  USDC: 'usd-coin',
  LTC: 'litecoin',
  BNB: 'binancecoin',
};

/** Достаёт курс снаружи. Подменяется в тестах. */
export type RateFetcher = (currency: string) => Promise<number | null>;

export const coingecko: RateFetcher = async (currency) => {
  const id = COINGECKO_IDS[currency];
  if (!id) return null;
  try {
    const res = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=rub`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as Record<string, { rub?: number }>;
    const rub = data[id]?.rub;
    return typeof rub === 'number' && rub > 0 ? rub : null;
  } catch (err) {
    console.warn(`[rates] CoinGecko не ответил по ${currency}:`, err instanceof Error ? err.message : err);
    return null;
  }
};

const FRESH_MS = 30 * 60 * 1000;

export function storedRate(db: Db, currency: string): { rub: number; at: number } | null {
  return (db.prepare('SELECT rub, at FROM rates WHERE currency = ?').get(currency) as { rub: number; at: number } | undefined) ?? null;
}

export function saveRate(db: Db, currency: string, rub: number, at: number): void {
  db.prepare('INSERT INTO rates (currency, rub, at) VALUES (?, ?, ?) ON CONFLICT(currency) DO UPDATE SET rub = excluded.rub, at = excluded.at').run(currency, rub, at);
}

/**
 * Курс сейчас: рубль — 1; свежий из базы; иначе спросить снаружи; не вышло —
 * последний известный. null — курса нет вовсе, и его надо вписать руками.
 */
export async function currentRate(db: Db, currency: string, fetcher: RateFetcher, now = Date.now()): Promise<number | null> {
  if (currency === 'RUB') return 1;
  const stored = storedRate(db, currency);
  if (stored && now - stored.at < FRESH_MS) return stored.rub;
  const fetched = await fetcher(currency);
  if (fetched) {
    saveRate(db, currency, fetched, now);
    return fetched;
  }
  return stored?.rub ?? null;
}
