export const migration001 = `
CREATE TABLE IF NOT EXISTS orders (
    id          TEXT PRIMARY KEY,
    location_id TEXT NOT NULL,
    table_uuid  TEXT,
    source      TEXT NOT NULL,
    status      TEXT NOT NULL,
    total       NUMERIC NOT NULL DEFAULT 0,
    origin      TEXT NOT NULL,
    push_state  TEXT NOT NULL DEFAULT 'synced',
    pushed_at   TEXT,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS order_items (
    id            TEXT PRIMARY KEY,
    order_id      TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    menu_item_id  TEXT NOT NULL,
    variant_id    TEXT,
    name_snapshot TEXT NOT NULL,
    quantity      INTEGER NOT NULL DEFAULT 1,
    unit_price    NUMERIC NOT NULL,
    notes         TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS order_item_modifiers (
    id            TEXT PRIMARY KEY,
    order_item_id TEXT NOT NULL REFERENCES order_items(id) ON DELETE CASCADE,
    modifier_id   TEXT NOT NULL,
    name_snapshot TEXT NOT NULL,
    price         NUMERIC NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sync_log (
    id            TEXT PRIMARY KEY,
    direction     TEXT NOT NULL,
    sync_type     TEXT NOT NULL,
    payload_ref   TEXT,
    status        TEXT NOT NULL,
    attempt_count INTEGER NOT NULL DEFAULT 0,
    error_message TEXT DEFAULT '',
    resolved_at   TEXT,
    created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sync_cursor (
    location_id   TEXT PRIMARY KEY,
    last_sequence INTEGER NOT NULL DEFAULT 0,
    updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS print_jobs (
    id            TEXT PRIMARY KEY,
    order_id      TEXT NOT NULL,
    station       TEXT NOT NULL,
    job_type      TEXT NOT NULL DEFAULT 'KOT',
    printer_id    TEXT,
    payload       TEXT NOT NULL,
    status        TEXT NOT NULL DEFAULT 'PENDING',
    attempt_count INTEGER NOT NULL DEFAULT 0,
    next_retry_at TEXT,
    last_error    TEXT,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS menu_cache (
    location_id  TEXT PRIMARY KEY,
    menu_version INTEGER NOT NULL DEFAULT 0,
    payload      TEXT NOT NULL DEFAULT '{}',
    updated_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS printers (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    connection TEXT NOT NULL,
    driver     TEXT NOT NULL,
    enabled    INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS print_routes (
    station             TEXT NOT NULL,
    job_type            TEXT NOT NULL,
    printer_id          TEXT NOT NULL REFERENCES printers(id),
    fallback_printer_id TEXT REFERENCES printers(id),
    PRIMARY KEY (station, job_type)
);

CREATE TABLE IF NOT EXISTS node_state (
    key   TEXT PRIMARY KEY,
    value TEXT
);
`
