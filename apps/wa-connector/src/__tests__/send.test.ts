import { describe, it, expect } from 'vitest'
import { sendSchema, buildSendContent } from '../routes/send.js'

describe('[COMP:wa-connector/send] Outbound send route', () => {
  describe('schema validation', () => {
    it('accepts a text body', () => {
      const r = sendSchema.safeParse({ jid: '123@s.whatsapp.net', text: 'hi' })
      expect(r.success).toBe(true)
    })

    it('accepts a media (video) body', () => {
      const r = sendSchema.safeParse({
        jid: '123@s.whatsapp.net',
        media: { url: 'https://example.com/clip.mp4', type: 'video', mimetype: 'video/mp4', caption: 'Highlight 1' },
      })
      expect(r.success).toBe(true)
    })

    it('rejects a body with neither text nor media', () => {
      const r = sendSchema.safeParse({ jid: '123@s.whatsapp.net' })
      expect(r.success).toBe(false)
    })

    it('rejects a media body with a non-URL url', () => {
      const r = sendSchema.safeParse({
        jid: '123@s.whatsapp.net',
        media: { url: 'not-a-url', type: 'video' },
      })
      expect(r.success).toBe(false)
    })

    it('rejects an unknown media type', () => {
      const r = sendSchema.safeParse({
        jid: '123@s.whatsapp.net',
        media: { url: 'https://example.com/x', type: 'audio' },
      })
      expect(r.success).toBe(false)
    })
  })

  describe('buildSendContent', () => {
    it('builds a text content', () => {
      const c = buildSendContent({ jid: 'j', text: 'hello' }) as { text: string }
      expect(c).toEqual({ text: 'hello' })
    })

    it('builds a video content addressed by URL with a default mimetype', () => {
      const c = buildSendContent({
        jid: 'j',
        media: { url: 'https://example.com/clip.mp4', type: 'video', caption: 'cap' },
      }) as { video: { url: string }; mimetype: string; caption: string }
      expect(c.video).toEqual({ url: 'https://example.com/clip.mp4' })
      expect(c.mimetype).toBe('video/mp4')
      expect(c.caption).toBe('cap')
    })

    it('builds an image content without a caption when none given', () => {
      const c = buildSendContent({
        jid: 'j',
        media: { url: 'https://example.com/p.jpg', type: 'image' },
      }) as Record<string, unknown>
      expect(c.image).toEqual({ url: 'https://example.com/p.jpg' })
      expect('caption' in c).toBe(false)
    })

    it('builds a document content with fileName and mimetype fallbacks', () => {
      const c = buildSendContent({
        jid: 'j',
        media: { url: 'https://example.com/f', type: 'document' },
      }) as { document: { url: string }; mimetype: string; fileName: string }
      expect(c.document).toEqual({ url: 'https://example.com/f' })
      expect(c.mimetype).toBe('application/octet-stream')
      expect(c.fileName).toBe('file')
    })

    it('attaches quoted context when quotedMessageId is present', () => {
      const c = buildSendContent({
        jid: 'j',
        text: 'reply',
        quotedMessageId: 'm1',
      }) as unknown as { quoted: { key: { id: string; remoteJid: string } } }
      expect(c.quoted).toEqual({ key: { id: 'm1', remoteJid: 'j' } })
    })
  })
})
