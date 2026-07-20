/**
 * [COMP:doc/platform-subdomains] Platform-issued workspace subdomains —
 * workspace-scoped claim/rename/release/suggestion/availability routes,
 * apex selection, reserved labels, default-page assignment. Lifecycle is
 * workspace-first (Settings): claiming needs NO page; the default page is
 * assigned afterwards. Spec: docs/architecture/features/platform-subdomains.md.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'

vi.mock('../../db/client.js', () => ({
  query: vi.fn(async () => ({ rows: [] })),
  queryWithRLS: vi.fn(async () => ({ rows: [] })),
  getPool: vi.fn(),
  getAppPool: vi.fn(),
  rollbackAndRelease: vi.fn(),
}))

const membership = vi.hoisted(() => ({ current: { role: 'owner' } as { role: string } | null }))
vi.mock('../../db/workspace-store.js', () => ({
  getWorkspaceMembershipWithClearanceSystem: vi.fn(async () => membership.current),
}))

import { viewsRoutes } from '../views.js'
import type { PageDomain } from '../../db/page-domain-store.js'

const WORKSPACE_ID = '00000000-0000-0000-0000-000000000010'
const FIRST_PARTY_WS = '00000000-0000-0000-0000-0000000000ff'
const USER_ID = '00000000-0000-0000-0000-000000000020'
const PAGE_ID = '00000000-0000-0000-0000-000000000030'

const CUSTOMER_APEX = 'usebrian.page'
const PLATFORM_APEX = 'usebrian.ai'
const RESERVED = ['www', 'app', 'api', 'admin']

function platformRow(over: Partial<PageDomain> = {}): PageDomain {
  return {
    id: 'pd_1',
    workspaceId: WORKSPACE_ID,
    pageId: null,
    hostname: `acme.${CUSTOMER_APEX}`,
    status: 'live',
    provider: 'platform',
    subdomainLabel: 'acme',
    verificationError: null,
    lastCheckedAt: null,
    createdBy: USER_ID,
    createdAt: 'now',
    updatedAt: 'now',
    ...over,
  }
}

function makeApp(opts: {
  store?: Record<string, unknown>
  apexes?: { customer?: string; platform?: string }
}) {
  const savedViewStore = { getById: vi.fn(async () => null) }
  const pageDomainStore = {
    getPlatformSubdomain: vi.fn(async () => null),
    isHostnameTaken: vi.fn(async () => false),
    claimSubdomain: vi.fn(async (i: { hostname: string; label: string }) =>
      platformRow({ hostname: i.hostname, subdomainLabel: i.label }),
    ),
    renameSubdomain: vi.fn(async (i: { hostname: string; label: string }) =>
      platformRow({ hostname: i.hostname, subdomainLabel: i.label }),
    ),
    releaseSubdomain: vi.fn(async () => platformRow()),
    getDomain: vi.fn(async () => platformRow()),
    setDefaultPage: vi.fn(async (_u: string, _d: string, pageId: string | null) =>
      platformRow({ pageId }),
    ),
    listDomainsForWorkspace: vi.fn(async () => []),
    ...opts.store,
  }
  // When `apexes` is passed, use it verbatim (an explicit `undefined` models
  // the dark/unconfigured case); otherwise default both apexes on.
  const customerApex = opts.apexes ? opts.apexes.customer : CUSTOMER_APEX
  const platformApex = opts.apexes ? opts.apexes.platform : PLATFORM_APEX
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    ;(req as unknown as { userId: string }).userId = USER_ID
    next()
  })
  app.use(
    '/api',
    viewsRoutes({
      savedViewStore,
      pageDomainStore,
      customerSubdomainApex: customerApex,
      platformSubdomainApex: platformApex,
      firstPartySubdomainWorkspaceIds: new Set([FIRST_PARTY_WS]),
      reservedSubdomainLabels: RESERVED,
    } as unknown as Parameters<typeof viewsRoutes>[0]),
  )
  return { app, pageDomainStore }
}

beforeEach(() => {
  vi.clearAllMocks()
  membership.current = { role: 'owner' }
})

describe('[COMP:doc/platform-subdomains] subdomain suggestion + availability', () => {
  it('suggests a random fruit+digits label under the customer apex', async () => {
    const { app } = makeApp({})
    const res = await request(app).get(`/api/workspaces/${WORKSPACE_ID}/subdomain-suggestion`)
    expect(res.status).toBe(200)
    expect(res.body.label).toMatch(/^[a-z]+[1-9]\d{2}$/)
    expect(res.body.apex).toBe(CUSTOMER_APEX)
    expect(res.body.hostname).toBe(`${res.body.label}.${CUSTOMER_APEX}`)
  })

  it('re-rolls the suggestion past taken hostnames', async () => {
    const isHostnameTaken = vi
      .fn()
      .mockResolvedValueOnce(true) // first roll taken
      .mockResolvedValue(false)
    const { app } = makeApp({ store: { isHostnameTaken } })
    const res = await request(app).get(`/api/workspaces/${WORKSPACE_ID}/subdomain-suggestion`)
    expect(res.status).toBe(200)
    expect(isHostnameTaken.mock.calls.length).toBeGreaterThanOrEqual(2)
  })

  it('reports a fresh label available under the customer apex', async () => {
    const { app } = makeApp({})
    const res = await request(app).get(
      `/api/workspaces/${WORKSPACE_ID}/subdomain-availability?label=acme`,
    )
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({
      valid: true,
      reserved: false,
      available: true,
      apex: CUSTOMER_APEX,
      hostname: `acme.${CUSTOMER_APEX}`,
    })
  })

  it('marks reserved and invalid labels unavailable', async () => {
    const { app } = makeApp({})
    const r1 = await request(app).get(
      `/api/workspaces/${WORKSPACE_ID}/subdomain-availability?label=app`,
    )
    expect(r1.body).toMatchObject({ valid: true, reserved: true, available: false })
    const r2 = await request(app).get(
      `/api/workspaces/${WORKSPACE_ID}/subdomain-availability?label=-bad-`,
    )
    expect(r2.body.valid).toBe(false)
  })

  it('503s when no apex is configured', async () => {
    const { app } = makeApp({ apexes: { customer: undefined, platform: undefined } })
    const res = await request(app).get(`/api/workspaces/${WORKSPACE_ID}/subdomain-suggestion`)
    expect(res.status).toBe(503)
    expect(res.body.code).toBe('subdomains_unconfigured')
  })
})

describe('[COMP:doc/platform-subdomains] claim (workspace-scoped, unbound)', () => {
  it('claims under the customer apex with NO page bound', async () => {
    const { app, pageDomainStore } = makeApp({})
    const res = await request(app)
      .post(`/api/workspaces/${WORKSPACE_ID}/subdomain`)
      .send({ label: 'acme' })
    expect(res.status).toBe(201)
    expect(res.body.subdomain).toMatchObject({
      hostname: `acme.${CUSTOMER_APEX}`,
      label: 'acme',
      defaultPageId: null,
    })
    expect(pageDomainStore.claimSubdomain).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: WORKSPACE_ID, label: 'acme' }),
    )
    expect(pageDomainStore.claimSubdomain).toHaveBeenCalledWith(
      expect.not.objectContaining({ pageId: expect.anything() }),
    )
  })

  it('routes a first-party workspace to the product apex', async () => {
    const { app } = makeApp({})
    const res = await request(app)
      .post(`/api/workspaces/${FIRST_PARTY_WS}/subdomain`)
      .send({ label: 'brand' })
    expect(res.status).toBe(201)
    expect(res.body.subdomain.hostname).toBe(`brand.${PLATFORM_APEX}`)
  })

  it('rejects reserved and invalid labels', async () => {
    const { app } = makeApp({})
    const r1 = await request(app)
      .post(`/api/workspaces/${WORKSPACE_ID}/subdomain`)
      .send({ label: 'admin' })
    expect(r1.status).toBe(409)
    expect(r1.body.code).toBe('reserved_label')
    const r2 = await request(app)
      .post(`/api/workspaces/${WORKSPACE_ID}/subdomain`)
      .send({ label: 'no_underscores' })
    expect(r2.status).toBe(400)
    expect(r2.body.code).toBe('invalid_label')
  })

  it('surfaces the one-per-workspace conflict', async () => {
    const { app } = makeApp({
      store: { claimSubdomain: vi.fn(async () => ({ error: 'workspace_has_subdomain' })) },
    })
    const res = await request(app)
      .post(`/api/workspaces/${WORKSPACE_ID}/subdomain`)
      .send({ label: 'acme' })
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('workspace_has_subdomain')
  })

  it('403s a plain member (owner/admin only)', async () => {
    membership.current = { role: 'member' }
    const { app } = makeApp({})
    const res = await request(app)
      .post(`/api/workspaces/${WORKSPACE_ID}/subdomain`)
      .send({ label: 'acme' })
    expect(res.status).toBe(403)
  })
})

describe('[COMP:doc/platform-subdomains] rename + release + default page', () => {
  it('renames (Reset re-roll goes through the same route)', async () => {
    const { app } = makeApp({
      store: { getPlatformSubdomain: vi.fn(async () => platformRow()) },
    })
    const res = await request(app)
      .put(`/api/workspaces/${WORKSPACE_ID}/subdomain`)
      .send({ label: 'grape209' })
    expect(res.status).toBe(200)
    expect(res.body.subdomain.hostname).toBe(`grape209.${CUSTOMER_APEX}`)
  })

  it('404s a rename when the workspace has no subdomain', async () => {
    const { app } = makeApp({ store: { getPlatformSubdomain: vi.fn(async () => null) } })
    const res = await request(app)
      .put(`/api/workspaces/${WORKSPACE_ID}/subdomain`)
      .send({ label: 'grape209' })
    expect(res.status).toBe(404)
  })

  it('releases the workspace subdomain', async () => {
    const { app, pageDomainStore } = makeApp({
      store: { getPlatformSubdomain: vi.fn(async () => platformRow()) },
    })
    const res = await request(app).delete(`/api/workspaces/${WORKSPACE_ID}/subdomain`)
    expect(res.status).toBe(200)
    expect(res.body.released).toBe(true)
    expect(pageDomainStore.releaseSubdomain).toHaveBeenCalledWith(USER_ID, 'pd_1')
  })

  it('sets a domain default page (workspace-validated in the store)', async () => {
    const { app, pageDomainStore } = makeApp({})
    const res = await request(app)
      .put(`/api/workspaces/${WORKSPACE_ID}/domains/pd_1/default-page`)
      .send({ pageId: PAGE_ID })
    expect(res.status).toBe(200)
    expect(res.body.domain.pageId).toBe(PAGE_ID)
    expect(pageDomainStore.setDefaultPage).toHaveBeenCalledWith(USER_ID, 'pd_1', PAGE_ID)
  })

  it('clears the default page on null and 400s a cross-workspace page', async () => {
    const { app } = makeApp({})
    const r1 = await request(app)
      .put(`/api/workspaces/${WORKSPACE_ID}/domains/pd_1/default-page`)
      .send({ pageId: null })
    expect(r1.status).toBe(200)
    expect(r1.body.domain.pageId).toBeNull()

    const { app: app2 } = makeApp({
      store: { setDefaultPage: vi.fn(async () => ({ error: 'page_not_in_workspace' })) },
    })
    const r2 = await request(app2)
      .put(`/api/workspaces/${WORKSPACE_ID}/domains/pd_1/default-page`)
      .send({ pageId: PAGE_ID })
    expect(r2.status).toBe(400)
    expect(r2.body.code).toBe('page_not_in_workspace')
  })
})
