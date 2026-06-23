import { describe, it, expect } from 'vitest'

import { episodeEnvelopeSchema } from '../../../index.js'
import { normalizeWhatsappGroup } from '../normalize.js'
import type {
  WhatsappGroupWindow,
  WhatsappIngestContext,
  WhatsappMessage,
} from '../types.js'

function makeMessage(
  partial: Partial<WhatsappMessage> & { message_id: string; timestamp: number },
): WhatsappMessage {
  return partial
}

function makeCtx(partial: Partial<WhatsappIngestContext> = {}): WhatsappIngestContext {
  return {
    workspace_id: 'ws-1',
    user_id: 'u-1',
    assistant_id: null,
    created_by_user_id: 'u-1',
    created_by_assistant_id: null,
    ...partial,
  }
}

const GROUP = '120363000000000000@g.us'
const ALICE = '111@s.whatsapp.net'
const BOB = '222@s.whatsapp.net'

function makeWindow(overrides: Partial<WhatsappGroupWindow> = {}): WhatsappGroupWindow {
  return {
    chat_jid: GROUP,
    subject: 'Team room',
    messages: [],
    ...overrides,
  }
}

describe('[COMP:brain/source-adapters/whatsapp] WhatsApp group normalizer', () => {
  it('round-trips a basic window through the envelope schema as a channel_window', () => {
    const window = makeWindow({
      messages: [
        makeMessage({ message_id: 'm1', sender_jid: ALICE, text: 'hi', timestamp: 1_700_000_000_000 }),
        makeMessage({ message_id: 'm2', sender_jid: BOB, text: 'hello', timestamp: 1_700_000_010_000 }),
        makeMessage({ message_id: 'm3', sender_jid: ALICE, text: 'thanks', timestamp: 1_700_000_020_000 }),
      ],
    })

    const env = normalizeWhatsappGroup(window, makeCtx())

    expect(env.source_kind).toBe('channel_window')
    expect(env.source_ref).toEqual({
      source_kind: 'channel_window',
      channel_id: GROUP,
      window_start: new Date(1_700_000_000_000),
      window_end: new Date(1_700_000_020_000),
      message_count: 3,
    })
    expect(env.occurred_at).toEqual(new Date(1_700_000_000_000))
    // Validates at the Pipeline B trust boundary.
    expect(() => episodeEnvelopeSchema.parse(env)).not.toThrow()
  })

  it('attributes per real sender — distinct actors, never one smeared user', () => {
    const window = makeWindow({
      messages: [
        makeMessage({ message_id: 'm1', sender_jid: ALICE, text: 'a', timestamp: 1 }),
        makeMessage({ message_id: 'm2', sender_jid: BOB, text: 'b', timestamp: 2 }),
        makeMessage({ message_id: 'm3', sender_jid: ALICE, text: 'c', timestamp: 3 }),
      ],
    })

    const env = normalizeWhatsappGroup(window, makeCtx())

    // Deduped to the two distinct participants, in first-seen order.
    expect(env.actors).toEqual([
      { role: 'sender', external_id: ALICE },
      { role: 'sender', external_id: BOB },
    ])
  })

  it('skips bots / own-number messages from actors', () => {
    const window = makeWindow({
      messages: [
        makeMessage({ message_id: 'm1', sender_jid: ALICE, text: 'a', timestamp: 1 }),
        makeMessage({ message_id: 'm2', sender_jid: '999@s.whatsapp.net', text: 'auto', timestamp: 2, is_bot: true }),
      ],
    })

    const env = normalizeWhatsappGroup(window, makeCtx())

    expect(env.actors).toEqual([{ role: 'sender', external_id: ALICE }])
  })

  it('threads the ingest context onto the envelope', () => {
    const window = makeWindow({
      messages: [makeMessage({ message_id: 'm1', sender_jid: ALICE, text: 'a', timestamp: 1 })],
    })

    const env = normalizeWhatsappGroup(
      window,
      makeCtx({ user_id: 'owner-1', created_by_user_id: 'owner-1', workspace_id: 'ws-9' }),
    )

    expect(env.workspace_id).toBe('ws-9')
    expect(env.user_id).toBe('owner-1')
    expect(env.created_by_user_id).toBe('owner-1')
  })
})
