/**
 * Долги по рекламе в боте: сделки с отметкой «Ждём оплату» (ads.ts) — продажи
 * «Нам должны», закупы «Мы должны». Раз в день — напоминание о тех, чей день
 * уже наступил: реклама, которая ещё не вышла, — пока не долг.
 */
import type { Db } from '../db/index.js';
import type { AdDealView } from '../ads.js';
import { DAY, ddmm, esc, mskDayStart, rub } from './text.js';

/** Места — как на странице. */
const SLOT_NAMES: Record<string, string> = { morning: 'утро', day: 'день', evening: 'вечер', night: 'ночь', stories: 'сторисы', n9: '9:00', n17: '17:00' };

/** Текст долгов на сегодня (ГГГГ-ММ-ДД по Москве); null — никто никому не должен. */
export function debtsText(deals: readonly AdDealView[], today: string): string | null {
  const due = deals
    .filter((d) => d.state === 'waiting' && !d.cancelled && d.date <= today)
    // самые давние сверху: им пора напомнить первыми
    .sort((a, b) => a.date.localeCompare(b.date) || a.ref.localeCompare(b.ref));
  const block = (title: string, list: AdDealView[]) => {
    if (!list.length) return null;
    const known = list.reduce((s, d) => s + (d.amount ?? 0), 0);
    const unknown = list.filter((d) => d.amount === null).length;
    // CPM ждёт просмотров — суммы ещё нет, но сам долг есть
    const total = unknown && !known ? 'сумма ещё не известна' : `${rub(known)}${unknown ? ` + ещё ${unknown} без суммы` : ''}`;
    const lines = list.map((d) => {
      const days = Math.round((Date.parse(today) - Date.parse(d.date)) / DAY);
      return `• ${esc(d.contact || d.channels || 'без контакта')} — ${d.amount === null ? 'сумма ещё не известна' : rub(d.amount)}`
        + ` · ${esc(SLOT_NAMES[d.slot] ?? d.slot)} ${ddmm(d.date)} · ${days ? `${days} дн.` : 'сегодня'}`;
    });
    return [`${title} ${total}`, ...lines].join('\n');
  };
  const blocks = [
    block('💸 Нам должны', due.filter((d) => d.kind === 'sale')),
    block('🧾 Мы должны', due.filter((d) => d.kind === 'buy')),
  ].filter((b) => b !== null);
  return blocks.length ? blocks.join('\n\n') : null;
}

/**
 * Пора ли напоминать: час по Москве настал, а сегодня ещё не напоминали.
 * Сервер, поднятый после этого часа, напомнит сразу — но только если сегодня
 * напоминания ещё не было.
 */
export function reminderDue(now: number, hour: number, lastDay: number | null): boolean {
  const day = mskDayStart(now);
  return now - day >= hour * 3600_000 && (lastDay === null || lastDay < day);
}

// День последнего напоминания — в import_state, как курсоры импорта: миграция
// ради одного числа не нужна, а память процесса перезапуск не переживает.
const STATE_SOURCE = 'reminder';

export function lastReminderDay(db: Db): number | null {
  return (db.prepare('SELECT cursor FROM import_state WHERE source = ?').get(STATE_SOURCE) as { cursor: number } | undefined)?.cursor ?? null;
}

export function markReminderDay(db: Db, day: number): void {
  db.prepare('INSERT INTO import_state (source, cursor) VALUES (?, ?) ON CONFLICT(source) DO UPDATE SET cursor = excluded.cursor').run(STATE_SOURCE, day);
}
