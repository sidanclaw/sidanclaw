import { describe, it, expect, vi } from 'vitest'
import { buildWhatsappListenerHandler } from '../whatsapp-listener-handler.js'
import type { WhatsappIngestor } from '../../ingest/whatsapp-ingest.js'

function fakeIngestor(): WhatsappIngestor & { ingest: ReturnType<typeof vi.fn> } {
  return {
    ingest: vi.fn().mockResolvedValue({ episodeId: 'e_1' }),
    isIngestChannel: vi.fn().mockResolvedValue(true),
  } as never
}

const groupInput = {
  channelId: 'a_1',
  chatJid: '120@g.us',
  senderJid: '5678@s.whatsapp.net',
  senderName: 'Alice',
  messageId: 'msg_1',
  text: 'hello team',
  timestamp: 1_700_000_000_000,
  isGroup: true,
}

describe('[COMP:api/whatsapp-ingest] WhatsApp ListenerHandler builder', () => {
  it('returns a listener handler for a group message that forwards to the ingestor', async () => {
    const ingestor = fakeIngestor()
    const handler = buildWhatsappListenerHandler(ingestor, groupInput)

    expect(handler).not.toBeNull()
    expect(handler!.kind).toBe('listener')

    await handler!.handle()
    expect(ingestor.ingest).toHaveBeenCalledOnce()
    expect(ingestor.ingest).toHaveBeenCalledWith(groupInput)
  })

  it('returns null for a non-group (DM) message — nothing is ingested', () => {
    const ingestor = fakeIngestor()
    const handler = buildWhatsappListenerHandler(ingestor, { ...groupInput, isGroup: false })
    expect(handler).toBeNull()
    expect(ingestor.ingest).not.toHaveBeenCalled()
  })

  it('returns null when no ingestor is configured', () => {
    expect(buildWhatsappListenerHandler(undefined, groupInput)).toBeNull()
  })

  it('handle() resolves even though ingest returns a value (dispatcher ignores it)', async () => {
    const ingestor = fakeIngestor()
    const handler = buildWhatsappListenerHandler(ingestor, groupInput)
    await expect(handler!.handle()).resolves.toBeUndefined()
  })
})
