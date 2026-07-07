/**
 * Unit tests for the KB gap candidate routes.
 * Component tag: [COMP:api/kb-gaps-route].
 *
 * The routes take their `kbGapStore` + `workspaceStore` as injected
 * deps, so we pass `vi.fn()` doubles and exercise the auth /
 * workspaceId / membership guards and the list / dismiss / draft happy
 * + not-found paths via supertest. Membership at any role is sufficient
 * (KB gaps surface to everyone who can read the KB); the list read must
 * pass `actingUserId` so RLS context is set.
 *
 * Spec: docs/architecture/context-engine/memory-consolidation.md → CL-9.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import type { KbGapCandidateStore, KbGapCandidateRow } from '../../db/kb-gap-candidate-store.js'
import type { WorkspaceStore } from '../../db/workspace-store.js'
import { kbGapsRoutes } from '../kb-gaps.js'

const ROW: KbGapCandidateRow = {
  id: 'g1',
  workspaceId: 'w1',
  patternSummary: 'How do refunds work',
  evidenceMissIds: ['m1', 'm2'],
  occurrences: 4,
  distinctSessions: 3,
  dismissedAt: null,
  dismissedByUserId: null,
  draftedAt: null,
  draftedByUserId: null,
  createdAt: new Date('2026-07-01T00:00:00.000Z'),
}

function makeDeps() {
  const kbGapStore = {
    create: vi.fn(),
    listOpen: vi.fn().mockResolvedValue([ROW]),
    dismiss: vi.fn().mockResolvedValue(true),
    markDrafted: vi.fn().mockResolvedValue(true),
  } as unknown as KbGapCandidateStore
  const workspaceStore = {
    getRole: vi.fn().mockResolvedValue('member'),
  } as unknown as WorkspaceStore
  return { kbGapStore, workspaceStore }
}

function makeApp(deps: ReturnType<typeof makeDeps>, userId?: string) {
  const app = express()
  app.use(express.json())
  if (userId) {
    app.use((req, _res, next) => {
      ;(req as { userId?: string }).userId = userId
      next()
    })
  }
  app.use('/api/kb-gaps', kbGapsRoutes(deps))
  return app
}

describe('[COMP:api/kb-gaps-route] GET /api/kb-gaps', () => {
  let deps: ReturnType<typeof makeDeps>
  beforeEach(() => {
    deps = makeDeps()
  })

  it('401 without auth', async () => {
    const res = await request(makeApp(deps)).get('/api/kb-gaps?workspaceId=w1')
    expect(res.status).toBe(401)
  })

  it('400 without workspaceId', async () => {
    const res = await request(makeApp(deps, 'u1')).get('/api/kb-gaps')
    expect(res.status).toBe(400)
  })

  it('403 when not a workspace member', async () => {
    deps.workspaceStore.getRole = vi.fn().mockResolvedValue(null)
    const res = await request(makeApp(deps, 'u1')).get('/api/kb-gaps?workspaceId=w1')
    expect(res.status).toBe(403)
    expect(deps.kbGapStore.listOpen).not.toHaveBeenCalled()
  })

  it('200 lists open candidates + count for any member, passing actingUserId for RLS', async () => {
    const res = await request(makeApp(deps, 'u1')).get('/api/kb-gaps?workspaceId=w1')
    expect(res.status).toBe(200)
    expect(res.body.count).toBe(1)
    expect(res.body.candidates[0].id).toBe('g1')
    expect(deps.kbGapStore.listOpen).toHaveBeenCalledWith('w1', { actingUserId: 'u1' })
  })

  it('500 when the store throws', async () => {
    deps.kbGapStore.listOpen = vi.fn().mockRejectedValue(new Error('boom'))
    const res = await request(makeApp(deps, 'u1')).get('/api/kb-gaps?workspaceId=w1')
    expect(res.status).toBe(500)
  })
})

describe('[COMP:api/kb-gaps-route] POST /api/kb-gaps/:id/dismiss', () => {
  let deps: ReturnType<typeof makeDeps>
  beforeEach(() => {
    deps = makeDeps()
  })

  it('401 without auth', async () => {
    const res = await request(makeApp(deps)).post('/api/kb-gaps/g1/dismiss')
    expect(res.status).toBe(401)
  })

  it('200 when the store dismisses the candidate', async () => {
    const res = await request(makeApp(deps, 'u1')).post('/api/kb-gaps/g1/dismiss')
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(deps.kbGapStore.dismiss).toHaveBeenCalledWith('u1', 'g1')
  })

  it('404 when the candidate is not found / already dismissed', async () => {
    deps.kbGapStore.dismiss = vi.fn().mockResolvedValue(false)
    const res = await request(makeApp(deps, 'u1')).post('/api/kb-gaps/g1/dismiss')
    expect(res.status).toBe(404)
  })
})

describe('[COMP:api/kb-gaps-route] POST /api/kb-gaps/:id/draft', () => {
  let deps: ReturnType<typeof makeDeps>
  beforeEach(() => {
    deps = makeDeps()
  })

  it('200 marks the candidate drafted (no KB row write here)', async () => {
    const res = await request(makeApp(deps, 'u1')).post('/api/kb-gaps/g1/draft')
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(deps.kbGapStore.markDrafted).toHaveBeenCalledWith('u1', 'g1')
  })

  it('404 when the candidate is not found / already drafted (idempotent)', async () => {
    deps.kbGapStore.markDrafted = vi.fn().mockResolvedValue(false)
    const res = await request(makeApp(deps, 'u1')).post('/api/kb-gaps/g1/draft')
    expect(res.status).toBe(404)
  })
})
