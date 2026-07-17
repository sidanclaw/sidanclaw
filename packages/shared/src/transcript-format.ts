// [COMP:media/transcript-format] — the ONE `[H:MM:SS] Speaker: text` transcript
// rendering, shared by every producer and consumer.
//
// This format is load-bearing in four places that must agree:
//   1. the transcriber's own line output (`transcribe-recording.ts`),
//   2. the transcript FILE persisted to workspace_files (feature: "transcript
//      stored as a file"),
//   3. the `## FULL TRANSCRIPT` block injected into the synthesis prompt
//      (`recording-synthesizer.ts`), which is why the model emits `[H:MM:SS]`
//      citations at all,
//   4. the render-time citation parser that turns those citations into
//      seek links.
//
// A divergence between the writer's format and the reader's parser is exactly
// the bug class this module exists to prevent: the model cites what it was
// shown, and the UI can only linkify what it can parse. One function, one
// regex, no second opinion.

/** A transcript line's minimal shape — structurally shared by the transcriber's
 *  `TranscribedUtterance`, a `transcript_segments` row, and a search hit. */
export type TranscriptLineSource = {
  startMs: number
  speaker?: string | null
  text: string
}

/** Speaker label used when diarization produced none. */
export const UNKNOWN_SPEAKER = 'Speaker'

/**
 * `ms` -> `H:MM:SS`. Hours are NOT zero-padded (matching what the synthesis
 * prompt asks the model for and what the transcriber emits); minutes and seconds
 * always are, so `[0:47:21]` is well-formed and `[00:85]` is impossible.
 */
export function formatStamp(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = String(Math.floor((total % 3600) / 60)).padStart(2, '0')
  const s = String(total % 60).padStart(2, '0')
  return `${h}:${m}:${s}`
}

/**
 * Matches a `[H:MM:SS]` or `[MM:SS]` citation. Anchored on the brackets so it
 * cannot swallow surrounding prose. Kept beside the formatter deliberately —
 * writer and reader change together or not at all.
 */
export const STAMP_RE = /\[(?:(\d+):)?(\d{1,2}):(\d{2})\]/

/**
 * Parse a `[H:MM:SS]` / `[MM:SS]` citation back to milliseconds. Returns null
 * when the text is not a citation, or when minutes/seconds are out of range —
 * `[00:85]` is not 85 seconds, it is a model hallucinating a timestamp, and
 * silently accepting it would put a citation at a moment that never existed.
 */
export function parseStamp(text: string): number | null {
  const m = STAMP_RE.exec(text)
  if (!m) return null
  const h = m[1] ? Number(m[1]) : 0
  const min = Number(m[2])
  const sec = Number(m[3])
  if (min > 59 || sec > 59) return null
  return ((h * 60 + min) * 60 + sec) * 1000
}

/** One transcript line: `[H:MM:SS] Speaker: text`. */
export function formatTranscriptLine(line: TranscriptLineSource): string {
  return `[${formatStamp(line.startMs)}] ${line.speaker || UNKNOWN_SPEAKER}: ${line.text}`
}

/** The whole transcript, one line per utterance/segment. */
export function formatTranscript(lines: readonly TranscriptLineSource[]): string {
  return lines.map(formatTranscriptLine).join('\n')
}
