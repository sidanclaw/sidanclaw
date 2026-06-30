/**
 * Brain-inbox route tests. The route lives in the OPEN package and is
 * mounted by `bootOpenApi` (open + hosted share it) — see boot.ts
 * `/api/brain-inbox`. Regression guard for the open-core wiring gap where
 * the brain detail drawer hit `/api/brain-inbox/:ws/:primitive/:rowId` but
 * the open API never mounted the route (the route was stranded in the closed
 * `api-platform` package), so the open build returned a bare `Cannot GET` 404.
 *
 * [COMP:api/brain-inbox-route]
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import request from 'supertest'
import { createTestApp } from './helpers.js'

vi.mock('../../db/client.js', () => ({
  query: vi.fn(),
  queryWithRLS: vi.fn(),
}))

import { brainInboxRoutes } from '../brain-inbox.js'
import { query } from '../../db/client.js'

const mockQuery = vi.mocked(query)

const WS = 'e1799b0e-9f64-46d5-8ed8-132a2194943d'
const ROW = 'f4b30b32-1771-4c90-b5af-b1b42311f543'

function makeApp(role: string | null = 'member') {
  const workspaceStore = { getRole: vi.fn().mockResolvedValue(role) } as never
  return createTestApp('/api/brain-inbox', brainInboxRoutes({ workspaceStore }), {
    userId: 'u_caller',
  })
}

describe('[COMP:api/brain-inbox-route] Brain inbox route', () => {
  beforeEach(() => vi.clearAllMocks())

  it('GET /:workspaceId/:primitive/:rowId returns a live memory row', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          primitive: 'memory',
          id: ROW,
          workspaceId: WS,
          createdAt: new Date('2026-06-24T07:41:18Z'),
          createdByAssistantId: 'a_1',
          verifiedByUserId: null,
          verifiedAt: null,
          body: { summary: 'sandbox.md', sensitivity: 'confidential' },
        },
      ],
    } as never)

    const res = await request(makeApp()).get(`/api/brain-inbox/${WS}/memory/${ROW}`)

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ primitive: 'memory', id: ROW, workspaceId: WS })
    expect(res.body.body.summary).toBe('sandbox.md')
    // The detail SELECT must be workspace-scoped + liveness-filtered.
    const sql = mockQuery.mock.calls[0][0] as string
    expect(sql).toMatch(/FROM memories/)
    expect(sql).toMatch(/valid_to IS NULL/)
    expect(sql).toMatch(/retracted_at IS NULL/)
  })

  it('returns 404 when the row is absent (soft-deleted / retracted / wrong workspace)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] } as never)
    const res = await request(makeApp()).get(`/api/brain-inbox/${WS}/memory/${ROW}`)
    expect(res.status).toBe(404)
  })

  it('rejects an unknown primitive with 400', async () => {
    const res = await request(makeApp()).get(`/api/brain-inbox/${WS}/bogus/${ROW}`)
    expect(res.status).toBe(400)
  })

  it('rejects a non-member with 403', async () => {
    const res = await request(makeApp(null)).get(`/api/brain-inbox/${WS}/memory/${ROW}`)
    expect(res.status).toBe(403)
  })

  it('file content endpoint returns 501 when no files API is wired', async () => {
    // makeApp() omits `filesApi`, mirroring an OSS boot without a blob client.
    const res = await request(makeApp()).get(`/api/brain-inbox/${WS}/workspace_file/${ROW}/content`)
    expect(res.status).toBe(501)
  })

  it('file adjust requires at least one of sensitivity / tags', async () => {
    const res = await request(makeApp())
      .post(`/api/brain-inbox/${WS}/workspace_file/${ROW}/adjust`)
      .send({ reason: 'just a note, no field change' })
    expect(res.status).toBe(400)
  })

  it('file adjust rejects an invalid sensitivity', async () => {
    const res = await request(makeApp())
      .post(`/api/brain-inbox/${WS}/workspace_file/${ROW}/adjust`)
      .send({ sensitivity: 'top-secret' })
    expect(res.status).toBe(400)
  })
})
