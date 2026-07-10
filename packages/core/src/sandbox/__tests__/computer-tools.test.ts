import { describe, it, expect } from 'vitest'
import { createComputerTools, SEND_LIKE_LABEL_PATTERN } from '../tools.js'
import { createLocalBrowserProvider } from '../local-browser-provider.js'
import type { Tool, ToolContext } from '../../tools/types.js'
import type { BrowserProvider, RelayCommandResult } from '../types.js'

function toolContext(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    userId: 'user-1',
    assistantId: 'asst-1',
    sessionId: 'sess-1',
    appId: 'app-1',
    channelType: 'web',
    channelId: 'chan-1',
    workspaceId: 'ws-1',
    abortSignal: new AbortController().signal,
    ...overrides,
  }
}

/** A fake BrowserProvider that records calls and serves a scripted snapshot. */
function fakeProvider(kind: 'local' | 'cloud'): BrowserProvider & { calls: string[] } {
  const calls: string[] = []
  return {
    kind,
    calls,
    async navigate(_ctx, url) {
      calls.push(`navigate:${url}`)
      return { url }
    },
    async snapshot() {
      calls.push('snapshot')
      return {
        url: 'https://www.linkedin.com/messaging/',
        title: 'Messaging',
        nodes: [
          { ref: '@e1', role: 'textbox', name: 'Write a message' },
          { ref: '@e2', role: 'button', name: 'Send' },
          { ref: '@e3', role: 'link', name: 'Jane Doe' },
        ],
      }
    },
    async click(_ctx, ref) {
      calls.push(`click:${ref}`)
    },
    async type(_ctx, ref, text) {
      calls.push(`type:${ref}:${text}`)
    },
    async currentUrl() {
      calls.push('currentUrl')
      return { url: 'https://www.linkedin.com/messaging/', title: 'Messaging' }
    },
    async stop() {
      calls.push('stop')
    },
  }
}

async function run(tool: Tool, input: Record<string, unknown>, ctx = toolContext()) {
  return tool.execute(tool.inputSchema.parse(input), ctx)
}

describe('[COMP:sandbox/browser-tools] Computer tool surface', () => {
  it('routes navigate per site: LinkedIn → local extension, public → cloud (same tool surface, §4.15)', async () => {
    const local = fakeProvider('local')
    const cloud = fakeProvider('cloud')
    const tools = createComputerTools({ local, cloud, cloudAvailable: () => true })

    await run(tools.browserNavigate, { url: 'https://www.linkedin.com/messaging/' })
    expect(local.calls).toEqual(['navigate:https://www.linkedin.com/messaging/'])
    expect(cloud.calls).toEqual([])

    await run(tools.browserNavigate, { url: 'https://news.ycombinator.com/' }, toolContext({ sessionId: 'sess-2' }))
    expect(cloud.calls).toEqual(['navigate:https://news.ycombinator.com/'])
  })

  it('keeps follow-up ops on the backend the last navigation picked', async () => {
    const local = fakeProvider('local')
    const cloud = fakeProvider('cloud')
    const tools = createComputerTools({ local, cloud, cloudAvailable: () => true })
    await run(tools.browserNavigate, { url: 'https://www.linkedin.com/messaging/' })
    await run(tools.browserSnapshot, {})
    await run(tools.browserType, { ref: '@e1', text: 'hello' })
    expect(local.calls).toEqual([
      'navigate:https://www.linkedin.com/messaging/',
      'snapshot',
      'type:@e1:hello',
    ])
    expect(cloud.calls).toEqual([])
  })

  it('serializes tool calls to P1.2 relay command envelopes through the local provider', async () => {
    const sent: Array<{ userId: string; op: string; args?: Record<string, unknown> }> = []
    const local = createLocalBrowserProvider({
      transport: {
        async send(params) {
          sent.push(params)
          const responses: Record<string, RelayCommandResult> = {
            navigate: { ok: true, data: { url: 'https://www.linkedin.com/messaging/' } },
            snapshot: {
              ok: true,
              data: { url: 'https://x.test/', title: 't', nodes: [{ ref: '@e1', role: 'button', name: 'Send' }] },
            },
            type: { ok: true },
            currentUrl: { ok: true, data: { url: 'https://x.test/', title: 't' } },
          }
          return responses[params.op] ?? { ok: true }
        },
      },
    })
    const tools = createComputerTools({ local, cloud: fakeProvider('cloud') })
    await run(tools.browserNavigate, { url: 'https://www.linkedin.com/messaging/' })
    await run(tools.browserSnapshot, {})
    await run(tools.browserType, { ref: '@e1', text: 'hi there' })
    await run(tools.browserCurrentUrl, {})
    expect(sent.map((s) => s.op)).toEqual(['navigate', 'snapshot', 'type', 'currentUrl'])
    expect(sent[0]).toMatchObject({ userId: 'user-1', args: { url: 'https://www.linkedin.com/messaging/' } })
    expect(sent[2]).toMatchObject({ args: { ref: '@e1', text: 'hi there' } })
  })

  it('surfaces the clear no-extension error through the tool result (P1.4)', async () => {
    const local = createLocalBrowserProvider({
      transport: { send: async () => ({ ok: false, error: 'none', code: 'no_extension' }) },
    })
    const tools = createComputerTools({ local, cloud: fakeProvider('cloud') })
    const res = await run(tools.browserSnapshot, {})
    expect(res.isError).toBe(true)
    expect(String(res.data)).toContain('sidanclaw extension')
    expect(res.meta?.code).toBe('no_extension')
  })

  it('renders the snapshot as a token-cheap ref list and caches labels for the send gate', async () => {
    const tools = createComputerTools({ local: fakeProvider('local'), cloud: fakeProvider('cloud') })
    const res = await run(tools.browserSnapshot, {})
    expect(String(res.data)).toContain('@e2 button "Send"')
    expect(String(res.data)).toContain('URL: https://www.linkedin.com/messaging/')
  })

  describe('send gate (P1.7 / §8 no unattended state-change)', () => {
    async function gateFor(input: { ref: string; intent?: string }, snapshotFirst = true) {
      const tools = createComputerTools({ local: fakeProvider('local'), cloud: fakeProvider('cloud') })
      const ctx = toolContext()
      if (snapshotFirst) await run(tools.browserSnapshot, {}, ctx)
      return {
        needsConfirmation: await tools.browserClick.resolveConfirmation!(ctx, input),
        tools,
        ctx,
      }
    }

    it('gates a click on a send-like label (the "Send" button) even without a declared intent', async () => {
      const { needsConfirmation } = await gateFor({ ref: '@e2' })
      expect(needsConfirmation).toBe(true)
    })

    it('gates any click the model declares intent:"submit" for', async () => {
      const { needsConfirmation } = await gateFor({ ref: '@e3', intent: 'submit' })
      expect(needsConfirmation).toBe(true)
    })

    it('does not gate composing clicks (opening a thread by a person link)', async () => {
      const { needsConfirmation } = await gateFor({ ref: '@e3' })
      expect(needsConfirmation).toBe(false)
    })

    it('fails closed: an unknown ref (no snapshot cached) requires confirmation', async () => {
      const { needsConfirmation } = await gateFor({ ref: '@e9' }, false)
      expect(needsConfirmation).toBe(true)
    })

    it('previews the send with the target label and the last typed message', async () => {
      const tools = createComputerTools({ local: fakeProvider('local'), cloud: fakeProvider('cloud') })
      const ctx = toolContext()
      await run(tools.browserSnapshot, {}, ctx)
      await run(tools.browserType, { ref: '@e1', text: 'Hey Jane, congrats on the launch!' }, ctx)
      const lines = await tools.browserClick.describeConfirmation!({ ref: '@e2' }, ctx)
      expect(lines?.[0]).toBe('Click "Send" in the browser')
      expect(lines?.[1]).toContain('Hey Jane, congrats on the launch!')
    })

    it('the pattern covers the spec verbs', () => {
      for (const label of ['Send', 'Post now', 'Submit order', 'Buy', 'Pay', 'Confirm', 'Delete message', 'Apply']) {
        expect(SEND_LIKE_LABEL_PATTERN.test(label)).toBe(true)
      }
      for (const label of ['Write a message', 'Jane Doe', 'Open thread', 'Search']) {
        expect(SEND_LIKE_LABEL_PATTERN.test(label)).toBe(false)
      }
    })
  })

  describe('autonomous-path hard block (Barrier 2 default posture)', () => {
    it('refuses every browser tool on a headless channel when unattended mode is off', async () => {
      const local = fakeProvider('local')
      const tools = createComputerTools({ local, cloud: fakeProvider('cloud') })
      const cronCtx = toolContext({ channelType: 'workflow' })
      for (const tool of [tools.browserNavigate, tools.browserSnapshot, tools.browserClick, tools.browserType, tools.browserCurrentUrl]) {
        const res = await tool.execute(
          tool.inputSchema.parse(
            tool.name === 'browserNavigate'
              ? { url: 'https://example.com/' }
              : tool.name === 'browserClick'
                ? { ref: '@e1' }
                : tool.name === 'browserType'
                  ? { ref: '@e1', text: 'x' }
                  : {},
          ),
          cronCtx,
        )
        expect(res.isError).toBe(true)
        expect(String(res.data)).toContain('autonomous')
      }
      expect(local.calls).toEqual([])
    })

    it('allows headless browsing only when unattended computer-use is enabled (metering-gated at boot)', async () => {
      const local = fakeProvider('local')
      const tools = createComputerTools({
        local,
        cloud: fakeProvider('cloud'),
        unattendedEnabled: () => true,
      })
      const res = await run(tools.browserSnapshot, {}, toolContext({ channelType: 'workflow' }))
      expect(res.isError).toBeUndefined()
      expect(local.calls).toEqual(['snapshot'])
    })
  })

  describe('safety fuse (P1.8)', () => {
    it('caps per-session browser calls', async () => {
      const tools = createComputerTools({
        local: fakeProvider('local'),
        cloud: fakeProvider('cloud'),
        fuse: { maxCallsPerSession: 2 },
      })
      const ctx = toolContext()
      await run(tools.browserSnapshot, {}, ctx)
      await run(tools.browserCurrentUrl, {}, ctx)
      const res = await run(tools.browserSnapshot, {}, ctx)
      expect(res.isError).toBe(true)
      expect(String(res.data)).toContain('safety cap')
    })

    it('caps per-session wall clock', async () => {
      let t = 1_000_000
      const tools = createComputerTools({
        local: fakeProvider('local'),
        cloud: fakeProvider('cloud'),
        fuse: { maxWallMsPerSession: 60_000 },
        now: () => t,
      })
      const ctx = toolContext()
      await run(tools.browserSnapshot, {}, ctx)
      t += 61_000
      const res = await run(tools.browserCurrentUrl, {}, ctx)
      expect(res.isError).toBe(true)
      expect(String(res.data)).toContain('wall-clock')
    })
  })

  describe('L1/L2 policy hook', () => {
    it('block policy refuses execution with a pointer to the settings surface', async () => {
      const tools = createComputerTools({
        local: fakeProvider('local'),
        cloud: fakeProvider('cloud'),
        resolvePolicy: async () => 'block',
      })
      const res = await run(tools.browserNavigate, { url: 'https://example.com/' })
      expect(res.isError).toBe(true)
      expect(String(res.data)).toContain('blocked by tool policy')
    })

    it('ask policy forces confirmation on any browser tool', async () => {
      const tools = createComputerTools({
        local: fakeProvider('local'),
        cloud: fakeProvider('cloud'),
        resolvePolicy: async () => 'ask',
      })
      expect(await tools.browserType.resolveConfirmation!(toolContext(), { ref: '@e1', text: 'x' })).toBe(true)
    })
  })

  it('rejects non-http(s) URLs before touching any backend', async () => {
    const local = fakeProvider('local')
    const tools = createComputerTools({ local, cloud: fakeProvider('cloud') })
    const res = await run(tools.browserNavigate, { url: 'file:///etc/passwd' })
    expect(res.isError).toBe(true)
    expect(local.calls).toEqual([])
  })

  it('audits every action as a metadata-only event (op + backend + host, no content)', async () => {
    const events: Array<Record<string, unknown>> = []
    const tools = createComputerTools({
      local: fakeProvider('local'),
      cloud: fakeProvider('cloud'),
      onEvent: (evt) => void events.push(evt as unknown as Record<string, unknown>),
    })
    const ctx = toolContext()
    await run(tools.browserNavigate, { url: 'https://www.linkedin.com/messaging/' }, ctx)
    await run(tools.browserSnapshot, {}, ctx)
    await run(tools.browserType, { ref: '@e1', text: 'SECRET DRAFT' }, ctx)
    expect(events).toHaveLength(3)
    expect(events[0]).toMatchObject({ op: 'navigate', backend: 'local', host: 'www.linkedin.com', ok: true })
    // No event ever carries typed text or page content.
    expect(JSON.stringify(events)).not.toContain('SECRET DRAFT')
  })
})
