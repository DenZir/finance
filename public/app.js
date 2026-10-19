// Страница учёта: плашки, кошельки, итоги месяца, операции.
// Суммы приходят в «микро» (миллионных долях единицы) — переводим только при показе.

const $ = (s) => document.querySelector(s);
const MICRO = 1e6;
const MSK = 3 * 3600e3;
const KIND_LABEL = { provider: 'платёжка', crypto: 'крипта', card: 'карта', cash: 'наличные' };
const OP_LABEL = { income: 'Доход', expense: 'Расход', transfer: 'Перевод', payout: 'Партнёру', adjust: 'Остаток' };

let S = null; // state
let month = monthOf(Date.now());
let opKind = 'income';
let deals = [];
let adsAll = false;
let payRef = null;

function monthOf(ms) {
  const d = new Date(ms + MSK);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}
function shiftMonth(m, delta) {
  const [y, mo] = m.split('-').map(Number);
  const d = new Date(Date.UTC(y, mo - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const rub = (micro) => `${(Math.round(micro / 10_000) / 100).toLocaleString('ru-RU', { minimumFractionDigits: 0, maximumFractionDigits: 2 })} ₽`;
const amt = (micro, cur) =>
  cur === 'RUB' ? rub(micro) : `${(micro / MICRO).toLocaleString('ru-RU', { maximumFractionDigits: 6 })} ${esc(cur)}`;
const day = (ms) => new Date(ms + MSK).toISOString().slice(8, 10) + '.' + new Date(ms + MSK).toISOString().slice(5, 7);

function toast(text) {
  const t = $('#toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (t.hidden = true), 3500);
}

async function api(path, init = {}) {
  const res = await fetch(path, { ...init, headers: { 'content-type': 'application/json', ...(init.headers || {}) } });
  if (res.status === 401) {
    showLogin();
    throw new Error('нужно войти');
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `ошибка ${res.status}`);
  return body;
}

// --- вход -----------------------------------------------------------------
async function showLogin() {
  $('#app').hidden = true;
  $('#login').hidden = false;
  const err = new URLSearchParams(location.search).get('login_error');
  if (err) {
    $('#loginError').textContent = `Не вышло: ${err}`;
    $('#loginError').hidden = false;
  }
  // три запроса страницы получают 401 разом — кнопку входа вставляем один раз
  if (showLogin.started) return;
  showLogin.started = true;
  const { botUsername } = await fetch('/api/login-info').then((r) => r.json());
  const s = document.createElement('script');
  s.async = true;
  s.src = 'https://telegram.org/js/telegram-widget.js?22';
  s.dataset.telegramLogin = botUsername;
  s.dataset.size = 'large';
  s.dataset.radius = '10';
  s.dataset.authUrl = '/auth/telegram';
  $('#widget').append(s);
}

// --- отрисовка -------------------------------------------------------------
const nameOf = (list, id) => list.find((x) => x.id === id)?.name ?? '—';

function renderTiles(report) {
  const vpn = S.partners[0];
  const tile = (label, value, sub, cls = '') => `<div class="tile ${cls}"><span>${label}</span><b>${value}</b><span>${sub}</span></div>`;
  $('#tiles').innerHTML =
    tile('На платёжках', rub(S.totals.onProviders), 'ещё не выведено') +
    tile('На кошельках', rub(S.totals.onWallets), 'выведено и лежит') +
    (vpn
      ? tile(`Должен партнёру · ${esc(vpn.name)}`, rub(Math.max(vpn.owed, 0)), vpn.owed < 0 ? `партнёр должен вам ${rub(-vpn.owed)}` : `${vpn.pct}% дохода и расходов`, vpn.owed > 0 ? 'warn' : '')
      : tile('Должен партнёру', '—', 'нет проектов с партнёром')) +
    tile('Чистыми за месяц', rub(report.net), 'доход − комиссии − расходы', report.net >= 0 ? 'good' : 'bad') +
    tile('Нам должны', rub(S.ads.owedToUs), S.ads.owedToUsCount ? `ждём оплату за продажи: ${S.ads.owedToUsCount}` : 'никто не должен', S.ads.owedToUs ? 'warn' : '') +
    tile('Мы должны', rub(S.ads.weOwe), S.ads.weOweCount ? `надо оплатить закупы: ${S.ads.weOweCount}` : 'никому не должны', S.ads.weOwe ? 'warn' : '');
}

// --- реклама ------------------------------------------------------------------
const SLOT = { morning: 'утро', day: 'день', evening: 'вечер', night: 'ночь', stories: 'сторисы', n9: '9:00', n17: '17:00' };
const dealDay = (date) => `${date.slice(8, 10)}.${date.slice(5, 7)}`;
const dealTitle = (d) => `${d.kind === 'sale' ? 'Продажа' : 'Закуп'} · ${SLOT[d.slot] ?? esc(d.slot)}`;

// сколько дней прошло с дня места; для будущих — через сколько
function dealAge(date) {
  const days = Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${todayIso()}T00:00:00Z`)) / 86400e3);
  if (days === 0) return 'сегодня';
  return days < 0 ? `${-days} дн. назад` : `через ${days} дн.`;
}

function dealLine(d) {
  const sum = d.amount == null ? '<span class="muted">суммы ещё нет</span>' : `<span class="${d.kind === 'sale' ? 'plus' : 'minus'}">${d.kind === 'sale' ? '+' : '−'}${rub(d.amount)}</span>`;
  const ref = esc(d.ref);
  const waitLabel = d.kind === 'sale' ? 'Ждём оплату' : 'Надо оплатить';
  let acts;
  if (d.state === 'paid') acts = `<span class="chip">оплачено</span>${d.cancelled ? ' <span class="chip warn">отменена в аналитике</span>' : ''}`;
  else if (d.state === 'barter') acts = `<span class="chip">бартер</span><button class="btn ghost" type="button" data-unbarter="${ref}">Вернуть</button>`;
  else if (d.cancelled) acts = `<span class="chip">отменена</span>${d.state === 'waiting' ? `<button class="btn ghost" type="button" data-unwait="${ref}">Не ждём</button>` : ''}`;
  else if (d.state === 'waiting')
    acts = `<button class="btn primary" type="button" data-pay="${ref}">Оплачено</button><button class="btn" type="button" data-barter="${ref}">Бартер</button><button class="btn ghost" type="button" data-unwait="${ref}" title="Вернуть в неразобранные">×</button>`;
  else
    acts = `<button class="btn primary" type="button" data-pay="${ref}">Оплачено</button><button class="btn" type="button" data-wait="${ref}">${waitLabel}</button><button class="btn" type="button" data-barter="${ref}">Бартер</button>`;
  const done = d.state === 'paid' || d.state === 'barter' || d.cancelled;
  const sub = [esc(d.contact), esc(d.channels), d.state === 'waiting' && !d.cancelled ? `<span class="age">${dealAge(d.date)}</span>` : ''].filter(Boolean).join(' · ');
  return `<div class="deal${done ? ' done' : ''}"><span class="when">${dealDay(d.date)}</span>
    <div class="what"><b>${dealTitle(d)}</b><small>${sub}</small></div>
    <div class="sum">${sum}</div><div class="acts">${acts}</div></div>`;
}

function renderAds() {
  $('#adsCard').hidden = !deals.length;
  if (!deals.length) return;
  $('#adsAll').textContent = adsAll ? 'Свернуть' : 'Все сделки';
  if (adsAll) {
    const all = [...deals].sort((a, b) => b.date.localeCompare(a.date));
    $('#ads').innerHTML = all.map(dealLine).join('');
    return;
  }
  // ждём оплату — самые давние сверху: они первые, кому пора напомнить;
  // оплаченная, но отменённая в аналитике тоже на виду
  const waiting = deals.filter((d) => (d.state === 'waiting' && !d.cancelled) || (d.state === 'paid' && d.cancelled) || (d.state === 'waiting' && d.cancelled));
  const unsorted = deals.filter((d) => d.state === 'open' && !d.cancelled);
  const group = (title, list, empty) =>
    `<h3 class="ads-h">${title}${list.length ? ` · ${list.length}` : ''}</h3>` + (list.length ? list.map(dealLine).join('') : `<div class="empty">${empty}</div>`);
  const unknown = S.ads.unknown ? `<div class="ads-sum"><span>без суммы: ${S.ads.unknown} — CPM ждёт просмотров или ПДП подсчёта, в долги пока не входят</span></div>` : '';
  $('#ads').innerHTML =
    group('Ждём оплату', waiting, 'Никто никому не должен.') + unknown +
    (unsorted.length ? group('Не разобраны', unsorted, '') : '');
}

function openPay(ref) {
  const d = deals.find((x) => x.ref === ref);
  if (!d) return;
  payRef = ref;
  const f = $('#payForm');
  f.reset();
  $('#payError').hidden = true;
  $('#payTitle').textContent = d.kind === 'sale' ? 'Продажа оплачена' : 'Закуп оплачен';
  $('#payDeal').textContent = `${dealDay(d.date)} · ${dealTitle(d)} · ${[d.contact, d.channels].filter(Boolean).join(' · ')}${d.amount != null ? ` · ${rub(d.amount)}` : ''}`;
  f.walletId.innerHTML = adWallets().map((w) => `<option value="${w.id}">${esc(w.name)} · ${esc(w.currency)}</option>`).join('');
  f.date.value = todayIso();
  $('#payAmountLabel').firstChild.textContent = d.kind === 'sale' ? 'Сколько пришло' : 'Сколько ушло';
  $('#payHint').textContent = d.kind === 'sale'
    ? 'Доход «Реклама», без комиссии. Сумма сделки пересчитана по курсу — впишите, сколько пришло на самом деле (при взаимозачёте — разницу).'
    : 'Расход «Закуп рекламы» с этого кошелька, без комиссии.';
  syncPay();
  $('#payDlg').showModal();
}

// За рекламу платят переводом на CryptoBot: он первым, а платёжки, принимающие
// оплату картой (Platega), в список не попадают.
const adWallets = () =>
  S.wallets
    .filter((w) => !w.archived && (w.kind !== 'provider' || /cryptobot/i.test(w.name)))
    .sort((a, b) => /cryptobot/i.test(b.name) - /cryptobot/i.test(a.name));

// сумма сделки — в рублях; на кошелёк в другой валюте подставляем по курсу
function syncPay() {
  const f = $('#payForm');
  const d = deals.find((x) => x.ref === payRef);
  const w = S.wallets.find((x) => String(x.id) === f.walletId.value);
  f.querySelector('[data-pay-rate]').hidden = !w || w.currency === 'RUB';
  if (!d || d.amount == null || !w) return;
  const v = w.currency === 'RUB' ? d.amount / MICRO : w.rate ? Math.round((d.amount / MICRO / w.rate) * 100) / 100 : '';
  f.amount.value = v === '' ? '' : String(v).replace('.', ',');
}


function renderWallets() {
  const list = S.wallets.filter((w) => !w.archived);
  $('#wallets').innerHTML = list.length
    ? list
        .map(
          (w) => `<div class="wallet">
          <div class="nm"><span>${esc(w.name)}</span><span class="chip">${KIND_LABEL[w.kind] ?? w.kind}${w.feePct ? ` · ${w.feePct}%` : ''}</span></div>
          <b>${amt(w.balance, w.currency)}</b>
          <small>${w.currency === 'RUB' ? '&nbsp;' : w.rubEstimate == null ? 'курса нет' : `≈ ${rub(w.rubEstimate)} · 1 ${esc(w.currency)} = ${w.rate.toLocaleString('ru-RU', { maximumFractionDigits: 2 })} ₽`}</small>
        </div>`
        )
        .join('')
    : '<div class="empty">Кошельков нет — добавьте первый.</div>';
}

function renderReport(r) {
  const rows = (list, kind) =>
    list.length
      ? list.map((x) => `<tr><td>${esc(nameOf(S.categories, x.categoryId))}<br><small class="muted">${esc(nameOf(S.projects, x.projectId))}</small></td><td class="num ${kind}">${rub(x.rub)}</td></tr>`).join('')
      : '<tr><td class="muted" colspan="2">нет</td></tr>';
  $('#report').innerHTML = `<div class="rep">
    <div><h3>Доходы</h3><table>${rows(r.income, 'plus')}<tr class="total"><td>Всего</td><td class="num">${rub(r.totalIncome)}</td></tr></table></div>
    <div><h3>Комиссии и расходы</h3><table>
      <tr><td>Комиссии платёжек</td><td class="num minus">${rub(r.incomeFees)}</td></tr>
      <tr><td>Потери при выводе и обмене</td><td class="num minus">${rub(r.transferFees)}</td></tr>
      ${rows(r.expense, 'minus')}
      <tr class="total"><td>Чистыми</td><td class="num ${r.net >= 0 ? 'plus' : 'minus'}">${rub(r.net)}</td></tr>
    </table></div></div>`;
}

function opLine(o) {
  const w = (id) => S.wallets.find((x) => x.id === id);
  const [a, b] = o.entries;
  let title, sum, sub;
  if (o.kind === 'adjust' && a) {
    const wallet = w(a.walletId);
    title = `Остаток · ${esc(wallet?.name)}`;
    sum = amt(o.target ?? 0, wallet?.currency);
    sub = a.amount === 0 ? 'сошлось' : `поправка ${a.amount > 0 ? '+' : '−'}${amt(Math.abs(a.amount), wallet?.currency)}`;
  } else if (o.kind === 'transfer' && a && b) {
    title = `${esc(w(a.walletId)?.name)} → ${esc(w(b.walletId)?.name)}`;
    sum = `${amt(-a.amount, w(a.walletId)?.currency)} → ${amt(b.amount, w(b.walletId)?.currency)}`;
    sub = o.feeRub ? `потеря ${rub(o.feeRub)}` : '';
  } else {
    const wallet = a && w(a.walletId);
    title = o.kind === 'payout' ? `Выплата партнёру · ${esc(nameOf(S.projects, o.projectId))}` : esc(nameOf(S.categories, o.categoryId));
    sum = `<span class="${o.kind === 'income' ? 'plus' : 'minus'}">${o.kind === 'income' ? '+' : '−'}${rub(o.grossRub)}</span>`;
    sub = [wallet && esc(wallet.name), o.kind === 'income' && o.feeRub ? `комиссия ${rub(o.feeRub)}` : '', wallet && wallet.currency !== 'RUB' && a ? amt(Math.abs(a.amount), wallet.currency) : ''].filter(Boolean).join(' · ');
  }
  const meta = [OP_LABEL[o.kind], o.projectId && o.kind !== 'payout' ? esc(nameOf(S.projects, o.projectId)) : '', esc(o.note), o.source === 'botprivat' ? 'авто · ботприват' : o.source === 'ads' ? 'сделка рекламы' : ''].filter(Boolean).join(' · ');
  return `<div class="op"><span class="when">${day(o.at)}</span><div class="what"><b>${title}</b><small>${meta}</small></div><div class="sum">${sum}<small>${sub}</small></div><button class="del" type="button" data-del="${o.id}" aria-label="Удалить операцию">×</button></div>`;
}

async function load() {
  const [state, report, ops, ads] = await Promise.all([api('/api/state'), api(`/api/report?month=${month}`), api(`/api/operations?month=${month}`), api('/api/ad-deals')]);
  S = state;
  deals = ads;
  $('#login').hidden = true;
  $('#app').hidden = false;
  if (location.search) history.replaceState(null, '', '/');
  const [y, m] = month.split('-').map(Number);
  $('#monthLabel').textContent = new Date(Date.UTC(y, m - 1, 15)).toLocaleString('ru-RU', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  renderTiles(report);
  renderAds();
  renderWallets();
  renderReport(report);
  $('#ops').innerHTML = ops.length ? ops.map(opLine).join('') : '<div class="empty">За этот месяц операций нет.</div>';
}

// --- форма операции ---------------------------------------------------------
const opts = (list, empty) => (empty ? `<option value="">${empty}</option>` : '') + list.map((x) => `<option value="${x.id}">${esc(x.name)}</option>`).join('');
const walletOpts = () => S.wallets.filter((w) => !w.archived).map((w) => `<option value="${w.id}">${esc(w.name)} · ${esc(w.currency)}</option>`).join('');
const todayIso = () => new Date(Date.now() + MSK).toISOString().slice(0, 10);

function renderOpFields() {
  const cats = (kind) => S.categories.filter((c) => c.kind === kind);
  const date = `<label>Дата<input type="date" name="date" value="${todayIso()}" required></label>`;
  const note = `<label class="wide">Заметка<input name="note" maxlength="500" placeholder="необязательно"></label>`;
  const rate = (name = 'rate', label = 'Курс к ₽') => `<label data-rate="${name}">${label}<input name="${name}" inputmode="decimal" placeholder="текущий"></label>`;
  let html = '';
  if (opKind === 'income')
    html = `<label>Кошелёк<select name="walletId">${walletOpts()}</select></label>${date}
      <label>Сколько заплатили<input name="amount" inputmode="decimal" required placeholder="299"></label>
      <label>Комиссия, %<input name="feePct" inputmode="decimal" placeholder="ставка кошелька"></label>
      <label>Вид дохода<select name="categoryId">${opts(cats('income'), '—')}</select></label>
      <label>Проект<select name="projectId">${opts(S.projects, '—')}</select></label>${rate()}${note}`;
  if (opKind === 'expense')
    html = `<label>Кошелёк<select name="walletId">${walletOpts()}</select></label>${date}
      <label class="wide">Сумма<input name="amount" inputmode="decimal" required placeholder="20"></label>
      <label>Вид расхода<select name="categoryId">${opts(cats('expense'), '—')}</select></label>
      <label>Проект<select name="projectId">${opts(S.projects, '—')}</select></label>${rate()}${note}`;
  if (opKind === 'transfer')
    html = `<label>Откуда<select name="walletId">${walletOpts()}</select></label>
      <label>Ушло<input name="amount" inputmode="decimal" required placeholder="10 000"></label>
      <label>Куда<select name="toWalletId">${walletOpts()}</select></label>
      <label>Пришло<input name="toAmount" inputmode="decimal" required placeholder="100"></label>
      ${rate('rate', 'Курс «откуда» к ₽')}${rate('toRate', 'Курс «куда» к ₽')}${date}${note}`;
  if (opKind === 'adjust')
    html = `<label>Кошелёк<select name="walletId">${walletOpts()}</select></label>${date}
      <label class="wide">Сколько на самом деле<input name="amount" inputmode="decimal" required placeholder="12 340"></label>${rate()}${note}`;
  if (opKind === 'payout')
    html = `<label>Кошелёк<select name="walletId">${walletOpts()}</select></label>${date}
      <label>Сумма<input name="amount" inputmode="decimal" required></label>
      <label>Проект<select name="projectId">${opts(S.projects.filter((p) => p.partnerPct > 0))}</select></label>${rate()}${note}`;
  $('#opFields').innerHTML = html;
  const transferSecond = S.wallets.filter((w) => !w.archived)[1];
  if (opKind === 'transfer' && transferSecond) $('#opFields [name=toWalletId]').value = transferSecond.id;
  $('#opHint').textContent = {
    income: 'На кошелёк ляжет сумма за вычетом комиссии; в отчёте — полная сумма и комиссия отдельно.',
    expense: 'Расход проекта с партнёром уменьшит долг перед ним на его долю.',
    transfer: 'Впишите, сколько ушло и сколько пришло — разница в рублях станет комиссией вывода (3 %, Rapira, курс).',
    payout: 'Выплата закрывает долг перед партнёром по проекту.',
    adjust: 'Фактический баланс по кабинету платёжки или кошелька на эту дату. Разница с насчитанным станет поправкой — она не доход и не расход. Так вносятся начальные остатки.',
  }[opKind];
  syncRates();
}

// поле курса нужно только для не-рублёвых кошельков
function syncRates() {
  const f = $('#opForm');
  const cur = (sel) => S.wallets.find((w) => String(w.id) === f.querySelector(sel)?.value)?.currency;
  for (const [field, sel] of [['rate', '[name=walletId]'], ['toRate', '[name=toWalletId]']]) {
    const label = f.querySelector(`[data-rate=${field}]`);
    if (label) label.hidden = !cur(sel) || cur(sel) === 'RUB';
  }
}

function openOp() {
  $('#opError').hidden = true;
  $('#opForm').reset();
  renderOpFields();
  $('#opDlg').showModal();
}

$('#opKinds').addEventListener('click', (e) => {
  const b = e.target.closest('[data-kind]');
  if (!b) return;
  opKind = b.dataset.kind;
  for (const x of $('#opKinds').children) x.classList.toggle('on', x === b);
  renderOpFields();
});
$('#opFields').addEventListener('change', syncRates);

$('#opForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = Object.fromEntries(new FormData(e.target));
  const [y, m, d] = String(f.date || todayIso()).split('-').map(Number);
  // дата без времени — полдень по Москве, чтобы операция не уехала в соседние сутки
  const at = Date.UTC(y, m - 1, d, 12) - MSK;
  try {
    await api('/api/operations', { method: 'POST', body: JSON.stringify({ ...f, kind: opKind, at }) });
    $('#opDlg').close();
    month = monthOf(at);
    await load();
    toast('Записано');
  } catch (err) {
    $('#opError').textContent = err.message;
    $('#opError').hidden = false;
  }
});

$('#walletForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('/api/wallets', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(e.target))) });
    $('#walletDlg').close();
    await load();
    toast('Кошелёк добавлен');
  } catch (err) {
    $('#walletError').textContent = err.message;
    $('#walletError').hidden = false;
  }
});

$('#ads').addEventListener('click', async (e) => {
  const pay = e.target.closest('[data-pay]');
  if (pay) return openPay(pay.dataset.pay);
  const b = e.target.closest('[data-barter],[data-unbarter],[data-wait],[data-unwait]');
  if (!b) return;
  const { barter, unbarter, wait, unwait } = b.dataset;
  const isBarter = !!(barter || unbarter);
  const on = !!(barter || wait);
  try {
    await api(`/api/ad-deals/${encodeURIComponent(barter || unbarter || wait || unwait)}/${isBarter ? 'barter' : 'waiting'}`, { method: 'POST', body: JSON.stringify({ on }) });
    await load();
    toast(isBarter ? (on ? 'Бартер — без денег' : 'Сделка снова не разобрана') : on ? 'Ждём оплату' : 'Сделка снова не разобрана');
  } catch (err) {
    toast(err.message);
  }
});
$('#adsAll').addEventListener('click', () => {
  adsAll = !adsAll;
  renderAds();
});
$('#payForm').addEventListener('change', (e) => {
  if (e.target.name === 'walletId') syncPay();
});
$('#payForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = Object.fromEntries(new FormData(e.target));
  const [y, m, d] = String(f.date || todayIso()).split('-').map(Number);
  const at = Date.UTC(y, m - 1, d, 12) - MSK;
  try {
    await api(`/api/ad-deals/${encodeURIComponent(payRef)}/pay`, { method: 'POST', body: JSON.stringify({ ...f, at }) });
    $('#payDlg').close();
    await load();
    toast('Записано');
  } catch (err) {
    $('#payError').textContent = err.message;
    $('#payError').hidden = false;
  }
});

$('#ops').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-del]');
  if (!b || !confirm('Удалить операцию? Балансы и отчёт пересчитаются.')) return;
  try {
    await api(`/api/operations/${b.dataset.del}`, { method: 'DELETE' });
    await load();
  } catch (err) {
    toast(err.message);
  }
});

document.addEventListener('click', (e) => {
  if (e.target.closest('[data-close]')) e.target.closest('dialog')?.close();
});
$('#addOp').addEventListener('click', openOp);
$('#addWallet').addEventListener('click', () => {
  $('#walletForm').reset();
  $('#walletError').hidden = true;
  $('#walletDlg').showModal();
});
$('#prevMonth').addEventListener('click', () => { month = shiftMonth(month, -1); load().catch((e) => toast(e.message)); });
$('#nextMonth').addEventListener('click', () => { month = shiftMonth(month, 1); load().catch((e) => toast(e.message)); });
$('#logout').addEventListener('click', async () => {
  await fetch('/auth/logout', { method: 'POST' });
  location.href = '/';
});

load().catch((e) => {
  if (e.message !== 'нужно войти') toast(e.message);
});
