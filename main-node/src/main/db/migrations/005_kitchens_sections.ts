export const migration005 = `
-- section_code on orders drives BILL routing (section → BILL printer).
-- Default 'COUNTER' means existing orders fall back to the counter/cashier printer.
ALTER TABLE orders ADD COLUMN section_code TEXT NOT NULL DEFAULT 'COUNTER';

-- Per-table section mapping populated when the node serves a menu for a table.
-- Allows resolving section_code for locally-created orders without a cloud round-trip.
CREATE TABLE IF NOT EXISTS table_sections (
    table_uuid   TEXT PRIMARY KEY,
    section_code TEXT NOT NULL DEFAULT 'COUNTER',
    section_name TEXT NOT NULL DEFAULT '',
    updated_at   TEXT NOT NULL
);
`;
