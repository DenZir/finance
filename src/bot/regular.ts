/** /regular — регулярные расходы месяца одним списком. */
import type { RecurringMonth } from '../recurring.js';
import { amount, ddmm, esc, monthName } from './text.js';

const STATE: Record<RecurringMonth['state'], string> = { paid: '✅ записан', skipped: '⏭ пропущен', due: '⏳ ждёт', upcoming: 'будет' };

export function regularText(list: readonly RecurringMonth[], month: string): string {
  const lines = list.map((r) => {
    const when = r.state === 'upcoming' ? `${STATE.upcoming} ${ddmm(r.dueDate)}` : r.state === 'due' ? `${STATE.due} с ${ddmm(r.dueDate)}` : STATE[r.state];
    return `• ${esc(r.name)} — ${amount(r.amount, r.currency)} · ${when}`;
  });
  return [`🔁 Регулярные расходы · ${monthName(month)}`, ...lines].join('\n');
}
