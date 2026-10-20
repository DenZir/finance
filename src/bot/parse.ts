/**
 * Разбор строки быстрой записи: «сервер 20 usdt», «+1500 сторис».
 *
 * Только текст, без базы: доход это или расход, сумма, валюта, если названа, и
 * заметка — всё, что осталось. Вид и проект угадываются по словам заметки;
 * угадано не то — владелец поправит кнопкой до записи.
 */
import { MoneyInputError, parseAmount } from '../money.js';

export type QuickKind = 'income' | 'expense';
/** payout — выплата партнёру, payin — партнёр докинул разницу */
export type EntryKind = QuickKind | 'payout' | 'payin';

export interface Parsed {
  kind: EntryKind;
  /** расход оплатил партнёр из своих денег: «партнёр сервер 20 usdt» */
  partner: boolean;
  /** микро в валюте currency, а если она не названа — в валюте кошелька */
  amount: number;
  currency: string | null;
  note: string;
}

// Число: «1 500» и «1 500,50» — пробел только между тройками цифр, иначе
// «2 сервера 20 usdt» дали бы сумму 2; «20,5» и «20.5» — дробь, как в parseAmount.
const NUM = String.raw`\d{1,3}(?: \d{3})+(?:[.,]\d+)?|\d+(?:[.,]\d+)?`;
// Длинные формы раньше коротких: «рублей» не должно остановиться на «р».
// «руб» перечислен по формам, а не «руб\p{L}*», чтобы «рубашка» не стала валютой.
const CUR_WORDS = String.raw`₽|\$|usdt|usd|долл(?:ар(?:ов|а|ы)?)?\.?|руб(?:лей|ля|ль)?\.?|rub|ton|trx|btc|eth`;
const BEFORE = String.raw`(?<![\p{L}\d])(?<!\d[.,])`;
const AFTER = String.raw`(?![\p{L}\d])`;
const AMOUNT = new RegExp(String.raw`${BEFORE}(?:(\$|₽) ?)?(${NUM})(?: ?(${CUR_WORDS}|р\.?))?${AFTER}`, 'giu');
// Валюта отдельно от суммы: «usdt 20 сервер». Одинокое «р» тут не в счёт — без
// числа рядом это скорее буква, чем рубли.
const LONE_CURRENCY = new RegExp(String.raw`(?<![\p{L}\d])(${CUR_WORDS})${AFTER}`, 'iu');
const INCOME_WORD = /(?<![\p{L}\d])(?:доход\p{L}*|пришл[оаи]|получил\p{L}*)(?![\p{L}\d])/iu;
const EXPENSE_WORD = /(?<![\p{L}\d])расход\p{L}*(?![\p{L}\d])/iu;
// Расчёт с партнёром — по падежу: «партнёру 5000» — выплата ему, «от партнёра
// 3000» — он докинул, «партнёр сервер 20 usdt» — расход, оплаченный им. Только
// «партнёр» целым словом: «+10$ партнёрка» — доход партнёрки, а не он.
const PAYIN_WORD = /(?<![\p{L}\d])от партн[её]ра(?![\p{L}\d])/iu;
const PAYOUT_WORD = /(?<![\p{L}\d])(?:(?:выплат\p{L}*|докинул\p{L}*|отдал\p{L}*|перевел\p{L}*|перевёл\p{L}*) )?партн[её]ру(?![\p{L}\d])/iu;
const PARTNER_PAID = /(?<![\p{L}\d])(?:(?:платит|платил|оплатил|заплатил) )?партн[её]р(?: (?:платит|платил|оплатил|заплатил))?(?![\p{L}\d])/iu;

function currencyCode(token: string): string {
  const t = token.toLowerCase().replace(/\.$/, '');
  if (t === '₽' || t === 'р' || t === 'rub' || t.startsWith('руб')) return 'RUB';
  if (t === '$' || t === 'usdt' || t === 'usd' || t.startsWith('долл')) return 'USDT';
  return t.toUpperCase();
}

const cut = (s: string, at: number, len: number) => `${s.slice(0, at)} ${s.slice(at + len)}`;

/** null — суммы в строке нет. */
export function parseQuick(input: string): Parsed | null {
  // неразрывные пробелы (так копируются суммы с сайтов и из банков) — обычными
  let text = input.replace(/\s+/g, ' ').trim();
  let kind: EntryKind = 'expense';
  if (text.startsWith('+')) {
    kind = 'income';
    text = text.slice(1);
  } else if (/^[-−–]/.test(text)) {
    text = text.slice(1);
  }
  let partner = false;
  const settle = PAYIN_WORD.exec(text) ?? PAYOUT_WORD.exec(text);
  if (settle) {
    // расчёт, а не доход и не расход: «+» и «доход» тут ничего не меняют
    kind = /^от/i.test(settle[0]) ? 'payin' : 'payout';
    text = cut(text, settle.index, settle[0].length);
  } else {
    const income = INCOME_WORD.exec(text);
    const expense = income ? null : EXPENSE_WORD.exec(text);
    if (income) kind = 'income';
    const marker = income ?? expense;
    if (marker) text = cut(text, marker.index, marker[0].length);
    // доход со словом «партнёр» («+5000 партнёр») — по-прежнему партнёрка
    const paid = kind === 'expense' ? PARTNER_PAID.exec(text) : null;
    if (paid) {
      partner = true;
      text = cut(text, paid.index, paid[0].length);
    }
  }

  // Чисел может быть несколько («домен на 2 года 15 usdt»): сумма — то, рядом с
  // чем стоит валюта, а без валюты — первое.
  let best: { index: number; length: number; amount: number; currency: string | null } | null = null;
  for (const m of text.matchAll(AMOUNT)) {
    let micro: number;
    try {
      micro = parseAmount(m[2]);
    } catch (err) {
      if (err instanceof MoneyInputError) continue;
      throw err;
    }
    const cur = m[1] ?? m[3];
    const found = { index: m.index, length: m[0].length, amount: micro, currency: cur ? currencyCode(cur) : null };
    if (!best || (found.currency && !best.currency)) best = found;
    if (best.currency) break;
  }
  if (!best) return null;

  let rest = cut(text, best.index, best.length);
  let currency = best.currency;
  if (!currency) {
    const lone = LONE_CURRENCY.exec(rest);
    if (lone) {
      currency = currencyCode(lone[1]!);
      rest = cut(rest, lone.index, lone[0].length);
    }
  }
  const note = rest.replace(/ +/g, ' ').replace(/^[\s,.;:—–-]+|[\s,.;:—–-]+$/g, '');
  return { kind, partner, amount: best.amount, currency, note };
}

interface Rule {
  kind: QuickKind;
  /** начала слов, без «ё» */
  words: string[];
  category: string;
  project: string | null;
}

// Виды и проекты — по кодам из миграций (categories.code, projects.code):
// владелец может их переименовать, коды остаются. Порядок важен: «vpn сервис»
// — серверы VPN, а не подписка.
const RULES: readonly Rule[] = [
  { kind: 'expense', words: ['сервер', 'хостинг', 'vps', 'впн', 'vpn', 'домен', 'прокси'], category: 'vpn_infra', project: 'vpn' },
  { kind: 'expense', words: ['подписк', 'сервис', 'claude', 'chatgpt'], category: 'services', project: null },
  { kind: 'expense', words: ['закуп', 'реклам'], category: 'ads_buy', project: 'ads' },
  { kind: 'income', words: ['сторис', 'stories'], category: 'ads_stories', project: 'ads' },
  { kind: 'income', words: ['пост', 'реклам'], category: 'ads_posts', project: 'ads' },
  { kind: 'income', words: ['привет', 'заявк'], category: 'welcome', project: null },
  { kind: 'income', words: ['партнер', 'рефер'], category: 'partner', project: null },
  { kind: 'income', words: ['приват'], category: 'privat', project: 'privat' },
  { kind: 'income', words: ['впн', 'vpn'], category: 'vpn', project: 'vpn' },
];

const norm = (s: string) => s.toLowerCase().replace(/ё/g, 'е');

/** Код вида и проекта по словам заметки; ничего не подошло — «Прочее» без проекта. */
export function guessCategory(kind: QuickKind, note: string): { category: string; project: string | null } {
  const t = norm(note);
  const rule = RULES.find((r) => r.kind === kind && r.words.some((w) => t.includes(w)));
  return rule ? { category: rule.category, project: rule.project } : { category: kind === 'income' ? 'other_income' : 'other_expense', project: null };
}

/** Код проекта, который у вида сам собой разумеется: «Закуп рекламы» — «Реклама». */
export function projectOf(kind: QuickKind, categoryCode: string | null): string | null {
  return RULES.find((r) => r.kind === kind && r.category === categoryCode)?.project ?? null;
}
