/**
 * Быстрая запись из бота: строка → черновик операции → «Записать».
 *
 * Черновик живёт в памяти, сутки: это пара нажатий, а не данные. После
 * перезапуска его кнопки ответят «Черновик устарел», и строку проще прислать
 * заново, чем хранить недописанное в базе. Записанная операция от памяти не
 * зависит: «Отменить» несёт её номер прямо в callback_data.
 */
import crypto from 'node:crypto';
import type { Db } from '../db/index.js';
import { MoneyInputError, toRub } from '../money.js';
import { addExpense, addIncome, deleteOperation, listCategories, listProjects, listWallets, type Wallet } from '../ledger.js';
import { currentRate, type RateFetcher } from '../rates.js';
import { guessCategory, parseQuick, projectOf, type QuickKind } from './parse.js';
import type { Keyboard } from './api.js';
import { DAY, amount, ddmm, esc, mskDayStart, mskIso, rub } from './text.js';

export const SOURCE = 'bot';

/**
 * Кошелёк по валюте строки. USDT — на CryptoBot: там владелец держит деньги на
 * расходы VPN и туда же приходят деньги за рекламу. Валюта не названа — тоже
 * CryptoBot, если он есть. Кабинеты VPN (с ролью) сами не выбираются — это
 * деньги, поделённые с партнёром; их можно выбрать кнопкой «Кошелёк».
 */
export function pickWallet(wallets: readonly Wallet[], currency: string | null): Wallet | null {
  const live = wallets.filter((w) => !w.archived && !w.role);
  const cryptobot = live.find((w) => /cryptobot/i.test(w.name) && w.currency === 'USDT');
  if (currency === 'USDT' && cryptobot) return cryptobot;
  const same = currency ? live.find((w) => w.currency === currency) : undefined;
  return same ?? cryptobot ?? live[0] ?? null;
}

/** Что ляжет на кошелёк — посчитано при показе и записывается ровно оно. */
export interface Calc {
  /** микро в валюте кошелька */
  walletAmount: number;
  /** курс валюты кошелька к ₽ для этой операции */
  rate: number;
  rub: number;
  /** сумма названа в другой валюте и пересчитана */
  converted: boolean;
}

export interface Draft {
  id: string;
  kind: QuickKind;
  amount: number;
  /** валюта, названная в строке; null — валюта кошелька */
  currency: string | null;
  walletId: number;
  categoryId: number | null;
  projectId: number | null;
  /** начало дня по Москве, когда прислана строка */
  day: number;
  yesterday: boolean;
  note: string;
  createdAt: number;
  calc: Calc | null;
  /** почему записать нельзя (нет курса) */
  problem: string | null;
  savedOpId: number | null;
}

/** Что сделать с сообщением после нажатия. */
export interface Outcome {
  /** новый текст сообщения; нет — сообщение не трогаем */
  text?: string;
  keyboard?: Keyboard;
  /** ответ на нажатие — всплывающая строка */
  answer?: string;
  alert?: boolean;
}

type View = 'main' | 'cat' | 'proj' | 'wallet';

interface Card {
  title: string;
  sum: string;
  wallet: string;
  category: string;
  project: string;
  date: string;
  note: string;
}

export function cardText(c: Card): string {
  return [
    `<b>${c.title} · ${c.sum}</b>`,
    `Кошелёк: ${esc(c.wallet)}`,
    `Вид: ${esc(c.category)}`,
    `Проект: ${esc(c.project)}`,
    `Дата: ${c.date}`,
    c.note ? `Заметка: ${esc(c.note)}` : '',
  ].filter(Boolean).join('\n');
}

const TTL_MS = DAY;
const NOON = 12 * 3600_000;
const KIND_TITLE: Record<QuickKind, string> = { income: 'Доход', expense: 'Расход' };
// Короткие коды кнопок: callback_data — не больше 64 байт.
const cb = (id: string, action: string, arg?: number) => `q:${id}:${action}${arg === undefined ? '' : `:${arg}`}`;
/** Дата без времени — полдень по Москве, как на странице: операция не уедет в соседние сутки. */
const atOf = (d: Draft) => d.day - (d.yesterday ? DAY : 0) + NOON;

/** Имя по номеру, в том числе архивного — запись могла сослаться на него раньше. */
const nameById = (db: Db, table: 'categories' | 'projects' | 'wallets', id: number | null): string =>
  id === null ? '—' : ((db.prepare(`SELECT name FROM ${table} WHERE id = ?`).get(id) as { name: string } | undefined)?.name ?? '—');

/** Как записанная операция выглядит в сообщении — по базе, а не по черновику. */
function opCard(db: Db, opId: number): Card | null {
  const op = db.prepare('SELECT * FROM operations WHERE id = ?').get(opId) as
    | { kind: string; at: number; category_id: number | null; project_id: number | null; note: string; gross_rub: number }
    | undefined;
  if (!op) return null;
  const entry = db.prepare('SELECT wallet_id, amount FROM entries WHERE op_id = ? ORDER BY id LIMIT 1').get(opId) as { wallet_id: number; amount: number } | undefined;
  const wallet = entry ? listWallets(db).find((w) => w.id === entry.wallet_id) : undefined;
  const sum = !wallet || !entry || wallet.currency === 'RUB' ? rub(op.gross_rub) : `${amount(Math.abs(entry.amount), wallet.currency)} ≈ ${rub(op.gross_rub)}`;
  return {
    title: op.kind === 'income' ? 'Доход' : 'Расход',
    sum,
    wallet: wallet?.name ?? '—',
    category: nameById(db, 'categories', op.category_id),
    project: nameById(db, 'projects', op.project_id),
    date: ddmm(mskIso(op.at)),
    note: op.note,
  };
}

export class QuickEntry {
  private drafts = new Map<string, Draft>();

  constructor(private deps: { db: Db; fetchRate: RateFetcher; now: () => number }) {}

  /** Строка от владельца → черновик с кнопками; null — суммы в строке нет. */
  async start(text: string): Promise<Outcome | null> {
    const parsed = parseQuick(text);
    if (!parsed) return null;
    const { db, now } = this.deps;
    const wallet = pickWallet(listWallets(db), parsed.currency);
    if (!wallet) return { text: 'Кошельков нет — заведите их на странице «Деньги».' };
    const t = now();
    for (const [id, d] of this.drafts) if (t - d.createdAt > TTL_MS) this.drafts.delete(id);
    const d: Draft = {
      id: crypto.randomBytes(4).toString('hex'),
      kind: parsed.kind,
      amount: parsed.amount,
      // Без валюты — рубли: владелец считает в рублях (цены рекламы, тарифы), и
      // «+1500 сторис» на CryptoBot — это 1 500 ₽ ≈ 18 USDT, а не 1 500 USDT.
      currency: parsed.currency ?? 'RUB',
      walletId: wallet.id,
      ...this.guess(parsed.kind, parsed.note),
      day: mskDayStart(t),
      yesterday: false,
      // как на странице — 500 знаков: длиннее и черновик не влезет в сообщение Telegram
      note: parsed.note.slice(0, 500),
      createdAt: t,
      calc: null,
      problem: null,
      savedOpId: null,
    };
    this.drafts.set(d.id, d);
    return this.render(d, 'main');
  }

  /** Нажатие кнопки под черновиком или под записанной операцией. */
  async press(data: string): Promise<Outcome> {
    const undo = /^u:(\d{1,15})$/.exec(data);
    if (undo) return this.undo(Number(undo[1]));
    const m = /^q:([0-9a-f]{8}):([a-z]{1,2})(?::(\d{1,15}))?$/.exec(data);
    if (!m) return { answer: 'Кнопка устарела' };
    const d = this.drafts.get(m[1]!);
    if (!d || this.deps.now() - d.createdAt > TTL_MS) return { answer: 'Черновик устарел — пришлите заново' };
    if (d.savedOpId !== null) return { answer: 'Уже записано' };
    const arg = m[3] === undefined ? null : Number(m[3]);
    const { db } = this.deps;
    switch (m[2]) {
      case 'k':
        d.kind = d.kind === 'income' ? 'expense' : 'income';
        // виды у дохода и расхода свои — угадываем заново
        Object.assign(d, this.guess(d.kind, d.note));
        return this.render(d, 'main');
      case 'c': {
        if (arg === null) return this.render(d, 'cat');
        const cat = listCategories(db).find((c) => c.id === arg && c.kind === d.kind);
        if (!cat) return { answer: 'Такого вида нет' };
        d.categoryId = cat.id;
        const project = projectOf(d.kind, cat.name);
        if (project) d.projectId = listProjects(db).find((p) => p.name === project)?.id ?? d.projectId;
        return this.render(d, 'main');
      }
      case 'p':
        if (arg === null) return this.render(d, 'proj');
        if (arg !== 0 && !listProjects(db).some((p) => p.id === arg)) return { answer: 'Такого проекта нет' };
        d.projectId = arg === 0 ? null : arg;
        return this.render(d, 'main');
      case 'w':
        if (arg === null) return this.render(d, 'wallet');
        if (!listWallets(db).some((w) => w.id === arg && !w.archived)) return { answer: 'Такого кошелька нет' };
        d.walletId = arg;
        return this.render(d, 'main');
      case 'd':
        d.yesterday = !d.yesterday;
        return this.render(d, 'main');
      case 'b':
        return this.render(d, 'main');
      case 'x':
        this.drafts.delete(d.id);
        return { text: 'Отменено — ничего не записано.', answer: 'Отменено' };
      case 'ok':
        return this.save(d);
      default:
        return { answer: 'Кнопка устарела' };
    }
  }

  private guess(kind: QuickKind, note: string): { categoryId: number | null; projectId: number | null } {
    const g = guessCategory(kind, note);
    const { db } = this.deps;
    return {
      categoryId: listCategories(db).find((c) => c.kind === kind && c.name === g.category)?.id ?? null,
      projectId: g.project === null ? null : (listProjects(db).find((p) => p.name === g.project)?.id ?? null),
    };
  }

  /**
   * Сумма в валюте кошелька. Названа другая валюта («1 500 ₽» на CryptoBot) —
   * пересчёт по текущему курсу, до сотых (у BTC и ETH — до миллионных), а курс
   * операции подогнан под округлённую сумму: в отчёт ляжет ровно 1 500 ₽.
   */
  private async compute(d: Draft, wallet: Wallet): Promise<{ calc: Calc } | { problem: string }> {
    const { db, fetchRate, now } = this.deps;
    const walletRate = await currentRate(db, wallet.currency, fetchRate, now());
    if (walletRate === null) return { problem: `нет курса ${wallet.currency} — запишите на странице, вписав курс` };
    const stated = d.currency ?? wallet.currency;
    if (stated === wallet.currency) {
      return { calc: { walletAmount: d.amount, rate: walletRate, rub: toRub(d.amount, walletRate), converted: false } };
    }
    const statedRate = await currentRate(db, stated, fetchRate, now());
    if (statedRate === null) return { problem: `нет курса ${stated} — запишите на странице, вписав курс` };
    const rubs = toRub(d.amount, statedRate);
    const step = walletRate > 1000 ? 1 : 10_000;
    const walletAmount = Math.round(rubs / walletRate / step) * step;
    if (walletAmount <= 0) return { problem: `в ${wallet.currency} это меньше сотой` };
    return { calc: { walletAmount, rate: rubs / walletAmount, rub: rubs, converted: true } };
  }

  private async render(d: Draft, view: View): Promise<Outcome> {
    const { db } = this.deps;
    const wallets = listWallets(db);
    const wallet = wallets.find((w) => w.id === d.walletId);
    if (!wallet) return { answer: 'Кошелька больше нет — пришлите заново' };
    const r = await this.compute(d, wallet);
    d.calc = 'calc' in r ? r.calc : null;
    d.problem = 'problem' in r ? r.problem : null;

    const stated = d.currency ?? wallet.currency;
    let sum: string;
    if (!d.calc) sum = amount(d.amount, stated);
    else {
      const parts = [amount(d.calc.walletAmount, wallet.currency)];
      if (d.calc.converted) parts.unshift(amount(d.amount, stated));
      if (wallet.currency !== 'RUB' && stated !== 'RUB') parts.push(rub(d.calc.rub));
      sum = parts.join(' ≈ ');
    }
    const at = atOf(d);
    let text = cardText({
      title: KIND_TITLE[d.kind],
      sum,
      wallet: wallet.name,
      category: nameById(db, 'categories', d.categoryId),
      project: nameById(db, 'projects', d.projectId),
      date: `${ddmm(mskIso(at))}, ${d.yesterday ? 'вчера' : 'сегодня'}`,
      note: d.note,
    });
    if (d.problem) text += `\n\n⚠️ ${esc(d.problem)}`;

    const choose = (items: { id: number; label: string; on: boolean }[], action: string): Keyboard => {
      const rows: Keyboard = [];
      for (let i = 0; i < items.length; i += 2) {
        rows.push(items.slice(i, i + 2).map((x) => ({ text: `${x.on ? '✓ ' : ''}${x.label}`, callback_data: cb(d.id, action, x.id) })));
      }
      rows.push([{ text: '‹ Назад', callback_data: cb(d.id, 'b') }]);
      return rows;
    };
    let keyboard: Keyboard;
    if (view === 'cat') {
      keyboard = choose(listCategories(db).filter((c) => c.kind === d.kind).map((c) => ({ id: c.id, label: c.name, on: c.id === d.categoryId })), 'c');
    } else if (view === 'proj') {
      keyboard = choose(
        [...listProjects(db).map((p) => ({ id: p.id, label: p.name, on: p.id === d.projectId })), { id: 0, label: 'Без проекта', on: d.projectId === null }],
        'p'
      );
    } else if (view === 'wallet') {
      keyboard = choose(wallets.filter((w) => !w.archived).map((w) => ({ id: w.id, label: `${w.name} · ${w.currency}`, on: w.id === d.walletId })), 'w');
    } else {
      keyboard = [
        [{ text: '✅ Записать', callback_data: cb(d.id, 'ok') }, { text: 'Расход ⇄ Доход', callback_data: cb(d.id, 'k') }],
        [{ text: 'Вид', callback_data: cb(d.id, 'c') }, { text: 'Проект', callback_data: cb(d.id, 'p') }, { text: 'Кошелёк', callback_data: cb(d.id, 'w') }],
        [{ text: d.yesterday ? 'Сегодня' : 'Вчера', callback_data: cb(d.id, 'd') }, { text: 'Отмена', callback_data: cb(d.id, 'x') }],
      ];
    }
    return { text, keyboard };
  }

  /** Записывается то, что владелец видел в черновике: те же сумма и курс. */
  private save(d: Draft): Outcome {
    const { db, now } = this.deps;
    if (!d.calc) return { answer: d.problem ?? 'Нечего записывать', alert: true };
    const base = {
      at: atOf(d),
      walletId: d.walletId,
      amount: d.calc.walletAmount,
      rate: d.calc.rate,
      categoryId: d.categoryId,
      projectId: d.projectId,
      note: d.note,
      source: SOURCE,
    };
    let id: number;
    try {
      // Доход из бота — перевод на кошелёк, а не приём платёжки: комиссии нет.
      id = d.kind === 'income' ? addIncome(db, { ...base, feePct: 0 }, now()) : addExpense(db, base, now());
    } catch (err) {
      if (err instanceof MoneyInputError) return { answer: err.message, alert: true };
      throw err;
    }
    d.savedOpId = id;
    return { text: `✅ Записано\n${cardText(opCard(db, id)!)}`, keyboard: [[{ text: 'Отменить', callback_data: `u:${id}` }]], answer: 'Записано' };
  }

  /** «Отменить» под записанной: удаляет только то, что записал бот. */
  private undo(opId: number): Outcome {
    const { db } = this.deps;
    const op = db.prepare('SELECT source FROM operations WHERE id = ?').get(opId) as { source: string } | undefined;
    if (!op) return { answer: 'Операции уже нет' };
    if (op.source !== SOURCE) return { answer: 'Это не запись бота — удалите её на странице', alert: true };
    const card = opCard(db, opId)!;
    deleteOperation(db, opId);
    return { text: `↩️ Отменено — операция удалена\n${cardText(card)}`, answer: 'Удалено' };
  }
}
