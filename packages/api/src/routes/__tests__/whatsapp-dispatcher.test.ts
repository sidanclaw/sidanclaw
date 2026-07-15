import { describe, it, expect, vi } from 'vitest'
import {
  selectHandlers,
  runHandlers,
  type WhatsAppCapabilities,
  type WhatsAppHandler,
} from '../whatsapp-dispatcher.js'

function fakeHandler(
  kind: WhatsAppHandler['kind'],
  impl?: () => Promise<void>,
): WhatsAppHandler & { calls: number } {
  const h = {
    kind,
    calls: 0,
    async handle() {
      h.calls++
      if (impl) await impl()
    },
  }
  return h
}

describe('[COMP:api/whatsapp-dispatcher] WhatsApp inbound dispatcher', () => {
  describe('selectHandlers (additive capability fan-out)', () => {
    const caps = (listener: boolean, bot: boolean): WhatsAppCapabilities => ({
      listener,
      bot,
    })

    it('listener-only capability selects only the listener', () => {
      const listener = fakeHandler('listener')
      const bot = fakeHandler('bot')
      const out = selectHandlers(caps(true, false), { listener, bot })
      expect(out).toEqual([listener])
    })

    it('bot-only capability selects only the bot', () => {
      const listener = fakeHandler('listener')
      const bot = fakeHandler('bot')
      const out = selectHandlers(caps(false, true), { listener, bot })
      expect(out).toEqual([bot])
    })

    it('dual mode selects both, listener before bot', () => {
      const listener = fakeHandler('listener')
      const bot = fakeHandler('bot')
      const out = selectHandlers(caps(true, true), { listener, bot })
      expect(out).toEqual([listener, bot])
    })

    it('no capability selects nothing', () => {
      const listener = fakeHandler('listener')
      const bot = fakeHandler('bot')
      expect(selectHandlers(caps(false, false), { listener, bot })).toEqual([])
    })

    it('a capability with no registered handler is skipped, not errored', () => {
      const listener = fakeHandler('listener')
      // bot capability is on but the registry slot is null (Phase 1 state).
      const out = selectHandlers(caps(true, true), { listener, bot: null })
      expect(out).toEqual([listener])
    })
  })

  describe('runHandlers (parallel, isolated failures)', () => {
    it('runs every selected handler', async () => {
      const a = fakeHandler('listener')
      const b = fakeHandler('bot')
      await runHandlers([a, b])
      expect(a.calls).toBe(1)
      expect(b.calls).toBe(1)
    })

    it('isolates a throwing handler so siblings still run', async () => {
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      const boom = fakeHandler('listener', async () => {
        throw new Error('ingest blew up')
      })
      const ok = fakeHandler('bot')

      await expect(runHandlers([boom, ok])).resolves.toBeUndefined()
      expect(boom.calls).toBe(1)
      expect(ok.calls).toBe(1)
      expect(errSpy).toHaveBeenCalledWith(
        expect.stringContaining('listener handler failed'),
        expect.any(Error),
      )
      errSpy.mockRestore()
    })

    it('runs handlers concurrently, not sequentially', async () => {
      const order: string[] = []
      const slow = fakeHandler('listener', async () => {
        await new Promise((r) => setTimeout(r, 20))
        order.push('slow')
      })
      const fast = fakeHandler('bot', async () => {
        order.push('fast')
      })
      await runHandlers([slow, fast])
      // Fast finishes first despite being second → they ran concurrently.
      expect(order).toEqual(['fast', 'slow'])
    })
  })
})
