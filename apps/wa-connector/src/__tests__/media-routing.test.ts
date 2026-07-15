import { describe, expect, it } from 'vitest'
import { shouldStreamMedia } from '../media-routing.js'
import type { MediaInfo } from '../message-parser.js'

const CAP = 10 * 1024 * 1024

const media = (over: Partial<MediaInfo>): MediaInfo => ({
  mediaType: 'image',
  mimeType: 'image/jpeg',
  fileLength: 1024,
  ...over,
})

describe('[COMP:wa-connector/media-routing] Inline vs stream media routing', () => {
  it('keeps sub-cap live-turn media inline: image, document, voice note', () => {
    expect(shouldStreamMedia(media({ mediaType: 'image' }), CAP)).toBe(false)
    expect(
      shouldStreamMedia(media({ mediaType: 'document', mimeType: 'application/pdf' }), CAP),
    ).toBe(false)
    expect(
      shouldStreamMedia(
        media({ mediaType: 'audio', mimeType: 'audio/ogg; codecs=opus', isVoiceNote: true }),
        CAP,
      ),
    ).toBe(false)
    expect(shouldStreamMedia(media({ mediaType: 'sticker', mimeType: 'image/webp' }), CAP)).toBe(false)
  })

  it('streams sub-cap video — it has no live-turn consumer and would be discarded inline', () => {
    expect(
      shouldStreamMedia(media({ mediaType: 'video', mimeType: 'video/mp4', fileLength: 9 * 1024 * 1024 }), CAP),
    ).toBe(true)
  })

  it('streams a video/audio sent via the Document picker (mediaType document, AV mime)', () => {
    expect(
      shouldStreamMedia(media({ mediaType: 'document', mimeType: 'video/mp4' }), CAP),
    ).toBe(true)
    expect(
      shouldStreamMedia(media({ mediaType: 'document', mimeType: 'audio/mpeg' }), CAP),
    ).toBe(true)
  })

  it('streams a sub-cap audio FILE (not a voice note)', () => {
    expect(
      shouldStreamMedia(
        media({ mediaType: 'audio', mimeType: 'audio/mpeg', isVoiceNote: false }),
        CAP,
      ),
    ).toBe(true)
    // Missing ptt flag reads as an audio file, not a voice note.
    expect(shouldStreamMedia(media({ mediaType: 'audio', mimeType: 'audio/mpeg' }), CAP)).toBe(true)
  })

  it('streams anything over the inline cap', () => {
    expect(shouldStreamMedia(media({ mediaType: 'image', fileLength: CAP + 1 }), CAP)).toBe(true)
    expect(
      shouldStreamMedia(media({ mediaType: 'document', fileLength: CAP + 1 }), CAP),
    ).toBe(true)
    expect(
      shouldStreamMedia(
        media({ mediaType: 'audio', isVoiceNote: true, fileLength: CAP + 1 }),
        CAP,
      ),
    ).toBe(true)
  })

  it('keeps unknown-size non-AV media inline (fileLength missing)', () => {
    expect(shouldStreamMedia(media({ mediaType: 'image', fileLength: undefined }), CAP)).toBe(false)
  })
})
