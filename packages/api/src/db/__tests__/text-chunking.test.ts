import { describe, it, expect } from 'vitest'
import {
  splitLongText,
  findSentenceCut,
  MAX_CHARS,
  SENTENCE_SPLIT_AT,
  SENTENCE_BOUNDARY,
} from '../text-chunking.js'

/**
 * The shared chunker. `file_segments` and `transcript_segments` used to declare
 * their own copies of these bounds with TWO DIFFERENT sentence regexes — and the
 * transcript one was CJK-blind, on a product whose motivating content is
 * Cantonese meeting audio. Component tag: [COMP:brain/text-chunking].
 */

/** A CJK sentence with a fullwidth terminator and NO trailing space. */
const CJK_SENTENCE = '我哋今日傾下個價錢同埋交貨期先啦。'
/** An ASCII sentence with the conventional trailing space. */
const ASCII_SENTENCE = 'We talked about pricing and delivery today. '

describe('[COMP:brain/text-chunking] findSentenceCut', () => {
  it('cuts at a fullwidth terminator that has NO following space', () => {
    // THE BUG. The old transcript regex `/[.!?]\s/` required BOTH an ASCII
    // terminator and a following space, so a Cantonese transcript had no
    // boundary at all and fell back to a hard cut mid-sentence.
    const text = '我'.repeat(SENTENCE_SPLIT_AT + 10) + '。' + '哋'.repeat(600)
    const cut = findSentenceCut(text)
    expect(cut).toBeLessThan(MAX_CHARS)
    // The terminator stays on the leading piece.
    expect(text[cut - 1]).toBe('。')
  })

  it('still cuts at an ASCII terminator followed by a space', () => {
    const text = 'a'.repeat(SENTENCE_SPLIT_AT + 10) + '. ' + 'b'.repeat(600)
    const cut = findSentenceCut(text)
    expect(cut).toBeLessThan(MAX_CHARS)
    expect(text[cut - 1]).toBe('.')
  })

  it('hard-cuts at MAX_CHARS when there is no boundary at all', () => {
    expect(findSentenceCut('x'.repeat(3000))).toBe(MAX_CHARS)
  })

  it('ignores a terminator before the split window (pieces stay near target)', () => {
    // A boundary at char 10 must not produce a 10-char segment.
    const text = 'a'.repeat(10) + '. ' + 'b'.repeat(3000)
    expect(findSentenceCut(text)).toBeGreaterThanOrEqual(SENTENCE_SPLIT_AT)
  })
})

describe('[COMP:brain/text-chunking] splitLongText', () => {
  it('leaves short text alone', () => {
    expect(splitLongText('short')).toEqual(['short'])
    expect(splitLongText('x'.repeat(MAX_CHARS))).toHaveLength(1)
  })

  it('splits a long Cantonese monologue on real sentence ends', () => {
    // The undiarized-monologue case: one utterance over MAX_CHARS is the ONLY
    // path that reaches the splitter, which is why this bug hid for so long.
    const text = CJK_SENTENCE.repeat(200)
    const pieces = splitLongText(text)
    expect(pieces.length).toBeGreaterThan(1)
    for (const p of pieces) expect(p.length).toBeLessThanOrEqual(MAX_CHARS)
    // Every piece but the last ends on a real sentence terminator rather than
    // mid-word — that is the whole difference the fix buys.
    for (const p of pieces.slice(0, -1)) expect(p.endsWith('。')).toBe(true)
    // Lossless: no character is dropped or duplicated.
    expect(pieces.join('')).toBe(text.replace(/\s/g, ''))
  })

  it('splits long ASCII prose the same way it always did (no regression)', () => {
    const text = ASCII_SENTENCE.repeat(200)
    const pieces = splitLongText(text)
    expect(pieces.length).toBeGreaterThan(1)
    for (const p of pieces) expect(p.length).toBeLessThanOrEqual(MAX_CHARS)
    for (const p of pieces.slice(0, -1)) expect(p.endsWith('.')).toBe(true)
  })

  it('handles mixed CJK + ASCII (a real Cantonese business meeting)', () => {
    const text = ('我哋個 pricing 要再傾下。The proposal is due Friday. ').repeat(120)
    const pieces = splitLongText(text)
    for (const p of pieces) expect(p.length).toBeLessThanOrEqual(MAX_CHARS)
    for (const p of pieces.slice(0, -1)) expect(/[.。]$/.test(p)).toBe(true)
  })

  it('never emits an empty piece', () => {
    for (const p of splitLongText('。'.repeat(3000))) expect(p.length).toBeGreaterThan(0)
  })
})

describe('[COMP:brain/text-chunking] SENTENCE_BOUNDARY', () => {
  it('matches every terminator, fullwidth and ASCII', () => {
    for (const t of ['.', '!', '?', '。', '！', '？', '；']) {
      // Fresh test per terminator — the exported regex is global, so lastIndex
      // must not leak between callers.
      expect(new RegExp(SENTENCE_BOUNDARY.source).test(`x${t}`)).toBe(true)
    }
  })

  it('does not require trailing whitespace', () => {
    expect(new RegExp(SENTENCE_BOUNDARY.source).test('價錢。')).toBe(true)
  })
})
