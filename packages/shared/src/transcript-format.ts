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

/** The bare `H:MM:SS` / `MM:SS` moment, with no brackets around it. */
const STAMP_CORE = String.raw`(?:(\d+):)?(\d{1,2}):(\d{2})`

/**
 * Matches a single `[H:MM:SS]` or `[MM:SS]` citation. Anchored on the brackets
 * so it cannot swallow surrounding prose. Kept beside the formatter
 * deliberately — writer and reader change together or not at all.
 */
export const STAMP_RE = new RegExp(String.raw`\[${STAMP_CORE}\]`)

/**
 * Matches a citation GROUP: one or more moments inside a single pair of
 * brackets, comma-separated — `[0:01:24]` and `[0:01:24, 0:01:44]` alike.
 *
 * The model writes the multi-moment form whenever a claim is grounded in more
 * than one place ("...they are not traditional [0:01:24, 0:01:44]"), and the
 * single-stamp `STAMP_RE` matched NONE of it: the `]` does not follow the first
 * moment, so the whole citation silently rendered as plain text. Every
 * multi-moment citation in every brief was therefore unclickable.
 */
const STAMP_GROUP_RE = new RegExp(
  String.raw`\[\s*${STAMP_CORE}(?:\s*,\s*${STAMP_CORE})*\s*\]`,
)

/** Shared arithmetic so the bracketed and bare paths cannot disagree. */
function coreToMs(h: string | undefined, min: string, sec: string): number | null {
  const hours = h ? Number(h) : 0
  const minutes = Number(min)
  const seconds = Number(sec)
  if (minutes > 59 || seconds > 59) return null
  return ((hours * 60 + minutes) * 60 + seconds) * 1000
}

/**
 * Parse a `[H:MM:SS]` / `[MM:SS]` citation back to milliseconds. Returns null
 * when the text is not a citation, or when minutes/seconds are out of range —
 * `[00:85]` is not 85 seconds, it is a model hallucinating a timestamp, and
 * silently accepting it would put a citation at a moment that never existed.
 */
export function parseStamp(text: string): number | null {
  const m = STAMP_RE.exec(text)
  if (!m) return null
  return coreToMs(m[1], m[2], m[3])
}

/** A citation found inside a longer text, with the offsets it occupies. */
export type StampMatch = {
  /** Character offset of the match within the scanned text. */
  index: number
  /**
   * Length of the matched citation. A lone citation matches its whole bracketed
   * token (`[0:47:21]`); inside a multi-moment group each moment matches on its
   * own, without the shared brackets.
   */
  length: number
  ms: number
  text: string
}

/**
 * Find every well-formed citation in a text, in order.
 *
 * The one scanner: the render-time decoration (which needs offsets to place a
 * link) and the write-time citation extractor (which needs only the moment) both
 * come through here, so a stamp either IS a citation for both of them or for
 * neither. Impossible stamps are skipped, not returned — `parseStamp` owns that
 * judgement, and this must not develop a second opinion about it.
 *
 * Scans in two levels: find the bracketed group, then each moment within it.
 * A group holding ONE moment reports the whole bracketed token, so a lone
 * citation keeps rendering as a single `[0:47:21]` pill exactly as before. A
 * group holding several reports each moment separately, so `[0:01:24, 0:01:44]`
 * becomes two independent seek links and the punctuation between them stays
 * plain text — there is no sensible single destination for a two-moment link.
 */
export function scanStamps(text: string): StampMatch[] {
  // A fresh global twin per call: a module-level /g regex carries `lastIndex`
  // between calls, which makes results depend on call order.
  const groupRe = new RegExp(STAMP_GROUP_RE.source, 'g')
  const out: StampMatch[] = []
  let group: RegExpExecArray | null
  while ((group = groupRe.exec(text)) !== null) {
    const coreRe = new RegExp(STAMP_CORE, 'g')
    const moments: Array<{ index: number; length: number; ms: number; text: string }> = []
    let core: RegExpExecArray | null
    let impossible = false
    while ((core = coreRe.exec(group[0])) !== null) {
      const ms = coreToMs(core[1], core[2], core[3])
      // One bad moment invalidates only itself, not its neighbours — a group is
      // a list of independent claims, not a single compound citation.
      if (ms === null) {
        impossible = true
        continue
      }
      moments.push({ index: core.index, length: core[0].length, ms, text: core[0] })
    }
    if (moments.length === 0) continue
    if (moments.length === 1 && !impossible) {
      out.push({ index: group.index, length: group[0].length, ms: moments[0].ms, text: group[0] })
      continue
    }
    for (const m of moments) {
      out.push({ index: group.index + m.index, length: m.length, ms: m.ms, text: m.text })
    }
  }
  return out
}

/** One transcript line: `[H:MM:SS] Speaker: text`. */
export function formatTranscriptLine(line: TranscriptLineSource): string {
  return `[${formatStamp(line.startMs)}] ${line.speaker || UNKNOWN_SPEAKER}: ${line.text}`
}

/** The whole transcript, one line per utterance/segment. */
export function formatTranscript(lines: readonly TranscriptLineSource[]): string {
  return lines.map(formatTranscriptLine).join('\n')
}
