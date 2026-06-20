export const migration006 = `
-- Cache the table's human label alongside its section so BILL/KOT receipts can
-- print "Table: T1" for ANY table without depending on a single bootstrap menu.
-- Populated by the boot warmup (fetchTables) and when a menu is served.
ALTER TABLE table_sections ADD COLUMN table_label TEXT NOT NULL DEFAULT '';
`;
