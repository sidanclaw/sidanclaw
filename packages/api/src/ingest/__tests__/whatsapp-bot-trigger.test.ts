import { describe, it, expect } from 'vitest'
import { buildWhatsappBotTrigger } from '../whatsapp-ingest.js'
import type { IngestRuleRow } from '../../db/ingest-rules-store.js'
import type { IngestRoutingMode } from '../../db/ingest-rules-store.js'

// No-op placeholder resolver so the trigger eval never touches the DB.
const noopResolve = (async (p: unknown) => p) as never

const ctx = { workspaceId: 'w_1', connectorInstanceId: 'ci_1' }

let order = 0
function rule(
  filterType: string,
  filterParams: Record<string, unknown>,
  routingMode: IngestRoutingMode,
): IngestRuleRow {
  return {
    id: `r_${order}`,
    connectorInstanceId: 'ci_1',
    source: 'whatsapp',
    ruleOrder: order++,
    filterType,
    filterParams,
    routingMode,
    routingSchedule: null,
    routingTimezone: 'UTC',
    alert: false,
    episodeSensitivity: null,
  } as IngestRuleRow
}

const dmInput = {
  channelId: 'a_1',
  chatJid: '5678@s.whatsapp.net',
  senderJid: '5678@s.whatsapp.net',
  messageId: 'm_1',
  text: 'please help me',
  timestamp: 1_700_000_000_000,
  isGroup: false,
}
const groupInput = { ...dmInput, chatJid: '120@g.us', isGroup: true, text: 'morning all' }

describe('[COMP:api/whatsapp-bot-triggers] buildWhatsappBotTrigger', () => {
  it('fires on an is_dm reply rule for a DM', async () => {
    order = 0
    const evalTrigger = buildWhatsappBotTrigger([rule('is_dm', {}, 'reply')], ctx, noopResolve)
    expect(await evalTrigger(dmInput)).toBe(true)
    expect(await evalTrigger(groupInput)).toBe(false)
  })

  it('fires on a keyword_match reply rule when the keyword is present', async () => {
    order = 0
    const evalTrigger = buildWhatsappBotTrigger(
      [rule('keyword_match', { keywords: ['help'] }, 'reply')],
      ctx,
      noopResolve,
    )
    expect(await evalTrigger(dmInput)).toBe(true)
    expect(await evalTrigger({ ...dmInput, text: 'no match here' })).toBe(false)
  })

  it('ignores non-reply rules — an ingest rule never triggers the bot', async () => {
    order = 0
    // An is_dm rule routed to the listener (realtime), not reply, must NOT trigger.
    const evalTrigger = buildWhatsappBotTrigger([rule('is_dm', {}, 'realtime')], ctx, noopResolve)
    expect(await evalTrigger(dmInput)).toBe(false)
  })

  it('returns false when there are no reply rules at all', async () => {
    order = 0
    const evalTrigger = buildWhatsappBotTrigger([], ctx, noopResolve)
    expect(await evalTrigger(dmInput)).toBe(false)
  })
})
