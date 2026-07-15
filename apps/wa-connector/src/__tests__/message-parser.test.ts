import { describe, it, expect, vi } from 'vitest'

// Force fallback normalizers by making Baileys exports undefined
vi.mock('@whiskeysockets/baileys', () => ({
  extractMessageContent: undefined,
  getContentType: undefined,
  normalizeMessageContent: undefined,
}))

import {
  extractText,
  extractMediaPlaceholder,
  extractMediaInfo,
  describeReplyContext,
  extractMentionedJids,
  isDownloadableMedia,
} from '../message-parser'

describe('[COMP:wa-connector/message-parser] Message parser', () => {
  // ── extractText ──

  describe('extractText', () => {
    it('extracts text from conversation message', () => {
      const msg = { conversation: 'Hello world' }
      expect(extractText(msg as any)).toBe('Hello world')
    })

    it('extracts text from extended text message', () => {
      const msg = { extendedTextMessage: { text: 'Extended hello' } }
      expect(extractText(msg as any)).toBe('Extended hello')
    })

    it('extracts caption from image message', () => {
      const msg = { imageMessage: { caption: 'Photo caption', mimetype: 'image/jpeg' } }
      expect(extractText(msg as any)).toBe('Photo caption')
    })

    it('extracts text through ephemeral wrapper', () => {
      const msg = { ephemeralMessage: { message: { conversation: 'Ephemeral text' } } }
      expect(extractText(msg as any)).toBe('Ephemeral text')
    })

    it('returns undefined for empty message', () => {
      expect(extractText(undefined)).toBeUndefined()
      expect(extractText({} as any)).toBeUndefined()
    })
  })

  // ── extractMediaPlaceholder ──

  describe('extractMediaPlaceholder', () => {
    it('returns <media:image> for image messages', () => {
      expect(extractMediaPlaceholder({ imageMessage: {} } as any)).toBe('<media:image>')
    })

    it('returns <media:video> for video messages', () => {
      expect(extractMediaPlaceholder({ videoMessage: {} } as any)).toBe('<media:video>')
    })

    it('returns <media:audio> for audio messages', () => {
      expect(extractMediaPlaceholder({ audioMessage: {} } as any)).toBe('<media:audio>')
    })

    it('returns undefined for non-media', () => {
      expect(extractMediaPlaceholder({ conversation: 'text' } as any)).toBeUndefined()
    })
  })

  // ── extractMediaInfo ──

  describe('extractMediaInfo', () => {
    it('tags each media kind with its mediaType', () => {
      expect(extractMediaInfo({ imageMessage: { mimetype: 'image/png' } } as any)).toMatchObject({
        mediaType: 'image',
        mimeType: 'image/png',
      })
      expect(extractMediaInfo({ videoMessage: {} } as any)).toMatchObject({
        mediaType: 'video',
        mimeType: 'video/mp4',
      })
      expect(
        extractMediaInfo({ documentMessage: { fileName: 'a.pdf', mimetype: 'application/pdf' } } as any),
      ).toMatchObject({ mediaType: 'document', fileName: 'a.pdf' })
    })

    it('marks a ptt audio message as a voice note', () => {
      expect(
        extractMediaInfo({ audioMessage: { mimetype: 'audio/ogg; codecs=opus', ptt: true } } as any),
      ).toMatchObject({ mediaType: 'audio', isVoiceNote: true })
    })

    it('marks a non-ptt audio message as an audio file', () => {
      expect(extractMediaInfo({ audioMessage: { mimetype: 'audio/mpeg' } } as any)).toMatchObject({
        mediaType: 'audio',
        isVoiceNote: false,
      })
    })

    it('returns null for non-media', () => {
      expect(extractMediaInfo({ conversation: 'text' } as any)).toBeNull()
    })
  })

  // ── describeReplyContext ──

  describe('describeReplyContext', () => {
    it('returns null when no quoted message', () => {
      expect(describeReplyContext({ conversation: 'hello' } as any)).toBeNull()
    })

    it('extracts reply context with quoted text', () => {
      const msg = {
        extendedTextMessage: {
          text: 'Reply',
          contextInfo: {
            stanzaId: 'quoted_123',
            participant: 'sender@s.whatsapp.net',
            quotedMessage: { conversation: 'Original message' },
          },
        },
      }
      const ctx = describeReplyContext(msg as any)
      expect(ctx).toEqual({
        id: 'quoted_123',
        body: 'Original message',
        senderJid: 'sender@s.whatsapp.net',
      })
    })
  })

  // ── extractMentionedJids ──

  describe('extractMentionedJids', () => {
    it('returns mentioned JIDs from extended text', () => {
      const msg = {
        extendedTextMessage: {
          text: '@user hello',
          contextInfo: { mentionedJid: ['user@s.whatsapp.net'] },
        },
      }
      expect(extractMentionedJids(msg as any)).toEqual(['user@s.whatsapp.net'])
    })

    it('returns undefined when no mentions', () => {
      expect(extractMentionedJids({ conversation: 'hello' } as any)).toBeUndefined()
    })
  })

  // ── isDownloadableMedia ──

  describe('isDownloadableMedia', () => {
    it('returns true for image, video, document, sticker', () => {
      expect(isDownloadableMedia({ imageMessage: {} } as any)).toBe(true)
      expect(isDownloadableMedia({ videoMessage: {} } as any)).toBe(true)
      expect(isDownloadableMedia({ documentMessage: {} } as any)).toBe(true)
      expect(isDownloadableMedia({ stickerMessage: {} } as any)).toBe(true)
    })

    it('returns true for audio (voice-transcription preflight downloads audio)', () => {
      expect(isDownloadableMedia({ audioMessage: {} } as any)).toBe(true)
      expect(isDownloadableMedia({ audioMessage: { ptt: true } } as any)).toBe(true)
    })

    it('returns false for plain-text-only messages', () => {
      expect(isDownloadableMedia({ conversation: 'hi' } as any)).toBe(false)
      expect(isDownloadableMedia({ extendedTextMessage: { text: 'hi' } } as any)).toBe(false)
      expect(isDownloadableMedia(undefined)).toBe(false)
      expect(isDownloadableMedia({} as any)).toBe(false)
    })
  })
})
