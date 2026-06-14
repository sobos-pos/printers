export const migration003 = `
CREATE TABLE IF NOT EXISTS label_assignments (
    location_id      TEXT NOT NULL,
    station_code     TEXT NOT NULL,
    print_type       TEXT NOT NULL,
    assigned_node_id TEXT,
    PRIMARY KEY (location_id, station_code, print_type)
);
`;
