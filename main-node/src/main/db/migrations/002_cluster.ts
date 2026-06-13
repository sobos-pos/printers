export const migration002 = `
CREATE TABLE IF NOT EXISTS node_config (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS cluster_nodes (
    node_id           TEXT PRIMARY KEY,
    node_label        TEXT NOT NULL DEFAULT '',
    station_codes     TEXT NOT NULL DEFAULT '[]',
    host              TEXT NOT NULL,
    port              INTEGER NOT NULL DEFAULT 3001,
    status            TEXT NOT NULL DEFAULT 'ONLINE',
    election_priority INTEGER NOT NULL DEFAULT 10,
    printer_info      TEXT,
    last_health_check TEXT NOT NULL,
    registered_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS remote_print_jobs (
    job_id      TEXT PRIMARY KEY,
    order_id    TEXT NOT NULL,
    station     TEXT NOT NULL,
    job_type    TEXT NOT NULL DEFAULT 'KOT',
    payload     TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'RECEIVED',
    received_at TEXT NOT NULL,
    printed_at  TEXT
);
`;
