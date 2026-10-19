/**
 * Суммы и даты в сообщениях бота — как на странице: разряды пробелом, дробь
 * через запятую, день по Москве. Пробел разрядов неразрывный, чтобы Telegram не
 * переносил «1 500» на две строки.
 */

export const MSK = 3 * 3600_000;
export const DAY = 24 * 3600_000;

/** Микро → «1 500», «18,29», «0,000123»: не больше digits знаков после запятой, без хвостовых нулей. */
export function num(micro: number, digits = 6): string {
  const units = Math.round(Math.abs(micro) / 10 ** (6 - digits));
  const div = 10 ** digits;
  const int = String(Math.floor(units / div)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  const frac = digits ? String(units % div).padStart(digits, '0').replace(/0+$/, '') : '';
  return `${micro < 0 && units > 0 ? '−' : ''}${int}${frac ? `,${frac}` : ''}`;
}

/** Рубли до копеек. */
export const rub = (micro: number) => `${num(micro, 2)} ₽`;

/** Сумма в валюте: рубли до копеек, крипта до шести знаков. */
export const amount = (micro: number, currency: string) => (currency === 'RUB' ? rub(micro) : `${num(micro)} ${currency}`);

/** Для parse_mode HTML: всё, что написали люди, — только так. */
export const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);

/** Начало суток по Москве (UTC+3, без перехода на летнее время), UTC мс. */
export const mskDayStart = (ms: number) => Math.floor((ms + MSK) / DAY) * DAY - MSK;

/** ГГГГ-ММ-ДД по Москве. */
export const mskIso = (ms: number) => new Date(ms + MSK).toISOString().slice(0, 10);

/** ГГГГ-ММ-ДД → ДД.ММ */
export const ddmm = (iso: string) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}`;
