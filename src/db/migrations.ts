/**
 * Схема учёта.
 *
 * Суммы — целые числа в миллионных долях единицы валюты («микро»): копейки
 * рубля и шесть знаков USDT/TRX ложатся без потерь, а плавающая точка в деньгах
 * копит ошибку округления на каждой операции.
 *
 * Операция — что произошло (доход, расход, перевод, выплата партнёру). Проводки
 * — как от этого изменились кошельки: у перевода их две, у дохода одна. Баланс
 * кошелька — сумма его проводок, своего поля «остаток» нет, чтобы ему не с чем
 * было разойтись.
 */
export const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE wallets (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT    NOT NULL,
    currency   TEXT    NOT NULL,              -- RUB, USDT, TON, TRX…
    kind       TEXT    NOT NULL,              -- provider | crypto | card | cash
    fee_pct    REAL    NOT NULL DEFAULT 0,    -- комиссия платёжки с приёма, %
    archived   INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );

  -- Проект — чьи это деньги. У проекта с партнёром его доля от дохода и
  -- расходов: VPN пополам (владелец, 2026-10-19).
  CREATE TABLE projects (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT    NOT NULL,
    partner_pct REAL    NOT NULL DEFAULT 0,
    archived    INTEGER NOT NULL DEFAULT 0
  );

  -- Вид дохода или расхода: приватка, реклама — посты, сторисы, заявки…
  CREATE TABLE categories (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    kind     TEXT    NOT NULL,                -- income | expense
    name     TEXT    NOT NULL,
    archived INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE operations (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    kind        TEXT    NOT NULL,             -- income | expense | transfer | payout
    at          INTEGER NOT NULL,             -- когда, UTC мс
    project_id  INTEGER REFERENCES projects(id),
    category_id INTEGER REFERENCES categories(id),
    note        TEXT    NOT NULL DEFAULT '',
    -- В рублях на момент операции: доход до комиссии / сумма расхода / сколько
    -- ушло при переводе. Отчёты складывают рубли, а не разные валюты.
    gross_rub   INTEGER NOT NULL DEFAULT 0,
    -- Комиссия в рублях: платёжки с приёма, потери при выводе и обмене.
    fee_rub     INTEGER NOT NULL DEFAULT 0,
    -- Откуда взялась: manual — внесена руками; иначе автоимпорт, и source_ref —
    -- номер в источнике, чтобы второй импорт не задвоил её.
    source      TEXT    NOT NULL DEFAULT 'manual',
    source_ref  TEXT,
    created_at  INTEGER NOT NULL,
    UNIQUE (source, source_ref)
  );
  CREATE INDEX operations_at ON operations(at);

  CREATE TABLE entries (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    op_id     INTEGER NOT NULL REFERENCES operations(id) ON DELETE CASCADE,
    wallet_id INTEGER NOT NULL REFERENCES wallets(id),
    amount    INTEGER NOT NULL,               -- микро в валюте кошелька, со знаком
    rub       INTEGER NOT NULL                -- то же в рублях-микро на момент операции
  );
  CREATE INDEX entries_wallet ON entries(wallet_id);
  CREATE INDEX entries_op ON entries(op_id);

  -- Последний известный курс валюты к рублю: для оценки остатков и для
  -- операций, где курс не вписали руками.
  CREATE TABLE rates (
    currency TEXT PRIMARY KEY,
    rub      REAL    NOT NULL,
    at       INTEGER NOT NULL
  );

  CREATE TABLE sessions (
    token      TEXT PRIMARY KEY,
    tg_id      TEXT    NOT NULL,
    expires_at INTEGER NOT NULL
  );

  INSERT INTO projects (name, partner_pct) VALUES
    ('Приватка MARIN', 0), ('Реклама', 0), ('VPN', 50), ('Прочее', 0);

  INSERT INTO categories (kind, name) VALUES
    ('income', 'Приватка'),
    ('income', 'Реклама — посты'),
    ('income', 'Реклама — сторисы'),
    ('income', 'Заявки с приветки'),
    ('income', 'Партнёрская программа'),
    ('income', 'VPN'),
    ('income', 'Прочее'),
    ('expense', 'Закуп рекламы'),
    ('expense', 'VPN — серверы и сервисы'),
    ('expense', 'Сервисы и подписки'),
    ('expense', 'Прочее');

  INSERT INTO wallets (name, currency, kind, fee_pct, created_at) VALUES
    ('Platega', 'RUB', 'provider', 14, CAST(strftime('%s','now') AS INTEGER) * 1000),
    ('CryptoBot', 'USDT', 'provider', 3, CAST(strftime('%s','now') AS INTEGER) * 1000);
  `,
  `
  -- «Остаток»: владелец вписывает фактический баланс кошелька на дату, а
  -- проводка-поправка — разница с тем, что насчитано. Хранится сам остаток, а не
  -- разница: импорт, дописавший оплаты задним числом, иначе сдвинул бы баланс, и
  -- вписанное «на 01.10 было 12 340 ₽» перестало бы быть правдой. Поправка
  -- пересчитывается после каждой записи (ledger.recomputeAdjustments).
  ALTER TABLE operations ADD COLUMN target INTEGER;   -- остаток, микро в валюте кошелька
  ALTER TABLE operations ADD COLUMN rate   REAL;      -- курс к ₽ на момент операции
  `,
  `
  -- До какого момента импорт из источника забрал всё. Не дальше самой ранней
  -- оплаты, которая ждёт (нет курса, нет кошелька): иначе следующий проход начал
  -- бы после более поздней записанной, и ждущая потерялась бы.
  CREATE TABLE import_state (
    source TEXT PRIMARY KEY,
    cursor INTEGER NOT NULL
  );
  `,
  `
  -- Сделки рекламы из tg-analytics: закупы и продажи, которые ждут отметки.
  -- «Оплачено» — это операция с source = 'ads' и source_ref = ref, отдельного
  -- флага нет: удалил операцию — сделка снова ждёт. «Бартер» — денег не было,
  -- в выручку и остатки сделка не идёт. Остальное приходит из аналитики и
  -- перезаписывается каждой сверкой: сумма у CPM появляется позже, сделку
  -- могут перенести или отменить.
  CREATE TABLE ad_deals (
    ref       TEXT PRIMARY KEY,            -- buy:12 / sale:5, как в аналитике
    kind      TEXT    NOT NULL,            -- buy | sale
    date      TEXT    NOT NULL,            -- ГГГГ-ММ-ДД, день места
    slot      TEXT    NOT NULL,            -- stories — сторис, остальное — посты
    contact   TEXT    NOT NULL DEFAULT '',
    channels  TEXT    NOT NULL DEFAULT '', -- через запятую
    amount    INTEGER,                     -- ₽-микро; null — сумма ещё не известна
    cancelled INTEGER NOT NULL DEFAULT 0,  -- отменена или удалена в аналитике
    barter_at INTEGER,
    synced_at INTEGER NOT NULL
  );
  CREATE INDEX ad_deals_date ON ad_deals(date);
  `,
  `
  -- «Ждём оплату»: владелец подтвердил, что за сделку должны заплатить (или он
  -- должен). Только такие сделки — «Нам должны» и «Мы должны»; остальные
  -- пришедшие из аналитики просто ещё не разобраны.
  ALTER TABLE ad_deals ADD COLUMN waiting_at INTEGER;
  `,
  `
  -- Оплаты VPN-бота идут в свои кабинеты Platega (8 %) и CryptoBot (3 %), не в
  -- кабинеты привата (владелец, 2026-10-19). role — по ней импорт находит
  -- кошелёк, а не по названию: название владелец может поменять, и «Platega VPN»
  -- по слову «platega» подошёл бы и к оплатам привата.
  ALTER TABLE wallets ADD COLUMN role TEXT;
  INSERT INTO wallets (name, currency, kind, fee_pct, created_at, role) VALUES
    ('Platega VPN', 'RUB', 'provider', 8, CAST(strftime('%s','now') AS INTEGER) * 1000, 'vpn:platega'),
    ('CryptoBot VPN', 'USDT', 'provider', 3, CAST(strftime('%s','now') AS INTEGER) * 1000, 'vpn:cryptobot');

  -- Оплаты VPN из tg-analytics. Записанная — это операция с source = 'vpn' и
  -- source_ref = ref. Платёжку передаёт VPN-бот; не передал — оплата ждёт, пока
  -- владелец выберет её руками. skipped_at — «Не учитывать» (тестовая оплата и т. п.).
  CREATE TABLE vpn_payments (
    ref        TEXT PRIMARY KEY,            -- номер события в аналитике
    at         INTEGER NOT NULL,            -- UTC мс
    type       TEXT    NOT NULL,            -- payment | renewal
    amount     INTEGER NOT NULL,            -- ₽-микро, фактически полученные
    provider   TEXT,                        -- platega | cryptobot | null
    skipped_at INTEGER,
    synced_at  INTEGER NOT NULL
  );
  CREATE INDEX vpn_payments_at ON vpn_payments(at);
  `,
  `
  -- Ещё два способа оплаты VPN-бота: «Карта резерв» (card_ru, 10 %) и Lolzteam
  -- (7 %) — свои кабинеты, в рублях (владелец, 2026-10-20).
  INSERT INTO wallets (name, currency, kind, fee_pct, created_at, role) VALUES
    ('Карта резерв VPN', 'RUB', 'provider', 10, CAST(strftime('%s','now') AS INTEGER) * 1000, 'vpn:card_ru'),
    ('Lolzteam VPN', 'RUB', 'provider', 7, CAST(strftime('%s','now') AS INTEGER) * 1000, 'vpn:lolzteam');
  `,
  `
  -- Lolzteam платит в долларах, а не в рублях (владелец, 2026-10-20). Кошелёк
  -- без проводок просто меняет валюту; с проводками — нет: их суммы записаны в
  -- рублях, и смена валюты молча превратила бы 300 ₽ в 300 $.
  UPDATE wallets SET currency = 'USD'
  WHERE role = 'vpn:lolzteam' AND NOT EXISTS (SELECT 1 FROM entries WHERE entries.wallet_id = wallets.id);
  `,
  `
  -- «Приветка»: ссылка покупателя в приветке владельца, оплата за заявки (welcome.ts).
  CREATE TABLE welcome_deals (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    contact    TEXT    NOT NULL,             -- кто: имя или @username
    price      INTEGER NOT NULL,             -- ₽-микро за заявку
    started_on TEXT    NOT NULL,             -- ГГГГ-ММ-ДД
    stopped_on TEXT,                         -- null — ещё идёт
    note       TEXT    NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
  );
  -- Фиксация: покупатель прислал, сколько заявок всего с начала.
  CREATE TABLE welcome_fixes (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    deal_id    INTEGER NOT NULL REFERENCES welcome_deals(id),
    on_date    TEXT    NOT NULL,
    total      INTEGER NOT NULL,             -- всего с начала, как прислал
    count      INTEGER NOT NULL,             -- новых с прошлой фиксации
    amount     INTEGER NOT NULL,             -- ₽-микро: count × цена на тот момент
    created_at INTEGER NOT NULL
  );
  CREATE INDEX welcome_fixes_deal ON welcome_fixes(deal_id);
  `,
  `
  -- Партнёрская программа: начисления в долларах на счёте в её миниапке, пока
  -- не выведены (partner.ts). Как платёжка — деньги ещё «не выведены».
  INSERT INTO wallets (name, currency, kind, fee_pct, created_at, role) VALUES
    ('Партнёрка', 'USD', 'provider', 0, CAST(strftime('%s','now') AS INTEGER) * 1000, 'partner');
  `,
  `
  -- Виды и проекты теперь можно переименовывать на странице. Импорты и бот
  -- находят свои по коду, а не по названию: «Приватка» под другим именем
  -- осталась бы без доходов привата. Код есть только у заведённых здесь.
  ALTER TABLE categories ADD COLUMN code TEXT;
  ALTER TABLE projects ADD COLUMN code TEXT;
  UPDATE categories SET code = CASE
    WHEN kind = 'income' AND name = 'Приватка' THEN 'privat'
    WHEN kind = 'income' AND name = 'Реклама — посты' THEN 'ads_posts'
    WHEN kind = 'income' AND name = 'Реклама — сторисы' THEN 'ads_stories'
    WHEN kind = 'income' AND name = 'Заявки с приветки' THEN 'welcome'
    WHEN kind = 'income' AND name = 'Партнёрская программа' THEN 'partner'
    WHEN kind = 'income' AND name = 'VPN' THEN 'vpn'
    WHEN kind = 'income' AND name = 'Прочее' THEN 'other_income'
    WHEN kind = 'expense' AND name = 'Закуп рекламы' THEN 'ads_buy'
    WHEN kind = 'expense' AND name = 'VPN — серверы и сервисы' THEN 'vpn_infra'
    WHEN kind = 'expense' AND name = 'Сервисы и подписки' THEN 'services'
    WHEN kind = 'expense' AND name = 'Прочее' THEN 'other_expense'
  END;
  UPDATE projects SET code = CASE name
    WHEN 'Приватка MARIN' THEN 'privat' WHEN 'Реклама' THEN 'ads' WHEN 'VPN' THEN 'vpn' WHEN 'Прочее' THEN 'other'
  END;
  CREATE UNIQUE INDEX categories_code ON categories(code) WHERE code IS NOT NULL;
  CREATE UNIQUE INDEX projects_code ON projects(code) WHERE code IS NOT NULL;
  `,
  `
  -- Регулярные расходы (recurring.ts): в свой день бот присылает черновик, и
  -- расход записывается по «Записать».
  CREATE TABLE recurring (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT    NOT NULL,
    amount      INTEGER NOT NULL,              -- микро в валюте currency
    currency    TEXT    NOT NULL,
    wallet_id   INTEGER NOT NULL REFERENCES wallets(id),
    category_id INTEGER REFERENCES categories(id),
    project_id  INTEGER REFERENCES projects(id),
    day         INTEGER NOT NULL,              -- какого числа, 1–31
    active      INTEGER NOT NULL DEFAULT 1,
    created_at  INTEGER NOT NULL
  );
  -- «Пропустить в этом месяце».
  CREATE TABLE recurring_skips (
    recurring_id INTEGER NOT NULL REFERENCES recurring(id),
    month        TEXT    NOT NULL,             -- ГГГГ-ММ
    at           INTEGER NOT NULL,
    PRIMARY KEY (recurring_id, month)
  );
  -- Черновик за месяц уже отправлен ботом — второй раз не шлём.
  CREATE TABLE recurring_notices (
    recurring_id INTEGER NOT NULL REFERENCES recurring(id),
    month        TEXT    NOT NULL,
    PRIMARY KEY (recurring_id, month)
  );
  `,
  `
  -- Платёжка «Карта резерв» у VPN-бота теперь называется parity (владелец,
  -- 2026-10-20): кошелёк и уже прочитанные, но не записанные оплаты переходят
  -- на новое имя. Название кошелька — только если его не переименовывали.
  UPDATE wallets SET role = 'vpn:parity',
    name = CASE WHEN name = 'Карта резерв VPN' THEN 'Parity VPN' ELSE name END
  WHERE role = 'vpn:card_ru';
  UPDATE vpn_payments SET provider = 'parity' WHERE provider = 'card_ru';
  `,
  `
  -- Расходы VPN оплачивает то владелец, то партнёр, а разницу потом докидывают
  -- (владелец, 2026-10-20). Расход, оплаченный партнёром, — операция без
  -- проводок: кошельки владельца не трогает, но входит в расходы проекта и в
  -- расчёт с партнёром. paid_amount / paid_currency — сколько и в чём он платил.
  ALTER TABLE operations ADD COLUMN paid_by TEXT;          -- 'partner'; null — владелец
  ALTER TABLE operations ADD COLUMN paid_amount INTEGER;   -- микро в paid_currency
  ALTER TABLE operations ADD COLUMN paid_currency TEXT;
  `,
  `
  -- Регулярный расход тоже может оплачивать партнёр — тогда кошелька у него нет.
  -- SQLite не снимает NOT NULL, поэтому таблица пересобирается. Ссылки из
  -- recurring_skips и recurring_notices идут по имени и после пересборки
  -- указывают на новую таблицу; проверка ссылок — в конце транзакции, когда
  -- строки уже на месте. Счётчик номеров сохраняется: номер удалённого
  -- регулярного не достаётся новому, иначе его записанные месяцы приписались бы
  -- чужому расходу (source_ref '<id>:<ГГГГ-ММ>').
  PRAGMA defer_foreign_keys = ON;
  CREATE TABLE recurring_tmp AS SELECT * FROM recurring;
  CREATE TABLE recurring_seq AS SELECT seq FROM sqlite_sequence WHERE name = 'recurring';
  DROP TABLE recurring;
  CREATE TABLE recurring (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT    NOT NULL,
    amount      INTEGER NOT NULL,              -- микро в валюте currency
    currency    TEXT    NOT NULL,
    wallet_id   INTEGER REFERENCES wallets(id), -- null — платит партнёр
    category_id INTEGER REFERENCES categories(id),
    project_id  INTEGER REFERENCES projects(id),
    day         INTEGER NOT NULL,              -- какого числа, 1–31
    active      INTEGER NOT NULL DEFAULT 1,
    created_at  INTEGER NOT NULL,
    paid_by     TEXT                           -- 'partner'; null — владелец
  );
  INSERT INTO recurring (id, name, amount, currency, wallet_id, category_id, project_id, day, active, created_at)
    SELECT id, name, amount, currency, wallet_id, category_id, project_id, day, active, created_at FROM recurring_tmp;
  DELETE FROM sqlite_sequence WHERE name = 'recurring';
  INSERT INTO sqlite_sequence (name, seq)
    SELECT 'recurring', MAX(COALESCE((SELECT seq FROM recurring_seq), 0), COALESCE((SELECT MAX(id) FROM recurring), 0));
  DROP TABLE recurring_tmp;
  DROP TABLE recurring_seq;
  `,
];
