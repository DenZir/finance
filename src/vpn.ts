/**
 * Оплаты VPN из tg-analytics (GET /api/finance/payments).
 *
 * VPN-бот — код партнёра, и обо всех его оплатах знает только аналитика: туда
 * бот сообщает каждую. Оплата становится доходом «VPN» проекта VPN (пополам с
 * партнёром) на кошелёк своей платёжки — Platega VPN (8 %), CryptoBot VPN
 * (3 %), Parity VPN (10 %) или Lolzteam VPN (7 %), — с её комиссией. Какая платёжка, бот передаёт полем provider; не
 * передал (старые оплаты, бот ещё не доработан) — оплата ждёт в «Разобрать»,
 * пока владелец не выберет платёжку сам.
 */
import type { Db } from './db/index.js';
import { MICRO, MoneyInputError } from './money.js';
import { addIncome, categoryIdByCode, listWallets, projectIdByCode } from './ledger.js';
import { currentRate, type RateFetcher } from './rates.js';

export const SOURCE = 'vpn';
/** Как их называет VPN-бот в поле provider; кошелёк — с ролью vpn:<имя>. */
export const PROVIDERS = ['platega', 'cryptobot', 'parity', 'lolzteam'] as const;
export type Provider = (typeof PROVIDERS)[number];
const isProvider = (v: unknown): v is Provider => (PROVIDERS as readonly unknown[]).includes(v);
// card_ru — прежнее имя parity (владелец, 2026-10-20): оплаты, ушедшие в аналитику
// до переименования, ложатся на тот же кошелёк, а не в «Разобрать».
const ALIASES: Record<string, Provider> = { card_ru: 'parity' };
const providerOf = (v: unknown): Provider | null => {
  if (typeof v !== 'string') return null;
  const s = v.toLowerCase();
  return isProvider(s) ? s : ALIASES[s] ?? null;
};

export interface AnalyticsPayment {
  id: number;
  at: string;
  type: string;
  amount: number;
  provider: string | null;
}

export type FetchPayments = (after: number) => Promise<{ payments: AnalyticsPayment[]; more: boolean }>;

export function httpPayments(url: string, key: string, project: string): FetchPayments {
  return async (after) => {
    const res = await fetch(`${url}/api/finance/payments?project=${encodeURIComponent(project)}&after=${after}`, {
      headers: { 'x-api-key': key },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`tg-analytics ответил ${res.status}${res.status === 404 ? ` — проекта «${project}» там нет (VPN_PROJECT)` : ''}`);
    const body = (await res.json()) as { payments?: AnalyticsPayment[]; more?: boolean };
    if (!Array.isArray(body.payments)) throw new Error('tg-analytics ответил без списка оплат');
    return { payments: body.payments, more: !!body.more };
  };
}

const MAX_PAGES = 40;

const cursorOf = (db: Db): number =>
  (db.prepare('SELECT cursor FROM import_state WHERE source = ?').get(SOURCE) as { cursor: number } | undefined)?.cursor ?? 0;
const saveCursor = (db: Db, cursor: number) =>
  db.prepare('INSERT INTO import_state (source, cursor) VALUES (?, ?) ON CONFLICT(source) DO UPDATE SET cursor = excluded.cursor').run(SOURCE, cursor);

const walletOf = (db: Db, provider: Provider) => listWallets(db).find((w) => !w.archived && w.role === `vpn:${provider}`);
const booked = (db: Db, ref: string) => !!db.prepare('SELECT 1 FROM operations WHERE source = ? AND source_ref = ?').get(SOURCE, ref);

/**
 * Записывает оплату доходом на кошелёк платёжки. Цена — в рублях: на кошелёк
 * в USDT она ложится по курсу, а выручка в отчёте — ровно сумма оплаты.
 * Вернёт причину, если записать нельзя (нет кошелька, нет курса).
 */
async function book(db: Db, p: { ref: string; at: number; type: string; amount: number }, provider: Provider, fetchRate: RateFetcher, now: number): Promise<string | null> {
  const wallet = walletOf(db, provider);
  if (!wallet) return `нет кошелька с ролью vpn:${provider} (или он в архиве)`;
  const rate = await currentRate(db, wallet.currency, fetchRate, now);
  if (rate === null) return `нет курса ${wallet.currency}`;
  // Курс ждали из сети: пока ждали, эту же оплату мог записать соседний проход.
  if (booked(db, p.ref)) return null;
  addIncome(db, {
    at: p.at,
    walletId: wallet.id,
    amount: wallet.currency === 'RUB' ? p.amount : Math.round(p.amount / rate),
    rate,
    grossRub: p.amount,
    categoryId: categoryIdByCode(db, 'vpn'),
    projectId: projectIdByCode(db, 'vpn'),
    note: p.type === 'renewal' ? 'продление' : 'покупка',
    source: SOURCE,
    sourceRef: p.ref,
  }, now);
  return null;
}

/**
 * Сверка: новые оплаты (после последнего прочитанного номера события)
 * записываются в vpn_payments, затем каждая незаписанная с известной
 * платёжкой становится доходом. Оплаты раньше IMPORT_SINCE пропускаются —
 * их деньги уже в начальных остатках.
 */
export async function syncVpn(
  db: Db,
  deps: { fetchPayments: FetchPayments; fetchRate: RateFetcher; since: number },
  now = Date.now()
): Promise<{ imported: number; booked: number; unsorted: number; waiting: string[] }> {
  let after = cursorOf(db);
  let imported = 0;
  const insert = db.prepare(
    `INSERT OR IGNORE INTO vpn_payments (ref, at, type, amount, provider, synced_at) VALUES (?, ?, ?, ?, ?, ?)`
  );
  for (let page = 0; page < MAX_PAGES; page++) {
    const { payments, more } = await deps.fetchPayments(after);
    db.transaction(() => {
      for (const p of payments) {
        after = Math.max(after, p.id);
        const at = Date.parse(p.at);
        if (!Number.isFinite(at) || at < deps.since || !(p.amount > 0)) continue;
        const provider = providerOf(p.provider);
        imported += insert.run(String(p.id), at, p.type === 'renewal' ? 'renewal' : 'payment', Math.round(p.amount * MICRO), provider, now).changes;
      }
      saveCursor(db, after);
    })();
    if (!more || !payments.length) break;
  }

  let bookedCount = 0;
  const waiting = new Set<string>();
  for (const p of pendingRows(db)) {
    if (!p.provider) continue;
    const why = await book(db, p, p.provider, deps.fetchRate, now);
    if (why) waiting.add(why);
    else bookedCount++;
  }
  return { imported, booked: bookedCount, unsorted: listUnsorted(db).length, waiting: [...waiting] };
}

interface Row { ref: string; at: number; type: string; amount: number; provider: Provider | null }

/** Не записанные доходом и не пропущенные. */
function pendingRows(db: Db): Row[] {
  return db
    .prepare(
      `SELECT v.ref, v.at, v.type, v.amount, v.provider FROM vpn_payments v
       WHERE v.skipped_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM operations o WHERE o.source = '${SOURCE}' AND o.source_ref = v.ref)
       ORDER BY v.at, v.ref`
    )
    .all() as Row[];
}

/** «Разобрать»: оплаты, по которым бот не сказал платёжку. */
export function listUnsorted(db: Db): { ref: string; at: number; type: string; amount: number }[] {
  return pendingRows(db).filter((p) => !p.provider).map(({ ref, at, type, amount }) => ({ ref, at, type, amount }));
}

const REF = /^\d{1,15}$/;
const MAX_REFS = 500;

function checkRefs(refs: unknown): string[] {
  if (!Array.isArray(refs) || !refs.length) throw new MoneyInputError('не выбрано ни одной оплаты');
  if (refs.length > MAX_REFS) throw new MoneyInputError(`за раз — не больше ${MAX_REFS} оплат`);
  for (const r of refs) if (typeof r !== 'string' || !REF.test(r)) throw new MoneyInputError(`«${String(r).slice(0, 40)}» — не оплата`);
  return [...new Set(refs as string[])];
}

/** «Не учтены»: оплаты, отмеченные «Не учитывать», — последние отмеченные сверху. */
export function listSkipped(db: Db): { ref: string; at: number; type: string; amount: number; provider: Provider | null; skippedAt: number }[] {
  return db
    .prepare(
      `SELECT v.ref, v.at, v.type, v.amount, v.provider, v.skipped_at AS skippedAt FROM vpn_payments v
       WHERE v.skipped_at IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM operations o WHERE o.source = '${SOURCE}' AND o.source_ref = v.ref)
       ORDER BY v.skipped_at DESC, v.at DESC, v.ref`
    )
    .all() as ReturnType<typeof listSkipped>;
}

/**
 * Вернуть из «Не учитывать» — по ошибке нажатый крестик (владелец, 2026-10-20).
 * Оплата с известной платёжкой сразу ложится доходом, без неё — обратно в
 * «Разобрать». Не отмеченные и неизвестные пропускаются.
 */
export async function restoreVpn(
  db: Db,
  refs: unknown,
  fetchRate: RateFetcher,
  now = Date.now()
): Promise<{ done: number; booked: number; skipped: number; waiting: string[] }> {
  const skippedRows = new Map(listSkipped(db).map((p) => [p.ref, p]));
  let done = 0;
  let bookedCount = 0;
  let skipped = 0;
  const waiting = new Set<string>();
  for (const ref of checkRefs(refs)) {
    const p = skippedRows.get(ref);
    if (!p) {
      skipped++;
      continue;
    }
    db.prepare('UPDATE vpn_payments SET skipped_at = NULL WHERE ref = ?').run(ref);
    done++;
    if (!p.provider) continue;
    // не вышло (нет кошелька, курса) — оплата не потеряна: её запишет следующая сверка
    const why = await book(db, p, p.provider, fetchRate, now);
    if (why) waiting.add(why);
    else bookedCount++;
  }
  return { done, booked: bookedCount, skipped, waiting: [...waiting] };
}

/**
 * Владелец выбрал платёжку (или «Не учитывать») для одной или многих оплат.
 * Платёжка запоминается в оплате, так что удалённая потом операция вернётся
 * не в «Разобрать», а запишется заново следующей сверкой — как оплата, о
 * платёжке которой бот сказал сам. Уже записанные и неизвестные пропускаются.
 */
export async function resolveVpn(
  db: Db,
  refs: unknown,
  action: unknown,
  fetchRate: RateFetcher,
  now = Date.now()
): Promise<{ done: number; skipped: number }> {
  if (action !== 'skip' && !isProvider(action)) throw new MoneyInputError('выберите платёжку: Platega, CryptoBot, Parity или Lolzteam');
  const list = checkRefs(refs);

  const pending = new Map(pendingRows(db).map((p) => [p.ref, p]));
  let done = 0;
  let skipped = 0;
  for (const ref of list) {
    const p = pending.get(ref);
    if (!p) {
      skipped++;
      continue;
    }
    if (action === 'skip') {
      db.prepare('UPDATE vpn_payments SET skipped_at = ? WHERE ref = ?').run(now, ref);
      done++;
      continue;
    }
    db.prepare('UPDATE vpn_payments SET provider = ? WHERE ref = ?').run(action, ref);
    const why = await book(db, p, action, fetchRate, now);
    if (why) throw new MoneyInputError(`записано ${done}, дальше не вышло: ${why}`);
    done++;
  }
  return { done, skipped };
}
