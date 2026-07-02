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

// Task adjust calls the tasks store + brain-stream notify; stub both so the
// happy-path test exercises the route wiring without a DB / live stream.
vi.mock('../../db/tasks.js', () => ({ updateTask: vi.fn() }))
vi.mock('../../brain-stream/notify.js', () => ({ notifyBrainInboxChange: vi.fn() }))
// Null-assistant memory adjust runs inline (no redirect) via the memory
// store + verification store; stub them so the route wiring is exercised
// without a DB.
vi.mock('../../db/memories.js', () => ({
  updateMemory: vi.fn(),
  getMemoryByIdSystem: vi.fn(),
  markVerifiedDirect: vi.fn(),
}))
vi.mock('../../db/memory-verifications-store.js', () => ({ recordVerification: vi.fn() }))

import { brainInboxRoutes } from '../brain-inbox.js'
import { query } from '../../db/client.js'
import { updateTask } from '../../db/tasks.js'
import { updateMemory, getMemoryByIdSystem, markVerifiedDirect } from '../../db/memories.js'
import { recordVerification } from '../../db/memory-verifications-store.js'

const mockQuery = vi.mocked(query)
const mockUpdateTask = vi.mocked(updateTask)
const mockUpdateMemory = vi.mocked(updateMemory)
const mockGetMemoryByIdSystem = vi.mocked(getMemoryByIdSystem)
const mockMarkVerifiedDirect = vi.mocked(markVerifiedDirect)
const mockRecordVerification = vi.mocked(recordVerification)

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

  it('task adjust requires at least one of title / status / due_at / tags', async () => {
    const res = await request(makeApp())
      .post(`/api/brain-inbox/${WS}/task/${ROW}/adjust`)
      .send({ reason: 'no field changed' })
    expect(res.status).toBe(400)
    expect(mockUpdateTask).not.toHaveBeenCalled()
  })

  it('task adjust rejects an invalid status', async () => {
    const res = await request(makeApp())
      .post(`/api/brain-inbox/${WS}/task/${ROW}/adjust`)
      .send({ status: 'shipping' })
    expect(res.status).toBe(400)
  })

  it('task adjust rejects a non-date due_at', async () => {
    const res = await request(makeApp())
      .post(`/api/brain-inbox/${WS}/task/${ROW}/adjust`)
      .send({ due_at: 'whenever' })
    expect(res.status).toBe(400)
  })

  it('task adjust patches the task and returns the new (superseded) id', async () => {
    // 1) workspace-ownership pre-check, then 2) updateTask returns the new row.
    mockQuery.mockResolvedValueOnce({ rows: [{ workspaceId: WS }] } as never)
    mockUpdateTask.mockResolvedValueOnce({ id: 'new-task-id', title: 'Refreshed' } as never)

    const res = await request(makeApp())
      .post(`/api/brain-inbox/${WS}/task/${ROW}/adjust`)
      .send({ title: 'Refreshed', status: 'in_progress', due_at: null })

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ ok: true, id: 'new-task-id' })
    expect(mockUpdateTask).toHaveBeenCalledWith('u_caller', ROW, {
      title: 'Refreshed',
      status: 'in_progress',
      due: null,
    })
  })

  it('task adjust returns 404 when the task is absent', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] } as never)
    const res = await request(makeApp())
      .post(`/api/brain-inbox/${WS}/task/${ROW}/adjust`)
      .send({ title: 'x' })
    expect(res.status).toBe(404)
    expect(mockUpdateTask).not.toHaveBeenCalled()
  })

  it('task adjust returns 403 for a task in a different workspace', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ workspaceId: 'other-ws' }] } as never)
    const res = await request(makeApp())
      .post(`/api/brain-inbox/${WS}/task/${ROW}/adjust`)
      .send({ status: 'done' })
    expect(res.status).toBe(403)
    expect(mockUpdateTask).not.toHaveBeenCalled()
  })

  // ── Memory adjust ────────────────────────────────────────────────
  const ASSISTANT = 'a1b2c3d4-0000-4000-8000-000000000001'
  const NEW_ROW = 'f4b30b32-1771-4c90-b5af-b1b42311f999'

  it('memory adjust 308-redirects to the per-assistant route when the memory has an owning assistant', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ assistantId: ASSISTANT }] } as never)
    const res = await request(makeApp())
      .post(`/api/brain-inbox/${WS}/memory/${ROW}/adjust`)
      .send({ summary: 'new' })
    expect(res.status).toBe(308)
    expect(res.headers.location).toBe(`/api/assistants/${ASSISTANT}/memories/${ROW}/adjust`)
    // Delegated — the inline path must not run.
    expect(mockUpdateMemory).not.toHaveBeenCalled()
  })

  it('memory adjust handles a null-assistant (workspace-shared) memory inline, no redirect', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ assistantId: null }] } as never)
    mockGetMemoryByIdSystem.mockResolvedValueOnce({
      id: ROW,
      assistantId: null,
      workspaceId: WS,
      scope: 'shared',
      sensitivity: 'confidential',
      summary: 'old',
      detail: null,
    } as never)
    mockUpdateMemory.mockResolvedValueOnce({
      id: NEW_ROW,
      workspaceId: WS,
      scope: 'shared',
      sensitivity: 'confidential',
      summary: 'new',
      detail: null,
    } as never)
    mockRecordVerification.mockResolvedValue({} as never)
    mockMarkVerifiedDirect.mockResolvedValueOnce({ id: NEW_ROW, summary: 'new' } as never)

    const res = await request(makeApp())
      .post(`/api/brain-inbox/${WS}/memory/${ROW}/adjust`)
      .send({ summary: 'new' })

    expect(res.status).toBe(200)
    expect(res.body.memory).toMatchObject({ id: NEW_ROW })
    // The redirect assistantId must never be built from null.
    expect(res.headers.location).toBeUndefined()
    expect(mockUpdateMemory).toHaveBeenCalledWith(ROW, expect.objectContaining({ summary: 'new' }))
    // Summary change writes an edit_summary verification, and the new row is stamped.
    expect(mockRecordVerification).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'edit_summary', verifiedBy: 'u_caller' }),
    )
    expect(mockMarkVerifiedDirect).toHaveBeenCalledWith(NEW_ROW, 'u_caller')
  })

  it('null-assistant memory adjust returns 404 when the memory is in another workspace', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ assistantId: null }] } as never)
    mockGetMemoryByIdSystem.mockResolvedValueOnce({
      id: ROW,
      assistantId: null,
      workspaceId: 'other-ws',
      scope: 'shared',
      sensitivity: 'internal',
      summary: 'old',
      detail: null,
    } as never)
    const res = await request(makeApp())
      .post(`/api/brain-inbox/${WS}/memory/${ROW}/adjust`)
      .send({ summary: 'new' })
    expect(res.status).toBe(404)
    expect(mockUpdateMemory).not.toHaveBeenCalled()
  })

  it('null-assistant memory adjust requires at least one field', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ assistantId: null }] } as never)
    const res = await request(makeApp())
      .post(`/api/brain-inbox/${WS}/memory/${ROW}/adjust`)
      .send({})
    expect(res.status).toBe(400)
    expect(mockGetMemoryByIdSystem).not.toHaveBeenCalled()
  })
})
