import { getDb, nowIso } from '../db/connection'

export const tableSectionRepository = {
  upsert(tableUuid: string, sectionCode: string, sectionName: string): void {
    getDb()
      .prepare(
        `INSERT INTO table_sections (table_uuid, section_code, section_name, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(table_uuid) DO UPDATE SET
           section_code = excluded.section_code,
           section_name = excluded.section_name,
           updated_at   = excluded.updated_at`,
      )
      .run(tableUuid, sectionCode, sectionName, nowIso())
  },

  getSectionCode(tableUuid: string): string {
    const row = getDb()
      .prepare('SELECT section_code FROM table_sections WHERE table_uuid = ?')
      .get(tableUuid) as { section_code: string } | undefined
    return row?.section_code ?? 'COUNTER'
  },
}
