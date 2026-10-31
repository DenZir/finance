/**
 * Долги в боте — по людям (владелец, 2026-10-31): у человека сразу всё, что
 * он должен, из всех источников — продажи рекламы и фиксации приветки — в
 * «Нам должны», закупы рекламы — в «Мы должны». Источник — personDebts
 * (debts.ts): там же частичные оплаты, аванс и прощённые остатки, поэтому
 * здесь везде остаток (remaining), а не сумма позиции.
 *
 * Раз в день — напоминание. Долг — только то, чей день уже наступил: реклама,
 * которая ещё не вышла, — пока не долг. Сделки CPM без суммы позициями долга не
 * бывают (платить пока не за что), но и не теряются: они под своим человеком
 * строкой «сумма ещё не известна».
 */
import type { Db } from '../db/index.js';
import type { AdDealView } from '../ads.js';
import type { DebtDir, PersonDebts } from '../debts.js';
import { personLabel } from '../people.js';
import { DAY, ddmm, esc, mskDayStart, num, rub } from './text.js';

/** Места — как на странице и в debts.ts. */
const SLOT_NAMES: Record<string, string> = { morning: 'утро', day: 'день', evening: 'вечер', night: 'ночь', n9: '9:00', n17: '17:00' };
const NO_CONTACT = 'без контакта';
/**
 * Отступ позиций под человеком. Неразрывные пробелы: обычные в начале строки
 * клиенты Telegram местами съедают, и позиции слипаются со строкой человека.
 */
const INDENT = '  – ';

interface Line {
  ref: string;
  date: string;
  what: string;
  /** ₽-микро, сколько ещё ждём; null — CPM, сумма ещё не известна */
  remaining: number | null;
  /** ₽-микро позиции целиком; > remaining — часть уже закрыта */
  amount: number | null;
}

interface Who {
  key: string;
  label: string;
  /** null — без контакта: ни аванса, ни взаимозачёта у такой группы нет */
  person: PersonDebts | null;
  in: Line[];
  out: Line[];
}

const byDate = (a: Line, b: Line) => a.date.localeCompare(b.date) || a.ref.localeCompare(b.ref, 'en', { numeric: true });
const known = (lines: readonly Line[]) => lines.reduce((s, l) => s + (l.remaining ?? 0), 0);
const unknown = (lines: readonly Line[]) => lines.filter((l) => l.remaining === null).length;

/** «2 300 ₽», «2 300 ₽ + ещё 1 без суммы», «сумма ещё не известна» */
function total(lines: readonly Line[], more: string): string {
  const k = known(lines), u = unknown(lines);
  if (u && !k) return 'сумма ещё не известна';
  return `${rub(k)}${u ? ` + ${more}${u} без суммы` : ''}`;
}

function cpmWhat(d: AdDealView): string {
  const place = d.slot === 'stories' ? 'сторисы' : `пост ${SLOT_NAMES[d.slot] ?? d.slot}`;
  return [place, d.channels].filter(Boolean).join(' · ');
}

/**
 * Текст долгов на сегодня (ГГГГ-ММ-ДД по Москве); null — никто никому не должен.
 * deals — сделки рекламы (listDeals): из них берутся только CPM без суммы,
 * остальное уже есть в people позициями.
 */
export function debtsText(people: readonly PersonDebts[], today: string, deals: readonly AdDealView[] = []): string | null {
  const groups = new Map<string, Who>();
  const groupOf = (key: string, label: string, person: PersonDebts | null): Who => {
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { key, label, person, in: [], out: [] }));
    return g;
  };
  const keyOf = (personId: number | null) => (personId === null ? 'none' : `p${personId}`);

  for (const p of people) {
    const g = groupOf(keyOf(p.personId), p.personId === null ? NO_CONTACT : personLabel(p), p.personId === null ? null : p);
    for (const it of p.items) {
      if (it.remaining <= 0 || it.date > today) continue;
      g[it.dir].push({ ref: it.ref, date: it.date, what: it.what, remaining: it.remaining, amount: it.amount });
    }
  }
  // CPM без суммы: к своему человеку, если он есть в долгах, иначе — по контакту из аналитики
  for (const d of deals) {
    if (d.amount !== null || d.state !== 'waiting' || d.cancelled || d.date > today) continue;
    const g = d.personId !== null && groups.has(keyOf(d.personId))
      ? groups.get(keyOf(d.personId))!
      : d.contact ? groupOf(`c${d.contact}`, d.contact, null) : groupOf(keyOf(null), NO_CONTACT, null);
    g[d.kind === 'sale' ? 'in' : 'out'].push({ ref: d.ref, date: d.date, what: cpmWhat(d), remaining: null, amount: null });
  }

  const age = (date: string) => {
    const days = Math.round((Date.parse(today) - Date.parse(date)) / DAY);
    return days ? `${days} дн.` : 'сегодня';
  };
  const itemLine = (l: Line) => {
    const sum = l.remaining === null
      ? 'сумма ещё не известна'
      : l.amount !== null && l.amount > l.remaining ? `${rub(l.remaining)}, оплачено ${num(l.amount - l.remaining, 2)} из ${rub(l.amount)}` : rub(l.remaining);
    return `${INDENT}${esc(l.what)} · ${ddmm(l.date)} · ${sum} · ${age(l.date)}`;
  };
  const personLine = (g: Who, dir: DebtDir) => {
    const notes = [`• ${esc(g.label)} — ${total(g[dir], '')}`];
    const p = g.person;
    if (p?.advanceIn) notes.push(`его аванс ${rub(p.advanceIn)}`);
    if (p?.advanceOut) notes.push(`наш аванс ${rub(p.advanceOut)}`);
    // взаимозачёт — только по тому, что уже долг с обеих сторон и с известной суммой
    const offset = p ? Math.min(known(g.in), known(g.out)) : 0;
    if (offset > 0) notes.push(`можно взаимозачёт на ${rub(offset)}`);
    return notes.join(' · ');
  };
  const block = (title: string, dir: DebtDir) => {
    const list = [...groups.values()].filter((g) => g[dir].length);
    if (!list.length) return null;
    for (const g of list) g[dir].sort(byDate);
    // самые давние долги сверху: им пора напомнить первыми
    list.sort((a, b) => byDate(a[dir][0]!, b[dir][0]!) || a.label.localeCompare(b.label, 'ru'));
    const all = list.flatMap((g) => g[dir]);
    return [`${title} ${total(all, 'ещё ')}`, ...list.flatMap((g) => [personLine(g, dir), ...g[dir].map(itemLine)])].join('\n');
  };
  const blocks = [block('💸 Нам должны', 'in'), block('🧾 Мы должны', 'out')].filter((b) => b !== null);
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
