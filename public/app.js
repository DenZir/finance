// Страница учёта: плашки, кошельки, итоги месяца или года, операции.
// Суммы приходят в «микро» (миллионных долях единицы) — переводим только при показе.

const $ = (s) => document.querySelector(s);
const MICRO = 1e6;
const MSK = 3 * 3600e3;
const KIND_LABEL = { provider: 'платёжка', crypto: 'крипта', card: 'карта', cash: 'наличные' };
const OP_LABEL = { income: 'Доход', expense: 'Расход', transfer: 'Перевод', payout: 'Партнёру', adjust: 'Остаток' };

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
let incomeRows = [];
let recurringRows = [];
let recurringEdit = null; // регулярный в окне правки; null — новый
let welcomeEdit = null; // размещение в окне правки; null — новое
let fixDealId = null;
let picked = new Set(); // сделки, выбранные для отметки списком; живут до следующей отрисовки
let vpnRows = []; // оплаты VPN без платёжки
let vpnPicked = new Set();

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
});

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
    tile(period === 'year' ? 'Чистыми за год' : 'Чистыми за месяц', rub(report.net), 'доход − комиссии − расходы', report.net >= 0 ? 'good' : 'bad') +
    tile('Нам должны', rub(S.ads.owedToUs + S.welcome.owed), [S.ads.owedToUsCount ? `реклама: ${S.ads.owedToUsCount}` : '', S.welcome.count ? `приветка: ${S.welcome.count}` : ''].filter(Boolean).join(' · ') || 'никто не должен', S.ads.owedToUs + S.welcome.owed ? 'warn' : '') +
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

// отметить списком можно то, что ещё ждёт решения: не оплаченное, не бартер, не отменённое
const pickable = (d) => (d.state === 'open' || d.state === 'waiting') && !d.cancelled;

// group — в какой группе строка («Ждём оплату», «Не разобраны»); без группы («Все сделки») выбора нет
function dealLine(d, group) {
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
  $('#adsCard').hidden = !deals.length;
  if (!deals.length) return;
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
  $('#ads').innerHTML =
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
const inc = { mode: 'income', by: 'cat', net: false, vpn: 'all', off: new Set(), open: new Set(), allDays: false };
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
  // ячейка × источник
  const cell = new Map();
  for (const r of incomeRows) {
    const v = incAmount(r);
    if (!v) continue;
    const k = `${r.key}|${srcOf(r).id}`;
    cell.set(k, (cell.get(k) ?? 0) + v);
  }
  const val = (key, s) => cell.get(`${key}|${s.id}`) ?? 0;
  const sums = new Map(sources.map((s) => [s.id, keys.reduce((t, k) => t + val(k, s), 0)]));
  // в «Чистыми» проект за месяц может выйти в ноль, а по дням — нет
  const present = sources.filter((s) => keys.some((k) => val(k, s) !== 0));
  const shown = present.filter((s) => !inc.off.has(s.id));
  const total = shown.reduce((t, s) => t + sums.get(s.id), 0);

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
  $('#incSub').textContent = [what, passed ? `в среднем ${net ? signed(total / passed) : rub(total / passed)} ${period === 'year' ? 'в месяц' : 'в день'}` : ''].filter(Boolean).join(' · ');
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

  drawIncomeChart(keys, shown, val);

  // лента: свежие сверху, только прошедшие дни; по умолчанию неделя.
  // В «Чистыми» полоска — одна, цветом знака: доли проектов с разными знаками не складываются в длину.
  const past = keys.filter(incPast).reverse();
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

function drawIncomeChart(keys, shown, val) {
  if (!window.Chart) {
    $('#incFallback').hidden = false;
    return;
  }
  $('#incFallback').hidden = true;
  const data = {
    labels: keys.map(incLabel),
    datasets: shown.map((s) => ({
      label: s.name,
      data: keys.map((k) => (incPast(k) ? Math.round(val(k, s) / 10_000) / 100 : null)),
      backgroundColor: s.color,
      // 2px зазор фоном между сегментами столбика; ниже нуля сегменты растут вниз
      borderColor: '#121821',
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
    maintainAspectRatio: false,
    animation: matchMedia('(prefers-reduced-motion: reduce)').matches ? false : { duration: 400 },
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: '#0b0f14', borderColor: '#232d3a', borderWidth: 1, padding: 10, cornerRadius: 10,
        titleColor: '#e6edf5', bodyColor: '#8b97a8', footerColor: '#e6edf5', usePointStyle: true, boxWidth: 8, boxHeight: 8,
        filter: (c) => c.parsed.y !== 0,
        itemSort: (a, b) => b.parsed.y - a.parsed.y,
        callbacks: {
          label: (c) => ` ${fmtRub(c.parsed.y)} · ${c.dataset.label}`,
          footer: (items) => `${inc.mode === 'net' ? 'Итого' : 'Всего'} ${fmtRub(items.reduce((t, c) => t + (c.parsed.y || 0), 0))}`,
        },
      },
    },
    scales: {
      x: { stacked: true, grid: { display: false }, ticks: { color: '#5e6a7b', maxTicksLimit: 10, font: { size: 10 } } },
      y: { stacked: true, beginAtZero: true, grid: { color: (c) => (c.tick.value === 0 ? 'rgba(255,255,255,.16)' : 'rgba(255,255,255,.05)') }, border: { display: false },
        ticks: { color: '#5e6a7b', maxTicksLimit: 5, font: { size: 10 }, callback: (v) => (Math.abs(v) >= 1000 ? `${v < 0 ? '−' : ''}${Math.round(Math.abs(v) / 100) / 10}к` : v < 0 ? `−${-v}` : v) } },
    },
  };
  if (incChart) incChart.destroy();
  incChart = new Chart($('#incChart'), { type: 'bar', data, options: opts });
}

// --- приветка: ссылка покупателя в приветке, оплата за заявки ----------------------
const isoDay = (iso) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}`;
const plural = (n, one, few, many) => (n % 10 === 1 && n % 100 !== 11 ? one : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? few : many);
const reqs = (n) => `${n.toLocaleString('ru-RU')} ${plural(n, 'заявка', 'заявки', 'заявок')}`;

function fixLine(d, f, last) {
  const sum = f.amount ? `<span class="plus">+${rub(f.amount)}</span>` : '<span class="muted">0 ₽</span>';
  const acts = f.paid
    ? `<span class="chip">${f.amount ? 'оплачено' : 'новых нет'}</span>`
    : `<button class="btn primary" type="button" data-wpay="${f.id}">Оплачено</button>`;
  const del = last && !(f.paid && f.amount) ? `<button class="btn ghost" type="button" data-wfixdel="${f.id}" title="Удалить фиксацию">×</button>` : '';
  return `<div class="deal"><span class="when">${isoDay(f.onDate)}</span>
    <div class="what"><b>+${reqs(f.count)}</b><small>всего ${f.total.toLocaleString('ru-RU')}</small></div>
    <div class="sum">${sum}</div><div class="acts">${acts}${del}</div></div>`;
}

function renderWelcome() {
  if (!welcomeRows.length) {
    $('#welcome').innerHTML = '<div class="empty">Размещений нет. Поставили чью-то ссылку в приветку — добавьте: кто и цена за заявку. Когда он пришлёт число заявок, нажмите «Зафиксировать».</div>';
    return;
  }
  $('#welcome').innerHTML = welcomeRows
    .map((d) => {
      const lastId = d.fixes.length ? d.fixes[d.fixes.length - 1].id : null;
      const open = d.fixes.filter((f) => !f.paid);
      const done = d.fixes.filter((f) => f.paid);
      const state = d.stoppedOn ? `<span class="chip warn">остановлено ${isoDay(d.stoppedOn)}</span>` : `<span class="chip">идёт с ${isoDay(d.startedOn)}</span>`;
      return `<div class="wdeal${d.stoppedOn ? ' stopped' : ''}">
        <div class="wd-h"><b>${esc(d.contact)}</b><span class="chip">${rub(d.price)} за заявку</span>${state}
          <div class="wd-acts"><button class="btn primary" type="button" data-wfix="${d.id}">Зафиксировать</button><button class="btn" type="button" data-wstop="${d.id}">${d.stoppedOn ? 'Возобновить' : 'Остановить'}</button><button class="btn ghost" type="button" data-wedit="${d.id}" aria-label="Изменить">✎</button></div></div>
        <div class="wd-sum">${d.fixes.length ? `заявок всего ${d.total.toLocaleString('ru-RU')} · начислено ${rub(d.accrued)} · оплачено ${rub(d.paidSum)}${d.owed ? ` · <span class="owed">должен ${rub(d.owed)}</span>` : ''}` : 'фиксаций ещё не было'}${d.note ? ` · ${esc(d.note)}` : ''}</div>
        ${open.map((f) => fixLine(d, f, f.id === lastId)).join('')}
        ${done.length ? `<details><summary>Оплаченные фиксации · ${done.length}</summary>${done.map((f) => fixLine(d, f, f.id === lastId)).join('')}</details>` : ''}
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
  f.startedOn.value = deal?.startedOn ?? todayIso();
  f.startedOn.disabled = !!deal;
  f.note.value = deal?.note ?? '';
  $('#welcomeDel').hidden = !deal;
  $('#welcomeDlg').showModal();
}

function openFix(deal) {
  fixDealId = deal.id;
  const f = $('#fixForm');
  f.reset();
  $('#fixError').hidden = true;
  $('#fixDeal').textContent = `${deal.contact} · ${rub(deal.price)} за заявку${deal.fixes.length ? ` · в прошлый раз всего ${deal.total.toLocaleString('ru-RU')}` : ''}`;
  f.onDate.value = todayIso();
  syncFix();
  $('#fixDlg').showModal();
  f.total.focus();
}

// сколько новых и на какую сумму — пока владелец печатает число
function syncFix() {
  const d = welcomeRows.find((x) => x.id === fixDealId);
  const total = Number(String($('#fixForm').total.value).replace(/\s/g, ''));
  if (!d || !Number.isInteger(total) || $('#fixForm').total.value === '') {
    $('#fixCalc').textContent = 'Число, которое прислал покупатель, — всего с начала размещения. Долг посчитается за новые.';
    return;
  }
  const n = total - d.total;
  $('#fixCalc').textContent = n < 0 ? `меньше прошлого (${d.total}) — так не бывает` : `новых ${reqs(n)} × ${rub(d.price)} = ${rub(n * d.price)}`;
}

function openFixPay(fixId) {
  const d = welcomeRows.find((x) => x.fixes.some((f) => f.id === fixId));
  const f = d?.fixes.find((x) => x.id === fixId);
  if (!f) return;
  showPay({
    title: 'Приветка оплачена',
    desc: `${d.contact} · ${reqs(f.count)} на ${isoDay(f.onDate)} · ${rub(f.amount)}`,
    amount: f.amount,
    amountLabel: 'Сколько пришло',
    hint: 'Доход «Заявки с приветки», без комиссии. Сумма пересчитана по курсу — впишите, сколько пришло на самом деле.',
    url: `/api/welcome-fix/${fixId}/pay`,
  });
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
      else if (r.state === 'due') acts = `<button class="btn primary" type="button" data-rpay="${id}">Записать</button><button class="btn" type="button" data-rskip="${id}" data-on="1">Пропустить</button>`;
      else acts = `<span class="chip">будет ${day(Date.parse(`${r.dueDate}T09:00:00Z`))}</span><button class="btn ghost" type="button" data-rpay="${id}" title="Записать заранее">Записать</button>`;
      const sub = [nameOrDash(S.categories, r.categoryId), nameOrDash(S.projects, r.projectId), nameOrDash(S.wallets, r.walletId)].filter(Boolean).map(esc).join(' · ');
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
  f.active.checked = r ? r.active : true;
  f.querySelector('[data-active]').hidden = !r;
  $('#recurringDel').hidden = !r;
  $('#recurringDlg').showModal();
}

function payRecurringRow(id) {
  const r = recurringRows.find((x) => x.id === id);
  if (!r) return;
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
  ['card_ru', 'Карта резерв', 'Карта резерв VPN'],
  ['lolzteam', 'Lolzteam', 'Lolzteam VPN'],
];
const vpnButtons = (attr, ref) =>
  VPN_PROVIDERS.map(([id, label]) => `<button class="btn" type="button" ${attr}="${id}"${ref ? ` data-ref="${ref}"` : ''}>${label}</button>`).join('');
$('#vpnBulkProviders').innerHTML = vpnButtons('data-vbulk');
const stamp = (ms) => `${day(ms)} ${new Date(ms + MSK).toISOString().slice(11, 16)}`;

function renderVpn() {
  vpnPicked.clear();
  syncVpnPick();
  $('#vpnCard').hidden = !vpnRows.length;
  if (!vpnRows.length) return;
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

function openPay(ref) {
  const d = deals.find((x) => x.ref === ref);
  if (!d) return;
  showPay({
    title: d.kind === 'sale' ? 'Продажа оплачена' : 'Закуп оплачен',
    desc: `${dealDay(d.date)} · ${dealTitle(d)} · ${[d.contact, d.channels].filter(Boolean).join(' · ')}${d.amount != null ? ` · ${rub(d.amount)}` : ''}`,
    amount: d.amount,
    amountLabel: d.kind === 'sale' ? 'Сколько пришло' : 'Сколько ушло',
    hint: d.kind === 'sale'
      ? 'Доход «Реклама», без комиссии. Сумма сделки пересчитана по курсу — впишите, сколько пришло на самом деле (при взаимозачёте — разницу).'
      : 'Расход «Закуп рекламы» с этого кошелька, без комиссии.',
    url: `/api/ad-deals/${encodeURIComponent(ref)}/pay`,
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
  const v = w.currency === 'RUB' ? amount / MICRO : w.rate ? Math.round((amount / MICRO / w.rate) * 100) / 100 : '';
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
    title = o.kind === 'payout' ? `Выплата партнёру · ${esc(nameOf(S.projects, o.projectId))}` : esc(nameOf(S.categories, o.categoryId));
    sum = `<span class="${o.kind === 'income' ? 'plus' : 'minus'}">${o.kind === 'income' ? '+' : '−'}${rub(o.grossRub)}</span>`;
    sub = [wallet && esc(wallet.name), o.kind === 'income' && o.feeRub ? `комиссия ${rub(o.feeRub)}` : '', wallet && wallet.currency !== 'RUB' && a ? amt(Math.abs(a.amount), wallet.currency) : ''].filter(Boolean).join(' · ');
  }
  const meta = [OP_LABEL[o.kind], o.projectId && o.kind !== 'payout' ? esc(nameOf(S.projects, o.projectId)) : '', esc(o.note), o.source === 'botprivat' ? 'авто · ботприват' : o.source === 'ads' ? 'сделка рекламы' : o.source === 'vpn' ? 'авто · VPN' : ''].filter(Boolean).join(' · ');
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
  [vpnRows, welcomeRows, incomeRows, recurringRows] = await Promise.all([
    api('/api/vpn/unsorted'),
    api('/api/welcome'),
    api(byYear ? `/api/income?year=${year}` : `/api/income?month=${month}`),
    api(`/api/recurring?month=${recMonth()}`),
  ]);
  $('#login').hidden = true;
  $('#app').hidden = false;
  if (location.search) history.replaceState(null, '', '/');
  const [y, m] = month.split('-').map(Number);
  $('#monthLabel').textContent = byYear ? String(year) : new Date(Date.UTC(y, m - 1, 15)).toLocaleString('ru-RU', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  $('#prevMonth').setAttribute('aria-label', byYear ? 'Прошлый год' : 'Прошлый месяц');
  $('#nextMonth').setAttribute('aria-label', byYear ? 'Следующий год' : 'Следующий месяц');
  for (const b of $('#period').children) {
    b.classList.toggle('on', b.dataset.period === period);
    b.setAttribute('aria-pressed', String(b.dataset.period === period));
  }
  $('#reportTitle').textContent = byYear ? 'Итоги года' : 'Итоги месяца';
  renderTiles(byYear ? report.total : report);
  renderAds();
  renderIncome();
  renderWelcome();
  renderRecurring();
  renderVpn();
  renderWallets();
  $('#report').innerHTML = byYear ? yearHtml(report) : reportHtml(report);
  $('#ops').innerHTML = byYear
    ? '<div class="empty">Операции — в режиме <button class="link" type="button" data-period="month">«Месяц»</button>.</div>'
    : ops.length ? ops.map(opLine).join('') : '<div class="empty">За этот месяц операций нет.</div>';
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
for (const [sel, key, parse] of [['#incMode', 'mode', (v) => v], ['#incBy', 'by', (v) => v], ['#incNet', 'net', (v) => v === '1'], ['#incVpn', 'vpn', (v) => v]]) {
  $(sel).addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    inc[key] = parse(b.dataset[key]);
    if (key === 'by' || key === 'mode') inc.off.clear(); // у видов дохода, расхода и проектов свои id
    for (const x of $(sel).children) x.classList.toggle('on', x === b);
    renderIncome();
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

$('#openCatalog').addEventListener('click', () => openCatalog().catch((e) => toast(e.message)));
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
  if (e.target.name === 'walletId') e.target.form.currency.placeholder = S.wallets.find((w) => String(w.id) === e.target.value)?.currency ?? '';
});
$('#recurringForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = Object.fromEntries(new FormData(e.target));
  const body = { name: f.name, walletId: f.walletId, amount: f.amount, currency: f.currency, day: f.day, categoryId: f.categoryId || null, projectId: f.projectId || null };
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
    else if (b.dataset.wpay) openFixPay(Number(b.dataset.wpay));
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
$('#fixForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = Object.fromEntries(new FormData(e.target));
  try {
    const r = await api(`/api/welcome/${fixDealId}/fix`, { method: 'POST', body: JSON.stringify(f) });
    $('#fixDlg').close();
    await load();
    toast(r.count ? `Зафиксировано: ${reqs(r.count)}, ${rub(r.amount)} — в «Нам должны»` : 'Новых заявок нет');
  } catch (err) {
    $('#fixError').textContent = err.message;
    $('#fixError').hidden = false;
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
});
$('#addOp').addEventListener('click', openOp);
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
$('#logout').addEventListener('click', async () => {
  await fetch('/auth/logout', { method: 'POST' });
  location.href = '/';
});

load()
  .then(() => {
    const ref = takeDealLink();
    if (ref) focusDeal(ref);
  })
  .catch((e) => {
    if (e.message !== 'нужно войти') toast(e.message);
  });
