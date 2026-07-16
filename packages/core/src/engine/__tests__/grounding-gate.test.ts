import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import type {
  LLMProvider,
  ProviderSession,
  SendOptions,
  SessionOptions,
  StreamChunk,
  Message,
} from '../../providers/types.js'
import { buildTool, type Tool } from '../../tools/types.js'
import { queryLoop, type QueryEvent } from '../query-loop.js'
import {
  matchFreshFactsQuestion,
  hasFigures,
  groundingGateCheck,
  buildGroundingNudge,
} from '../grounding-gate.js'

type SendCall = { messages: Message[] }

function scriptedProvider(scripts: StreamChunk[][]): {
  provider: LLMProvider
  calls: SendCall[]
} {
  const calls: SendCall[] = []
  let turn = 0
  function streamNext(): AsyncIterable<StreamChunk> {
    const chunks = scripts[Math.min(turn, scripts.length - 1)]
    turn++
    return (async function* () {
      for (const chunk of chunks) yield chunk
    })()
  }
  const session: ProviderSession = {
    send(messages: Message[], _opts?: SendOptions) {
      calls.push({ messages })
      return streamNext()
    },
  }
  return {
    calls,
    provider: {
      name: 'scripted',
      models: ['mock-model'],
      stream: () => streamNext(),
      createSession: (_o: SessionOptions) => session,
    },
  }
}

const textTurn = (text: string): StreamChunk[] => [
  { type: 'message_start', model: 'mock-model' },
  { type: 'text_delta', text },
  { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 5, outputTokens: 3 } },
]

const baseContext = {
  userId: 'u',
  assistantId: 'a',
  sessionId: 's',
  appId: 'test',
  channelType: 'web',
  channelId: 'c',
  abortSignal: new AbortController().signal,
}

const webSearchStub: Tool = buildTool({
  name: 'webSearch',
  description: 'stub',
  inputSchema: z.object({ query: z.string() }),
  isConcurrencySafe: true,
  isReadOnly: true,
  async execute() {
    return { data: { results: [] } }
  },
})

function lastUserText(messages: Message[]): string {
  const last = messages[messages.length - 1]
  if (!last || last.role !== 'user') return ''
  if (typeof last.content === 'string') return last.content
  return last.content
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join('')
}

async function run(opts: {
  provider: LLMProvider
  userMessage: string
  groundingGate?: { userMessage: string; draftDelivered?: boolean }
  tools?: Map<string, Tool>
}): Promise<QueryEvent[]> {
  const events: QueryEvent[] = []
  for await (const e of queryLoop({
    provider: opts.provider,
    model: 'mock-model',
    systemPrompt: 'sys',
    messages: [{ role: 'user', content: opts.userMessage }],
    tools: opts.tools ?? new Map([['webSearch', webSearchStub]]),
    context: baseContext,
    maxTurns: 10,
    groundingGate: opts.groundingGate,
  })) {
    events.push(e)
  }
  return events
}

// The 2026-07-16 incident message — Cantonese "what's the current welcome
// offer on the SC Cathay credit card", answered twice with confabulated
// figures and zero tool calls.
const INCIDENT_MESSAGE = 'cx sc credit card 而家個迎新係點'
const INCIDENT_DRAFT =
  '依家(2026年7月)渣打國泰卡嘅迎新優惠:簽滿 HK$20,000 送 40,000 里,7月23號前申請。'

describe('[COMP:engine/grounding-gate] Fresh-facts heuristic', () => {
  it('matches the incident message (Cantonese freshness cue + volatile noun)', () => {
    expect(matchFreshFactsQuestion(INCIDENT_MESSAGE)).toBe('而家')
  })

  it('matches English current-offer questions', () => {
    expect(
      matchFreshFactsQuestion('what is the current welcome offer for the SC Cathay card?'),
    ).toBeTruthy()
    expect(matchFreshFactsQuestion('how much does the annual fee cost now?')).toBeTruthy()
  })

  it('requires BOTH halves — one alone is everyday chat', () => {
    // Freshness cue without a volatile noun.
    expect(matchFreshFactsQuestion('call me now please')).toBeNull()
    expect(matchFreshFactsQuestion('而家得閒傾兩句嗎')).toBeNull()
    // Volatile noun without a freshness cue.
    expect(matchFreshFactsQuestion('the offer we discussed sounds good')).toBeNull()
    expect(matchFreshFactsQuestion('remind me about the deadline tomorrow')).toBeNull()
  })

  it('documents the known v1 gap: short dispute follow-ups do not match', () => {
    // The incident's second turn — re-asserted fabricated figures. No
    // freshness cue, so v1 misses it (spec → "Known gaps").
    expect(matchFreshFactsQuestion('唔係要 look 11萬咩')).toBeNull()
  })
})

describe('[COMP:engine/grounding-gate] Figure detection', () => {
  it('detects Arabic digits, full-width digits, and CJK numeral+unit compounds', () => {
    expect(hasFigures('HK$20,000 送 40,000 里')).toBe(true)
    expect(hasFigures('簽賬滿２０００蚊')).toBe(true)
    expect(hasFigures('要簽夠十一萬先食盡')).toBe(true)
    expect(hasFigures('大約五千蚊左右')).toBe(true)
  })

  it('does not count figure-less clarifying replies', () => {
    expect(hasFigures('你想問邊張卡嘅迎新?等我幫你查下先。')).toBe(false)
    expect(hasFigures('Let me check the latest offer for you.')).toBe(false)
    // CJK numerals inside ordinary words (no magnitude/unit) are not figures.
    expect(hasFigures('我哋一齊研究下')).toBe(false)
  })
})

describe('[COMP:engine/grounding-gate] Gate check conditions', () => {
  const boundTools = new Map([['webSearch', webSearchStub]])

  it('fires when all content conditions hold', () => {
    const verdict = groundingGateCheck({
      userMessage: INCIDENT_MESSAGE,
      draftText: INCIDENT_DRAFT,
      boundTools,
    })
    expect(verdict).toEqual({ fire: true, matchedCue: '而家' })
  })

  it('never fires without a web-verification tool bound', () => {
    expect(
      groundingGateCheck({
        userMessage: INCIDENT_MESSAGE,
        draftText: INCIDENT_DRAFT,
        boundTools: new Map(),
      }),
    ).toEqual({ fire: false })
  })

  it('never fires on a figure-less draft', () => {
    expect(
      groundingGateCheck({
        userMessage: INCIDENT_MESSAGE,
        draftText: '你想問邊張卡?我幫你查下。',
        boundTools,
      }),
    ).toEqual({ fire: false })
  })

  it('nudge copy branches on draftDelivered and never names a tool', () => {
    const channel = buildGroundingNudge({ draftDelivered: false })
    const web = buildGroundingNudge({ draftDelivered: true })
    expect(channel).toContain('NOT delivered')
    expect(web).toContain('already shown')
    for (const copy of [channel, web]) {
      expect(copy).not.toMatch(/webSearch|xSearch|urlReader/)
    }
  })
})

describe('[COMP:engine/grounding-gate] Query-loop wiring', () => {
  it('injects one verification nudge and ships the corrected turn', async () => {
    const { provider, calls } = scriptedProvider([
      textTurn(INCIDENT_DRAFT),
      textTurn('查證後:標準卡迎新為簽 HK$5,000 送 20,000 里 (來源: sc.com)。'),
    ])
    const events = await run({
      provider,
      userMessage: INCIDENT_MESSAGE,
      groundingGate: { userMessage: INCIDENT_MESSAGE, draftDelivered: false },
    })
    // Gate forced a second model turn.
    expect(calls).toHaveLength(2)
    // The injected nudge orders verification and forbids unverified figures.
    const nudge = lastUserText(calls[1].messages)
    expect(nudge).toContain('verify')
    expect(nudge).toContain('not verified')
    // Exactly one grounding_nudge event, carrying the matched cue.
    const nudgeEvents = events.filter((e) => e.type === 'grounding_nudge')
    expect(nudgeEvents).toHaveLength(1)
    expect(nudgeEvents[0]).toMatchObject({ matchedCue: '而家' })
    // The loop still completes.
    expect(events.find((e) => e.type === 'turn_complete')).toBeDefined()
  })

  it('fires at most once — a model that ignores the nudge ships its second attempt', async () => {
    const { provider, calls } = scriptedProvider([
      textTurn(INCIDENT_DRAFT),
      textTurn(INCIDENT_DRAFT), // stubborn: same confabulated figures again
    ])
    const events = await run({
      provider,
      userMessage: INCIDENT_MESSAGE,
      groundingGate: { userMessage: INCIDENT_MESSAGE },
    })
    expect(calls).toHaveLength(2)
    expect(events.filter((e) => e.type === 'grounding_nudge')).toHaveLength(1)
    expect(events.find((e) => e.type === 'turn_complete')).toBeDefined()
  })

  it('does nothing when the lane did not opt in (default behavior preserved)', async () => {
    const { provider, calls } = scriptedProvider([textTurn(INCIDENT_DRAFT)])
    const events = await run({ provider, userMessage: INCIDENT_MESSAGE })
    expect(calls).toHaveLength(1)
    expect(events.filter((e) => e.type === 'grounding_nudge')).toHaveLength(0)
  })

  it('does not fire on a non-fresh-facts message', async () => {
    const { provider, calls } = scriptedProvider([textTurn('It adds up to 42.')])
    const events = await run({
      provider,
      userMessage: 'what is 20 + 22?',
      groundingGate: { userMessage: 'what is 20 + 22?' },
    })
    expect(calls).toHaveLength(1)
    expect(events.filter((e) => e.type === 'grounding_nudge')).toHaveLength(0)
  })

  it('does not fire when no verification tool is bound', async () => {
    const { provider, calls } = scriptedProvider([textTurn(INCIDENT_DRAFT)])
    const events = await run({
      provider,
      userMessage: INCIDENT_MESSAGE,
      groundingGate: { userMessage: INCIDENT_MESSAGE },
      tools: new Map(),
    })
    expect(calls).toHaveLength(1)
    expect(events.filter((e) => e.type === 'grounding_nudge')).toHaveLength(0)
  })
})
