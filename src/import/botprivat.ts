/**
 * Импорт оплат привата из ботприватa (GET /finance/orders).
 *
 * Каждая оплата — доход вида «Приватка» в проекте «Приватка MARIN» на кошелёк
 * своей платёжки, с её комиссией. Номер заказа — source_ref: повторный импорт
 * той же оплаты упирается в уникальный ключ и ничего не задваивает.
 */
import type { Db } from '../db/index.js';
import { MICRO } from '../money.js';
import { addIncome, categoryIdByCode, listWallets, projectIdByCode } from '../ledger.js';
import { currentRate, type RateFetcher } from '../rates.js';

export interface PaidOrder {
  orderId: string;
  provider: string;
  /** цена заказа в рублях, целым числом */
  amount: number;
  paidAt: number | null;
  tariffName: string;
}

export type FetchOrders = (since: number) => Promise<{ orders: PaidOrder[]; more: boolean }>;

export function httpOrders(url: string, key: string): FetchOrders {
  return async (since) => {
    const res = await fetch(`${url}/finance/orders?since=${since}`, {
      headers: { 'x-finance-key': key },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`ботприват ответил ${res.status}`);
    return (await res.json()) as { orders: PaidOrder[]; more: boolean };
  };
}

export const SOURCE = 'botprivat';
/** Берём с запасом назад: оплата могла записаться в ботприват позже соседней. */
const OVERLAP_MS = 10 * 60 * 1000;
const MAX_PAGES = 20;

const cursorOf = (db: Db): number | null =>
  (db.prepare('SELECT cursor FROM import_state WHERE source = ?').get(SOURCE) as { cursor: number } | undefined)?.cursor ?? null;
const saveCursor = (db: Db, cursor: number) =>
  db.prepare('INSERT INTO import_state (source, cursor) VALUES (?, ?) ON CONFLICT(source) DO UPDATE SET cursor = excluded.cursor').run(SOURCE, cursor);

const exists = (db: Db, ref: string) =>
  !!db.prepare('SELECT 1 FROM operations WHERE source = ? AND source_ref = ?').get(SOURCE, ref);

/** Кошелёк платёжки по имени провайдера: «Platega», «CryptoBot». Кошельки с ролью (VPN) — чужие кабинеты. */
function providerWallet(db: Db, provider: string) {
  return listWallets(db).find((w) => !w.archived && !w.role && w.kind === 'provider' && w.name.toLowerCase().includes(provider.toLowerCase()));
}

export async function importBotprivat(
  db: Db,
  deps: { fetchOrders: FetchOrders; fetchRate: RateFetcher; since: number },
  now = Date.now()
): Promise<{ imported: number; waiting: string[] }> {
  const cursor = cursorOf(db);
  let since = Math.max(deps.since, (cursor ?? 0) - OVERLAP_MS);
  let seen = cursor ?? deps.since;
  let firstWaiting: number | null = null;
  const category = categoryIdByCode(db, 'privat');
  const project = projectIdByCode(db, 'privat');
  let imported = 0;
  const waiting = new Set<string>();

  for (let page = 0; page < MAX_PAGES; page++) {
    const { orders, more } = await deps.fetchOrders(since);
    for (const o of orders) {
      if (!o.paidAt || o.paidAt < deps.since) continue;
      seen = Math.max(seen, o.paidAt);
      if (exists(db, o.orderId)) continue;
      const wait = (why: string) => {
        waiting.add(why);
        firstWaiting = Math.min(firstWaiting ?? o.paidAt!, o.paidAt!);
      };
      const wallet = providerWallet(db, o.provider);
      if (!wallet) {
        wait(`нет кошелька платёжки «${o.provider}»`);
        continue;
      }
      // Цена заказа — в рублях. На кошелёк не в рублях (CryptoBot в USDT)
      // она ложится по курсу; выручка в отчёте — ровно цена заказа.
      const rate = await currentRate(db, wallet.currency, deps.fetchRate, now);
      if (rate === null) {
        wait(`нет курса ${wallet.currency}`);
        continue;
      }
      const grossRub = o.amount * MICRO;
      addIncome(db, {
        at: o.paidAt,
        walletId: wallet.id,
        amount: wallet.currency === 'RUB' ? grossRub : Math.round(grossRub / rate),
        rate,
        grossRub,
        categoryId: category,
        projectId: project,
        note: o.tariffName,
        source: SOURCE,
        sourceRef: o.orderId,
      }, now);
      imported++;
    }
    if (!more || !orders.length) break;
    since = orders[orders.length - 1]!.paidAt ?? since;
  }
  saveCursor(db, firstWaiting ?? seen);
  return { imported, waiting: [...waiting] };
}
