import type { MediaInfo } from './message-parser.js'

/**
 * Decide whether inbound media streams to GCS (→ the channel-media intake,
 * a `mediaRef` on the relay) or inlines as base64 (`mediaBase64`).
 *
 * Inline is reserved for media with a live-turn consumer on the API side:
 * images become multimodal content blocks, voice notes (ptt) get the
 * voice-transcription preflight, documents parse into the turn, stickers are
 * dropped upstream. Video and audio FILES have no live-turn consumer — an
 * inlined one is silently discarded on the BYON path — so they always stream,
 * regardless of size, and become recording episodes via the intake.
 * Anything over the inline cap streams too (the original size rule).
 *
 * A video/audio can also arrive typed as a **document** (WhatsApp "Document"
 * picker): then `mediaType === 'document'` but the `mimeType` is `video/*` /
 * `audio/*`. Those must stream too (become recording episodes), else a small
 * video sent as a Document goes inline and is never resolvable by media-fetch.
 * So key off the mime, not just `mediaType`.
 */
export function shouldStreamMedia(info: MediaInfo, maxInlineBytes: number): boolean {
  if ((info.fileLength ?? 0) > maxInlineBytes) return true
  const mime = (info.mimeType ?? '').toLowerCase()
  if (info.mediaType === 'video' || mime.startsWith('video/')) return true
  if ((info.mediaType === 'audio' || mime.startsWith('audio/')) && !info.isVoiceNote) return true
  return false
}
