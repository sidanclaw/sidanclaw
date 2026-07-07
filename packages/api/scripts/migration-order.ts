/**
 * Orders migration files from multiple source dirs into one global,
 * name-sorted apply sequence.
 *
 * Why: applying each dir fully before the next (open-then-overlay) breaks a
 * fresh hosted bootstrap — an open post-baseline migration (e.g. 285's
 * `ALTER TABLE connector_instance`) can reference a table that only the
 * overlay baseline creates. Filenames are globally unique across dirs by
 * convention (database-schema.md § Adding a migration), so a single
 * lexicographic sort interleaves both dirs correctly: `000_open_schema_v1.sql`
 * < `000_overlay_v1.sql` < every numbered file.
 */
export type MigrationDir = { dir: string; files: string[] }

export type OrderedMigration = { dir: string; file: string }

export function orderMigrationFiles(dirs: MigrationDir[]): OrderedMigration[] {
  const owner = new Map<string, string>()
  for (const { dir, files } of dirs) {
    for (const file of files) {
      if (!file.endsWith('.sql')) continue
      const existing = owner.get(file)
      if (existing !== undefined) {
        throw new Error(
          `Duplicate migration filename "${file}" in both ${existing} and ${dir}; ` +
            'filenames must be globally unique across migration dirs',
        )
      }
      owner.set(file, dir)
    }
  }
  return [...owner.entries()]
    .map(([file, dir]) => ({ dir, file }))
    .sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0))
}
