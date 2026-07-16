/**
 * `text-chunking.ts` — the shared packing bounds + sentence boundary for every
 * embedded chunk primitive.
 *
 * `file_segments` (297) and `transcript_segments` (280) chunk different content
 * into the same retrieval unit, for the same embedder, at the same granularity.
 * They had independently-declared copies of the same four constants and TWO
 * DIFFERENT sentence regexes — and `file-segments-store.ts` documented the
 * divergence against itself:
 *
 *   > Sentence boundary for splitting an over-long block. CJK-aware: fullwidth
 *   > terminators (。！？；) rarely carry a following space, so `\s?` — the
 *   > transcript store's `/[.!?]\s/` misses them entirely.
 *
 * Someone knew, wrote it down, and left the transcript store broken. It matters:
 * the motivating content is Cantonese meeting audio, where `。` is the sentence
 * terminator and a following space is rare — so the transcript splitter found no
 * boundary at all and fell back to a hard cut at MAX_CHARS, mid-sentence.
 *
 * One module, one boundary, both callers.
 *
 * [COMP:brain/text-chunking]
 */

// Packing bounds — same granularity for both primitives (same embedder, same
// retrieval unit). 1500 chars ≈ ≤1500 CJK tokens, under the embedder cap.
export const TARGET_CHARS = 1200
export const MAX_CHARS = 1500
export const MIN_CHARS = 200
export const SENTENCE_SPLIT_AT = 900

/**
 * Sentence terminators, ASCII + fullwidth. The single source of truth — both
 * regex shapes below are built from it, so a new terminator is added once.
 */
const TERMINATORS = '.!?。！？；'

/**
 * Sentence boundary, global — for scanning a block for every boundary.
 *
 * The trailing whitespace is OPTIONAL (`\s?`) and that is the whole point:
 * fullwidth terminators rarely carry a following space, so requiring one
 * (`/[.!?]\s/`) misses every CJK sentence end.
 */
export const SENTENCE_BOUNDARY = new RegExp(`[${TERMINATORS}]\\s?`, 'g')

/** Non-global twin, for `String.prototype.search` (which ignores `lastIndex`,
 *  but a fresh non-global instance keeps intent obvious and avoids sharing
 *  mutable regex state across callers). */
const SENTENCE_BOUNDARY_SEARCH = new RegExp(`[${TERMINATORS}]\\s?`)

/**
 * Find where to cut an over-long string: the last position at/after
 * `SENTENCE_SPLIT_AT` and before `MAX_CHARS` that ends a sentence, else
 * `MAX_CHARS` (a hard cut).
 *
 * @returns the exclusive end index of the first piece.
 */
export function findSentenceCut(text: string): number {
  const window = text.slice(SENTENCE_SPLIT_AT, MAX_CHARS)
  const m = window.search(SENTENCE_BOUNDARY_SEARCH)
  // +1 keeps the terminator itself on the leading piece.
  return m >= 0 ? SENTENCE_SPLIT_AT + m + 1 : MAX_CHARS
}

/**
 * Split an over-long string on sentence boundaries near `SENTENCE_SPLIT_AT`,
 * hard-splitting at `MAX_CHARS`. Keeps sentences intact when it can; never
 * emits an empty piece.
 */
export function splitLongText(text: string): string[] {
  if (text.length <= MAX_CHARS) return [text]
  const pieces: string[] = []
  let rest = text
  while (rest.length > MAX_CHARS) {
    const cut = findSentenceCut(rest)
    pieces.push(rest.slice(0, cut).trim())
    rest = rest.slice(cut).trim()
  }
  if (rest.length > 0) pieces.push(rest)
  return pieces.filter((p) => p.length > 0)
}
