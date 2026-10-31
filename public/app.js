// Страница учёта: разделы слева (на телефоне — снизу), как в tg-analytics; обзор —
// плашки, доход, что ждёт действия, последние операции.
// Суммы приходят в «микро» (миллионных долях единицы) — переводим только при показе.

const $ = (s) => document.querySelector(s);
const MICRO = 1e6;
const MSK = 3 * 3600e3;
const KIND_LABEL = { provider: 'платёжка', crypto: 'крипта', card: 'карта', cash: 'наличные' };
const OP_LABEL = { income: 'Доход', expense: 'Расход', transfer: 'Перевод', payout: 'Партнёру', payin: 'От партнёра', adjust: 'Остаток' };

let S = null; // state
let month = monthOf(Date.now());
// «Год»: переключатель вверху листает годы, «Итоги» — по месяцам года, операции скрыты
let period = 'month';
let year = Number(month.slice(0, 4));
let opKind = 'income';
let deals = [];
let adsAll = false;
// что оплачивается в окне «Оплачено»: сделка рекламы или фиксация приветки
let payTarget = null;
let welcomeRows = [];
let incomeRows = []; // строки с expected — долги, которые «Если всё оплачено» считает оплаченными
let tilesReport = null; // итоги периода для плашек: переключатель долгов перерисовывает «Чистыми»
let recurringRows = [];
let recurringEdit = null; // регулярный в окне правки; null — новый
let welcomeEdit = null; // размещение в окне правки; null — новое
let fixDealId = null;
let picked = new Set(); // сделки, выбранные для отметки списком; живут до следующей отрисовки
let vpnRows = []; // оплаты VPN без платёжки
let vpnSkipped = []; // отмеченные «Не учитывать»
let vpnPicked = new Set();
let partnerRows = []; // расчёт с партнёром по проектам (VPN)
// Долги по людям (владелец, 2026-10-31): один человек — и реклама, и приветка
let peopleRows = []; // GET /api/people: сначала с долгом, «без контакта» — последней группой
let personCard = null; // открытая карточка: { p, sel: Set<ref> } — галочки для «Оплачено»
let ppay = null; // окно «Оплачено» у человека: { p, dir, refs }
let linkDealId = null; // «Новая ссылка» приветки
let dealPersonRef = null; // «Чья сделка»
let personEditId = null; // окно правки человека; null — новый

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
  if (!res.ok) {
    // code — когда сервер предлагает действие (new_link: «Это новая ссылка?»)
    const err = new Error(body.error || `ошибка ${res.status}`);
    err.code = body.code;
    throw err;
  }
  return body;
}

// --- ссылка на сделку из tg-analytics: /#deal=sale:5 ------------------------------
// Вход через Telegram уводит со страницы и возвращает на «/» без хвоста адреса —
// поэтому сделку из ссылки запоминаем до входа и открываем после.
const DEAL_LINK = /^#deal=((?:buy|sale):\d+)$/;
function rememberDealLink() {
  const m = DEAL_LINK.exec(location.hash);
  if (!m) return;
  try { sessionStorage.setItem('dealLink', m[1]); } catch { /* приватный режим — откроется без сделки */ }
  history.replaceState(null, '', location.pathname + location.search);
}
function takeDealLink() {
  try {
    const ref = sessionStorage.getItem('dealLink');
    sessionStorage.removeItem('dealLink');
    return ref;
  } catch {
    return null;
  }
}
function focusDeal(ref) {
  const d = deals.find((x) => x.ref === ref);
  if (!d) {
    toast('Этой сделки в «Деньгах» ещё нет — она подтянется из аналитики в течение 5 минут');
    return;
  }
  showScreen('ads');
  // оплаченная, бартер и отменённая видны только во «Все сделки»
  if (!adsAll && !$(`#ads [data-deal="${CSS.escape(ref)}"]`)) {
    adsAll = true;
    renderAds();
  }
  const row = $(`#ads [data-deal="${CSS.escape(ref)}"]`);
  if (!row) return;
  row.scrollIntoView({ block: 'center', behavior: 'smooth' });
  row.classList.add('hl');
  setTimeout(() => row.classList.remove('hl'), 4000);
}
rememberDealLink();
window.addEventListener('hashchange', () => {
  rememberDealLink();
  const ref = takeDealLink();
  if (ref && S) focusDeal(ref);
  else showScreen(screenOfHash(), false);
});

// --- разделы: меню слева, на телефоне — снизу и «Ещё» -----------------------------
// Раздел — в адресе (#ads), чтобы «Назад» в браузере и обновление страницы вели туда же.
const SCREENS = {
  overview: ['Обзор', 'Деньги проектов: доход, долги и что ждёт действия'],
  people: ['Люди', 'Кто кому должен — реклама и приветка одного человека вместе'],
  ads: ['Реклама', 'Сделки из аналитики: оплачено, ждём оплату, бартер'],
  welcome: ['Приветка', 'Чужие ссылки в приветке и оплата за заявки'],
  recurring: ['Регулярные расходы', 'Серверы и подписки: в свой день бот присылает черновик'],
  vpn: ['VPN — разобрать', 'Оплаты VPN, по которым бот не сказал платёжку'],
  partner: ['Партнёр', 'Кто сколько оплатил по проекту с партнёром и кто кому докидывает'],
  wallets: ['Кошельки', 'Платёжки, кабинеты VPN, крипта и карты'],
  report: ['Итоги', 'Доходы, комиссии и расходы по видам — за месяц или год'],
  ops: ['Операции', 'Всё, что записано: руками, ботом и импортом'],
};
const IN_MORE = ['people', 'welcome', 'vpn', 'partner', 'wallets', 'report']; // на телефоне — в «Ещё»
let screen = 'overview';
const screenOfHash = () => (SCREENS[location.hash.slice(1)] ? location.hash.slice(1) : 'overview');

function showScreen(name, push = true) {
  if (!SCREENS[name]) name = 'overview';
  const moved = name !== screen;
  screen = name;
  for (const s of document.querySelectorAll('.screen')) s.classList.toggle('active', s.id === `scr-${name}`);
  for (const b of document.querySelectorAll('.nav-it[data-scr], .tab[data-scr]')) b.classList.toggle('on', b.dataset.scr === name);
  $('[data-more]').classList.toggle('on', IN_MORE.includes(name));
  $('#tbTitle').textContent = SCREENS[name][0];
  $('#tbSub').textContent = SCREENS[name][1];
  document.title = name === 'overview' ? 'Деньги' : `${SCREENS[name][0]} · Деньги`;
  if (push && moved) history.pushState(null, '', name === 'overview' ? location.pathname : `#${name}`);
  if (moved) scrollTo({ top: 0 });
}
window.addEventListener('popstate', () => showScreen(screenOfHash(), false));
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-scr]');
  if (!b) return;
  if ($('#moreDlg').open) $('#moreDlg').close();
  showScreen(b.dataset.scr);
});
showScreen(screenOfHash(), false);
$('#tbEyebrow').textContent = `${new Date().toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Moscow' })} · деньги`;

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

// значки и мини-график — как у плашек tg-analytics
const ic = (p) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
const IC = {
  card: ic('<rect x="2.5" y="5.5" width="19" height="13" rx="2.5"/><path d="M2.5 10h19"/>'),
  wallet: ic('<path d="M4 7.5A2.5 2.5 0 0 1 6.5 5H18v3"/><rect x="4" y="8" width="16" height="11" rx="2.5"/><path d="M15.5 13.5h2"/>'),
  users: ic('<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.7-3.2 3.3-5 6.5-5s5.8 1.8 6.5 5"/><path d="M16 4.8a3.5 3.5 0 0 1 0 6.4M17.8 15.3c2 .7 3.3 2.2 3.7 4.7"/>'),
  rub: ic('<path d="M7 20h7M7 16h7M7 4h4.5a4 4 0 0 1 0 8H7V4zm0 0v16"/>'),
  in: ic('<path d="M17 7 7 17M15 17H7V9"/>'),
  out: ic('<path d="M7 17 17 7M9 7h8v8"/>'),
  ads: ic('<path d="M3 10.5 17 5v13L3 12.5v-2z"/><path d="M7 13.5V18a2 2 0 0 0 4 0v-3"/>'),
  welcome: ic('<path d="M4 5.5h16v10H9l-5 4v-14z"/><path d="M8 9.5h8M8 12.5h5"/>'),
  recurring: ic('<path d="M4 11a7 7 0 0 1 12-5l2 2"/><path d="M18 4v4h-4"/><path d="M20 13a7 7 0 0 1-12 5l-2-2"/><path d="M6 20v-4h4"/>'),
  vpn: ic('<path d="M12 3 4.5 6v5.5c0 4.6 3.2 8.2 7.5 9.5 4.3-1.3 7.5-4.9 7.5-9.5V6L12 3z"/>'),
};
const C = { blue: '#57B6FF', green: '#3DDC97', amber: '#FFB454', red: '#FF6B7A', violet: '#9B8CFF' };
const hueBox = (c) => `background:${c}1f;color:${c};border:1px solid ${c}33`;
function spark(vals, color) {
  if (vals.length < 2) vals = [0, ...vals, 0].slice(-2);
  const w = 92, h = 26, mn = Math.min(...vals), mx = Math.max(...vals), r = mx - mn || 1;
  const d = vals.map((v, i) => `${i ? 'L' : 'M'}${((i / (vals.length - 1)) * w).toFixed(1)} ${(h - 3 - ((v - mn) / r) * (h - 7)).toFixed(1)}`).join(' ');
  return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"><path d="${d} L ${w} ${h} L 0 ${h} Z" fill="${color}" opacity=".12"/><path d="${d}" fill="none" stroke="${color}" stroke-width="1.6" stroke-linecap="round" vector-effect="non-scaling-stroke"/></svg>`;
}

// чистыми нарастающим итогом по дням (за год — по месяцам), как в итогах
function netSeries() {
  const byKey = new Map();
  for (const r of incomeRows) {
    if (r.expected && !inc.assume) continue;
    const v = r.kind === 'income' ? r.gross - r.fee : r.kind === 'expense' ? -r.gross : -r.fee;
    byKey.set(r.key, (byKey.get(r.key) ?? 0) + v);
  }
  let acc = 0;
  return incKeys().filter(incPast).map((k) => (acc += byKey.get(k) ?? 0));
}

function renderTiles(report) {
  const vpn = S.partners[0];
  const all = S.totals.onProviders + S.totals.onWallets;
  const share = (v) => (all > 0 ? Math.max(0, Math.min(100, (v / all) * 100)) : 0);
  const count = (pred) => S.wallets.filter((w) => !w.archived && pred(w)).length;
  const D = S.debts;
  const owedUs = D.owedToUs;
  const deb = debtCounts();
  // «Если всё оплачено» — к итогам периода долги из ленты дохода, как в блоке «Доход»
  const ahead = inc.assume ? incomeRows.filter((r) => r.expected) : [];
  const aheadIncome = ahead.reduce((s, r) => s + (r.kind === 'income' ? r.gross : 0), 0);
  const aheadNet = ahead.reduce((s, r) => s + (r.kind === 'income' ? r.gross - r.fee : -r.gross), 0);
  report = { ...report, totalIncome: report.totalIncome + aheadIncome, net: report.net + aheadNet };
  const tiles = [
    { lbl: 'На платёжках', icon: IC.card, c: C.blue, val: rub(S.totals.onProviders), delta: '<span class="delta flat">не выведено</span>',
      sub: `кабинетов: ${count((w) => w.kind === 'provider')}`, bar: share(S.totals.onProviders) },
    { lbl: 'На кошельках', icon: IC.wallet, c: C.violet, val: rub(S.totals.onWallets), delta: '<span class="delta flat">выведено</span>',
      sub: `кошельков: ${count((w) => w.kind !== 'provider')}`, bar: share(S.totals.onWallets) },
    vpn
      ? { lbl: `Должен партнёру · ${esc(vpn.name)}`, icon: IC.users, c: C.amber, val: rub(Math.max(vpn.owed, 0)), cls: vpn.owed > 0 ? 'warn' : '', scr: 'partner',
          delta: vpn.owed < 0 ? '<span class="delta up">вам должны</span>' : `<span class="delta flat">${vpn.pct}%</span>`,
          sub: vpn.owed < 0 ? `партнёр должен вам ${rub(-vpn.owed)}` : `${vpn.pct}% дохода и расходов — расчёт в «Партнёре»` }
      : { lbl: 'Должен партнёру', icon: IC.users, c: C.amber, val: '—', delta: '', sub: 'нет проектов с партнёром' },
    { lbl: period === 'year' ? 'Чистыми за год' : 'Чистыми за месяц', icon: IC.rub, c: report.net >= 0 ? C.green : C.red, val: rub(report.net), cls: report.net >= 0 ? 'good' : 'bad',
      delta: report.totalIncome ? `<span class="delta ${report.net >= 0 ? 'up' : 'dn'}">${Math.round((report.net / report.totalIncome) * 100)}% дохода</span>` : '<span class="delta flat">нет дохода</span>',
      sub: inc.assume ? `если всё оплатят${aheadNet ? `: ${aheadNet > 0 ? '+' : '−'}${rub(Math.abs(aheadNet))} долгами` : ' — долгов нет'}` : 'доход − комиссии − расходы', spark: netSeries() },
    { lbl: 'Нам должны', icon: IC.in, c: C.amber, val: rub(owedUs), cls: owedUs ? 'warn' : '', scr: 'people',
      delta: `<span class="delta ${owedUs ? 'warn' : 'flat'}">${deb.inPeople ? persons(deb.inPeople) : 'никто'}</span>`,
      sub: [deb.inAds ? `реклама: ${deb.inAds}` : '', deb.inWelcome ? `приветка: ${deb.inWelcome}` : ''].filter(Boolean).join(' · ') || 'никто не должен' },
    { lbl: 'Мы должны', icon: IC.out, c: C.red, val: rub(D.weOwe), cls: D.weOwe ? 'warn' : '', scr: 'people',
      delta: `<span class="delta ${D.weOwe ? 'dn' : 'flat'}">${deb.outPeople ? persons(deb.outPeople) : 'никому'}</span>`,
      sub: D.weOweCount ? `надо оплатить закупы: ${D.weOweCount}` : 'никому не должны' },
  ];
  $('#tiles').innerHTML = tiles
    .map((k) => `<article class="card kpi"${k.scr ? ` data-scr="${k.scr}" title="Открыть «${esc(SCREENS[k.scr][0])}»"` : ''}>
      <div class="kpi-top"><span class="kpi-ic" style="${hueBox(k.c)}">${k.icon}</span><span class="kpi-lbl">${k.lbl}</span>${k.delta}</div>
      <div class="kpi-val ${k.cls ?? ''}">${k.val}</div>
      <div class="kpi-sub">${k.sub}</div>
      ${k.spark ? `<div class="kpi-spark">${spark(k.spark, k.c)}</div>` : k.bar != null ? `<div class="kpi-bar" title="доля всех денег"><i style="width:${k.bar}%;background:${k.c}"></i></div>` : ''}
    </article>`)
    .join('');
}

// «Что ждёт действия» на обзоре: каждая строка ведёт в свой раздел
function renderTodo() {
  const unsorted = deals.filter((d) => d.state === 'open' && !d.cancelled).length;
  const deb = debtCounts();
  const due = recurringRows.filter((r) => r.active && r.state === 'due');
  const vpnSum = vpnRows.reduce((s, p) => s + p.amount, 0);
  const n = (k, one, few, many) => `${k} ${plural(k, one, few, many)}`;
  const items = [
    S.debts.owedToUs && ['people', IC.in, C.green, 'Нам должны', [deb.inPeople ? persons(deb.inPeople) : '', deb.inAds ? `реклама: ${deb.inAds}` : '', deb.inWelcome ? `приветка: ${deb.inWelcome}` : ''].filter(Boolean).join(' · '), `<span class="plus">+${rub(S.debts.owedToUs)}</span>`],
    S.debts.weOwe && ['people', IC.out, C.red, 'Мы должны — закупы', [deb.outPeople ? persons(deb.outPeople) : '', n(S.debts.weOweCount, 'закуп', 'закупа', 'закупов')].filter(Boolean).join(' · '), `<span class="minus">−${rub(S.debts.weOwe)}</span>`],
    unsorted && ['ads', IC.ads, C.blue, 'Сделки не разобраны', 'оплачено, ждём оплату или бартер', String(unsorted)],
    due.length && ['recurring', IC.recurring, C.violet, 'Регулярные — ждут записи', due.slice(0, 3).map((r) => esc(r.name)).join(', ') + (due.length > 3 ? '…' : ''), `≈ ${rub(due.reduce((s, r) => s + (r.rubEstimate ?? 0), 0))}`],
    vpnRows.length && ['vpn', IC.vpn, C.blue, 'VPN — без платёжки', n(vpnRows.length, 'оплата', 'оплаты', 'оплат'), `<span class="plus">+${rub(vpnSum)}</span>`],
  ].filter(Boolean);
  $('#todo').innerHTML = items.length
    ? items.map(([scr, icon, c, title, sub, v]) => `<button class="todo-it" type="button" data-scr="${scr}"><span class="todo-ic" style="${hueBox(c)}">${icon}</span><span><b>${title}</b><small>${sub}</small></span><span class="v">${v}</span></button>`).join('')
    : '<div class="todo-ok"><i></i>Всё разобрано — ничего не ждёт</div>';
}

// счётчики в меню: что ждёт оплаты или разбора
function renderBadges() {
  const n = {
    ads: deals.filter((d) => (d.state === 'waiting' || d.state === 'open') && !d.cancelled).length,
    welcome: S.welcome.count,
    people: S.debts.people,
    recurring: recurringRows.filter((r) => r.active && r.state === 'due').length,
    vpn: vpnRows.length,
  };
  // приветка с долгом — тоже чей-то долг в «Людях»: не считаем дважды
  n.more = n.people + n.vpn;
  for (const el of document.querySelectorAll('[data-nb]')) {
    const v = n[el.dataset.nb] || 0;
    el.hidden = !v;
    el.textContent = v > 99 ? '99+' : String(v);
  }
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

// отметить списком можно то, что ещё ждёт решения: не оплаченное, не бартер, не отменённое
const pickable = (d) => (d.state === 'open' || d.state === 'waiting') && !d.cancelled;

// оплатить можно то, что ждёт решения и с суммой
const payable = (d) => pickable(d) && d.amount != null && d.amount > 0;
const places = (n) => `${n} ${plural(n, 'место', 'места', 'мест')}`;

// «Оплатить у человека»: у кого долг по рекламе и не одна позиция — платят одним
// переводом, а сумма закрывает его позиции по порядку даты (владелец, 2026-10-31).
// Платят в карточке человека: там видно и приветку, и встречный закуп.
function peopleToPay() {
  return peopleRows.filter((p) => p.personId !== null && p.items.some((i) => i.source === 'ads' && i.remaining > 0) && p.items.filter((i) => i.remaining > 0).length >= 2);
}

function personLine(p) {
  const open = p.items.filter((i) => i.remaining > 0);
  const n = (src) => open.filter((i) => i.source === src).length;
  const sub = [n('ads') ? `реклама: ${places(n('ads'))}` : '', n('welcome') ? `приветка: ${n('welcome')}` : '', p.advanceIn || p.advanceOut ? `аванс ${rub(p.advanceIn + p.advanceOut)}` : ''].filter(Boolean).join(' · ');
  const sum = [p.owedToUs ? `<span class="plus">+${rub(p.owedToUs)}</span>` : '', p.weOwe ? `<span class="minus">−${rub(p.weOwe)}</span>` : ''].filter(Boolean).join('<br>');
  return `<div class="deal person"><span class="when">человек</span>
    <div class="what"><b>${esc(personName(p))}</b><small>${sub}</small></div>
    <div class="sum">${sum}</div>
    <div class="acts"><button class="btn btn-primary" type="button" data-person-open="${p.personId}">Оплатить у человека</button></div></div>`;
}

const dealCovered = (d) => (d.state === 'waiting' && d.amount != null && d.remaining > 0 && d.remaining < d.amount ? d.amount - d.remaining : 0);

// group — в какой группе строка («Ждём оплату», «Не разобраны»); без группы («Все сделки») выбора нет
function dealLine(d, group) {
  // покрыто — деньгами или авансом человека; оставшееся висит долгом
  const covered = dealCovered(d);
  const part = d.paid > 0 && d.remaining > 0;
  const sum = d.amount == null
    ? '<span class="muted">суммы ещё нет</span>'
    : `<span class="${d.kind === 'sale' ? 'plus' : 'minus'}">${d.kind === 'sale' ? '+' : '−'}${rub(covered ? d.remaining : d.amount)}</span>${covered ? `<small>${d.paid ? 'оплачено' : 'аванс покрыл'} ${rub(covered)} из ${rub(d.amount)}</small>` : ''}`;
  const ref = esc(d.ref);
  const waitLabel = d.kind === 'sale' ? 'Ждём оплату' : 'Надо оплатить';
  let acts;
  if (d.state === 'paid') acts = `<span class="chip ${d.closed ? '' : 'ok'}">${d.closed ? 'прощено' : 'оплачено'}</span>${d.cancelled ? ' <span class="chip warn">отменена в аналитике</span>' : ''}`;
  else if (d.state === 'barter') acts = `<span class="chip">бартер</span><button class="btn ghost" type="button" data-unbarter="${ref}">Вернуть</button>`;
  else if (d.cancelled) acts = `<span class="chip">отменена</span>${d.state === 'waiting' ? `<button class="btn ghost" type="button" data-unwait="${ref}">Не ждём</button>` : ''}`;
  else if (d.state === 'waiting' && part)
    // часть денег уже пришла — это не бартер и не «не разобрана»: снять — удалив оплату в карточке человека
    acts = `<span class="chip warn">частично</span><button class="btn btn-primary" type="button" data-pay="${ref}">Оплачено</button>`;
  else if (d.state === 'waiting')
    acts = `<button class="btn btn-primary" type="button" data-pay="${ref}">Оплачено</button><button class="btn" type="button" data-barter="${ref}">Бартер</button><button class="btn ghost" type="button" data-unwait="${ref}" title="Вернуть в неразобранные">×</button>`;
  else
    acts = `<button class="btn btn-primary" type="button" data-pay="${ref}">Оплачено</button><button class="btn" type="button" data-wait="${ref}">${waitLabel}</button><button class="btn" type="button" data-barter="${ref}">Бартер</button>`;
  const done = d.state === 'paid' || d.state === 'barter' || d.cancelled;
  const sub = [dealWho(d), esc(d.channels), d.state === 'waiting' && !d.cancelled ? `<span class="age">${dealAge(d.date)}</span>` : ''].filter(Boolean).join(' · ');
  const when = !group
    ? dealDay(d.date)
    : pickable(d)
      ? `<label class="pick"><input type="checkbox" data-pick="${ref}" data-g="${group}">${dealDay(d.date)}</label>`
      : `<span class="pick-gap"></span>${dealDay(d.date)}`;
  return `<div class="deal${done ? ' done' : ''}" data-deal="${ref}"><span class="when">${when}</span>
    <div class="what"><b>${dealTitle(d)}</b><small>${sub}</small></div>
    <div class="sum">${sum}</div><div class="acts">${acts}</div></div>`;
}

function renderAds() {
  picked.clear();
  syncPick();
  $('#adsAll').hidden = !deals.length;
  if (!deals.length) {
    $('#ads').innerHTML = '<div class="empty">Сделок рекламы пока нет — они приходят из аналитики раз в 5 минут.</div>';
    return;
  }
  $('#adsAll').textContent = adsAll ? 'Свернуть' : 'Все сделки';
  if (adsAll) {
    const all = [...deals].sort((a, b) => b.date.localeCompare(a.date));
    $('#ads').innerHTML = all.map((d) => dealLine(d)).join('');
    return;
  }
  // ждём оплату — самые давние сверху: они первые, кому пора напомнить;
  // оплаченная, но отменённая в аналитике тоже на виду
  const waiting = deals.filter((d) => (d.state === 'waiting' && !d.cancelled) || (d.state === 'paid' && d.cancelled) || (d.state === 'waiting' && d.cancelled));
  const unsorted = deals.filter((d) => d.state === 'open' && !d.cancelled);
  const group = (key, title, list, empty) => {
    const head = `${title}${list.length ? ` · ${list.length}` : ''}`;
    return `<h3 class="ads-h">${list.some(pickable) ? `<label class="pick"><input type="checkbox" data-pick-all="${key}" aria-label="Выбрать все">${head}</label>` : head}</h3>` +
      (list.length ? list.map((d) => dealLine(d, key)).join('') : `<div class="empty">${empty}</div>`);
  };
  const unknown = S.ads.unknown ? `<div class="ads-sum"><span>без суммы: ${S.ads.unknown} — CPM ждёт просмотров или ПДП подсчёта, в долги пока не входят</span></div>` : '';
  const people = peopleToPay();
  const byPerson = people.length ? `<h3 class="ads-h">Оплатить у человека · ${people.length}</h3>${people.map(personLine).join('')}` : '';
  $('#ads').innerHTML =
    byPerson +
    group('waiting', 'Ждём оплату', waiting, 'Никто никому не должен.') + unknown +
    (unsorted.length ? group('unsorted', 'Не разобраны', unsorted, '') : '');
}

// Галочки групп и плашка снизу — по тому, что выбрано сейчас.
function syncPick() {
  for (const all of document.querySelectorAll('[data-pick-all]')) {
    const boxes = [...document.querySelectorAll(`[data-pick][data-g="${all.dataset.pickAll}"]`)];
    const n = boxes.filter((x) => x.checked).length;
    all.checked = n > 0 && n === boxes.length;
    all.indeterminate = n > 0 && n < boxes.length;
  }
  const list = deals.filter((d) => picked.has(d.ref));
  $('#adsBar').hidden = !list.length;
  if (!list.length) return;
  const sum = (kind) => list.filter((d) => d.kind === kind && d.amount != null).reduce((s, d) => s + d.amount, 0);
  const has = (kind) => list.some((d) => d.kind === kind);
  const noSum = list.filter((d) => d.amount == null).length;
  const money = [has('sale') ? `<span class="plus">+${rub(sum('sale'))}</span>` : '', has('buy') ? `<span class="minus">−${rub(sum('buy'))}</span>` : ''].filter(Boolean).join(' / ');
  $('#adsPicked').innerHTML = `<b>Выбрано ${list.length}</b> · ${money}${noSum ? ` <span class="muted">· без суммы: ${noSum}</span>` : ''}`;
}

// --- доход: итог, доли, график и лента дней ----------------------------------------
// Цвет держится за источником, а не за местом в списке: вид или проект красится
// своим цветом, что бы ни было выключено. Порядок и оттенки проверены на тёмном
// фоне — различимы и при дальтонизме (валидатор палитры, соседние пары).
const PALETTE = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9'];
const MON_SHORT = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
const DOW = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
// mode: income — доход; expense — расходы и потери при выводе; net — доход за вычетом
// комиссий и расходов, по проектам (у расхода свой вид, у дохода свой — общий только проект)
// Крупные экраны увеличены через CSS zoom (style.css): холст графика рисуется в пикселях
// страницы — без поправки он мылится, а точку мыши Chart.js получает в экранных
// пикселях — подсказка открывалась у соседнего дня. Повтор события после update()
// приходит уже исправленным.
const pageZoom = () => parseFloat(getComputedStyle(document.documentElement).zoom) || 1;
if (window.Chart) Chart.register({
  id: 'pageZoomFix',
  beforeEvent(chart, args) {
    const z = pageZoom(), e = args.event;
    if (z === 1 || args.replay || e.x == null) return;
    e.x /= z; e.y /= z;
    const a = chart.chartArea;
    args.inChartArea = e.x >= a.left && e.x <= a.right && e.y >= a.top && e.y <= a.bottom;
  },
});
// assume — «Если всё оплачено»: долги рекламы и приветки (строки с expected) как оплаченные
const inc = { mode: 'income', by: 'cat', net: false, vpn: 'all', assume: false, off: new Set(), open: new Set(), allDays: false };
let incChart = null;
// потери при выводе и обмене: у перевода нет ни вида, ни проекта
const FEES = { id: 'fees', name: 'Комиссии выводов', color: '#7d8796' };
const incBy = () => (inc.mode === 'net' ? 'proj' : inc.by);

// источники: виды или проекты; без вида / без проекта — в «Прочее» (по коду: название меняют)
function incSources() {
  const kind = inc.mode === 'expense' ? 'expense' : 'income';
  const list = incBy() === 'cat' ? S.categories.filter((c) => c.kind === kind) : S.projects;
  const sources = list.map((x, i) => ({ id: String(x.id), code: x.code, name: x.name, color: PALETTE[i % PALETTE.length] }));
  return inc.mode === 'income' ? sources : [...sources, FEES];
}

// сумма строки с учётом переключателей: до комиссий / чистыми, VPN целиком / доля владельца.
// В «Чистыми» расходы и потери при выводе — со знаком минус.
function incAmount(r) {
  if (r.expected && !inc.assume) return 0;
  if (inc.mode === 'income' && r.kind !== 'income') return 0;
  if (inc.mode === 'expense' && r.kind === 'income') return 0;
  let v = r.kind === 'income' ? (inc.net || inc.mode === 'net' ? r.gross - r.fee : r.gross) : r.kind === 'expense' ? r.gross : r.fee;
  if (inc.mode === 'net' && r.kind !== 'income') v = -v;
  const p = S.projects.find((x) => x.id === r.projectId);
  if (inc.vpn === 'own' && p?.partnerPct) v = (v * (100 - p.partnerPct)) / 100;
  return v;
}
const signed = (v) => (v > 0 ? `+${rub(v)}` : v < 0 ? `−${rub(-v)}` : rub(0));

// ячейки периода: дни месяца по сегодняшний (по Москве) или месяцы года
function incKeys() {
  if (period === 'year') return Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, '0')}`);
  const [y, m] = month.split('-').map(Number);
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return Array.from({ length: days }, (_, i) => `${month}-${String(i + 1).padStart(2, '0')}`);
}
const incLabel = (key) => (key.length === 7 ? MON_SHORT[Number(key.slice(5)) - 1] : `${key.slice(8)}.${key.slice(5, 7)}`);
const incPast = (key) => key <= (key.length === 7 ? todayIso().slice(0, 7) : todayIso());

function renderIncome() {
  const net = inc.mode === 'net';
  const sources = incSources();
  const otherCode = incBy() === 'proj' ? 'other' : inc.mode === 'expense' ? 'other_expense' : 'other_income';
  const other = sources.find((s) => s.code === otherCode) ?? sources.filter((s) => s !== FEES).at(-1) ?? FEES;
  const srcOf = (r) => (r.kind === 'transfer' ? FEES : sources.find((s) => s.id === String(incBy() === 'cat' ? r.categoryId : r.projectId)) ?? other);
  const keys = incKeys();
  // ячейка × источник; ahead — та часть, что пока долг
  const cell = new Map();
  const ahead = new Map();
  for (const r of incomeRows) {
    const v = incAmount(r);
    if (!v) continue;
    const k = `${r.key}|${srcOf(r).id}`;
    cell.set(k, (cell.get(k) ?? 0) + v);
    if (r.expected) ahead.set(k, (ahead.get(k) ?? 0) + v);
  }
  const val = (key, s) => cell.get(`${key}|${s.id}`) ?? 0;
  const valAhead = (key, s) => ahead.get(`${key}|${s.id}`) ?? 0;
  const sums = new Map(sources.map((s) => [s.id, keys.reduce((t, k) => t + val(k, s), 0)]));
  // в «Чистыми» проект за месяц может выйти в ноль, а по дням — нет
  const present = sources.filter((s) => keys.some((k) => val(k, s) !== 0));
  const shown = present.filter((s) => !inc.off.has(s.id));
  const total = shown.reduce((t, s) => t + sums.get(s.id), 0);
  const aheadTotal = shown.reduce((t, s) => t + keys.reduce((u, k) => u + valAhead(k, s), 0), 0);
  // день впереди виден, только если на него стоит долг (место завтра, оплату ждём)
  const seen = (k) => incPast(k) || shown.some((s) => val(k, s) !== 0);

  $('#incBy').hidden = net;
  $('#incNet').hidden = inc.mode !== 'income';
  // VPN «целиком / ваша доля» — только если в периоде есть деньги проекта с партнёром
  $('#incVpn').hidden = !incomeRows.some((r) => incAmount(r) && S.projects.find((p) => p.id === r.projectId)?.partnerPct);
  const [yy, mm] = month.split('-').map(Number);
  const periodName = period === 'year' ? `за ${year} год` : `за ${new Date(Date.UTC(yy, mm - 1, 15)).toLocaleString('ru-RU', { month: 'long', timeZone: 'UTC' })}`;
  $('#incomeTitle').textContent = `${{ income: 'Доход', expense: 'Расходы', net: 'Чистыми' }[inc.mode]} ${periodName}`;
  $('#incTotal').textContent = net ? signed(total) : rub(total);
  $('#incTotal').className = net && total ? (total > 0 ? 'plus' : 'minus') : '';
  const passed = keys.filter(incPast).length;
  const what = { income: inc.net ? 'чистыми, за вычетом комиссий' : 'до комиссий', expense: 'траты и потери при выводе', net: 'доход за вычетом комиссий и расходов' }[inc.mode];
  const owed = !inc.assume ? '' : aheadTotal ? `из них ждём оплату ${net ? signed(aheadTotal) : rub(aheadTotal)}` : 'долгов за период нет';
  $('#incSub').textContent = [what, owed, passed ? `в среднем ${net ? signed(total / passed) : rub(total / passed)} ${period === 'year' ? 'в месяц' : 'в день'}` : ''].filter(Boolean).join(' · ');
  $('#incChart').setAttribute('aria-label', `${{ income: 'Доход', expense: 'Расходы', net: 'Чистыми' }[inc.mode]} по ${period === 'year' ? 'месяцам' : 'дням'}`);

  // доли целого — только когда все части одного знака
  $('#incShare').innerHTML = total && !net ? shown.map((s) => `<i style="flex:${sums.get(s.id)};background:${s.color}"></i>`).join('') : '';
  $('#incChips').innerHTML = present.length
    ? present
        .map((s) => {
          const off = inc.off.has(s.id);
          const v = sums.get(s.id);
          return `<button class="inc-chip${off ? ' off' : ''}" type="button" data-src="${s.id}" aria-pressed="${!off}" title="${off ? 'Показать' : 'Скрыть'}"><i style="background:${s.color}"></i><span>${esc(s.name)}</span><span class="v">${net ? signed(v) : rub(v)}</span>${!off && total && !net ? `<span class="p">${Math.round((v / total) * 100)}%</span>` : ''}</button>`;
        })
        .join('')
    : `<div class="empty">${{ income: 'Дохода', expense: 'Расходов', net: 'Ни дохода, ни расходов' }[inc.mode]} за этот период нет.</div>`;

  drawIncomeChart(keys, shown, val, valAhead, seen);

  // лента: свежие сверху, только прошедшие дни; по умолчанию неделя.
  // В «Чистыми» полоска — одна, цветом знака: доли проектов с разными знаками не складываются в длину.
  const past = keys.filter(seen).reverse();
  const dayTotal = (k) => shown.reduce((t, s) => t + val(k, s), 0);
  const max = Math.max(1, ...past.map((k) => Math.abs(dayTotal(k))));
  const limit = period === 'year' || inc.allDays ? past.length : 7;
  $('#incDays').innerHTML =
    past
      .slice(0, limit)
      .map((k) => {
        const t = dayTotal(k);
        const parts = shown.filter((s) => val(k, s) !== 0);
        const any = parts.length > 0;
        const when = k.length === 7 ? MON_SHORT[Number(k.slice(5)) - 1] : `${incLabel(k)} ${DOW[new Date(`${k}T12:00:00Z`).getUTCDay()]}`;
        const open = inc.open.has(k) && any;
        const bar = net ? (t ? `<i class="${t > 0 ? 'pos' : 'neg'}"></i>` : '') : parts.map((s) => `<i style="flex:${val(k, s)};background:${s.color}"></i>`).join('');
        const sum = !any ? '—' : net ? `<span class="${t > 0 ? 'plus' : t < 0 ? 'minus' : ''}">${signed(t)}</span>` : rub(t);
        return `<button class="iday${any ? '' : ' zero'}" type="button" data-day="${k}" ${any ? `aria-expanded="${open}"` : 'tabindex="-1"'}>
          <span class="when">${when}</span>
          <span class="ibar" style="width:${(Math.abs(t) / max) * 100}%">${bar}</span>
          <b>${sum}</b></button>${open ? `<div class="iday-d">${[...parts].sort((a, b) => val(k, b) - val(k, a)).map((s) => `<div><i style="background:${s.color}"></i><span>${esc(s.name)}</span><span>${net ? signed(val(k, s)) : rub(val(k, s))}</span></div>`).join('')}</div>` : ''}`;
      })
      .join('') + (past.length > limit ? `<button class="btn ghost inc-more" type="button" data-alldays>Все дни месяца · ${past.length}</button>` : '');
}

// долги — отдельными полупрозрачными сегментами поверх оплаченного
function drawIncomeChart(keys, shown, val, valAhead, seen) {
  if (!window.Chart) {
    $('#incFallback').hidden = false;
    return;
  }
  $('#incFallback').hidden = true;
  const r2 = (v) => Math.round(v / 10_000) / 100;
  const series = [
    ...shown.map((s) => ({ label: s.name, color: s.color, at: (k) => val(k, s) - valAhead(k, s) })),
    ...shown.filter((s) => keys.some((k) => valAhead(k, s))).map((s) => ({ label: `${s.name} · ждём оплату`, color: `${s.color}59`, at: (k) => valAhead(k, s) })),
  ];
  const data = {
    labels: keys.map(incLabel),
    datasets: series.map(({ label, color, at }) => ({
      label,
      data: keys.map((k) => (seen(k) ? r2(at(k)) : null)),
      backgroundColor: color,
      // 2px зазор фоном между сегментами столбика; ниже нуля сегменты растут вниз
      borderColor: '#0f141b',
      borderWidth: (c) => (c.raw < 0 ? { bottom: 2 } : { top: 2 }),
      borderSkipped: false,
      borderRadius: 2,
      barPercentage: 0.7,
      categoryPercentage: 0.85,
    })),
  };
  const fmtRub = (v) => `${v < 0 ? '−' : ''}${Math.abs(Math.round(v)).toLocaleString('ru-RU')} ₽`;
  const opts = {
    responsive: true,
    devicePixelRatio: (window.devicePixelRatio || 1) * pageZoom(),
    maintainAspectRatio: false,
    animation: matchMedia('(prefers-reduced-motion: reduce)').matches ? false : { duration: 400 },
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: '#0F1520', borderColor: 'rgba(255,255,255,.12)', borderWidth: 1, padding: 12, cornerRadius: 10,
        titleColor: '#E8EDF4', bodyColor: '#9AA5B8', footerColor: '#E8EDF4', bodyFont: { family: 'JetBrains Mono', size: 11 }, usePointStyle: true, boxWidth: 7, boxHeight: 7,
        filter: (c) => c.parsed.y !== 0,
        itemSort: (a, b) => b.parsed.y - a.parsed.y,
        callbacks: {
          label: (c) => ` ${fmtRub(c.parsed.y)} · ${c.dataset.label}`,
          footer: (items) => `${inc.mode === 'net' ? 'Итого' : 'Всего'} ${fmtRub(items.reduce((t, c) => t + (c.parsed.y || 0), 0))}`,
        },
      },
    },
    scales: {
      x: { stacked: true, grid: { display: false }, ticks: { color: '#5A6478', maxTicksLimit: 10, font: { family: 'JetBrains Mono', size: 10 } } },
      y: { stacked: true, beginAtZero: true, grid: { color: (c) => (c.tick.value === 0 ? 'rgba(255,255,255,.16)' : 'rgba(255,255,255,.05)') }, border: { display: false },
        ticks: { color: '#5A6478', maxTicksLimit: 5, font: { family: 'JetBrains Mono', size: 10 }, callback: (v) => (Math.abs(v) >= 1000 ? `${v < 0 ? '−' : ''}${Math.round(Math.abs(v) / 100) / 10}к` : v < 0 ? `−${-v}` : v) } },
    },
  };
  if (incChart) incChart.destroy();
  incChart = new Chart($('#incChart'), { type: 'bar', data, options: opts });
}

// --- приветка: ссылка покупателя в приветке, оплата за заявки ----------------------
const isoDay = (iso) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}`;
const plural = (n, one, few, many) => (n % 10 === 1 && n % 100 !== 11 ? one : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? few : many);
const reqs = (n) => `${n.toLocaleString('ru-RU')} ${plural(n, 'заявка', 'заявки', 'заявок')}`;

// Статус позиции долга — одинаково в приветке и в карточке человека.
// paid — деньгами (₽-микро, число), advance — покрыто авансом человека.
function debtStatus(it) {
  const got = it.paid + it.advance;
  if (it.state === 'closed') return `<span class="chip">прощено</span>${got ? `<small>оплачено ${rub(got)} из ${rub(it.amount)}</small>` : ''}`;
  if (it.state === 'paid') return it.advance && !it.paid ? '<span class="chip ok">аванс покрыл</span>' : `<span class="chip ok">оплачено</span>${it.advance ? '<small>с авансом</small>' : ''}`;
  if (it.state === 'partial') return `<span class="chip warn">${it.paid ? `оплачено ${rub(got)} из ${rub(it.amount)}` : `аванс покрыл ${rub(got)} из ${rub(it.amount)}`}</span>`;
  return `<span class="chip warn">${it.dir === 'out' ? 'надо оплатить' : 'ждём'}</span>`;
}

// ссылка размещения — «ссылка 2» или её подпись; у единственной — ничего
const linkName = (d, linkId) => {
  if (d.links.length < 2) return '';
  const i = d.links.findIndex((l) => l.id === linkId);
  return i < 0 ? '' : d.links[i].label || `ссылка ${i + 1}`;
};

function fixLine(d, f, last) {
  const sum = f.amount
    ? `<span class="plus">+${rub(f.remaining && f.remaining < f.amount ? f.remaining : f.amount)}</span>${f.remaining && f.remaining < f.amount ? `<small>из ${rub(f.amount)}</small>` : ''}`
    : '<span class="muted">0 ₽</span>';
  const status = f.amount ? debtStatus({ ...f, dir: 'in' }) : '<span class="chip">новых нет</span>';
  // удалить можно последнюю и без денег: следующие посчитаны от неё
  const del = last && !f.paid ? `<button class="btn ghost" type="button" data-wfixdel="${f.id}" title="Удалить фиксацию">×</button>` : '';
  const link = linkName(d, f.linkId);
  return `<div class="deal"><span class="when">${isoDay(f.onDate)}</span>
    <div class="what"><b>+${reqs(f.count)}</b><small>всего по ссылке ${f.total.toLocaleString('ru-RU')}${link ? ` · ${esc(link)}` : ''}</small></div>
    <div class="sum">${sum}</div><div class="acts">${status}${del}</div></div>`;
}

function linksHistory(d) {
  if (d.links.length < 2) return '';
  const rows = d.links
    .map((l, i) => {
      const cur = l.id === d.current.id;
      const del = !l.fixes && d.links.length > 1 ? `<button class="btn ghost" type="button" data-wlinkdel="${l.id}" title="Удалить ссылку, заведённую по ошибке">×</button>` : '';
      return `<div class="deal"><span class="when">с ${isoDay(l.startedOn)}</span>
        <div class="what"><b>${esc(l.label || `Ссылка ${i + 1}`)}</b><small>${rub(l.price)} за заявку · фиксаций: ${l.fixes}</small></div>
        <div class="sum">${reqs(l.total)}</div><div class="acts">${cur ? '<span class="chip ok">текущая</span>' : ''}${del}</div></div>`;
    })
    .join('');
  return `<details class="wd-links"><summary>Ссылки · ${d.links.length}</summary>${rows}</details>`;
}

function renderWelcome() {
  if (!welcomeRows.length) {
    $('#welcome').innerHTML = '<div class="empty">Размещений нет. Поставили чью-то ссылку в приветку — добавьте: кто и цена за заявку. Когда он пришлёт число заявок, нажмите «Зафиксировать».</div>';
    return;
  }
  $('#welcome').innerHTML = welcomeRows
    .map((d) => {
      const lastId = d.fixes.length ? d.fixes[d.fixes.length - 1].id : null;
      // ждём — что ещё не закрыто; оплаченные, прощённые и пустые — свёрнуто
      const open = d.fixes.filter((f) => f.remaining > 0);
      const done = d.fixes.filter((f) => !(f.remaining > 0));
      const state = d.stoppedOn ? `<span class="chip warn">остановлено ${isoDay(d.stoppedOn)}</span>` : `<span class="chip">идёт с ${isoDay(d.startedOn)}</span>`;
      const who = d.personId != null ? `<button class="link wd-who" type="button" data-person-open="${d.personId}" title="Карточка человека">${esc(d.contact)}</button>` : `<b>${esc(d.contact)}</b>`;
      const cur = d.current;
      const curName = d.links.length > 1 ? esc(cur.label || `ссылка ${d.links.length}`) : 'ссылка';
      const curLine = `<div class="wd-cur"><span>${curName} с ${isoDay(cur.startedOn)}</span><span>${rub(cur.price)} за заявку</span><span>всего по ней <b>${cur.total.toLocaleString('ru-RU')}</b></span></div>`;
      return `<div class="wdeal${d.stoppedOn ? ' stopped' : ''}">
        <div class="wd-h">${who}${state}
          <div class="wd-acts"><button class="btn btn-primary" type="button" data-wfix="${d.id}">Зафиксировать</button>${d.owed && d.personId != null ? `<button class="btn" type="button" data-person-open="${d.personId}" title="Оплата — в карточке человека: вместе с его рекламой">Оплатить</button>` : ''}<button class="btn" type="button" data-wlink="${d.id}">Новая ссылка</button><button class="btn" type="button" data-wstop="${d.id}">${d.stoppedOn ? 'Возобновить' : 'Остановить'}</button><button class="btn ghost" type="button" data-wedit="${d.id}" aria-label="Изменить">✎</button></div></div>
        ${curLine}
        <div class="wd-sum">${d.fixes.length ? `начислено ${rub(d.accrued)} · оплачено ${rub(d.paidSum)}${d.owed ? ` · <span class="owed">должен ${rub(d.owed)}</span>` : ''}` : 'фиксаций ещё не было'}${d.note ? ` · ${esc(d.note)}` : ''}</div>
        ${open.map((f) => fixLine(d, f, f.id === lastId)).join('')}
        ${done.length ? `<details><summary>Закрытые и без новых · ${done.length}</summary>${done.map((f) => fixLine(d, f, f.id === lastId)).join('')}</details>` : ''}
        ${linksHistory(d)}
      </div>`;
    })
    .join('');
}

function openWelcome(deal) {
  welcomeEdit = deal ?? null;
  const f = $('#welcomeForm');
  f.reset();
  $('#welcomeError').hidden = true;
  $('#welcomeTitle').textContent = deal ? 'Размещение в приветке' : 'Ссылка в приветке';
  f.contact.value = deal?.contact ?? '';
  f.price.value = deal ? String(deal.price / MICRO).replace('.', ',') : '';
  $('#welcomePriceLabel').firstChild.textContent = deal && deal.links.length > 1 ? 'Цена текущей ссылки, ₽' : 'Цена за заявку, ₽';
  f.startedOn.value = deal?.startedOn ?? todayIso();
  f.startedOn.disabled = !!deal;
  f.note.value = deal?.note ?? '';
  $('#welcomeHint').textContent = deal
    ? 'Покупатель — знакомый из подсказки или новый: имя и @username. Цена меняется для следующих фиксаций — прошлые посчитаны по старой.'
    : 'Покупатель — знакомый из подсказки (у него уже может быть реклама) или новый: имя и @username.';
  $('#welcomeDel').hidden = !deal;
  $('#welcomeDlg').showModal();
}

function openFix(deal) {
  fixDealId = deal.id;
  const f = $('#fixForm');
  f.reset();
  $('#fixError').hidden = true;
  $('#fixNewLink').hidden = true;
  const c = deal.current;
  $('#fixDeal').textContent = `${deal.contact} · ${deal.links.length > 1 ? `${c.label || `ссылка ${deal.links.length}`} ` : 'ссылка '}с ${isoDay(c.startedOn)} · ${rub(c.price)} за заявку${c.fixes ? ` · по ней в прошлый раз всего ${c.total.toLocaleString('ru-RU')}` : ''}`;
  f.onDate.value = todayIso();
  syncFix();
  $('#fixDlg').showModal();
  fixInput().focus();
}

// поле зовётся value, как в API; form.value — не поле, а свойство-ловушка, поэтому по имени
const fixInput = () => $('#fixForm [name=value]');

// «340» — всего по текущей ссылке, «+120» — прибавилось (welcome.ts, fixWelcome)
function fixValue(raw, prev) {
  const s = String(raw ?? '').replace(/[\s ]/g, '');
  const plus = /^\+(\d+)$/.exec(s);
  if (plus) return { total: prev + Number(plus[1]), n: Number(plus[1]) };
  if (/^\d+$/.test(s)) return { total: Number(s), n: Number(s) - prev };
  return null;
}

// сколько новых и на какую сумму — пока владелец печатает число
function syncFix() {
  const d = welcomeRows.find((x) => x.id === fixDealId);
  const f = $('#fixForm');
  const v = d && fixValue(fixInput().value, d.current.total);
  if (!d || !v) {
    $('#fixCalc').textContent = fixInput().value.trim() ? 'Число заявок: всего по ссылке (340) или сколько прибавилось (+120).' : 'Число, которое прислал покупатель, — всего по текущей ссылке, или «+120», если он прислал, сколько прибавилось. Долг посчитается за новые.';
    $('#fixNewLink').hidden = true;
    return;
  }
  if (v.n < 0) {
    $('#fixCalc').innerHTML = `<span class="owed">Меньше прошлого: по этой ссылке было ${d.current.total.toLocaleString('ru-RU')}.</span>`;
    askNewLink(d);
    return;
  }
  $('#fixNewLink').hidden = true;
  $('#fixCalc').innerHTML = `новых <b>${v.n.toLocaleString('ru-RU')}</b> на <b>${rub(v.n * d.current.price)}</b> · ${rub(d.current.price)} за заявку · всего по ссылке станет ${v.total.toLocaleString('ru-RU')}`;
}

// Заявки не убывают: меньше прошлого — покупатель сменил ссылку, и счётчик начался заново
function askNewLink(d) {
  const f = $('#fixForm');
  const raw = String(fixInput().value).trim();
  const n = Number(raw.replace(/[^\d]/g, '')) || 0;
  $('#fixNewLinkText').innerHTML = `Это новая ссылка? Заведём её с ${f.onDate.value ? isoDay(f.onDate.value) : 'дня фиксации'} по ${rub(d.current.price)} за заявку и зафиксируем на ней ${reqs(n)} — <b>${rub(n * d.current.price)}</b>. Цену потом можно поправить в ✎.`;
  $('#fixNewLink').hidden = false;
}

function openLink(deal) {
  linkDealId = deal.id;
  const f = $('#linkForm');
  f.reset();
  $('#linkError').hidden = true;
  $('#linkDeal').textContent = `${deal.contact} · сейчас ${rub(deal.current.price)} за заявку, по текущей ссылке всего ${deal.current.total.toLocaleString('ru-RU')}`;
  const last = deal.fixes.at(-1)?.onDate;
  f.startedOn.value = last && last > todayIso() ? last : todayIso();
  f.price.value = String(deal.current.price / MICRO).replace('.', ',');
  $('#linkDlg').showModal();
}

// --- люди: долг по человеку целиком (владелец, 2026-10-31) -----------------------------
// Один человек бывает должен из разных источников сразу — продал ему пост, купил у
// него сторис, его ссылка в приветке. Позиции и оплаты — с сервера (debts.ts); здесь
// только показ и тот же расчёт «что закроется» до записи, чтобы владелец видел его заранее.
const personLabel = (p) => (!p.username ? p.name : p.name.toLowerCase() === `@${p.username}` ? p.name : `${p.name} (@${p.username})`);
const personName = (p) => p.name;
// @username рядом с именем — если имя не сам @username («@kate_ads» без имени)
const personAt = (p) => (p.username && p.name.toLowerCase() !== `@${p.username}` ? `@${p.username}` : '');
const persons = (n) => `${n} ${plural(n, 'человек', 'человека', 'человек')}`;
const positions = (n) => `${n} ${plural(n, 'позиция', 'позиции', 'позиций')}`;
const peopleById = (id) => peopleRows.find((p) => p.personId === id);
const SRC = { ads: 'реклама', welcome: 'приветка' };

// для плашек и «Что ждёт действия»: сколько людей и позиций по сторонам
function debtCounts() {
  const open = peopleRows.flatMap((p) => p.items.filter((i) => i.remaining > 0));
  const ppl = (dir) => peopleRows.filter((p) => p.personId !== null && p.items.some((i) => i.dir === dir && i.remaining > 0)).length;
  return {
    inAds: open.filter((i) => i.dir === 'in' && i.source === 'ads').length,
    inWelcome: open.filter((i) => i.dir === 'in' && i.source === 'welcome').length,
    inPeople: ppl('in'),
    outPeople: ppl('out'),
  };
}

// Деньги — как на сервере (money.ts): копейки округляются, без плавающей точки в итогах
const toRubC = (micro, rate) => Math.round((micro * rate) / 10_000) * 10_000;
function parseMoney(v) {
  const s = String(v ?? '').replace(/[\s  ]/g, '').replace(',', '.');
  if (!/^\d+(\.\d{1,6})?$/.test(s)) return null;
  return Math.round(Number(s) * MICRO);
}
const moneyStr = (micro) => String(Math.round(micro / 10_000) / 100).replace('.', ',');
// Рубли → сумма в валюте кошелька для поля: с теми знаками, при которых она даёт
// ровно эти рубли. С двумя знаками 1 400 ₽ по 95 — 14,74 USDT = 1 400,30 ₽: при
// частичных оплатах это 30 копеек аванса или недоплаты на позиции.
function fromRub(rubMicro, rate) {
  for (let digits = 2; digits <= 6; digits++) {
    const v = Math.round((rubMicro / MICRO / rate) * 10 ** digits) / 10 ** digits;
    if (toRubC(Math.round(v * MICRO), rate) === rubMicro) return String(v).replace('.', ',');
  }
  return String(Math.round((rubMicro / MICRO / rate) * 1e6) / 1e6).replace('.', ',');
}

// Деньги по позициям по порядку: каждой — её остаток, последней — сколько хватило (debts.ts, distribute)
function distributeC(items, total) {
  const parts = [];
  let left = total;
  for (const it of items) {
    if (left <= 0) break;
    const r = Math.min(left, it.remaining);
    if (r <= 0) continue;
    parts.push({ it, rub: r });
    left -= r;
  }
  return { parts, left };
}

// чей контакт в строке сделки: человек — ссылкой на карточку, ✎ — поменять
function dealWho(d) {
  const p = d.personId != null ? peopleById(d.personId) : null;
  const name = p ? personLabel(p) : d.contact || '';
  const who = d.personId != null
    ? `<button class="link" type="button" data-person-open="${d.personId}" title="Карточка человека">${esc(name)}</button>`
    : name ? esc(name) : '<span class="muted">без контакта</span>';
  return `${who}<button class="link-ic" type="button" data-dperson="${esc(d.ref)}" title="Чья сделка — поменять человека" aria-label="Чья сделка">✎</button>`;
}

function renderPeople() {
  const D = S.debts;
  $('#peopleSum').innerHTML = D.owedToUs || D.weOwe
    ? [D.owedToUs ? `нам должны <span class="plus">+${rub(D.owedToUs)}</span>` : '', D.weOwe ? `мы должны <span class="minus">−${rub(D.weOwe)}</span>` : '', `с долгом — ${persons(D.people)}`].filter(Boolean).join(' · ')
    : 'Никто никому не должен';
  if (!peopleRows.length) {
    $('#people').innerHTML = '<div class="empty">Людей пока нет. Они появляются из контактов сделок рекламы и покупателей приветки.</div>';
    return;
  }
  const row = (p) => {
    const open = p.items.filter((i) => i.remaining > 0);
    const n = (src) => open.filter((i) => i.source === src).length;
    const adv = p.advanceIn + p.advanceOut;
    const sub = [esc(personAt(p)), n('ads') ? `реклама: ${n('ads')}` : '', n('welcome') ? `приветка: ${n('welcome')}` : '', !open.length ? 'в расчёте' : ''].filter(Boolean).join(' · ');
    const v = (val, cls, sign, lbl) => `<span class="pr-v${val ? '' : ' zero'}"><span class="${val ? cls : ''}">${val ? `${sign}${rub(val)}` : '—'}</span><small>${lbl}</small></span>`;
    return `<button class="prow${p.personId === null ? ' orphan' : ''}" type="button" data-person-open="${p.personId ?? 'none'}">
      <span class="ava" aria-hidden="true">${esc((p.name.replace(/^@/, '')[0] || '?').toUpperCase())}</span>
      <span class="pr-who"><b>${esc(p.name)}</b><small>${sub}</small></span>
      ${v(p.owedToUs, 'plus', '+', 'должен нам')}${v(p.weOwe, 'minus', '−', 'мы должны')}${v(adv, 'adv', '', 'аванс')}
    </button>`;
  };
  const debt = peopleRows.filter((p) => p.owedToUs || p.weOwe);
  const rest = peopleRows.filter((p) => !(p.owedToUs || p.weOwe));
  const open = $('#people details')?.open ? ' open' : '';
  $('#people').innerHTML =
    (debt.length ? `<h3 class="ads-h">С долгом · ${debt.length}</h3>${debt.map(row).join('')}` : '<div class="empty">Долгов нет — все в расчёте.</div>') +
    (rest.length ? `<details class="people-rest"${open}><summary>В расчёте · ${rest.length}</summary>${rest.map(row).join('')}</details>` : '');
}

// подсказка «кто это»: известные люди и контакты из сделок и приветки
function renderPeopleDatalist() {
  const labels = new Set([
    ...peopleRows.filter((p) => p.personId !== null).map(personLabel),
    ...welcomeRows.map((d) => d.contact.trim()),
    ...deals.map((d) => d.contact.trim()),
  ]);
  labels.delete('');
  $('#peopleList').innerHTML = [...labels].sort((a, b) => a.localeCompare(b, 'ru')).map((l) => `<option value="${esc(l)}"></option>`).join('');
}

// Карточка человека. keep — после записи: галочки остаются у того, что ещё ждёт
async function openPerson(id, keep = false) {
  const p = id === null ? peopleRows.find((x) => x.personId === null) : await api(`/api/people/${id}`);
  if (!p) {
    if ($('#personDlg').open) $('#personDlg').close();
    return;
  }
  const sel = keep && personCard ? new Set([...personCard.sel].filter((ref) => p.items.some((i) => i.ref === ref && i.remaining > 0))) : new Set();
  personCard = { p, sel };
  renderPerson();
  if (!$('#personDlg').open) $('#personDlg').showModal();
}

function renderPerson() {
  const { p } = personCard;
  const real = p.personId !== null;
  $('#personName').textContent = p.name;
  $('#personUser').textContent = personAt(p);
  $('#personEdit').hidden = !real;
  const live = p.items.filter((i) => i.remaining > 0);
  const done = p.items.filter((i) => !(i.remaining > 0));
  const cnt = (dir) => live.filter((i) => i.dir === dir).length;
  const box = (lbl, v, cls, sub) => `<div class="pp-box"><span class="kpi-lbl">${lbl}</span><b class="${cls}">${v}</b><small>${sub}</small></div>`;
  const adv = p.advanceIn + p.advanceOut;
  const tots = `<div class="pp-tots">
    ${box('Должен нам', p.owedToUs ? `+${rub(p.owedToUs)}` : rub(0), p.owedToUs ? 'plus' : '', cnt('in') ? positions(cnt('in')) : 'ничего')}
    ${box('Мы должны', p.weOwe ? `−${rub(p.weOwe)}` : rub(0), p.weOwe ? 'minus' : '', cnt('out') ? positions(cnt('out')) : 'ничего')}
    ${adv ? box('Аванс', rub(adv), 'adv', p.advanceIn ? 'его переплата — покроет следующие' : 'наша переплата — покроет закупы') : ''}
  </div>`;
  const acts = real
    ? `<div class="pp-acts"><button class="btn btn-primary" type="button" data-ppay>Оплачено</button>${p.owedToUs && p.weOwe ? `<button class="btn" type="button" data-poffset title="Он должен вам и вы ему — закрыть обе стороны без денег">Взаимозачёт</button>` : ''}<span id="ppSel" class="pp-sel"></span></div>`
    : '<p class="hint pp-orphan">У этих позиций нет контакта. Укажите человека (✎ «чья?») — тогда их можно оплатить вместе с его остальными.</p>';
  const itemLine = (it) => {
    const ref = esc(it.ref);
    const sign = it.dir === 'in' ? '+' : '−';
    const cls = it.dir === 'in' ? 'plus' : 'minus';
    const when = it.remaining > 0 && real
      ? `<label class="pick"><input type="checkbox" data-psel="${ref}">${isoDay(it.date)}</label>`
      : `<span class="pick-gap"></span>${isoDay(it.date)}`;
    const part = it.remaining > 0 && it.remaining < it.amount;
    const sum = `<span class="${it.remaining > 0 ? cls : ''}">${sign}${rub(part ? it.remaining : it.amount)}</span>${part ? `<small>из ${rub(it.amount)}</small>` : ''}`;
    const extra = it.state === 'partial'
      ? `<button class="btn ghost tiny" type="button" data-pclose="${ref}" title="Скидка или недоплата, которую уже не ждём">Простить остаток</button>`
      : it.state === 'closed' ? `<button class="btn ghost tiny" type="button" data-punclose="${ref}" title="Снова ждать остаток">Вернуть</button>` : '';
    const whose = it.source === 'ads' ? `<button class="link-ic" type="button" data-dperson="${ref}" title="Чья сделка — поменять человека">✎ чья?</button>` : '';
    return `<div class="deal pp-it${it.remaining > 0 ? '' : ' done'}"><span class="when">${when}</span>
      <div class="what"><b>${it.dir === 'in' ? 'Он нам' : 'Мы ему'} · ${esc(it.what)}</b><small>${SRC[it.source]}${whose}</small></div>
      <div class="sum">${sum}</div><div class="acts">${debtStatus(it)}${extra}</div></div>`;
  };
  const dirOf = new Map(p.items.map((i) => [i.ref, i.dir]));
  const payLine = (x) => {
    const w = S.wallets.find((y) => y.id === x.walletId);
    const off = x.kind === 'offset';
    const title = off ? 'Взаимозачёт' : x.dir === 'in' ? 'Он заплатил' : 'Мы заплатили';
    const sum = off ? rub(x.rub) : `<span class="${x.dir === 'in' ? 'plus' : 'minus'}">${x.dir === 'in' ? '+' : '−'}${w && w.currency !== 'RUB' ? amt(x.amount, w.currency) : rub(x.rub)}</span>${w && w.currency !== 'RUB' ? `<small>≈ ${rub(x.rub)}</small>` : ''}`;
    const parts = [
      ...x.parts.map((pt) => `<li><span>${off ? (dirOf.get(pt.ref) === 'out' ? 'мы ему · ' : 'он нам · ') : ''}${esc(pt.what)}</span><b>${rub(pt.rub)}</b></li>`),
      ...(x.advance ? [`<li><span>в аванс</span><b>${rub(x.advance)}</b></li>`] : []),
    ].join('');
    const meta = [off ? 'без движения денег' : w ? esc(w.name) : '', esc(x.note)].filter(Boolean).join(' · ');
    return `<div class="op pp-pay"><span class="when">${day(x.at)}</span>
      <div class="what"><b>${title}</b><small>${meta}</small>${parts ? `<ul class="pp-parts">${parts}</ul>` : ''}</div>
      <div class="sum">${sum}</div><button class="del" type="button" data-pdel="${x.id}" aria-label="Удалить оплату" title="Удалить оплату целиком">×</button></div>`;
  };
  const openDone = $('#personBody .pp-done')?.open ? ' open' : '';
  $('#personBody').innerHTML =
    tots + acts +
    (live.length ? `<h4 class="ads-h">Ждём · ${live.length}</h4>${live.map(itemLine).join('')}` : `<div class="empty">${p.items.length ? 'Долгов нет — всё оплачено.' : 'Позиций нет.'}</div>`) +
    (done.length ? `<details class="pp-done"${openDone}><summary>Оплаченные · ${done.length}</summary>${done.map(itemLine).join('')}</details>` : '') +
    (p.payments.length ? `<h4 class="ads-h">Оплаты · ${p.payments.length}</h4>${p.payments.map(payLine).join('')}` : '');
  syncPersonSel();
}

// галочки: одна сторона за раз — продажи и закупы оплачиваются в разные стороны
function syncPersonSel() {
  const { p, sel } = personCard;
  for (const x of $('#personBody').querySelectorAll('[data-psel]')) x.checked = sel.has(x.dataset.psel);
  const el = $('#ppSel');
  if (!el) return;
  const list = p.items.filter((i) => sel.has(i.ref));
  const sum = list.reduce((t, i) => t + i.remaining, 0);
  el.innerHTML = list.length
    ? `выбрано ${list.length} · <span class="${list[0].dir === 'in' ? 'plus' : 'minus'}">${list[0].dir === 'in' ? '+' : '−'}${rub(sum)}</span> <button class="link" type="button" data-psel-clear>снять</button>`
    : 'без галочек — самые старые позиции первыми';
  $('#personBody [data-ppay]').textContent = list.length ? 'Оплачено · выбранные' : 'Оплачено';
}

function openPersonPay() {
  const { p, sel } = personCard;
  const chosen = p.items.filter((i) => sel.has(i.ref));
  const both = p.owedToUs > 0 && p.weOwe > 0;
  const dir = chosen[0]?.dir ?? (p.weOwe > 0 && !p.owedToUs ? 'out' : 'in');
  ppay = { p, dir, refs: chosen.length ? chosen.map((i) => i.ref) : null };
  const f = $('#ppayForm');
  f.reset();
  $('#ppayError').hidden = true;
  $('#ppayTitle').textContent = `Оплачено · ${p.name}`;
  $('#ppayWho').textContent = ppay.refs
    ? `По выбранным: ${positions(chosen.length)} — по порядку даты.`
    : 'Без галочек: самые старые позиции закроются первыми, последняя — частично, лишнее — в аванс.';
  // направление выбирают, когда оно не следует из долгов: долги в обе стороны или долгов нет
  $('#ppayDir').hidden = !!ppay.refs || !(both || (!p.owedToUs && !p.weOwe));
  f.walletId.innerHTML = adWallets().map((w) => `<option value="${w.id}">${esc(w.name)} · ${esc(w.currency)}</option>`).join('');
  f.date.value = todayIso();
  setPPayDir(dir);
  $('#ppayDlg').showModal();
  f.amount.focus();
}

function setPPayDir(dir) {
  ppay.dir = dir;
  for (const b of $('#ppayDir').children) b.classList.toggle('on', b.dataset.dir === dir);
  $('#ppayAmountLabel').firstChild.textContent = dir === 'in' ? 'Сколько пришло' : 'Сколько ушло';
  ppayDefault();
}

const ppayTargets = () =>
  ppay.refs ? ppay.p.items.filter((i) => ppay.refs.includes(i.ref)) : ppay.p.items.filter((i) => i.dir === ppay.dir && i.remaining > 0);

// курс для расчёта: рубль — 1, вписан — он, иначе текущий из /api/state
function ppayRate() {
  const f = $('#ppayForm');
  const w = S.wallets.find((x) => String(x.id) === f.walletId.value);
  if (!w) return { w: null, rate: null };
  if (w.currency === 'RUB') return { w, rate: 1 };
  const typed = Number(String(f.rate.value).replace(/[\s ]/g, '').replace(',', '.'));
  return { w, rate: typed > 0 ? typed : w.rate };
}

// сумма по умолчанию — остаток выбранных (или всех этого направления) в валюте кошелька
function ppayDefault() {
  const f = $('#ppayForm');
  const { w, rate } = ppayRate();
  f.querySelector('[data-pay-rate]').hidden = !w || w.currency === 'RUB';
  const sum = ppayTargets().reduce((t, i) => t + i.remaining, 0);
  f.amount.value = !sum || !rate ? '' : w.currency === 'RUB' ? moneyStr(sum) : fromRub(sum, rate);
  syncPPay();
}

// до записи: что закроется, что станет частичным, что уйдёт в аванс — тем же правилом, что сервер
function syncPPay() {
  const f = $('#ppayForm');
  const { w, rate } = ppayRate();
  const amount = parseMoney(f.amount.value);
  const targets = ppayTargets();
  const box = $('#ppayPreview');
  if (!w) return (box.innerHTML = '<p class="hint">Нет кошелька для оплаты рекламы.</p>');
  if (amount === null || amount === 0) return (box.innerHTML = '<p class="hint">Впишите сумму — здесь будет видно, что она закроет.</p>');
  if (!rate) return (box.innerHTML = `<p class="hint">Нет курса ${esc(w.currency)} — впишите его, чтобы посчитать рубли.</p>`);
  const total = toRubC(amount, rate);
  const { parts, left } = distributeC(targets, total);
  const touched = new Set(parts.map((x) => x.it.ref));
  const rest = targets.filter((i) => !touched.has(i.ref) && i.remaining > 0);
  const row = (cls, tag, what, v) => `<div class="pv-r ${cls}"><span class="pv-t">${tag}</span><span class="pv-w">${what}</span><b>${v}</b></div>`;
  box.innerHTML =
    `<div class="pv-h">${w.currency !== 'RUB' ? `≈ ${rub(total)} по курсу ${rate.toLocaleString('ru-RU', { maximumFractionDigits: 4 })} · ` : ''}${ppay.dir === 'in' ? 'он платит вам' : 'вы платите ему'}</div>` +
    parts
      .map(({ it, rub: r }) =>
        r >= it.remaining
          ? row('ok', 'закроется', `${isoDay(it.date)} · ${esc(it.what)}`, rub(r))
          : row('part', 'частично', `${isoDay(it.date)} · ${esc(it.what)} — останется ${rub(it.remaining - r)}`, rub(r)))
      .join('') +
    (rest.length ? row('wait', 'ждём дальше', `${positions(rest.length)} не хватило`, rub(rest.reduce((t, i) => t + i.remaining, 0))) : '') +
    (left > 0 ? row('adv', 'в аванс', ppay.dir === 'in' ? 'покроет его следующие позиции' : 'наша переплата — покроет следующие закупы', rub(left)) : '') +
    (!targets.length ? '<p class="hint">Позиций этого направления нет — вся сумма станет авансом.</p>' : '');
}

function openOffset() {
  const { p } = personCard;
  const max = Math.min(p.owedToUs, p.weOwe);
  const f = $('#offsetForm');
  f.reset();
  $('#offsetError').hidden = true;
  $('#offsetWho').textContent = `${p.name}: должен вам ${rub(p.owedToUs)}, вы ему ${rub(p.weOwe)}. Зачесть можно до ${rub(max)}.`;
  f.amount.value = moneyStr(max);
  f.date.value = todayIso();
  syncOffset();
  $('#offsetDlg').showModal();
}

function syncOffset() {
  const { p } = personCard;
  const f = $('#offsetForm');
  const max = Math.min(p.owedToUs, p.weOwe);
  const amount = parseMoney(f.amount.value);
  const box = $('#offsetPreview');
  if (!amount) return (box.innerHTML = '<p class="hint">Впишите сумму зачёта в рублях.</p>');
  if (amount > max) return (box.innerHTML = `<p class="err">Не больше ${rub(max)}: столько ${p.owedToUs <= p.weOwe ? 'он должен вам' : 'вы должны ему'}.</p>`);
  const side = (dir, label) => {
    const { parts } = distributeC(p.items.filter((i) => i.dir === dir && i.remaining > 0), amount);
    return `<div class="pv-h">${label}</div>` + parts
      .map(({ it, rub: r }) => `<div class="pv-r ${r >= it.remaining ? 'ok' : 'part'}"><span class="pv-t">${r >= it.remaining ? 'закроется' : 'частично'}</span><span class="pv-w">${isoDay(it.date)} · ${esc(it.what)}${r < it.remaining ? ` — останется ${rub(it.remaining - r)}` : ''}</span><b>${rub(r)}</b></div>`)
      .join('');
  };
  box.innerHTML = side('in', 'Он вам') + side('out', 'Вы ему');
}

function openPersonEdit(p) {
  personEditId = p ? p.personId : null;
  const f = $('#personEditForm');
  f.reset();
  $('#personEditError').hidden = true;
  $('#personEditTitle').textContent = p ? 'Человек' : 'Новый человек';
  f.name.value = p?.name ?? '';
  f.username.value = p?.username ? `@${p.username}` : '';
  $('#personEditHint').textContent = p
    ? 'Имя видно здесь, в приветке и в боте. @username узнаёт человека в новых сделках из аналитики.'
    : 'Если такой уже есть (тот же @username или то же имя без @), откроется он, а не новый.';
  const others = peopleRows.filter((x) => x.personId !== null && x.personId !== p?.personId);
  $('#personMerge').hidden = !p || !others.length;
  f.into.innerHTML = others.map((x) => `<option value="${x.personId}">${esc(personLabel(x))}</option>`).join('');
  $('#personEditDlg').showModal();
}

function openDealPerson(ref) {
  dealPersonRef = ref;
  const d = deals.find((x) => x.ref === ref);
  const f = $('#dealPersonForm');
  f.reset();
  $('#dealPersonError').hidden = true;
  const p = d?.personId != null ? peopleById(d.personId) : null;
  $('#dealPersonDeal').textContent = d
    ? `${dealDay(d.date)} · ${dealTitle(d)} · ${d.channels}${d.contact ? ` · в аналитике: ${d.contact}` : ''}`
    : ref;
  f.contact.value = p ? personLabel(p) : d?.contact ?? '';
  $('#dealPersonDlg').showModal();
  f.contact.select();
}

// --- виды и проекты -----------------------------------------------------------------
let catalogData = null;

async function openCatalog() {
  $('#catalogError').hidden = true;
  catalogData = await api('/api/catalog');
  renderCatalog();
  if (!$('#catalogDlg').open) $('#catalogDlg').showModal();
}

function renderCatalog() {
  const { categories, projects } = catalogData;
  const used = (n) => `<span class="used" title="Операций с ним">${n ? `${n} оп.` : ''}</span>`;
  const lockOrArch = (x, type) => (x.code ? '<span class="lock" title="Нужен импорту или боту — только переименовать">🔒</span>' : `<button class="icon" type="button" data-arch="${type}:${x.id}" aria-label="В архив" title="В архив">×</button>`);
  const rowCat = (c) => `<div class="cat-row"><input value="${esc(c.name)}" maxlength="60" data-rename="categories:${c.id}" aria-label="Название">${used(c.used)}${lockOrArch(c, 'categories')}</div>`;
  const rowPrj = (p) => `<div class="cat-row prj"><input value="${esc(p.name)}" maxlength="60" data-rename="projects:${p.id}" aria-label="Название"><input value="${p.partnerPct || ''}" inputmode="decimal" placeholder="0 %" data-pct="${p.id}" aria-label="Доля партнёра, %" title="Доля партнёра, % — от дохода за вычетом комиссий и от расходов">${used(p.used)}${lockOrArch(p, 'projects')}</div>`;
  const archived = (list, type) => (list.length ? `<details><summary>В архиве · ${list.length}</summary>${list.map((x) => `<div class="cat-row arch"><span>${esc(x.name)}</span>${used(x.used)}<button class="btn ghost" type="button" data-unarch="${type}:${x.id}">Вернуть</button></div>`).join('')}</details>` : '');
  const sec = (title, kind) => {
    const list = categories.filter((c) => c.kind === kind);
    return `<div class="cat-sec"><h4>${title}</h4>${list.filter((c) => !c.archived).map(rowCat).join('')}
      <form class="cat-add" data-add="${kind}"><input name="name" maxlength="60" placeholder="Новый вид"><button class="btn" type="submit">Добавить</button></form>${archived(list.filter((c) => c.archived), 'categories')}</div>`;
  };
  $('#catalog').innerHTML = sec('Виды дохода', 'income') + sec('Виды расхода', 'expense') +
    `<div class="cat-sec"><h4>Проекты · доля партнёра, %</h4>${projects.filter((p) => !p.archived).map(rowPrj).join('')}
      <form class="cat-add prj" data-add="project"><input name="name" maxlength="60" placeholder="Новый проект"><input name="partnerPct" inputmode="decimal" placeholder="0 %"><button class="btn" type="submit">Добавить</button></form>${archived(projects.filter((p) => p.archived), 'projects')}</div>`;
}

async function catalogCall(path, init) {
  try {
    $('#catalogError').hidden = true;
    await api(path, init);
    await load();
    catalogData = await api('/api/catalog');
    renderCatalog();
    return true;
  } catch (err) {
    $('#catalogError').textContent = err.message;
    $('#catalogError').hidden = false;
    return false;
  }
}

// --- партнёрка: доход по балансу в миниапке ----------------------------------------
function openPartner() {
  const w = S.wallets.find((x) => x.role === 'partner');
  if (!w) return;
  const f = $('#partnerForm');
  f.reset();
  $('#partnerError').hidden = true;
  f.date.value = todayIso();
  f.querySelector('[data-rate]').hidden = w.currency === 'RUB';
  $('#partnerCounted').textContent = `Насчитано сейчас: ${amt(w.balance, w.currency)}. Впишите, сколько на счёте в миниапке, — прирост станет доходом «Партнёрская программа». Выводы вносите «Переводом» с «Партнёрки».`;
  $('#partnerDlg').showModal();
  f.balance.focus();
}

// --- партнёр: расчёт по проекту с партнёром -------------------------------------------
// Долг = его доля дохода − его доля всех расходов + что он оплатил сам − что ему
// докинули + что он докинул (ledger.ts, owedFrom). Здесь — та же сумма по частям.
const ym = (m) => `${MONTHS[Number(m.slice(5)) - 1]} ${m.slice(0, 4)}`;
function renderPartner() {
  if (!partnerRows.length) {
    $('#partner').innerHTML = '<article class="card"><div class="empty" style="padding-top:18px">Проектов с партнёром нет — его долю задают в ⚙ «Виды и проекты».</div></article>';
    return;
  }
  const line = (label, v, cls = '') => `<div class="pl-row"><span>${label}</span><b class="${cls}">${v}</b></div>`;
  const sign = (v) => (v > 0 ? `+${rub(v)}` : v < 0 ? `−${rub(-v)}` : rub(0));
  $('#partner').innerHTML = partnerRows
    .map((p) => {
      const o = p.owed;
      const head = o > 0 ? 'Докинуть партнёру' : o < 0 ? 'Партнёр докидывает вам' : 'Расчёт сошёлся';
      const months = [...p.months].reverse();
      const opRow = (x) => {
        const w = S.wallets.find((y) => y.id === x.walletId);
        const title = x.kind === 'payout' ? 'Вы докинули партнёру' : x.kind === 'payin' ? 'Партнёр докинул вам' : `${esc(nameOf(S.categories, x.categoryId))} · платил партнёр`;
        const sum = x.kind === 'expense' && x.paidCurrency && x.paidCurrency !== 'RUB' ? `${amt(x.paidAmount, x.paidCurrency)}<small>≈ ${rub(x.grossRub)}</small>` : rub(x.grossRub);
        return `<div class="op"><span class="when">${day(x.at)}</span><div class="what"><b>${title}</b><small>${[w && esc(w.name), esc(x.note)].filter(Boolean).join(' · ') || OP_LABEL[x.kind]}</small></div>
          <div class="sum"><span class="${x.kind === 'payin' ? 'plus' : 'minus'}">${sum}</span></div><button class="del" type="button" data-del="${x.id}" aria-label="Удалить операцию">×</button></div>`;
      };
      return `<article class="card hero">
        <div class="card-h"><span class="card-idx">01 / расчёт</span><div class="card-tt"><h2 class="card-t">${esc(p.name)} · партнёру ${p.pct}%</h2><div class="card-s">Его доля — ${p.pct}% дохода после комиссий и ${p.pct}% всех расходов, кто бы их ни оплатил</div></div>
          <div class="right"><button class="btn" type="button" data-pexp="${p.projectId}">+ Расход партнёра</button></div></div>
        <div class="pl-grid">
          <div class="pl-total"><span class="kpi-lbl">${head}</span><b class="${o > 0 ? 'warn' : o < 0 ? 'good' : ''}">${rub(Math.abs(o))}</b>
            <small>${o > 0 ? 'столько вы должны ему на сегодня' : o < 0 ? 'столько он должен вам на сегодня' : 'никто никому не должен'}</small>
            <div class="pl-acts">
              <button class="btn ${o > 0 ? 'btn-primary' : ''}" type="button" data-psettle="payout" data-project="${p.projectId}" data-amount="${o > 0 ? o : ''}">Докинуть партнёру</button>
              <button class="btn ${o < 0 ? 'btn-primary' : ''}" type="button" data-psettle="payin" data-project="${p.projectId}" data-amount="${o < 0 ? -o : ''}">Партнёр докинул</button>
            </div>
          </div>
          <div>
            ${line('Доход после комиссий', rub(p.income))}
            ${line(`Его доля дохода · ${p.pct}%`, sign(p.incomeShare), 'plus')}
            ${line('Расходы — платили вы', rub(p.expenseOwner))}
            ${line('Расходы — платил партнёр', rub(p.expensePartner))}
            ${line(`Его доля расходов · ${p.pct}%`, sign(-p.expenseShare), 'minus')}
            ${line('Вернуть ему его расходы', sign(p.expensePartner), 'plus')}
            ${line('Вы докинули ему', sign(-p.paidOut), 'minus')}
            ${line('Он докинул вам', sign(p.paidIn), 'plus')}
            <div class="pl-row total"><span>${o >= 0 ? 'Вы должны партнёру' : 'Партнёр должен вам'}</span><b class="${o > 0 ? 'minus' : o < 0 ? 'plus' : ''}">${rub(Math.abs(o))}</b></div>
          </div>
        </div>
      </article>
      <article class="card">
        <div class="card-h"><span class="card-idx">02 / по месяцам</span><div class="card-tt"><h2 class="card-t">Как набегало</h2><div class="card-s">«Набежало» — его доля дохода − его доля расходов + его расходы; «долг» — ваш ему на конец месяца, с выплатами</div></div></div>
        ${months.length ? `<div class="scroll-x"><table>
          <thead><tr><th>Месяц</th><th class="num">Доход</th><th class="num">Платили вы</th><th class="num">Платил он</th><th class="num">Набежало</th><th class="num">Выплаты</th><th class="num">Долг</th></tr></thead>
          <tbody>${months.map((m) => `<tr><td>${ym(m.month)}</td><td class="num">${rub(m.income)}</td><td class="num">${rub(m.expenseOwner)}</td><td class="num">${rub(m.expensePartner)}</td>
            <td class="num">${sign(m.accrued)}</td><td class="num">${m.paidOut || m.paidIn ? sign(m.paidIn - m.paidOut) : '—'}</td>
            <td class="num ${m.owed > 0 ? 'minus' : m.owed < 0 ? 'plus' : ''}">${m.owed >= 0 ? rub(m.owed) : `он вам ${rub(-m.owed)}`}</td></tr>`).join('')}</tbody>
        </table></div>` : '<div class="empty">Операций по проекту ещё нет.</div>'}
      </article>
      <article class="card">
        <div class="card-h"><span class="card-idx">03 / операции</span><div class="card-tt"><h2 class="card-t">Его расходы и выплаты</h2><div class="card-s">Расходы, которые оплатил партнёр, и деньги туда и обратно</div></div></div>
        ${p.ops.length ? p.ops.map(opRow).join('') : '<div class="empty">Пока ничего — партнёр ничего не оплачивал, выплат не было.</div>'}
      </article>`;
    })
    .join('');
}

// --- регулярные расходы ------------------------------------------------------------
// месяц блока — выбранный; в режиме «Год» — текущий
const recMonth = () => (period === 'year' ? todayIso().slice(0, 7) : month);
const nameOrDash = (list, id) => (id == null ? '' : list.find((x) => x.id === id)?.name ?? '');

function renderRecurring() {
  const m = recMonth();
  const [y, mo] = m.split('-').map(Number);
  $('#recurringTitle').textContent = `Регулярные расходы · ${new Date(Date.UTC(y, mo - 1, 15)).toLocaleString('ru-RU', { month: 'long', timeZone: 'UTC' })}`;
  const active = recurringRows.filter((r) => r.active);
  const sum = (pick) => active.filter(pick).reduce((t, r) => t + (r.rubEstimate ?? 0), 0);
  $('#recurringSum').innerHTML = active.length
    ? [`в месяц ≈ ${rub(sum(() => true))}`, `записано ${rub(sum((r) => r.state === 'paid'))}`, sum((r) => r.state === 'due') ? `<span class="owed">ждёт ${rub(sum((r) => r.state === 'due'))}</span>` : '', sum((r) => r.state === 'upcoming') ? `впереди ${rub(sum((r) => r.state === 'upcoming'))}` : ''].filter(Boolean).join(' · ')
    : '';
  if (!recurringRows.length) {
    $('#recurring').innerHTML = '<div class="empty">Регулярных расходов нет. Сервер, подписка — заведите: сумма, кошелёк, какого числа. В этот день бот пришлёт готовый черновик.</div>';
    return;
  }
  $('#recurring').innerHTML = recurringRows
    .map((r) => {
      const id = r.id;
      const sumTxt = `${amt(r.amount, r.currency)}${r.currency !== 'RUB' && r.rubEstimate != null ? `<small>≈ ${rub(r.rubEstimate)}</small>` : ''}`;
      let acts;
      if (!r.active) acts = '<span class="chip">выключен</span>';
      else if (r.state === 'paid') acts = '<span class="chip">✓ записан</span>';
      else if (r.state === 'skipped') acts = `<span class="chip">пропущен</span><button class="btn ghost" type="button" data-rskip="${id}" data-on="0">Вернуть</button>`;
      else if (r.state === 'due') acts = `<button class="btn btn-primary" type="button" data-rpay="${id}">Записать</button><button class="btn" type="button" data-rskip="${id}" data-on="1">Пропустить</button>`;
      else acts = `<span class="chip">будет ${day(Date.parse(`${r.dueDate}T09:00:00Z`))}</span><button class="btn ghost" type="button" data-rpay="${id}" title="Записать заранее">Записать</button>`;
      const sub = [nameOrDash(S.categories, r.categoryId), nameOrDash(S.projects, r.projectId), r.paidBy === 'partner' ? 'платит партнёр' : nameOrDash(S.wallets, r.walletId)].filter(Boolean).map(esc).join(' · ');
      return `<div class="deal${!r.active || r.state === 'paid' || r.state === 'skipped' ? ' done' : ''}"><span class="when">${String(r.day).padStart(2, '0')} числа</span>
        <div class="what"><b>${esc(r.name)}</b><small>${sub}${r.state === 'due' && r.active ? ` · <span class="age">ждёт с ${day(Date.parse(`${r.dueDate}T09:00:00Z`))}</span>` : ''}</small></div>
        <div class="sum">${sumTxt}</div><div class="acts">${acts}<button class="btn ghost" type="button" data-redit="${id}" aria-label="Изменить">✎</button></div></div>`;
    })
    .join('');
}

function openRecurring(r) {
  recurringEdit = r ?? null;
  const f = $('#recurringForm');
  f.reset();
  $('#recurringError').hidden = true;
  $('#recurringTitleDlg').textContent = r ? 'Регулярный расход' : 'Новый регулярный расход';
  f.walletId.innerHTML = S.wallets.filter((w) => !w.archived).map((w) => `<option value="${w.id}">${esc(w.name)} · ${esc(w.currency)}</option>`).join('');
  f.categoryId.innerHTML = opts(S.categories.filter((c) => c.kind === 'expense'), '—');
  f.projectId.innerHTML = opts(S.projects, '—');
  const cb = S.wallets.find((w) => /cryptobot/i.test(w.name) && !w.role && !w.archived);
  f.name.value = r?.name ?? '';
  f.walletId.value = String(r?.walletId ?? cb?.id ?? f.walletId.value);
  f.amount.value = r ? String(r.amount / MICRO).replace('.', ',') : '';
  f.currency.value = r?.currency ?? '';
  f.currency.placeholder = S.wallets.find((w) => String(w.id) === f.walletId.value)?.currency ?? '';
  f.day.value = r?.day ?? '';
  f.categoryId.value = r?.categoryId ?? '';
  f.projectId.value = r?.projectId ?? '';
  f.paidBy.value = r?.paidBy === 'partner' ? 'partner' : 'me';
  syncRecPayer();
  f.active.checked = r ? r.active : true;
  f.querySelector('[data-active]').hidden = !r;
  $('#recurringDel').hidden = !r;
  $('#recurringDlg').showModal();
}

// платит партнёр — кошелёк не нужен, а в проект годится только проект с партнёром
function syncRecPayer() {
  const f = $('#recurringForm');
  const partner = f.paidBy.value === 'partner';
  f.querySelector('[data-rec-wallet]').hidden = partner;
  f.walletId.disabled = partner;
  f.currency.placeholder = partner ? 'RUB' : S.wallets.find((w) => String(w.id) === f.walletId.value)?.currency ?? '';
}

function payRecurringRow(id) {
  const r = recurringRows.find((x) => x.id === id);
  if (!r) return;
  if (r.paidBy === 'partner') {
    showPay({
      title: 'Регулярный расход партнёра',
      desc: `${r.name} · ${amt(r.amount, r.currency)} за ${$('#recurringTitle').textContent.split('· ')[1]} · платит партнёр`,
      amount: r.rubEstimate,
      native: { amount: r.amount, currency: r.currency },
      noWallet: true,
      currency: r.currency,
      amountLabel: `Сколько заплатил партнёр, ${r.currency}`,
      hint: 'Ваши кошельки не трогает: вы останетесь должны партнёру эту сумму за вычетом его доли.',
      url: `/api/recurring/${id}/pay`,
      extra: { month: recMonth() },
    });
    return;
  }
  showPay({
    title: 'Регулярный расход',
    desc: `${r.name} · ${amt(r.amount, r.currency)} за ${$('#recurringTitle').textContent.split('· ')[1]}`,
    amount: r.rubEstimate,
    native: { amount: r.amount, currency: r.currency },
    wallets: S.wallets.filter((w) => !w.archived),
    walletId: r.walletId,
    amountLabel: 'Сколько ушло',
    hint: [nameOrDash(S.categories, r.categoryId), nameOrDash(S.projects, r.projectId)].filter(Boolean).join(' · ') || 'Расход',
    url: `/api/recurring/${id}/pay`,
    extra: { month: recMonth() },
  });
}

// --- VPN: оплаты без платёжки ----------------------------------------------------
// как их называет VPN-бот → кнопка и кошелёк (роль vpn:<имя>)
const VPN_PROVIDERS = [
  ['platega', 'Platega', 'Platega VPN'],
  ['cryptobot', 'CryptoBot', 'CryptoBot VPN'],
  ['parity', 'Parity', 'Parity VPN'],
  ['lolzteam', 'Lolzteam', 'Lolzteam VPN'],
];
const vpnButtons = (attr, ref) =>
  VPN_PROVIDERS.map(([id, label]) => `<button class="btn" type="button" ${attr}="${id}"${ref ? ` data-ref="${ref}"` : ''}>${label}</button>`).join('');
$('#vpnBulkProviders').innerHTML = vpnButtons('data-vbulk');
const stamp = (ms) => `${day(ms)} ${new Date(ms + MSK).toISOString().slice(11, 16)}`;

function renderVpn() {
  vpnPicked.clear();
  syncVpnPick();
  if (!vpnRows.length) {
    $('#vpn').innerHTML = '<div class="empty">Всё разобрано: у каждой оплаты VPN есть платёжка.</div>';
    return;
  }
  const total = vpnRows.reduce((s, p) => s + p.amount, 0);
  $('#vpn').innerHTML =
    `<h3 class="ads-h"><label class="pick"><input type="checkbox" data-vpick-all aria-label="Выбрать все">Без платёжки · ${vpnRows.length} · ${rub(total)}</label></h3>` +
    vpnRows
      .map((p) => {
        const ref = esc(p.ref);
        return `<div class="deal"><span class="when"><label class="pick"><input type="checkbox" data-vpick="${ref}">${day(p.at)}</label></span>
          <div class="what"><b>${p.type === 'renewal' ? 'Продление' : 'Покупка'}</b><small>${stamp(p.at)} по Москве</small></div>
          <div class="sum"><span class="plus">+${rub(p.amount)}</span></div>
          <div class="acts">${vpnButtons('data-vone', ref)}<button class="btn ghost" type="button" data-vone="skip" data-ref="${ref}" title="Не учитывать: тестовая оплата и т. п.">×</button></div></div>`;
      })
      .join('');
}

// «Не учитывать» нажали по ошибке — оплату можно вернуть: с платёжкой она сразу
// ляжет доходом, без неё — снова в «Без платёжки».
function renderVpnSkipped() {
  if (!vpnSkipped.length) {
    $('#vpnSkipped').innerHTML = '';
    return;
  }
  const total = vpnSkipped.reduce((s, p) => s + p.amount, 0);
  const open = $('#vpnSkipped details')?.open ? ' open' : ''; // после «Вернуть» список не сворачивается
  $('#vpnSkipped').innerHTML =
    `<details class="vpn-skipped"${open}><summary>Не учтены · ${vpnSkipped.length} · ${rub(total)}</summary>` +
    vpnSkipped
      .map((p) => {
        const ref = esc(p.ref);
        const prov = VPN_PROVIDERS.find(([id]) => id === p.provider)?.[1];
        return `<div class="deal"><span class="when">${day(p.at)}</span>
          <div class="what"><b>${p.type === 'renewal' ? 'Продление' : 'Покупка'}</b><small>${stamp(p.at)} по Москве${prov ? ` · ${prov}` : ''} · отмечена ${day(p.skippedAt)}</small></div>
          <div class="sum"><span class="plus">+${rub(p.amount)}</span></div>
          <div class="acts"><button class="btn" type="button" data-vrestore="${ref}" title="${prov ? `Записать доходом на ${esc(prov)}` : 'Вернуть в «Без платёжки»'}">Вернуть</button></div></div>`;
      })
      .join('') +
    '</details>';
}

function syncVpnPick() {
  const boxes = [...document.querySelectorAll('[data-vpick]')];
  const all = $('[data-vpick-all]');
  const n = boxes.filter((x) => x.checked).length;
  if (all) {
    all.checked = n > 0 && n === boxes.length;
    all.indeterminate = n > 0 && n < boxes.length;
  }
  const list = vpnRows.filter((p) => vpnPicked.has(p.ref));
  $('#vpnBar').hidden = !list.length;
  if (list.length) $('#vpnPicked').innerHTML = `<b>Выбрано ${list.length}</b> · <span class="plus">+${rub(list.reduce((s, p) => s + p.amount, 0))}</span>`;
}

async function resolveVpn(refs, action, buttons) {
  for (const x of buttons) x.disabled = true;
  try {
    const r = await api('/api/vpn/resolve', { method: 'POST', body: JSON.stringify({ refs, action }) });
    await load();
    toast(`${action === 'skip' ? 'Не учитываются' : `Записано на ${VPN_PROVIDERS.find(([id]) => id === action)?.[2] ?? action}`}: ${r.done}${r.skipped ? `, пропущено: ${r.skipped}` : ''}`);
  } catch (err) {
    toast(err.message);
    await load().catch(() => {});
  } finally {
    for (const x of buttons) x.disabled = false;
  }
}

async function restoreVpn(ref, button) {
  button.disabled = true;
  try {
    const r = await api('/api/vpn/restore', { method: 'POST', body: JSON.stringify({ refs: [ref] }) });
    await load();
    toast(r.booked ? 'Возвращена и записана доходом' : r.waiting.length ? `Возвращена, но не записана: ${r.waiting[0]}` : r.done ? 'Возвращена в «Без платёжки»' : 'Уже возвращена');
  } catch (err) {
    toast(err.message);
    await load().catch(() => {});
  } finally {
    button.disabled = false;
  }
}

function openPay(ref) {
  const d = deals.find((x) => x.ref === ref);
  if (!d) return;
  const part = dealCovered(d) > 0;
  const tail = 'Меньше суммы — оплачена частично, остаток ждём; больше — переплата уйдёт в аванс человека. Встречный долг закрывайте «Взаимозачётом» в его карточке.';
  showPay({
    title: d.kind === 'sale' ? 'Продажа оплачена' : 'Закуп оплачен',
    desc: `${dealDay(d.date)} · ${dealTitle(d)} · ${[d.contact, d.channels].filter(Boolean).join(' · ')}${d.amount != null ? ` · ${part ? `осталось ${rub(d.remaining)} из ${rub(d.amount)}` : rub(d.amount)}` : ''}`,
    amount: part ? d.remaining : d.amount,
    amountLabel: d.kind === 'sale' ? 'Сколько пришло' : 'Сколько ушло',
    hint: d.kind === 'sale'
      ? `Доход «Реклама», без комиссии. Сумма пересчитана по курсу — впишите, сколько пришло на самом деле. ${d.amount != null ? tail : ''}`
      : `Расход «Закуп рекламы» с этого кошелька, без комиссии. ${d.amount != null ? tail : ''}`,
    url: `/api/ad-deals/${encodeURIComponent(ref)}/pay`,
  });
}

// Несколько мест одним переводом: самые старые целиком, последнее — частично (ads.ts, payDeals).
function openPayMany(list, who) {
  const ok = list.filter(payable);
  if (!ok.length) return toast('Оплачивать нечего: у выбранных мест нет суммы');
  if (new Set(ok.map((d) => d.kind)).size > 1) return toast('Продажи и закупы — отдельно: деньги идут в разные стороны');
  const sale = ok[0].kind === 'sale';
  const sum = ok.reduce((s, d) => s + d.amount, 0);
  const skipped = list.length - ok.length;
  showPay({
    title: `${sale ? 'Оплачено' : 'Оплатил'}: ${places(ok.length)}`,
    desc: `${who ? `${who} · ` : ''}${ok.map((d) => `${dealDay(d.date)} ${SLOT[d.slot] ?? d.slot}`).join(', ')} · ${rub(sum)}${skipped ? ` · без суммы и разобранные (${skipped}) — мимо` : ''}`,
    amount: sum,
    amountLabel: sale ? 'Сколько пришло всего' : 'Сколько ушло всего',
    hint: `${sale ? 'Доход «Реклама»' : 'Расход «Закуп рекламы»'}, без комиссии. Впишите, сколько ${sale ? 'пришло' : 'ушло'} на самом деле: сумма закроет места по порядку даты — старые целиком, последнее частично, лишнее — в аванс человека.`,
    url: '/api/ad-deals/pay-many',
    extra: { refs: ok.map((d) => d.ref) },
  });
}

function showPay(target) {
  payTarget = target;
  const f = $('#payForm');
  f.reset();
  $('#payError').hidden = true;
  $('#payTitle').textContent = target.title;
  $('#payDeal').textContent = target.desc;
  f.walletId.innerHTML = (target.wallets ?? adWallets()).map((w) => `<option value="${w.id}">${esc(w.name)} · ${esc(w.currency)}</option>`).join('');
  // платит партнёр — кошелька нет, и в запрос он не уходит
  f.walletId.closest('label').hidden = !!target.noWallet;
  f.walletId.disabled = !!target.noWallet;
  if (target.walletId) f.walletId.value = String(target.walletId);
  f.date.value = target.date ?? todayIso();
  $('#payAmountLabel').firstChild.textContent = target.amountLabel;
  $('#payHint').textContent = target.hint;
  syncPay();
  $('#payDlg').showModal();
}

// За рекламу платят переводом на CryptoBot: он первым, а платёжки, принимающие
// оплату картой (Platega), в список не попадают. Кабинеты VPN (с ролью) — тоже:
// это деньги, поделённые с партнёром.
const adWallets = () =>
  S.wallets
    .filter((w) => !w.archived && !w.role && (w.kind !== 'provider' || /cryptobot/i.test(w.name)))
    .sort((a, b) => /cryptobot/i.test(b.name) - /cryptobot/i.test(a.name));

// сумма сделки — в рублях; на кошелёк в другой валюте подставляем по курсу
function syncPay() {
  const f = $('#payForm');
  if (payTarget?.noWallet) {
    f.querySelector('[data-pay-rate]').hidden = payTarget.currency === 'RUB';
    if (payTarget.native) f.amount.value = String(payTarget.native.amount / MICRO).replace('.', ',');
    return;
  }
  const amount = payTarget?.amount;
  const w = S.wallets.find((x) => String(x.id) === f.walletId.value);
  f.querySelector('[data-pay-rate]').hidden = !w || w.currency === 'RUB';
  if (!w) return;
  // сумма в валюте кошелька известна точно — без круга через рубли
  if (payTarget?.native && payTarget.native.currency === w.currency) {
    f.amount.value = String(payTarget.native.amount / MICRO).replace('.', ',');
    return;
  }
  if (amount == null) return;
  // частичная оплата теперь частичная: сумма по умолчанию должна давать ровно рубли сделки
  f.amount.value = w.currency === 'RUB' ? String(amount / MICRO).replace('.', ',') : w.rate ? fromRub(amount, w.rate) : '';
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
          ${w.role === 'partner' ? '<button class="btn wallet-act" type="button" data-partner title="Вписать баланс из миниапки — прирост станет доходом">Сверить</button>' : ''}
        </div>`
        )
        .join('')
    : '<div class="empty">Кошельков нет — добавьте первый.</div>';
}

function reportHtml(r) {
  const rows = (list, kind) =>
    list.length
      ? list.map((x) => `<tr><td>${esc(nameOf(S.categories, x.categoryId))}<br><small class="muted">${esc(nameOf(S.projects, x.projectId))}</small></td><td class="num ${kind}">${rub(x.rub)}</td></tr>`).join('')
      : '<tr><td class="muted" colspan="2">нет</td></tr>';
  return `<div class="rep">
    <div><h3>Доходы</h3><table>${rows(r.income, 'plus')}<tr class="total"><td>Всего</td><td class="num">${rub(r.totalIncome)}</td></tr></table></div>
    <div><h3>Комиссии и расходы</h3><table>
      <tr><td>Комиссии платёжек</td><td class="num minus">${rub(r.incomeFees)}</td></tr>
      <tr><td>Потери при выводе и обмене</td><td class="num minus">${rub(r.transferFees)}</td></tr>
      ${rows(r.expense, 'minus')}
      <tr class="total"><td>Чистыми</td><td class="num ${r.net >= 0 ? 'plus' : 'minus'}">${rub(r.net)}</td></tr>
    </table></div></div>`;
}

const MONTHS = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];

// Год: строка на месяц (нажать — открыть месяц), итог, ниже — весь год по видам.
// Таблица шире телефона и прокручивается внутри карточки, а не вся страница.
function yearHtml(y) {
  const cell = (v) => (v ? `<td class="num">${rub(v)}</td>` : '<td class="num muted">—</td>');
  const empty = (m) => !m.totalIncome && !m.incomeFees && !m.transferFees && !m.totalExpense;
  const cells = (m) =>
    cell(m.totalIncome) + cell(m.incomeFees) + cell(m.transferFees) + cell(m.totalExpense) +
    (empty(m) ? '<td class="num muted">—</td>' : `<td class="num ${m.net >= 0 ? 'plus' : 'minus'}">${rub(m.net)}</td>`);
  const rows = y.months
    .map((m, i) => `<tr data-month="${m.month}" title="Открыть месяц"><td>${MONTHS[i]}</td>${cells(m)}</tr>`)
    .join('');
  return `<div class="scroll-x"><table class="year">
    <thead><tr><th>Месяц</th><th class="num">Доход</th><th class="num">Комиссии</th><th class="num">Потери при выводе</th><th class="num">Расходы</th><th class="num">Чистыми</th></tr></thead>
    <tbody>${rows}<tr class="total"><td>За год</td>${cells(y.total)}</tr></tbody>
  </table></div>${reportHtml(y.total)}`;
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
    const plus = o.kind === 'income' || o.kind === 'payin';
    title = o.kind === 'payout' ? `Выплата партнёру · ${esc(nameOf(S.projects, o.projectId))}` : o.kind === 'payin' ? `От партнёра · ${esc(nameOf(S.projects, o.projectId))}` : esc(nameOf(S.categories, o.categoryId));
    sum = `<span class="${plus ? 'plus' : 'minus'}">${plus ? '+' : '−'}${rub(o.grossRub)}</span>`;
    sub = o.paidBy === 'partner'
      ? ['платил партнёр', o.paidCurrency && o.paidCurrency !== 'RUB' ? amt(o.paidAmount, o.paidCurrency) : ''].filter(Boolean).join(' · ')
      : [wallet && esc(wallet.name), o.kind === 'income' && o.feeRub ? `комиссия ${rub(o.feeRub)}` : '', wallet && wallet.currency !== 'RUB' && a ? amt(Math.abs(a.amount), wallet.currency) : ''].filter(Boolean).join(' · ');
  }
  const meta = [OP_LABEL[o.kind], o.projectId && o.kind !== 'payout' && o.kind !== 'payin' ? esc(nameOf(S.projects, o.projectId)) : '', esc(o.note), o.source === 'botprivat' ? 'авто · ботприват' : o.source === 'ads' ? 'сделка рекламы' : o.source === 'vpn' ? 'авто · VPN' : ''].filter(Boolean).join(' · ');
  return `<div class="op"><span class="when">${day(o.at)}</span><div class="what"><b>${title}</b><small>${meta}</small></div><div class="sum">${sum}<small>${sub}</small></div><button class="del" type="button" data-del="${o.id}" aria-label="Удалить операцию">×</button></div>`;
}

async function load() {
  const byYear = period === 'year';
  const [state, report, ops, ads] = await Promise.all([
    api('/api/state'),
    byYear ? api(`/api/year?year=${year}`) : api(`/api/report?month=${month}`),
    byYear ? null : api(`/api/operations?month=${month}`),
    api('/api/ad-deals'),
  ]);
  S = state;
  deals = ads;
  [vpnRows, vpnSkipped, welcomeRows, incomeRows, recurringRows, peopleRows] = await Promise.all([
    api('/api/vpn/unsorted'),
    api('/api/vpn/skipped'),
    api('/api/welcome'),
    api(byYear ? `/api/income?year=${year}` : `/api/income?month=${month}`),
    api(`/api/recurring?month=${recMonth()}`),
    api('/api/people'),
  ]);
  partnerRows = await api('/api/partner-settlement');
  $('#login').hidden = true;
  $('#app').hidden = false;
  if (location.search) history.replaceState(null, '', location.pathname + location.hash);
  const [y, m] = month.split('-').map(Number);
  // на узком телефоне месяц — коротко («окт 2026»), иначе подпись не помещается рядом с «+»
  const monthLong = new Date(Date.UTC(y, m - 1, 15)).toLocaleString('ru-RU', { month: 'long', timeZone: 'UTC' });
  $('#monthLabel').innerHTML = byYear ? String(year) : `<span class="m-l">${monthLong}</span><span class="m-s">${MONTHS[m - 1]}</span> ${y}`;
  $('#prevMonth').setAttribute('aria-label', byYear ? 'Прошлый год' : 'Прошлый месяц');
  $('#nextMonth').setAttribute('aria-label', byYear ? 'Следующий год' : 'Следующий месяц');
  for (const b of $('#period').children) {
    b.classList.toggle('on', b.dataset.period === period);
    b.setAttribute('aria-pressed', String(b.dataset.period === period));
  }
  $('#reportTitle').textContent = byYear ? 'Итоги года' : 'Итоги месяца';
  tilesReport = byYear ? report.total : report;
  renderTiles(tilesReport);
  renderTodo();
  renderBadges();
  const usdt = S.wallets.find((w) => w.currency === 'USDT' && w.rate);
  $('#sysRate').textContent = usdt ? `1 USDT = ${usdt.rate.toLocaleString('ru-RU', { maximumFractionDigits: 2 })} ₽` : 'курсы — CoinGecko';
  renderAds();
  renderIncome();
  renderWelcome();
  renderPeople();
  renderPeopleDatalist();
  // открытая карточка человека — со свежими позициями и оплатами
  if (personCard && $('#personDlg').open) await openPerson(personCard.p.personId, true).catch((e) => toast(e.message));
  renderRecurring();
  renderVpn();
  renderVpnSkipped();
  renderPartner();
  renderWallets();
  $('#report').innerHTML = byYear ? yearHtml(report) : reportHtml(report);
  $('#ops').innerHTML = byYear
    ? '<div class="empty">Операции — в режиме <button class="link" type="button" data-period="month">«Месяц»</button>.</div>'
    : ops.length ? ops.map(opLine).join('') : '<div class="empty">За этот месяц операций нет.</div>';
  $('#recentSub').textContent = byYear ? 'в режиме «Год» — по месяцам в «Итогах»' : `за ${new Date(Date.UTC(y, m - 1, 15)).toLocaleString('ru-RU', { month: 'long', timeZone: 'UTC' })}`;
  $('#recent').innerHTML = byYear ? '' : ops.length ? ops.slice(0, 8).map(opLine).join('') : '<div class="empty">За этот месяц операций нет.</div>';
}

// Месяц ↔ год. Из года в месяц — тот же месяц выбранного года, или тот, что нажали в таблице.
function setPeriod(p, m) {
  if (p === 'year') year = Number(month.slice(0, 4));
  else month = m ?? `${year}-${month.slice(5)}`;
  period = p;
  load().catch((e) => toast(e.message));
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
    html = `<label>Платил<select name="paidBy"><option value="me">Я — с кошелька</option>${S.projects.some((p) => p.partnerPct > 0) ? '<option value="partner">Партнёр — своими</option>' : ''}</select></label>
      <label data-me>Кошелёк<select name="walletId">${walletOpts()}</select></label>
      <label data-partner hidden>Валюта<input name="currency" maxlength="6" autocapitalize="characters" placeholder="RUB"></label>${date}
      <label>Сумма<input name="amount" inputmode="decimal" required placeholder="20"></label>
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
  if (opKind === 'payout' || opKind === 'payin')
    html = `<label>${opKind === 'payin' ? 'На какой кошелёк' : 'С какого кошелька'}<select name="walletId">${walletOpts()}</select></label>${date}
      <label>Сумма<input name="amount" inputmode="decimal" required></label>
      <label>Проект<select name="projectId">${opts(S.projects.filter((p) => p.partnerPct > 0))}</select></label>${rate()}${note}`;
  $('#opFields').innerHTML = html;
  const transferSecond = S.wallets.filter((w) => !w.archived)[1];
  if (opKind === 'transfer' && transferSecond) $('#opFields [name=toWalletId]').value = transferSecond.id;
  $('#opHint').textContent = {
    income: 'На кошелёк ляжет сумма за вычетом комиссии; в отчёте — полная сумма и комиссия отдельно.',
    expense: 'Расход проекта с партнёром делится по долям, кто бы его ни оплатил. Платил партнёр — кошелёк не нужен: впишите, сколько и в чём он заплатил, — вы останетесь должны ему это за вычетом его доли.',
    transfer: 'Впишите, сколько ушло и сколько пришло — разница в рублях станет комиссией вывода (3 %, Rapira, курс).',
    payout: 'Вы докидываете партнёру — долг перед ним меньше. Не расход.',
    payin: 'Партнёр докинул вам разницу — деньги на ваш кошелёк, его долг меньше. Не доход.',
    adjust: 'Фактический баланс по кабинету платёжки или кошелька на эту дату. Разница с насчитанным станет поправкой — она не доход и не расход. Так вносятся начальные остатки.',
  }[opKind];
  syncRates();
}

// поле курса нужно только для не-рублёвых кошельков (или валюты, в которой платил партнёр)
function syncRates() {
  const f = $('#opForm');
  const partner = f.paidBy?.value === 'partner';
  for (const x of f.querySelectorAll('[data-me]')) x.hidden = partner;
  for (const x of f.querySelectorAll('[data-partner]')) x.hidden = !partner;
  if (f.walletId) f.walletId.disabled = partner; // без кошелька — и в запрос не уходит
  const cur = (sel) => S.wallets.find((w) => String(w.id) === f.querySelector(sel)?.value)?.currency;
  for (const [field, sel] of [['rate', '[name=walletId]'], ['toRate', '[name=toWalletId]']]) {
    const label = f.querySelector(`[data-rate=${field}]`);
    const c = partner && field === 'rate' ? (f.currency.value.trim().toUpperCase() || 'RUB') : cur(sel);
    if (label) label.hidden = !c || c === 'RUB';
  }
}

// платит партнёр — только проекты с партнёром; плачу я — любые
function syncPayer() {
  const f = $('#opForm');
  if (!f.paidBy) return;
  const partner = f.paidBy.value === 'partner';
  const keep = f.projectId.value;
  f.projectId.innerHTML = partner ? opts(S.projects.filter((p) => p.partnerPct > 0)) : opts(S.projects, '—');
  if ([...f.projectId.options].some((o) => o.value === keep)) f.projectId.value = keep;
  syncRates();
}

// preset — поля, заполненные заранее: из раздела «Партнёр» окно открывается с суммой и проектом
function openOp(kind = opKind, preset = {}) {
  opKind = kind;
  for (const x of $('#opKinds').children) x.classList.toggle('on', x.dataset.kind === kind);
  $('#opError').hidden = true;
  $('#opForm').reset();
  renderOpFields();
  const f = $('#opForm');
  for (const [k, v] of Object.entries(preset)) if (f[k]) f[k].value = v;
  syncPayer();
  $('#opDlg').showModal();
}

$('#opKinds').addEventListener('click', (e) => {
  const b = e.target.closest('[data-kind]');
  if (!b) return;
  opKind = b.dataset.kind;
  for (const x of $('#opKinds').children) x.classList.toggle('on', x === b);
  renderOpFields();
});
$('#opFields').addEventListener('change', (e) => (e.target.name === 'paidBy' ? syncPayer() : syncRates()));
$('#opFields').addEventListener('input', (e) => {
  if (e.target.name === 'currency') syncRates();
});

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
    year = Number(month.slice(0, 4));
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
$('#ads').addEventListener('change', (e) => {
  const all = e.target.closest('[data-pick-all]');
  if (all) for (const x of document.querySelectorAll(`[data-pick][data-g="${all.dataset.pickAll}"]`)) x.checked = all.checked;
  else if (!e.target.closest('[data-pick]')) return;
  picked = new Set([...document.querySelectorAll('[data-pick]:checked')].map((x) => x.dataset.pick));
  syncPick();
});
$('#adsBar').addEventListener('click', async (e) => {
  if (e.target.closest('[data-bulk-clear]')) return renderAds();
  if (e.target.closest('[data-bulk-pay]')) {
    const list = deals.filter((d) => picked.has(d.ref));
    const who = [...new Set(list.map((d) => d.contact.trim()))];
    return openPayMany(list, who.length === 1 ? who[0] : '');
  }
  const b = e.target.closest('[data-bulk]');
  if (!b || !picked.size) return;
  const buttons = $('#adsBar').querySelectorAll('button');
  for (const x of buttons) x.disabled = true;
  try {
    const r = await api('/api/ad-deals/bulk', { method: 'POST', body: JSON.stringify({ refs: [...picked], action: b.dataset.bulk }) });
    await load();
    toast(`Отмечено: ${r.changed}${r.skipped ? `, пропущено: ${r.skipped}` : ''}`);
  } catch (err) {
    toast(err.message);
  } finally {
    for (const x of buttons) x.disabled = false;
  }
});
for (const [sel, key, parse] of [['#incMode', 'mode', (v) => v], ['#incBy', 'by', (v) => v], ['#incNet', 'net', (v) => v === '1'], ['#incVpn', 'vpn', (v) => v], ['#incAssume', 'assume', (v) => v === '1']]) {
  $(sel).addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    inc[key] = parse(b.dataset[key]);
    if (key === 'by' || key === 'mode') inc.off.clear(); // у видов дохода, расхода и проектов свои id
    for (const x of $(sel).children) x.classList.toggle('on', x === b);
    renderIncome();
    if (key === 'assume') renderTiles(tilesReport);
  });
}
$('#incChips').addEventListener('click', (e) => {
  const b = e.target.closest('[data-src]');
  if (!b) return;
  const id = b.dataset.src;
  if (inc.off.has(id)) inc.off.delete(id);
  else if ($('#incChips').querySelectorAll('.inc-chip:not(.off)').length > 1) inc.off.add(id); // хоть один источник остаётся
  renderIncome();
});
$('#incDays').addEventListener('click', (e) => {
  if (e.target.closest('[data-alldays]')) {
    inc.allDays = true;
    return renderIncome();
  }
  const d = e.target.closest('.iday:not(.zero)');
  if (!d) return;
  if (inc.open.has(d.dataset.day)) inc.open.delete(d.dataset.day);
  else inc.open.add(d.dataset.day);
  renderIncome();
});

$('#catalog').addEventListener('change', (e) => {
  const t = e.target;
  if (t.dataset.rename) {
    const [type, id] = t.dataset.rename.split(':');
    catalogCall(`/api/${type}/${id}`, { method: 'PATCH', body: JSON.stringify({ name: t.value }) });
  } else if (t.dataset.pct) {
    catalogCall(`/api/projects/${t.dataset.pct}`, { method: 'PATCH', body: JSON.stringify({ partnerPct: t.value }) });
  }
});
$('#catalog').addEventListener('click', (e) => {
  const b = e.target.closest('[data-arch],[data-unarch]');
  if (!b) return;
  const [type, id] = (b.dataset.arch || b.dataset.unarch).split(':');
  const on = !!b.dataset.arch;
  if (on && !confirm('Убрать в архив? Он пропадёт из выбора, операции с ним останутся.')) return;
  catalogCall(`/api/${type}/${id}`, { method: 'PATCH', body: JSON.stringify({ archived: on }) });
});
$('#catalog').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target.closest('[data-add]');
  const data = Object.fromEntries(new FormData(f));
  const project = f.dataset.add === 'project';
  const ok = await catalogCall(project ? '/api/projects' : '/api/categories', { method: 'POST', body: JSON.stringify(project ? data : { kind: f.dataset.add, name: data.name }) });
  if (ok) toast(project ? 'Проект добавлен' : 'Вид добавлен');
});

$('#wallets').addEventListener('click', (e) => {
  if (e.target.closest('[data-partner]')) openPartner();
});
$('#partnerForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = Object.fromEntries(new FormData(e.target));
  const [y, m, d] = String(f.date || todayIso()).split('-').map(Number);
  // сегодня — сейчас, а не полдень: сверка сравнивает с тем, что насчитано на этот момент
  const at = f.date === todayIso() ? Date.now() : Date.UTC(y, m - 1, d, 20, 59) - MSK;
  try {
    const r = await api('/api/partner/check', { method: 'POST', body: JSON.stringify({ ...f, at }) });
    $('#partnerDlg').close();
    await load();
    toast(r.income ? `Доход партнёрки: +${amt(r.income, r.currency)}` : 'Нового дохода нет — на счёте столько же, сколько насчитано');
  } catch (err) {
    $('#partnerError').textContent = err.message;
    $('#partnerError').hidden = false;
  }
});

$('#addRecurring').addEventListener('click', () => openRecurring(null));
$('#recurring').addEventListener('click', async (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.redit) return openRecurring(recurringRows.find((x) => x.id === Number(b.dataset.redit)));
  if (b.dataset.rpay) return payRecurringRow(Number(b.dataset.rpay));
  if (b.dataset.rskip) {
    try {
      const on = b.dataset.on === '1';
      await api(`/api/recurring/${b.dataset.rskip}/skip`, { method: 'POST', body: JSON.stringify({ month: recMonth(), on }) });
      await load();
      toast(on ? 'Пропущено в этом месяце' : 'Снова ждёт');
    } catch (err) {
      toast(err.message);
    }
  }
});
$('#recurringForm').addEventListener('change', (e) => {
  if (e.target.name === 'walletId' || e.target.name === 'paidBy') syncRecPayer();
});
$('#recurringForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = Object.fromEntries(new FormData(e.target));
  const body = { name: f.name, paidBy: f.paidBy, walletId: f.walletId, amount: f.amount, currency: f.currency, day: f.day, categoryId: f.categoryId || null, projectId: f.projectId || null };
  if (recurringEdit) body.active = e.target.active.checked;
  try {
    if (recurringEdit) await api(`/api/recurring/${recurringEdit.id}`, { method: 'PATCH', body: JSON.stringify(body) });
    else await api('/api/recurring', { method: 'POST', body: JSON.stringify(body) });
    $('#recurringDlg').close();
    await load();
    toast(recurringEdit ? 'Сохранено' : 'Регулярный расход добавлен — в его день бот пришлёт черновик');
  } catch (err) {
    $('#recurringError').textContent = err.message;
    $('#recurringError').hidden = false;
  }
});
$('#recurringDel').addEventListener('click', async () => {
  if (!recurringEdit || !confirm(`Удалить «${recurringEdit.name}»? Уже записанные расходы останутся.`)) return;
  try {
    await api(`/api/recurring/${recurringEdit.id}`, { method: 'DELETE' });
    $('#recurringDlg').close();
    await load();
  } catch (err) {
    $('#recurringError').textContent = err.message;
    $('#recurringError').hidden = false;
  }
});

$('#addWelcome').addEventListener('click', () => openWelcome(null));
$('#welcome').addEventListener('click', async (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  const byId = (id) => welcomeRows.find((x) => x.id === Number(id));
  try {
    if (b.dataset.wfix) openFix(byId(b.dataset.wfix));
    else if (b.dataset.wedit) openWelcome(byId(b.dataset.wedit));
    else if (b.dataset.wlink) openLink(byId(b.dataset.wlink));
    else if (b.dataset.wlinkdel) {
      if (!confirm('Удалить ссылку? По ней нет фиксаций — текущей станет прежняя.')) return;
      await api(`/api/welcome-link/${b.dataset.wlinkdel}`, { method: 'DELETE' });
      await load();
      toast('Ссылка удалена');
    }
    else if (b.dataset.wstop) {
      const d = byId(b.dataset.wstop);
      await api(`/api/welcome/${d.id}`, { method: 'PATCH', body: JSON.stringify({ stoppedOn: d.stoppedOn ? null : todayIso() }) });
      await load();
      toast(d.stoppedOn ? 'Размещение снова идёт' : 'Остановлено — уберите ссылку из приветки');
    } else if (b.dataset.wfixdel) {
      if (!confirm('Удалить фиксацию? Долг по ней пропадёт.')) return;
      await api(`/api/welcome-fix/${b.dataset.wfixdel}`, { method: 'DELETE' });
      await load();
    }
  } catch (err) {
    toast(err.message);
  }
});
$('#welcomeForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = Object.fromEntries(new FormData(e.target));
  try {
    if (welcomeEdit) await api(`/api/welcome/${welcomeEdit.id}`, { method: 'PATCH', body: JSON.stringify({ contact: f.contact, price: f.price, note: f.note }) });
    else await api('/api/welcome', { method: 'POST', body: JSON.stringify(f) });
    $('#welcomeDlg').close();
    await load();
    toast(welcomeEdit ? 'Сохранено' : 'Размещение добавлено');
  } catch (err) {
    $('#welcomeError').textContent = err.message;
    $('#welcomeError').hidden = false;
  }
});
$('#welcomeDel').addEventListener('click', async () => {
  if (!welcomeEdit || !confirm(`Удалить размещение «${welcomeEdit.contact}» вместе с фиксациями?`)) return;
  try {
    await api(`/api/welcome/${welcomeEdit.id}`, { method: 'DELETE' });
    $('#welcomeDlg').close();
    await load();
  } catch (err) {
    $('#welcomeError').textContent = err.message;
    $('#welcomeError').hidden = false;
  }
});
$('#fixForm').addEventListener('input', syncFix);
async function submitFix() {
  const f = Object.fromEntries(new FormData($('#fixForm')));
  const r = await api(`/api/welcome/${fixDealId}/fix`, { method: 'POST', body: JSON.stringify({ value: f.value, onDate: f.onDate }) });
  $('#fixDlg').close();
  await load();
  toast(r.count ? `Зафиксировано: ${reqs(r.count)}, ${rub(r.amount)} — в «Нам должны»` : 'Новых заявок нет');
}
$('#fixForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#fixError').hidden = true;
  try {
    await submitFix();
  } catch (err) {
    // меньше прошлого по ссылке — сервер спрашивает «Это новая ссылка?»
    if (err.code === 'new_link') {
      const d = welcomeRows.find((x) => x.id === fixDealId);
      if (d) return askNewLink(d);
    }
    $('#fixError').textContent = err.message;
    $('#fixError').hidden = false;
  }
});
// «Да, новая ссылка»: ссылка с дня фиксации по нынешней цене, затем то же число — уже на ней
$('#fixNewLinkYes').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  $('#fixError').hidden = true;
  try {
    await api(`/api/welcome/${fixDealId}/links`, { method: 'POST', body: JSON.stringify({ startedOn: $('#fixForm').onDate.value }) });
    welcomeRows = await api('/api/welcome');
    await submitFix();
    toast('Новая ссылка заведена, число зафиксировано на ней');
  } catch (err) {
    await load().catch(() => {});
    $('#fixError').textContent = err.message;
    $('#fixError').hidden = false;
  } finally {
    btn.disabled = false;
  }
});
$('#fixNewLinkNo').addEventListener('click', () => {
  $('#fixNewLink').hidden = true;
  fixInput().select();
});
$('#linkForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = Object.fromEntries(new FormData(e.target));
  try {
    await api(`/api/welcome/${linkDealId}/links`, { method: 'POST', body: JSON.stringify({ startedOn: f.startedOn, price: f.price, label: f.label }) });
    $('#linkDlg').close();
    await load();
    toast('Новая ссылка — счётчик заявок с нуля');
  } catch (err) {
    $('#linkError').textContent = err.message;
    $('#linkError').hidden = false;
  }
});

// --- люди: карточка, оплата, взаимозачёт, правка ---------------------------------------
$('#addPerson').addEventListener('click', () => openPersonEdit(null));
$('#personEdit').addEventListener('click', () => personCard && openPersonEdit(personCard.p));
$('#personBody').addEventListener('change', (e) => {
  const box = e.target.closest('[data-psel]');
  if (!box) return;
  const { p, sel } = personCard;
  const it = p.items.find((i) => i.ref === box.dataset.psel);
  if (box.checked) {
    // другая сторона — другие деньги: галочки той стороны снимаются
    for (const ref of [...sel]) if (p.items.find((i) => i.ref === ref)?.dir !== it.dir) sel.delete(ref);
    sel.add(it.ref);
  } else sel.delete(it.ref);
  syncPersonSel();
});
$('#personBody').addEventListener('click', async (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.pselClear !== undefined) {
    personCard.sel.clear();
    return syncPersonSel();
  }
  if (b.dataset.ppay !== undefined) return openPersonPay();
  if (b.dataset.poffset !== undefined) return openOffset();
  try {
    if (b.dataset.pclose) {
      const it = personCard.p.items.find((i) => i.ref === b.dataset.pclose);
      if (!confirm(`Простить остаток ${rub(it.remaining)} по «${it.what}»? Позиция закроется, остаток больше не ждём.`)) return;
      await api(`/api/debts/${encodeURIComponent(it.ref)}/close`, { method: 'POST', body: JSON.stringify({ on: true }) });
      await load();
      toast('Остаток прощён');
    } else if (b.dataset.punclose) {
      await api(`/api/debts/${encodeURIComponent(b.dataset.punclose)}/close`, { method: 'POST', body: JSON.stringify({ on: false }) });
      await load();
      toast('Снова ждём остаток');
    } else if (b.dataset.pdel) {
      const x = personCard.p.payments.find((y) => y.id === Number(b.dataset.pdel));
      if (!confirm(`Удалить ${x?.kind === 'offset' ? 'взаимозачёт' : 'оплату'} ${x ? rub(x.rub) : ''} целиком? Позиции снова будут ждать эти деньги${x?.advance ? ', аванс уменьшится' : ''}.`)) return;
      await api(`/api/payments/${b.dataset.pdel}`, { method: 'DELETE' });
      await load();
      toast('Оплата удалена');
    }
  } catch (err) {
    toast(err.message);
  }
});
$('#ppayDir').addEventListener('click', (e) => {
  const b = e.target.closest('[data-dir]');
  if (b && ppay) setPPayDir(b.dataset.dir);
});
$('#ppayForm').addEventListener('change', (e) => {
  if (e.target.name === 'walletId') ppayDefault();
});
$('#ppayForm').addEventListener('input', (e) => {
  if (e.target.name === 'amount' || e.target.name === 'rate') syncPPay();
});
$('#ppayForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = Object.fromEntries(new FormData(e.target));
  const [y, m, d] = String(f.date || todayIso()).split('-').map(Number);
  const at = Date.UTC(y, m - 1, d, 12) - MSK;
  try {
    const r = await api(`/api/people/${ppay.p.personId}/pay`, {
      method: 'POST',
      body: JSON.stringify({ dir: ppay.dir, walletId: f.walletId, amount: f.amount, rate: f.rate, at, note: f.note, ...(ppay.refs ? { refs: ppay.refs } : {}) }),
    });
    $('#ppayDlg').close();
    if (personCard) personCard.sel.clear();
    await load();
    toast([r.paid ? `Записано: ${positions(r.paid)}${r.partial ? ', последняя — частично' : ''}` : 'Записано', r.advance ? `в аванс ${rub(r.advance)}` : ''].filter(Boolean).join(' · '));
  } catch (err) {
    $('#ppayError').textContent = err.message;
    $('#ppayError').hidden = false;
  }
});
$('#offsetForm').addEventListener('input', syncOffset);
$('#offsetForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = Object.fromEntries(new FormData(e.target));
  const [y, m, d] = String(f.date || todayIso()).split('-').map(Number);
  try {
    const r = await api(`/api/people/${personCard.p.personId}/offset`, { method: 'POST', body: JSON.stringify({ amount: f.amount, at: Date.UTC(y, m - 1, d, 12) - MSK, note: f.note }) });
    $('#offsetDlg').close();
    await load();
    toast(`Зачтено ${rub(r.amount)} с каждой стороны`);
  } catch (err) {
    $('#offsetError').textContent = err.message;
    $('#offsetError').hidden = false;
  }
});
$('#personEditForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = Object.fromEntries(new FormData(e.target));
  try {
    if (personEditId === null) {
      const name = f.name.trim();
      const u = f.username.trim().replace(/^@/, '');
      const contact = name && u ? `${name} (@${u})` : name || (u ? `@${u}` : '');
      const { id } = await api('/api/people', { method: 'POST', body: JSON.stringify({ contact }) });
      $('#personEditDlg').close();
      await load();
      await openPerson(id);
    } else {
      await api(`/api/people/${personEditId}`, { method: 'PATCH', body: JSON.stringify({ name: f.name, username: f.username }) });
      $('#personEditDlg').close();
      await load();
      toast('Сохранено');
    }
  } catch (err) {
    $('#personEditError').textContent = err.message;
    $('#personEditError').hidden = false;
  }
});
$('#personMergeBtn').addEventListener('click', async () => {
  const f = $('#personEditForm');
  const into = Number(f.into.value);
  const target = peopleRows.find((x) => x.personId === into);
  if (!into || !confirm(`Объединить с «${target ? personLabel(target) : into}»? Сделки, приветка и оплаты перейдут к нему, эта запись удалится.`)) return;
  try {
    await api('/api/people/merge', { method: 'POST', body: JSON.stringify({ from: personEditId, into }) });
    $('#personEditDlg').close();
    personCard = null;
    await load();
    await openPerson(into);
    toast('Объединено');
  } catch (err) {
    $('#personEditError').textContent = err.message;
    $('#personEditError').hidden = false;
  }
});
// «Чья сделка»: знакомый находится по @username или имени, новый заводится (people.ts, personFor)
$('#dealPersonForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const contact = $('#dealPersonForm').contact.value;
  try {
    const { id } = await api('/api/people', { method: 'POST', body: JSON.stringify({ contact }) });
    await api(`/api/ad-deals/${encodeURIComponent(dealPersonRef)}/person`, { method: 'POST', body: JSON.stringify({ personId: id }) });
    $('#dealPersonDlg').close();
    await load();
    toast('Сделка перешла к человеку');
  } catch (err) {
    $('#dealPersonError').textContent = err.message;
    $('#dealPersonError').hidden = false;
  }
});

$('#vpn').addEventListener('change', (e) => {
  if (e.target.closest('[data-vpick-all]')) for (const x of document.querySelectorAll('[data-vpick]')) x.checked = e.target.checked;
  else if (!e.target.closest('[data-vpick]')) return;
  vpnPicked = new Set([...document.querySelectorAll('[data-vpick]:checked')].map((x) => x.dataset.vpick));
  syncVpnPick();
});
$('#vpn').addEventListener('click', (e) => {
  const b = e.target.closest('[data-vone]');
  if (!b) return;
  if (b.dataset.vone === 'skip' && !confirm('Не учитывать эту оплату? В доход она не пойдёт.')) return;
  resolveVpn([b.dataset.ref], b.dataset.vone, b.parentElement.querySelectorAll('button'));
});
$('#vpnSkipped').addEventListener('click', (e) => {
  const b = e.target.closest('[data-vrestore]');
  if (b) restoreVpn(b.dataset.vrestore, b);
});
$('#vpnBar').addEventListener('click', (e) => {
  if (e.target.closest('[data-vbulk-clear]')) return renderVpn();
  const b = e.target.closest('[data-vbulk]');
  if (!b || !vpnPicked.size) return;
  if (b.dataset.vbulk === 'skip' && !confirm(`Не учитывать выбранные оплаты (${vpnPicked.size})? В доход они не пойдут.`)) return;
  resolveVpn([...vpnPicked], b.dataset.vbulk, $('#vpnBar').querySelectorAll('button'));
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
    await api(payTarget.url, { method: 'POST', body: JSON.stringify({ ...f, at, ...(payTarget.extra ?? {}) }) });
    $('#payDlg').close();
    await load();
    toast('Записано');
  } catch (err) {
    $('#payError').textContent = err.message;
    $('#payError').hidden = false;
  }
});

$('#partner').addEventListener('click', async (e) => {
  const exp = e.target.closest('[data-pexp]');
  if (exp) return openOp('expense', { paidBy: 'partner', projectId: exp.dataset.pexp, categoryId: S.categories.find((c) => c.code === 'vpn_infra')?.id ?? '' });
  const settle = e.target.closest('[data-psettle]');
  if (settle) {
    const v = Number(settle.dataset.amount);
    return openOp(settle.dataset.psettle, { projectId: settle.dataset.project, amount: v ? String(Math.round(v / 10_000) / 100).replace('.', ',') : '' });
  }
  const b = e.target.closest('[data-del]');
  if (!b || !confirm('Удалить операцию? Расчёт с партнёром пересчитается.')) return;
  try {
    await api(`/api/operations/${b.dataset.del}`, { method: 'DELETE' });
    await load();
  } catch (err) {
    toast(err.message);
  }
});
$('#ops').addEventListener('click', async (e) => {
  if (e.target.closest('[data-period]')) return setPeriod('month');
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
  const po = e.target.closest('[data-person-open]');
  if (po) {
    if ($('#moreDlg').open) $('#moreDlg').close();
    openPerson(po.dataset.personOpen === 'none' ? null : Number(po.dataset.personOpen)).catch((err) => toast(err.message));
  }
  const dp = e.target.closest('[data-dperson]');
  if (dp) openDealPerson(dp.dataset.dperson);
  if (e.target.closest('[data-add-op]')) openOp();
  if (e.target.closest('[data-more]')) $('#moreDlg').showModal();
  if (e.target.closest('[data-catalog]')) {
    if ($('#moreDlg').open) $('#moreDlg').close();
    openCatalog().catch((err) => toast(err.message));
  }
  if (e.target.closest('[data-logout]')) fetch('/auth/logout', { method: 'POST' }).finally(() => (location.href = '/'));
});
// лист «Ещё» закрывается и нажатием мимо него
$('#moreDlg').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) e.currentTarget.close();
});
$('#addWallet').addEventListener('click', () => {
  $('#walletForm').reset();
  $('#walletError').hidden = true;
  $('#walletDlg').showModal();
});
// в режиме «Год» стрелки листают годы; вне 2000–2100 сервер год не считает
function step(delta) {
  if (period === 'year') year = Math.min(2100, Math.max(2000, year + delta));
  else month = shiftMonth(month, delta);
  load().catch((e) => toast(e.message));
}
$('#prevMonth').addEventListener('click', () => step(-1));
$('#nextMonth').addEventListener('click', () => step(1));
$('#period').addEventListener('click', (e) => {
  const b = e.target.closest('[data-period]');
  if (b && b.dataset.period !== period) setPeriod(b.dataset.period);
});
$('#report').addEventListener('click', (e) => {
  const tr = e.target.closest('tr[data-month]');
  if (tr) setPeriod('month', tr.dataset.month);
});

load()
  .then(() => {
    const ref = takeDealLink();
    if (ref) focusDeal(ref);
  })
  .catch((e) => {
    if (e.message !== 'нужно войти') toast(e.message);
  });
