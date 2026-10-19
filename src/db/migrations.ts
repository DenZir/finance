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
];
