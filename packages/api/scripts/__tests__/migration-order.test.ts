import { describe, expect, it } from 'vitest'
import { orderMigrationFiles } from '../migration-order.js'

describe('[COMP:api/migration-order] Migration file ordering', () => {
  it('sorts the overlay baseline between the open baseline and numbered open files', () => {
    // The exact fresh-hosted-bootstrap regression: open 285 ALTERs
    // connector_instance, which only overlay 000_overlay_v1 creates. Dir-by-dir
    // apply ran 285 first; the global name-sort must not.
    const ordered = orderMigrationFiles([
      {
        dir: '/open',
        files: ['000_open_schema_v1.sql', '285_connector_credentials_type_gcs.sql'],
      },
      { dir: '/overlay', files: ['000_overlay_v1.sql'] },
    ])
    expect(ordered.map((m) => m.file)).toEqual([
      '000_open_schema_v1.sql',
      '000_overlay_v1.sql',
      '285_connector_credentials_type_gcs.sql',
    ])
    expect(ordered[1]).toEqual({ dir: '/overlay', file: '000_overlay_v1.sql' })
  })

  it('interleaves numbered files from multiple dirs into one sequence', () => {
    const ordered = orderMigrationFiles([
      { dir: '/open', files: ['281_recording_surcharges.sql', '285_goals.sql', '001_doc_brain_sync.sql'] },
      { dir: '/overlay', files: ['283_whatsapp_bot_triggers.sql', '282_wa_auth_state.sql'] },
    ])
    expect(ordered).toEqual([
      { dir: '/open', file: '001_doc_brain_sync.sql' },
      { dir: '/open', file: '281_recording_surcharges.sql' },
      { dir: '/overlay', file: '282_wa_auth_state.sql' },
      { dir: '/overlay', file: '283_whatsapp_bot_triggers.sql' },
      { dir: '/open', file: '285_goals.sql' },
    ])
  })

  it('ignores non-sql files', () => {
    const ordered = orderMigrationFiles([
      { dir: '/open', files: ['001_a.sql', 'README.md', '.DS_Store'] },
    ])
    expect(ordered).toEqual([{ dir: '/open', file: '001_a.sql' }])
  })

  it('throws on a duplicate filename across dirs', () => {
    expect(() =>
      orderMigrationFiles([
        { dir: '/open', files: ['282_wa_auth_state.sql'] },
        { dir: '/overlay', files: ['282_wa_auth_state.sql'] },
      ]),
    ).toThrow(/globally unique/)
  })
})
