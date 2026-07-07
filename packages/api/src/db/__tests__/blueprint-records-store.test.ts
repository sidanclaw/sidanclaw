import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../client.js', () => ({
  query: vi.fn(),
  queryWithRLS: vi.fn(),
}))

import { createDbBlueprintRecordStore } from '../blueprint-records-store.js'
import { queryWithRLS } from '../client.js'

const mockQueryWithRLS = vi.mocked(queryWithRLS)

const ROW = {
  id: 'r-1',
  workspace_id: 'ws-1',
  blueprint_id: 'bp-1',
  spec_snapshot: [{ key: 'summary', heading: 'Summary', instruction: 's', type: 'markdown', required: true }],
  subject: 'Acme',
  anchor_key: 'generate-synthesis:ws-1:bp-1:acme',
  fields: { summary: 'text' },
  status: 'incomplete',
  missing: ['summary'],
  source_kind: 'brain',
  source_id: 'Acme',
  sensitivity: 'internal',
  page_id: null,
  created_by: 'u-1',
  created_at: new Date('2026-07-07T00:00:00Z'),
  updated_at: new Date('2026-07-07T00:00:00Z'),
}

beforeEach(() => {
  vi.clearAllMocks()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mockQueryWithRLS.mockResolvedValue({ rows: [ROW] } as any)
})

const store = createDbBlueprintRecordStore()

describe('[COMP:api/blueprint-records-store] blueprint records store', () => {
  it('ensure upserts on (workspace, anchor) and resets fields only when asked', async () => {
    const rec = await store.ensure('u-1', {
      workspaceId: 'ws-1',
      blueprintId: 'bp-1',
      specSnapshot: ROW.spec_snapshot as never,
      subject: 'Acme',
      anchorKey: ROW.anchor_key,
      sourceKind: 'brain',
      sourceId: 'Acme',
      sensitivity: 'internal',
      resetFields: true,
    })
    const [userId, sql, params] = [
      mockQueryWithRLS.mock.calls[0][0],
      mockQueryWithRLS.mock.calls[0][1] as string,
      mockQueryWithRLS.mock.calls[0][2] as unknown[],
    ]
    expect(userId).toBe('u-1')
    expect(sql).toContain('INSERT INTO blueprint_records')
    expect(sql).toContain('ON CONFLICT (workspace_id, anchor_key) DO UPDATE')
    // Fresh fills wipe stale keys; partial saves keep them (the CASE arm).
    expect(sql).toContain(`fields = CASE WHEN $10 THEN '{}'::jsonb ELSE blueprint_records.fields END`)
    expect(sql).toContain(`status = 'incomplete'`)
    expect(params[4]).toBe(ROW.anchor_key)
    expect(params[9]).toBe(true)
    expect(rec.id).toBe('r-1')
    expect(rec.status).toBe('incomplete')
    expect(rec.createdAt).toBe('2026-07-07T00:00:00.000Z')
  })

  it('mergeFields shallow-merges via jsonb concat', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockQueryWithRLS.mockResolvedValue({ rows: [{ id: 'r-1' }] } as any)
    const ok = await store.mergeFields('u-1', 'r-1', { summary: 'text' })
    const sql = mockQueryWithRLS.mock.calls[0][1] as string
    expect(sql).toContain('SET fields = fields || $2::jsonb')
    expect(mockQueryWithRLS.mock.calls[0][2]).toEqual(['r-1', JSON.stringify({ summary: 'text' })])
    expect(ok).toBe(true)
  })

  it('finalize stamps status + missing and only overwrites page_id when provided', async () => {
    await store.finalize('u-1', 'r-1', { status: 'complete', missing: [], pageId: null })
    const sql = mockQueryWithRLS.mock.calls[0][1] as string
    expect(sql).toContain('SET status = $2, missing = $3::jsonb, page_id = COALESCE($4, page_id)')
  })

  it('getLatestForSource orders newest-first for the {{lastRun.output}} read', async () => {
    await store.getLatestForSource('u-1', 'ws-1', 'workflow', 'run-9')
    const sql = mockQueryWithRLS.mock.calls[0][1] as string
    expect(sql).toContain('source_kind = $2 AND source_id = $3')
    expect(sql).toContain('ORDER BY updated_at DESC')
    expect(mockQueryWithRLS.mock.calls[0][2]).toEqual(['ws-1', 'workflow', 'run-9'])
  })

  it('getLatestBySubject matches case-insensitively', async () => {
    await store.getLatestBySubject('u-1', 'ws-1', 'bp-1', 'ACME')
    const sql = mockQueryWithRLS.mock.calls[0][1] as string
    expect(sql).toContain('lower(subject) = lower($3)')
  })

  it('listForBlueprint clamps the limit into [1, 500]', async () => {
    await store.listForBlueprint('u-1', 'ws-1', 'bp-1', 9999)
    expect((mockQueryWithRLS.mock.calls[0][2] as unknown[])[2]).toBe(500)
    await store.listForBlueprint('u-1', 'ws-1', 'bp-1', 0)
    expect((mockQueryWithRLS.mock.calls[1][2] as unknown[])[2]).toBe(1)
  })
})
