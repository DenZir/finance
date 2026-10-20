/**
 * HTTP: вход через Telegram, API для страницы и сама страница.
 * Всё под /api — только для владельца с живой сессией.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type NextFunction, type Request, type Response } from 'express';
import cookieParser from 'cookie-parser';
import type { Db } from './db/index.js';
import type { Config } from './config.js';
import { SESSION_COOKIE, SESSION_MS, checkTelegramLogin, createSession, dropSession, sessionUser } from './auth.js';
import { MoneyInputError, parseAmount, parsePct, parseRate } from './money.js';
import {
  WALLET_KINDS, addAdjustment, addExpense, addIncome, addPayout, addTransfer, balances, createWallet, deleteOperation, getWallet,
  listCategories, listOperations, listProjects, listWallets, monthRange, monthReport, partnerDebts, updateWallet, yearReport,
  type Wallet,
  type WalletKind,
} from './ledger.js';
import { currentRate, type RateFetcher } from './rates.js';
import { adDebts, bulkMark, listDeals, payDeal, setBarter, setWaiting } from './ads.js';
import { listUnsorted, resolveVpn } from './vpn.js';
import { createWelcome, deleteFix, deleteWelcome, fixWelcome, listWelcome, payFix, updateWelcome, welcomeDebts } from './welcome.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

export interface AppDeps {
  db: Db;
  config: Pick<Config, 'botToken' | 'botUsername' | 'ownerIds'>;
  fetchRate: RateFetcher;
  now?: () => number;
}

const optId = (v: unknown): number | null => (v === undefined || v === null || v === '' ? null : Number(v));
const reqId = (v: unknown, what: string): number => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new MoneyInputError(`не выбран ${what}`);
  return n;
};

export function createApp({ db, config, fetchRate, now = Date.now }: AppDeps) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '100kb' }));
  app.use(cookieParser());

  // Курс для операции: рубль — 1, вписан руками — он, иначе текущий.
  const rateFor = async (currency: string, typed: unknown): Promise<number> => {
    if (currency === 'RUB') return 1;
    if (typed !== undefined && typed !== null && String(typed).trim() !== '') return parseRate(typed);
    const r = await currentRate(db, currency, fetchRate, now());
    if (r === null) throw new MoneyInputError(`нет курса ${currency} — впишите его руками`);
    return r;
  };

  // --- вход ---------------------------------------------------------------
  app.get('/api/login-info', (_req, res) => {
    res.json({ botUsername: config.botUsername });
  });

  // Виджет Telegram перенаправляет сюда с данными пользователя в адресе.
  app.get('/auth/telegram', (req, res) => {
    const check = checkTelegramLogin(req.query as Record<string, unknown>, config.botToken, config.ownerIds, Math.floor(now() / 1000));
    if (!check.ok) {
      console.warn(`[auth] вход отклонён: ${check.reason}`);
      res.redirect(`/?login_error=${encodeURIComponent(check.reason)}`);
      return;
    }
    const token = createSession(db, check.tgId, now());
    res.cookie(SESSION_COOKIE, token, { httpOnly: true, secure: req.secure || req.get('x-forwarded-proto') === 'https', sameSite: 'lax', maxAge: SESSION_MS });
    res.redirect('/');
  });

  app.post('/auth/logout', (req, res) => {
    dropSession(db, req.cookies?.[SESSION_COOKIE]);
    res.clearCookie(SESSION_COOKIE);
    res.json({ ok: true });
  });

  const requireOwner = (req: Request, res: Response, next: NextFunction) => {
    if (!sessionUser(db, req.cookies?.[SESSION_COOKIE], config.ownerIds, now())) {
      res.status(401).json({ error: 'нужно войти' });
      return;
    }
    next();
  };
  app.use('/api', requireOwner);

  // --- данные --------------------------------------------------------------
  app.get('/api/state', async (_req, res, next) => {
    try {
      const bal = balances(db);
      type WalletView = Wallet & { balance: number; rate: number | null; rubEstimate: number | null };
      const wallets: WalletView[] = [];
      for (const w of listWallets(db)) {
        const balance = bal.get(w.id) ?? 0;
        const rate = await currentRate(db, w.currency, fetchRate, now());
        wallets.push({ ...w, balance, rate, rubEstimate: rate === null ? null : Math.round(balance * rate) });
      }
      const sum = (pick: (w: WalletView) => boolean) =>
        wallets.filter((w) => !w.archived && pick(w)).reduce((s, w) => s + (w.rubEstimate ?? 0), 0);
      res.json({
        wallets,
        projects: listProjects(db),
        categories: listCategories(db),
        partners: partnerDebts(db),
        totals: { onProviders: sum((w) => w.kind === 'provider'), onWallets: sum((w) => w.kind !== 'provider') },
        ads: adDebts(db),
        welcome: (() => {
          const debts = welcomeDebts(db);
          return { owed: debts.reduce((s, d) => s + d.amount, 0), count: debts.length };
        })(),
      });
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/operations', (req, res) => {
    const { from, to } = monthRange(String(req.query.month ?? ''));
    res.json(listOperations(db, from, to));
  });

  app.get('/api/report', (req, res) => {
    const { from, to } = monthRange(String(req.query.month ?? ''));
    res.json(monthReport(db, from, to));
  });

  app.get('/api/year', (req, res) => {
    res.json(yearReport(db, Number(req.query.year)));
  });

  app.post('/api/operations', async (req, res, next) => {
    try {
      const b = req.body ?? {};
      const at = Number(b.at) || now();
      const base = { at, projectId: optId(b.projectId), note: String(b.note ?? '').slice(0, 500) };
      let id: number;
      switch (b.kind) {
        case 'income': {
          const w = getWallet(db, reqId(b.walletId, 'кошелёк'));
          id = addIncome(db, {
            ...base, walletId: w.id, amount: parseAmount(b.amount), categoryId: optId(b.categoryId),
            feePct: b.feePct === undefined || b.feePct === '' ? undefined : parsePct(b.feePct),
            rate: await rateFor(w.currency, b.rate),
          }, now());
          break;
        }
        case 'expense': {
          const w = getWallet(db, reqId(b.walletId, 'кошелёк'));
          id = addExpense(db, { ...base, walletId: w.id, amount: parseAmount(b.amount), categoryId: optId(b.categoryId), rate: await rateFor(w.currency, b.rate) }, now());
          break;
        }
        case 'transfer': {
          const from = getWallet(db, reqId(b.walletId, 'кошелёк, откуда'));
          const to = getWallet(db, reqId(b.toWalletId, 'кошелёк, куда'));
          id = addTransfer(db, {
            ...base, fromWalletId: from.id, amount: parseAmount(b.amount), fromRate: await rateFor(from.currency, b.rate),
            toWalletId: to.id, toAmount: parseAmount(b.toAmount), toRate: await rateFor(to.currency, b.toRate),
          }, now());
          break;
        }
        case 'payout': {
          const w = getWallet(db, reqId(b.walletId, 'кошелёк'));
          id = addPayout(db, { ...base, walletId: w.id, amount: parseAmount(b.amount), projectId: reqId(b.projectId, 'проект'), rate: await rateFor(w.currency, b.rate) }, now());
          break;
        }
        case 'adjust': {
          const w = getWallet(db, reqId(b.walletId, 'кошелёк'));
          id = addAdjustment(db, { at, walletId: w.id, balance: parseAmount(b.amount, { allowZero: true }), rate: await rateFor(w.currency, b.rate), note: base.note }, now());
          break;
        }
        default:
          throw new MoneyInputError('неизвестный вид операции');
      }
      res.json({ id });
    } catch (err) {
      next(err);
    }
  });

  app.delete('/api/operations/:id', (req, res) => {
    res.json({ deleted: deleteOperation(db, Number(req.params.id)) });
  });

  // --- реклама ---------------------------------------------------------------
  app.get('/api/ad-deals', (_req, res) => {
    res.json(listDeals(db));
  });

  // Отметка списком; refs и action проверяет bulkMark.
  app.post('/api/ad-deals/bulk', (req, res) => {
    const b = req.body ?? {};
    res.json(bulkMark(db, b.refs, b.action, now()));
  });

  // --- приветка ------------------------------------------------------------------
  app.get('/api/welcome', (_req, res) => {
    res.json(listWelcome(db));
  });
  app.post('/api/welcome', (req, res) => {
    res.json({ id: createWelcome(db, req.body ?? {}, now()) });
  });
  app.patch('/api/welcome/:id', (req, res) => {
    updateWelcome(db, reqId(req.params.id, 'размещение'), req.body ?? {});
    res.json({ ok: true });
  });
  app.delete('/api/welcome/:id', (req, res) => {
    deleteWelcome(db, reqId(req.params.id, 'размещение'));
    res.json({ ok: true });
  });
  app.post('/api/welcome/:id/fix', (req, res) => {
    res.json(fixWelcome(db, reqId(req.params.id, 'размещение'), req.body ?? {}, now()));
  });
  app.delete('/api/welcome-fix/:id', (req, res) => {
    deleteFix(db, reqId(req.params.id, 'фиксация'));
    res.json({ ok: true });
  });
  app.post('/api/welcome-fix/:id/pay', async (req, res, next) => {
    try {
      const b = req.body ?? {};
      const w = getWallet(db, reqId(b.walletId, 'кошелёк'));
      const id = payFix(db, reqId(req.params.id, 'фиксация'), {
        walletId: w.id, amount: parseAmount(b.amount), rate: await rateFor(w.currency, b.rate), at: Number(b.at) || now(),
      }, now());
      res.json({ id });
    } catch (err) {
      next(err);
    }
  });

  // --- VPN ---------------------------------------------------------------------
  app.get('/api/vpn/unsorted', (_req, res) => {
    res.json(listUnsorted(db));
  });

  // Платёжка для оплат, о которой VPN-бот не сказал; refs и action проверяет resolveVpn.
  app.post('/api/vpn/resolve', async (req, res, next) => {
    try {
      const b = req.body ?? {};
      res.json(await resolveVpn(db, b.refs, b.action, fetchRate, now()));
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/ad-deals/:ref/pay', async (req, res, next) => {
    try {
      const b = req.body ?? {};
      const w = getWallet(db, reqId(b.walletId, 'кошелёк'));
      const id = payDeal(db, String(req.params.ref), {
        walletId: w.id, amount: parseAmount(b.amount), rate: await rateFor(w.currency, b.rate), at: Number(b.at) || now(),
      }, now());
      res.json({ id });
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/ad-deals/:ref/barter', (req, res) => {
    setBarter(db, String(req.params.ref), req.body?.on !== false, now());
    res.json({ ok: true });
  });

  app.post('/api/ad-deals/:ref/waiting', (req, res) => {
    setWaiting(db, String(req.params.ref), req.body?.on !== false, now());
    res.json({ ok: true });
  });

  app.post('/api/wallets', (req, res) => {
    const b = req.body ?? {};
    const kind = String(b.kind ?? '') as WalletKind;
    if (!WALLET_KINDS.includes(kind)) throw new MoneyInputError('неизвестный вид кошелька');
    const id = createWallet(db, { name: String(b.name ?? ''), currency: String(b.currency ?? ''), kind, feePct: b.feePct === undefined || b.feePct === '' ? 0 : parsePct(b.feePct) }, now());
    res.json({ id });
  });

  app.patch('/api/wallets/:id', (req, res) => {
    const b = req.body ?? {};
    updateWallet(db, Number(req.params.id), {
      name: b.name === undefined ? undefined : String(b.name),
      feePct: b.feePct === undefined ? undefined : parsePct(b.feePct),
      archived: b.archived === undefined ? undefined : Boolean(b.archived),
    });
    res.json({ ok: true });
  });

  app.use(express.static(PUBLIC_DIR));

  // Ошибка ввода — понятным текстом владельцу; остальное — в журнал.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof MoneyInputError) {
      res.status(400).json({ error: err.message });
      return;
    }
    console.error('[server] ошибка:', err);
    res.status(500).json({ error: 'внутренняя ошибка — смотрите журнал' });
  });

  return app;
}
