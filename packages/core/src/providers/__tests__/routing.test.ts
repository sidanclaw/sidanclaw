import { describe, it, expect, vi } from 'vitest'
import { createRoutingProvider } from '../routing.js'
import type { LLMProvider, ProviderRequest, StreamChunk } from '../types.js'

function stubProvider(name: string, reply: string): LLMProvider & { seen: ProviderRequest[] } {
  const seen: ProviderRequest[] = []
  return {
    name,
    models: [],
    seen,
    async *stream(request) {
      seen.push(request)
      yield { type: 'message_start', model: request.model }
      yield { type: 'text_delta', text: reply }
      yield { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } }
    },
    createSession(opts) {
      return {
        send: (messages) => this.stream({ model: opts.model, systemPrompt: opts.systemPrompt, messages }),
      }
    },
  }
}

function failingProvider(name: string, status: number): LLMProvider {
  return {
    name,
    models: [],
    // eslint-disable-next-line require-yield
    async *stream() {
      const err = new Error(`${name} down`) as Error & { status?: number }
      err.status = status
      throw err
    },
    createSession(opts) {
      return { send: (messages) => this.stream({ model: opts.model, systemPrompt: opts.systemPrompt, messages }) }
    },
  }
}

async function text(stream: AsyncIterable<StreamChunk>): Promise<string> {
  let out = ''
  for await (const c of stream) if (c.type === 'text_delta') out += c.text
  return out
}

describe('[COMP:providers/routing-provider] dispatch', () => {
  it('routes each model id to its registry row provider', async () => {
    const gemini = stubProvider('gemini', 'from-gemini')
    const routing = createRoutingProvider({ gemini })
    await text(routing.stream({ model: 'gemini-3.5-flash', systemPrompt: '', messages: [] }))
    expect(gemini.seen[0]?.model).toBe('gemini-3.5-flash')
  })

  it('createSession dispatches on the session model', async () => {
    const gemini = stubProvider('gemini', 'hi')
    const routing = createRoutingProvider({ gemini })
    const session = routing.createSession({ model: 'gemini-3-flash-standard', systemPrompt: 's' })
    await text(session.send([{ role: 'user', content: 'x' }]))
    expect(gemini.seen[0]?.model).toBe('gemini-3-flash-standard')
  })

  it('fails loud on an unknown model id', () => {
    const routing = createRoutingProvider({ gemini: stubProvider('gemini', '') })
    expect(() => routing.stream({ model: 'not-a-registered-model', systemPrompt: '', messages: [] }))
      .toThrow(/unknown model id 'not-a-registered-model'/)
  })

  it('fails loud when the row provider is not configured (missing key)', () => {
    // claude-haiku-4-5 routes to 'anthropic', absent from the table.
    const routing = createRoutingProvider({ gemini: stubProvider('gemini', '') })
    expect(() => routing.stream({ model: 'claude-haiku-4-5', systemPrompt: '', messages: [] }))
      .toThrow(/provider 'anthropic'.*not configured/)
  })
})

describe('[COMP:providers/routing-provider] same-class fallback (L2)', () => {
  it('falls back standard-pro Gemini to Claude Haiku and emits the analytics event', async () => {
    const anthropic = stubProvider('anthropic', 'from-haiku')
    const onFallback = vi.fn()
    const routing = createRoutingProvider(
      { gemini: failingProvider('gemini', 503), anthropic },
      { analytics: { onFallback } },
    )

    const reply = await text(routing.stream({ model: 'gemini-flash-3', systemPrompt: '', messages: [] }))
    expect(reply).toBe('from-haiku')
    // The fallback request swaps to the fallback row's alias.
    expect(anthropic.seen[0]?.model).toBe('claude-haiku-4-5')
    expect(onFallback).toHaveBeenCalledWith(expect.objectContaining({
      primaryModel: 'gemini-flash-3',
      fallbackModel: 'claude-haiku-4-5',
    }))
  })

  it('a class with no same-class fallback surfaces the outage (never swaps class)', async () => {
    const anthropic = stubProvider('anthropic', 'from-haiku')
    const routing = createRoutingProvider({ gemini: failingProvider('gemini', 503), anthropic })
    // Max class: no fallbackAlias on the registry row — the 503 must surface
    // rather than silently serving a Max-billed turn on a standard-pro model.
    await expect(text(routing.stream({ model: 'gemini-3.5-flash', systemPrompt: '', messages: [] })))
      .rejects.toThrow(/gemini down/)
    expect(anthropic.seen).toHaveLength(0)
  })

  it('runs without fallback when the fallback provider is not configured', async () => {
    const routing = createRoutingProvider({ gemini: failingProvider('gemini', 503) })
    await expect(text(routing.stream({ model: 'gemini-flash-3', systemPrompt: '', messages: [] })))
      .rejects.toThrow(/gemini down/)
  })
})
