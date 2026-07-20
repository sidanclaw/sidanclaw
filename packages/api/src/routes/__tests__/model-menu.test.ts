/**
 * [COMP:api/model-menu] Model selection routes — menus derive from the
 * registry gated by configured providers (L12), profiles CRUD is
 * membership-gated, estimates ride the injected closed seam.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import { modelMenuRoutes, type ModelMenuRouteOptions } from '../model-menu.js'

const getRole = vi.fn()
const profiles = {
  list: vi.fn(),
  get: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
}

function makeApp(overrides?: Partial<ModelMenuRouteOptions>) {
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => { (req as { userId?: string }).userId = 'u1'; next() })
  app.use('/api', modelMenuRoutes({
    workspaceStore: { getRole } as never,
    meteredProfileStore: profiles as never,
    configuredProviders: new Set(['gemini', 'openai-compat:dashscope-intl']),
    estimateMeteredTurn: (alias, rounds) => ({ modelAlias: alias, toolRounds: rounds, minCredits: 9, maxCredits: 12 * rounds }),
    ...overrides,
  }))
  return app
}

beforeEach(() => {
  vi.clearAllMocks()
  getRole.mockResolvedValue('member')
  profiles.list.mockResolvedValue([])
})

describe('[COMP:api/model-menu] GET /models/menu', () => {
  it('lists per-class menus with the wave-1 metered ports when the key is configured', async () => {
    const res = await request(makeApp()).get('/api/models/menu?workspaceId=00000000-0000-0000-0000-000000000001').expect(200)
    expect(res.body.classes['standard-pro'].map((m: { alias: string }) => m.alias))
      .toEqual(['gemini-3-flash-standard', 'gemini-flash-3'])
    expect(res.body.classes['metered'].map((m: { alias: string }) => m.alias).sort())
      .toEqual(['deepseek-v4-flash', 'deepseek-v4-pro', 'qwen3.7-max', 'qwen3.7-plus'])
    expect(res.body.meteredBillingAvailable).toBe(true)
  })

  it('drops keyless-provider models from every menu without error (L12)', async () => {
    const res = await request(makeApp({ configuredProviders: new Set(['gemini']) }))
      .get('/api/models/menu?workspaceId=00000000-0000-0000-0000-000000000001').expect(200)
    expect(res.body.classes['metered']).toEqual([])
    expect(res.body.classes['standard-pro'].length).toBeGreaterThan(0)
  })

  it('hides profiles whose model lost its key, keeps them in the store', async () => {
    profiles.list.mockResolvedValue([
      { id: 'p1', workspaceId: 'w', name: 'deep', modelAlias: 'deepseek-v4-pro', toolRounds: 100, thinking: null },
    ])
    const res = await request(makeApp({ configuredProviders: new Set(['gemini']) }))
      .get('/api/models/menu?workspaceId=00000000-0000-0000-0000-000000000001').expect(200)
    expect(res.body.profiles).toEqual([])
  })

  it('403s non-members', async () => {
    getRole.mockResolvedValue(null)
    await request(makeApp()).get('/api/models/menu?workspaceId=00000000-0000-0000-0000-000000000001').expect(403)
  })
})

describe('[COMP:api/model-menu] metered estimate + profiles CRUD', () => {
  it('estimates at the requested budget through the injected seam', async () => {
    const res = await request(makeApp())
      .post('/api/models/metered-estimate')
      .send({ workspaceId: '00000000-0000-0000-0000-000000000001', modelAlias: 'qwen3.7-max', toolRounds: 100 })
      .expect(200)
    expect(res.body.estimate).toMatchObject({ modelAlias: 'qwen3.7-max', toolRounds: 100, maxCredits: 1200 })
  })

  it('creates a profile with clamped fields and returns it', async () => {
    profiles.create.mockResolvedValue({ id: 'p1', name: 'deep' })
    await request(makeApp())
      .post('/api/workspaces/00000000-0000-0000-0000-000000000001/metered-profiles')
      .send({ name: 'deep', modelAlias: 'deepseek-v4-pro', toolRounds: 100 })
      .expect(200)
    expect(profiles.create).toHaveBeenCalledWith(expect.objectContaining({ modelAlias: 'deepseek-v4-pro', toolRounds: 100 }))
  })

  it('maps a non-metered model to a 400', async () => {
    profiles.create.mockRejectedValue(new Error("metered-profile: 'gemini-3.5-flash' is not an active metered registry model"))
    const res = await request(makeApp())
      .post('/api/workspaces/00000000-0000-0000-0000-000000000001/metered-profiles')
      .send({ name: 'x', modelAlias: 'gemini-3.5-flash', toolRounds: 10 })
      .expect(400)
    expect(res.body.error).toBe('Not a metered model')
  })
})
