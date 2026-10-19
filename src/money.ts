/**
 * Деньги в целых «микро» — миллионных долях единицы. Здесь всё, что переводит
 * их из текста и обратно; больше нигде с дробями не работаем.
 */

export const MICRO = 1_000_000;

export class MoneyInputError extends Error {}

/**
 * «10 000,50», «10000.5», «9 700» → микро. Пробелы (и неразрывные) — разделитель
 * разрядов, запятая и точка — дробной части. Отрицательное и пустое отвергается:
 * знак задаёт вид операции, а не минус в поле.
 */
export function parseAmount(input: unknown, opts: { allowZero?: boolean } = {}): number {
  const s = String(input ?? '').replace(/[\s\u00a0\u202f]/g, '').replace(',', '.');
  if (!/^\d+(\.\d{1,6})?$/.test(s)) throw new MoneyInputError(`«${String(input ?? '')}» — не сумма. Пример: 10 000,50`);
  const [int, frac = ''] = s.split('.');
  const micro = Number(int) * MICRO + Number(frac.padEnd(6, '0'));
  if (!Number.isSafeInteger(micro)) throw new MoneyInputError('слишком большая сумма');
  if (micro === 0 && !opts.allowZero) throw new MoneyInputError('сумма — ноль');
  return micro;
}

/** Процент комиссии: «14», «3,5». От 0 до 100. */
export function parsePct(input: unknown): number {
  const s = String(input ?? '').trim().replace(',', '.');
  const n = Number(s);
  if (s === '' || !Number.isFinite(n) || n < 0 || n >= 100) throw new MoneyInputError(`«${String(input ?? '')}» — не процент от 0 до 100`);
  return n;
}

/** Курс к рублю: сколько рублей за единицу валюты. */
export function parseRate(input: unknown): number {
  const s = String(input ?? '').replace(/[\s\u00a0]/g, '').replace(',', '.');
  const n = Number(s);
  if (s === '' || !Number.isFinite(n) || n <= 0) throw new MoneyInputError(`«${String(input ?? '')}» — не курс`);
  return n;
}

/** Микро × курс → рубли-микро, округлено до копейки. */
export function toRub(micro: number, rate: number): number {
  return Math.round((micro * rate) / 10_000) * 10_000;
}

/** Доля в микро: процент от суммы, округлено до копейки. */
export function pctOf(micro: number, pct: number): number {
  return Math.round((micro * pct) / 100 / 10_000) * 10_000;
}

/** Для показа: микро → число (рубли до копеек, крипта до 6 знаков). */
export function fromMicro(micro: number): number {
  return micro / MICRO;
}
