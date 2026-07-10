/**
 * The computer-use SDK both surfaces ride — the Take-Over live view page
 * (`/w/[workspaceId]/computer/[sessionId]`) and the Session Management
 * settings section. Asserts the wire contract against `/api/computer/*`
 * (paths, methods, bodies) and the null/error mappings the UI branches on.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth-fetch', () => ({ authFetch: vi.fn() }))

import { authFetch } from '@/lib/auth-fetch'
import {
  completeComputerTask,
  getComputerFrame,
  getComputerTask,
  listBrowserSessions,
  markComputerSessionCaptured,
  resumeComputerTask,
  revokeBrowserSession,
  sendComputerInput,
} from '../computer'

const mockFetch = vi.mocked(authFetch)

function respond(status: number, body?: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response
}

beforeEach(() => {
  vi.clearAllMocks()
  mockFetch.mockResolvedValue(respond(200, {}))
})

describe('[COMP:app-web/sandbox-takeover] Take-Over live view SDK', () => {
  it('resolves the active task and maps 404 to null (the "no task" empty state)', async () => {
    mockFetch.mockResolvedValueOnce(
      respond(200, { taskId: 't1', status: 'running', injectedSite: null, workspaceId: 'w1', createdAt: 1 }),
    )
    const task = await getComputerTask('sess-1')
    expect(task?.status).toBe('running')
    expect(String(mockFetch.mock.calls[0][0])).toContain('/api/computer/tasks/sess-1')

    mockFetch.mockResolvedValueOnce(respond(404))
    expect(await getComputerTask('sess-1')).toBeNull()
  })

  it('resumes on arrival, polls frames, and forwards scaled input events', async () => {
    await resumeComputerTask('sess-1')
    expect(String(mockFetch.mock.calls[0][0])).toContain('/tasks/sess-1/resume')
    expect(mockFetch.mock.calls[0][1]).toMatchObject({ method: 'POST' })

    mockFetch.mockResolvedValueOnce(respond(200, { data: 'AAAA', mimeType: 'image/png' }))
    const frame = await getComputerFrame('sess-1')
    expect(frame).toEqual({ data: 'AAAA', mimeType: 'image/png' })

    mockFetch.mockResolvedValueOnce(respond(204))
    expect(await getComputerFrame('sess-1')).toBeNull()

    await sendComputerInput('sess-1', { kind: 'click', x: 10, y: 20 })
    const inputCall = mockFetch.mock.calls.at(-1)!
    expect(String(inputCall[0])).toContain('/tasks/sess-1/input')
    expect(JSON.parse(inputCall[1]!.body as string)).toEqual({ kind: 'click', x: 10, y: 20 })
  })

  it('captures the signed-in session and completes (close-to-stop) with the chosen outcome', async () => {
    await markComputerSessionCaptured('sess-1', 'github.com')
    const captured = mockFetch.mock.calls.at(-1)!
    expect(String(captured[0])).toContain('/tasks/sess-1/captured')
    expect(JSON.parse(captured[1]!.body as string)).toEqual({ site: 'github.com' })

    await completeComputerTask('sess-1', 'failed')
    const complete = mockFetch.mock.calls.at(-1)!
    expect(String(complete[0])).toContain('/tasks/sess-1/complete')
    expect(JSON.parse(complete[1]!.body as string)).toEqual({ outcome: 'failed' })
  })
})

describe('[COMP:app-web/session-management] Session Management SDK', () => {
  it('lists vaulted sessions scoped to the workspace', async () => {
    mockFetch.mockResolvedValueOnce(
      respond(200, {
        configured: true,
        sessions: [{ site: 'github.com', capturedAt: 'x', lastUsedAt: null, status: 'active' }],
      }),
    )
    const res = await listBrowserSessions('ws-1')
    expect(res.configured).toBe(true)
    expect(res.sessions[0].site).toBe('github.com')
    expect(String(mockFetch.mock.calls[0][0])).toContain('/api/computer/sessions?workspaceId=ws-1')
  })

  it('revokes by site with the workspace in the query', async () => {
    await revokeBrowserSession('ws-1', 'github.com')
    const call = mockFetch.mock.calls.at(-1)!
    expect(String(call[0])).toContain('/api/computer/sessions/github.com?workspaceId=ws-1')
    expect(call[1]).toMatchObject({ method: 'DELETE' })
  })
})
