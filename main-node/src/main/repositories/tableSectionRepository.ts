import { getDb, nowIso } from '../db/connection'

export interface TableSectionRow {
  table_uuid: string
  section_code: string
  section_name: string
  table_label: string
}

export const tableSectionRepository = {
  /** Upsert a table's section mapping. A blank tableLabel preserves any label
   *  already stored (so a caller that only knows the section never wipes it). */
  upsert(tableUuid: string, sectionCode: string, sectionName: string, tableLabel = ''): void {
    getDb()
      .prepare(
        `INSERT INTO table_sections (table_uuid, section_code, section_name, table_label, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(table_uuid) DO UPDATE SET
           section_code = excluded.section_code,
           section_name = excluded.section_name,
           table_label  = CASE WHEN excluded.table_label != ''
                               THEN excluded.table_label
                               ELSE table_sections.table_label END,
           updated_at   = excluded.updated_at`,
      )
      .run(tableUuid, sectionCode, sectionName, tableLabel, nowIso())
  },

  get(tableUuid: string): TableSectionRow | null {
    const row = getDb()
      .prepare('SELECT * FROM table_sections WHERE table_uuid = ?')
      .get(tableUuid) as TableSectionRow | undefined
    return row ?? null
  },

  getSectionCode(tableUuid: string): string {
    const row = getDb()
      .prepare('SELECT section_code FROM table_sections WHERE table_uuid = ?')
      .get(tableUuid) as { section_code: string } | undefined
    return row?.section_code ?? 'COUNTER'
  },

  getLabel(tableUuid: string): string | null {
    const row = getDb()
      .prepare('SELECT table_label FROM table_sections WHERE table_uuid = ?')
      .get(tableUuid) as { table_label: string } | undefined
    return row?.table_label ? row.table_label : null
  },
}
