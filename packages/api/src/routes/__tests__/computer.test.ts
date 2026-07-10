import { describe, it, expect, beforeEach } from 'vitest'
import request from 'supertest'
import { createTestApp } from './helpers.js'
import { computerRoutes } from '../computer.js'
import {
  StubSandboxProvider,
  createCloudBrowserProvider,
  createInMemorySandboxTaskStore,
  createSandboxOrchestrator,
  type SessionBundle,
  type SessionVault,
} from '@sidanclaw/core'

function memoryVault(): SessionVault & { bundles: Map<string, SessionBundle> } {
  const bundles = new Map<string, SessionBundle>()
  const key = (p: { userId: string; workspaceId: string; site: string }) =>
    `${p.userId}:${p.workspaceId}:${p.site}`
  return {
    bundles,
    async get(p) {
      return bundles.get(key(p)) ?? null
    },
    async put(p) {
      bundles.set(key(p), p.bundle)
    },
    async markDead() {},
    async touch() {},
    async list(p) {
      return [...bundles.entries()]
        .filter(([k]) => k.startsWith(`${p.userId}:${p.workspaceId}:`))
        .map(([k, b]) => ({
          site: k.split(':')[2],
          capturedAt: b.capturedAt,
          lastUsedAt: null,
          status: 'active' as const,
        }))
    },
    async revoke(p) {
      bundles.delete(key(p))
    },
  }
}

describe('[COMP:routes/computer] Take-Over live view + Session Management routes', () => {
  let provider: StubSandboxProvider
  let orchestrator: ReturnType<typeof createSandboxOrchestrator>
  let vault: ReturnType<typeof memoryVault>
  let app: ReturnType<typeof createTestApp>

  beforeEach(async () => {
    provider = new StubSandboxProvider()
    vault = memoryVault()
    orchestrator = createSandboxOrchestrator({
      provider,
      taskStore: createInMemorySandboxTaskStore(),
      vault,
    })
    // Start a cloud task for user-1's chat session the way the tools would.
    const browser = createCloudBrowserProvider({ provider, binding: orchestrator.binding })
    await browser.navigate(
      { userId: 'user-1', workspaceId: 'ws-1', sessionId: 'sess-1' },
      'https://github.com/notifications',
    )
    app = createTestApp(
      '/api/computer',
      computerRoutes({ orchestrator, provider, vault }),
      { userId: 'user-1' },
    )
  })

  it('returns the active task for its owner and 404 for a session with none', async () => {
    const ok = await request(app).get('/api/computer/tasks/sess-1')
    expect(ok.status).toBe(200)
    expect(ok.body).toMatchObject({ status: 'running', workspaceId: 'ws-1' })

    const none = await request(app).get('/api/computer/tasks/sess-9')
    expect(none.status).toBe(404)
  })

  it('hides another user\'s task (ownership check)', async () => {
    const stranger = createTestApp(
      '/api/computer',
      computerRoutes({ orchestrator, provider, vault }),
      { userId: 'intruder' },
    )
    const res = await request(stranger).get('/api/computer/tasks/sess-1')
    expect(res.status).toBe(404)
  })

  it('serves screencast frames and relays takeover input (§4.8)', async () => {
    const frame = await request(app).get('/api/computer/tasks/sess-1/frame')
    expect(frame.status).toBe(200)
    expect(frame.body.mimeType).toBe('image/png')
    expect(typeof frame.body.data).toBe('string')

    const input = await request(app)
      .post('/api/computer/tasks/sess-1/input')
      .send({ kind: 'click', x: 100, y: 60 })
    expect(input.status).toBe(200)

    const bad = await request(app)
      .post('/api/computer/tasks/sess-1/input')
      .send({ kind: 'teleport' })
    expect(bad.status).toBe(400)

    const task = await orchestrator.getActiveTask('sess-1')
    const ops = provider.sandboxes.get(task!.sandboxId)?.actions.map((a) => a.op)
    expect(ops).toContain('takeoverInput')
  })

  it('captures the signed-in session to the vault ("I signed in", §4.4)', async () => {
    const res = await request(app)
      .post('/api/computer/tasks/sess-1/captured')
      .send({ site: 'github.com' })
    expect(res.status).toBe(200)
    expect(vault.bundles.get('user-1:ws-1:github.com')).toBeTruthy()
  })

  it('resume + complete drive the task lifecycle (close-to-stop)', async () => {
    await orchestrator.pauseForTakeover('sess-1')
    const resumed = await request(app).post('/api/computer/tasks/sess-1/resume')
    expect(resumed.status).toBe(200)
    expect((await orchestrator.getActiveTask('sess-1'))?.status).toBe('running')

    const done = await request(app)
      .post('/api/computer/tasks/sess-1/complete')
      .send({ outcome: 'failed' })
    expect(done.status).toBe(200)
    expect(await orchestrator.getActiveTask('sess-1')).toBeNull()
  })

  it('lists and revokes vaulted sessions (Session Management, §4.10)', async () => {
    await vault.put({
      userId: 'user-1',
      workspaceId: 'ws-1',
      site: 'github.com',
      bundle: { site: 'github.com', cookies: [], capturedAt: new Date().toISOString() },
    })
    const list = await request(app).get('/api/computer/sessions?workspaceId=ws-1')
    expect(list.status).toBe(200)
    expect(list.body.sessions).toEqual([expect.objectContaining({ site: 'github.com' })])

    const revoked = await request(app).delete('/api/computer/sessions/github.com?workspaceId=ws-1')
    expect(revoked.status).toBe(200)
    expect(vault.bundles.size).toBe(0)

    const missing = await request(app).get('/api/computer/sessions')
    expect(missing.status).toBe(400)
  })

  it('answers honestly when no orchestrator/vault is configured', async () => {
    const dark = createTestApp(
      '/api/computer',
      computerRoutes({ orchestrator: null, provider: null, vault: null }),
      { userId: 'user-1' },
    )
    expect((await request(dark).get('/api/computer/tasks/sess-1')).status).toBe(404)
    const sessions = await request(dark).get('/api/computer/sessions?workspaceId=ws-1')
    expect(sessions.status).toBe(200)
    expect(sessions.body).toEqual({ configured: false, sessions: [] })
  })
})
