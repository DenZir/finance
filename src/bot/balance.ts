/**
 * /balance — то же, что плашки и кошельки на странице: остаток каждого кошелька
 * в его валюте и ≈ в рублях по текущему курсу, итоги «на платёжках» и «на
 * кошельках», долг партнёру.
 */
import type { Db } from '../db/index.js';
import { balances, listWallets, partnerDebts } from '../ledger.js';
import { currentRate, type RateFetcher } from '../rates.js';
import { amount, esc, rub } from './text.js';

export async function balanceText(db: Db, fetchRate: RateFetcher, now = Date.now()): Promise<string> {
  const bal = balances(db);
  const lines = ['<b>Остатки</b>'];
  let onProviders = 0;
  let onWallets = 0;
  for (const w of listWallets(db).filter((x) => !x.archived)) {
    const balance = bal.get(w.id) ?? 0;
    const rate = await currentRate(db, w.currency, fetchRate, now);
    const estimate = rate === null ? null : Math.round(balance * rate);
    if (estimate !== null) {
      if (w.kind === 'provider') onProviders += estimate;
      else onWallets += estimate;
    }
    const sum = w.currency === 'RUB' ? rub(balance) : `${amount(balance, w.currency)} ${estimate === null ? '· курса нет' : `≈ ${rub(estimate)}`}`;
    lines.push(`${esc(w.name)} — ${sum}`);
  }
  lines.push('', `На платёжках: ${rub(onProviders)}`, `На кошельках: ${rub(onWallets)}`);
  for (const p of partnerDebts(db)) {
    lines.push(p.owed >= 0 ? `Должен партнёру · ${esc(p.name)}: ${rub(p.owed)}` : `Партнёр по «${esc(p.name)}» должен вам: ${rub(-p.owed)}`);
  }
  return lines.join('\n');
}
