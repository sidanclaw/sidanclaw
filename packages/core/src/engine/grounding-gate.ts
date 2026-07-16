/**
 * Grounding gate — fresh-facts answers must be tool-verified.
 *
 * The mechanical guard behind the 2026-07-16 credit-card welcome-offer
 * incident: a Cantonese "what's the current welcome offer" question was
 * answered with fully confabulated figures in two consecutive turns with
 * ZERO tool calls. Layer 1 already orders "time-sensitive data: ALWAYS
 * search first", but prompt rules do not bind standard-tier models — the
 * same lesson as the identifier-provenance gate, applied to interactive
 * reply text instead of record writes.
 *
 * The gate is deterministic (two regex halves + counters, no LLM call) and
 * fires at the query loop's tool-less turn end, at most once per invocation,
 * only on lanes that opt in via the `groundingGate` option (interactive chat
 * + messaging channels). Spec: docs/architecture/engine/grounding-gate.md.
 *
 * [COMP:engine/grounding-gate]
 */

/**
 * Tools that count as web verification for condition 5 ("a verification
 * tool is bound"). Deliberately the narrow web set — the gate exists for
 * public-world facts; brain/memory retrieval cannot verify a bank's current
 * promotion. If none of these is bound, the gate never fires (nudging a
 * model that cannot search is pointless — Layer 1's honesty rules are all
 * we have there).
 */
const WEB_VERIFICATION_TOOLS = ['webSearch', 'xSearch', 'urlReader'] as const

// ── Fresh-facts heuristic (two halves, both must match) ────────────
//
// Same shape as `stepAdvisories`' contact-research heuristic: a single half
// alone is everyday chat ("call me now", "the offer we discussed"); the
// conjunction is what marks "a question about the current state of a
// volatile fact". `\b` never matches around CJK characters (not `\w` in JS
// regex), so the CJK halves live in boundary-free patterns — the same
// convention as the operate-site CJK verbs in research-classifier.ts.
//
// Bias: false positives are cheap (one redundant verification turn on a
// question that was fresh-facts-shaped anyway); false negatives ship
// confabulated figures. Lean toward matching.

const FRESHNESS_CUE = new RegExp(
  [
    /\b(?:right\s+now|now|current(?:ly)?|latest|today|tonight|this\s+(?:week|month|year)|these\s+days|as\s+of|up[\s-]to[\s-]date|recent(?:ly)?)\b/i
      .source,
    // yue/zh/ja: 而家·依家·宜家 (Cantonese "now"), 現時/現在/目前, 最新, 今日/今天,
    // 今個月/本月, 今年, 最近, 呢排/近排 (Cantonese "lately"), 現時点 (ja).
    /而家|依家|宜家|現時|现时|現在|现在|目前|最新|今日|今天|今個月|今个月|本月|今年|最近|呢排|近排|近來|近来|現時点/
      .source,
  ].join('|'),
  'i',
)

const VOLATILE_FACT_NOUN = new RegExp(
  [
    /\b(?:price|prices|pricing|cost|costs|fee|fees|rate|rates|offer|offers|promo(?:tion)?s?|deal|deals|discount|bonus|cashback|miles|points|interest|apr|stock|share\s+price|quote|schedule|timetable|deadline|availability|in\s+stock|news|score|scores|weather|forecast)\b/i
      .source,
    // 價錢/價格, 幾錢 (Cantonese "how much"), 收費/費用/年費, 利率/息口, 匯率,
    // 優惠 (offer), 迎新 (welcome offer), 折扣, 回贈 (rebate), 里數 (miles),
    // 積分, 股價, 新聞, 截止/死線 (deadline), 時間表/班次, 天氣, 賽果/比分,
    // ja: 価格/料金/金利/キャンペーン.
    /價[錢格]|价[钱格]|幾錢|幾多錢|几钱|几多钱|收費|收费|費用|费用|年費|年费|利率|息口|匯率|汇率|優惠|优惠|迎新|折扣|回贈|回赠|里數|里数|積分|积分|股價|股价|新聞|新闻|截止|死線|死线|時間表|时间表|班次|天氣|天气|賽果|赛果|比分|価格|料金|金利|キャンペーン/
      .source,
  ].join('|'),
  'i',
)

/**
 * Does the user message ask about the current state of a volatile fact?
 * Returns the matched freshness cue for telemetry (`matched_cue` on the
 * `grounding_nudge_fired` analytics event).
 */
export function matchFreshFactsQuestion(message: string): string | null {
  const cue = message.match(FRESHNESS_CUE)
  if (!cue) return null
  if (!VOLATILE_FACT_NOUN.test(message)) return null
  return cue[0]
}

// Arabic digits (half or full width), or a CJK numeral run ending in a
// magnitude/unit character (十一萬, 五千蚊, 三百元). The unit requirement is
// what keeps ordinary words (一齊, 十分) from counting as figures.
const FIGURE_PATTERN =
  /[0-9０-９]|[一二三四五六七八九十百千]+\s*[萬万億亿千百十%％蚊元円圓]/

/** Does the draft reply carry figures? A clarifying question or a
 *  "let me check" reply must not trip the gate. */
export function hasFigures(text: string): boolean {
  return FIGURE_PATTERN.test(text)
}

export type GroundingGateOptions = {
  /** The turn's raw user message text — the lane passes it explicitly
   *  rather than the loop re-parsing `messages` (resume shapes, envelopes). */
  userMessage: string
  /**
   * Whether the draft already reached the user when the gate fires. Web SSE
   * streams the draft live (true); final-only channels retract it via the
   * `grounding_nudge` event's buffer reset (false, the default). Branches
   * one sentence of the nudge copy so the model is never lied to about what
   * the user saw.
   */
  draftDelivered?: boolean
}

export type GroundingGateVerdict =
  | { fire: false }
  | { fire: true; matchedCue: string }

/**
 * Content-level gate conditions (2, 4, 5 of the spec). The loop-level
 * conditions — opt-in, zero tool calls, budget, once-per-invocation — stay
 * in query-loop.ts where that state lives.
 */
export function groundingGateCheck(input: {
  userMessage: string
  draftText: string
  boundTools: { has(name: string): boolean }
}): GroundingGateVerdict {
  if (!WEB_VERIFICATION_TOOLS.some((name) => input.boundTools.has(name))) {
    return { fire: false }
  }
  if (!hasFigures(input.draftText)) return { fire: false }
  const matchedCue = matchFreshFactsQuestion(input.userMessage)
  if (!matchedCue) return { fire: false }
  return { fire: true, matchedCue }
}

/**
 * The synthetic user message injected when the gate fires. Names no
 * specific tool (tool-awareness rule) — condition 5 already guarantees a
 * verification tool exists, and the model sees its own tool list.
 */
export function buildGroundingNudge(opts: { draftDelivered: boolean }): string {
  const tail = opts.draftDelivered
    ? 'Your draft was already shown to the user — if verification changes any figure, open by correcting it explicitly.'
    : 'Your draft was NOT delivered to the user — the reply you write now is the only message they will see, so make it complete and standalone.'
  return (
    'Your reply makes specific figure claims about current, time-sensitive facts ' +
    '(prices, offers, rates, dates), but you called no tools this turn — those figures ' +
    'came from your stale training data and are likely wrong. Do this now: ' +
    '(1) verify every specific figure with your search / retrieval tools; ' +
    "(2) rewrite your answer in the user's language using ONLY figures that appear in tool results, " +
    'and say where they came from; ' +
    '(3) state anything you could not verify plainly as not verified — never guess, and never repeat ' +
    `an unverified figure from your draft. ${tail}`
  )
}
