import { describe, it, expect, vi } from 'vitest'
import {
  buildWhatsappBotHandler,
  botMaySend,
  botMayAnswer,
  botAnswerDecision,
  normalizeWhatsappNumber,
  type WhatsappBotConfig,
  type WhatsappBotDeps,
  type WhatsappBotInput,
} from '../whatsapp-bot-handler.js'

const dmInput: WhatsappBotInput = {
  channelId: 'a_1',
  chatJid: '5678@s.whatsapp.net',
  senderJid: '5678@s.whatsapp.net',
  senderName: 'Bob',
  messageId: 'm_1',
  text: 'hey bot',
  isGroup: false,
  timestamp: 1_700_000_000_000,
}
const groupInput: WhatsappBotInput = {
  ...dmInput,
  chatJid: '120@g.us',
  isGroup: true,
}

function deps(over: Partial<WhatsappBotDeps> = {}): WhatsappBotDeps {
  return {
    evalTrigger: vi.fn().mockResolvedValue(true),
    getRecentHistory: vi.fn().mockResolvedValue('history'),
    generateReply: vi.fn().mockResolvedValue('hello back'),
    send: vi.fn().mockResolvedValue({ messageId: 'sent_1' }),
    ...over,
  }
}

const dmScope: WhatsappBotConfig = { persona: 'You are helpful', sendScope: 'dm' }

describe('[COMP:api/whatsapp-bot-triggers] botMaySend (send-scope gate)', () => {
  it('always allows DMs', () => {
    expect(botMaySend(dmScope, dmInput)).toBe(true)
  })

  it('blocks group replies under the default DM-only scope', () => {
    expect(botMaySend(dmScope, groupInput)).toBe(false)
  })

  it('blocks a group that is not opted in even when groups are enabled', () => {
    const cfg: WhatsappBotConfig = { persona: null, sendScope: 'dm_and_groups', groupOptIn: ['999@g.us'] }
    expect(botMaySend(cfg, groupInput)).toBe(false)
  })

  it('allows an opted-in group when groups are enabled', () => {
    const cfg: WhatsappBotConfig = { persona: null, sendScope: 'dm_and_groups', groupOptIn: ['120@g.us'] }
    expect(botMaySend(cfg, groupInput)).toBe(true)
  })
})

describe('[COMP:api/whatsapp-bot-handler] normalizeWhatsappNumber', () => {
  it('strips the JID suffix and device part to phone digits', () => {
    expect(normalizeWhatsappNumber('85291234567:3@s.whatsapp.net')).toBe('85291234567')
  })
  it('strips +, spaces and dashes from a typed number', () => {
    expect(normalizeWhatsappNumber('+852 9123-4567')).toBe('85291234567')
  })
  it('returns null for an @lid jid (the member hides their number)', () => {
    expect(normalizeWhatsappNumber('1955123456789@lid')).toBeNull()
  })
  it('returns null when there are too few digits to be a number', () => {
    expect(normalizeWhatsappNumber('123@s.whatsapp.net')).toBeNull()
  })
})

describe('[COMP:api/whatsapp-bot-handler] botMayAnswer (access control)', () => {
  const dm = (jid: string): WhatsappBotInput => ({ ...dmInput, senderJid: jid })
  const grp = (jid: string): WhatsappBotInput => ({ ...groupInput, senderJid: jid })

  it('allow_all (the default) answers everyone', () => {
    expect(botMayAnswer({ persona: null, sendScope: 'dm' }, dm('85291234567@s.whatsapp.net'))).toBe(true)
  })

  it('allowlist answers a listed number and drops an unlisted one', () => {
    const cfg: WhatsappBotConfig = {
      persona: null, sendScope: 'dm', accessMode: 'allowlist', allowedNumbers: ['85291234567'],
    }
    expect(botMayAnswer(cfg, dm('85291234567:2@s.whatsapp.net'))).toBe(true)
    expect(botMayAnswer(cfg, dm('85299999999@s.whatsapp.net'))).toBe(false)
  })

  it('group_members always answers a group message (sender is a co-member)', () => {
    const cfg: WhatsappBotConfig = {
      persona: null, sendScope: 'dm_and_groups', accessMode: 'group_members', groupMemberNumbers: [],
    }
    expect(botMayAnswer(cfg, grp('85288888888@s.whatsapp.net'))).toBe(true)
  })

  it('group_members answers a DM from someone in a shared group, drops a stranger', () => {
    const cfg: WhatsappBotConfig = {
      persona: null, sendScope: 'dm', accessMode: 'group_members', groupMemberNumbers: ['85291234567'],
    }
    expect(botMayAnswer(cfg, dm('85291234567@s.whatsapp.net'))).toBe(true)
    expect(botMayAnswer(cfg, dm('85299999999@s.whatsapp.net'))).toBe(false)
  })

  it('blocklist answers everyone except a blocked number', () => {
    const cfg: WhatsappBotConfig = {
      persona: null, sendScope: 'dm', accessMode: 'blocklist', blockedNumbers: ['85299999999'],
    }
    expect(botMayAnswer(cfg, dm('85291234567@s.whatsapp.net'))).toBe(true)
    expect(botMayAnswer(cfg, dm('85299999999:1@s.whatsapp.net'))).toBe(false)
  })

  it('blocklist allows an @lid sender (cannot be matched → not blocked)', () => {
    const cfg: WhatsappBotConfig = {
      persona: null, sendScope: 'dm', accessMode: 'blocklist', blockedNumbers: ['85299999999'],
    }
    expect(botMayAnswer(cfg, dm('199@lid'))).toBe(true)
  })

  it('drops an @lid DM under allowlist when no PN twin was resolved', () => {
    const cfg: WhatsappBotConfig = {
      persona: null, sendScope: 'dm', accessMode: 'allowlist', allowedNumbers: ['85291234567'],
    }
    expect(botMayAnswer(cfg, dm('199@lid'))).toBe(false)
    expect(botAnswerDecision(cfg, dm('199@lid'))).toEqual({
      allowed: false,
      reason: 'lid_unidentifiable',
    })
  })

  it('allows an @lid DM under allowlist when the resolved PN twin is listed', () => {
    const cfg: WhatsappBotConfig = {
      persona: null, sendScope: 'dm', accessMode: 'allowlist', allowedNumbers: ['85266986281'],
    }
    const lidWithPn: WhatsappBotInput = {
      ...dmInput,
      senderJid: '237288437104831@lid',
      senderPnJid: '85266986281@s.whatsapp.net',
    }
    expect(botMayAnswer(cfg, lidWithPn)).toBe(true)
    // An unlisted PN twin still drops, with the allowlist reason (identified,
    // just not allowed).
    const unlisted: WhatsappBotInput = { ...lidWithPn, senderPnJid: '85299999999@s.whatsapp.net' }
    expect(botAnswerDecision(cfg, unlisted)).toEqual({
      allowed: false,
      reason: 'not_in_allowlist',
    })
  })

  it('matches an @lid sender against group_members via the PN twin', () => {
    const cfg: WhatsappBotConfig = {
      persona: null, sendScope: 'dm', accessMode: 'group_members', groupMemberNumbers: ['85266986281'],
    }
    const lidWithPn: WhatsappBotInput = {
      ...dmInput,
      senderJid: '237288437104831@lid',
      senderPnJid: '85266986281@s.whatsapp.net',
    }
    expect(botMayAnswer(cfg, lidWithPn)).toBe(true)
  })

  it('blocks an @lid sender under blocklist when the resolved PN twin is blocked', () => {
    const cfg: WhatsappBotConfig = {
      persona: null, sendScope: 'dm', accessMode: 'blocklist', blockedNumbers: ['85266986281'],
    }
    const lidWithPn: WhatsappBotInput = {
      ...dmInput,
      senderJid: '237288437104831@lid',
      senderPnJid: '85266986281@s.whatsapp.net',
    }
    expect(botAnswerDecision(cfg, lidWithPn)).toEqual({ allowed: false, reason: 'blocked' })
  })
})

describe('[COMP:api/whatsapp-bot-handler] access-gate drop logging', () => {
  it('warns with the deny reason when the gate drops a sender', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const d = deps()
    const cfg: WhatsappBotConfig = {
      persona: null, sendScope: 'dm', accessMode: 'allowlist', allowedNumbers: ['85291234567'],
    }
    const handler = buildWhatsappBotHandler(d, cfg, { ...dmInput, senderJid: '199@lid' })
    await handler.handle()

    expect(warnSpy).toHaveBeenCalledWith(
      '[whatsapp-bot] access-gate drop',
      expect.objectContaining({ mode: 'allowlist', reason: 'lid_unidentifiable' }),
    )
    expect(d.send).not.toHaveBeenCalled()
    warnSpy.mockRestore()
  })
})

describe('[COMP:api/whatsapp-bot-handler] BotHandler pipeline', () => {
  it('replies to a triggered DM with the persona LLM output', async () => {
    const d = deps()
    const handler = buildWhatsappBotHandler(d, dmScope, dmInput)
    expect(handler.kind).toBe('bot')

    await handler.handle()
    expect(d.evalTrigger).toHaveBeenCalledOnce()
    expect(d.generateReply).toHaveBeenCalledWith(
      expect.objectContaining({ persona: 'You are helpful', history: 'history', brainContext: '' }),
    )
    expect(d.send).toHaveBeenCalledWith('5678@s.whatsapp.net', 'hello back')
  })

  it('does not reply when no trigger matches', async () => {
    const d = deps({ evalTrigger: vi.fn().mockResolvedValue(false) })
    await buildWhatsappBotHandler(d, dmScope, dmInput).handle()
    expect(d.generateReply).not.toHaveBeenCalled()
    expect(d.send).not.toHaveBeenCalled()
  })

  it('does not reply in a non-opted-in group even if the trigger would match', async () => {
    const d = deps()
    await buildWhatsappBotHandler(d, dmScope, groupInput).handle()
    expect(d.evalTrigger).not.toHaveBeenCalled() // scope gate short-circuits first
    expect(d.send).not.toHaveBeenCalled()
  })

  it('sends nothing when the LLM returns a blank reply', async () => {
    const d = deps({ generateReply: vi.fn().mockResolvedValue('   ') })
    await buildWhatsappBotHandler(d, dmScope, dmInput).handle()
    expect(d.send).not.toHaveBeenCalled()
  })

  it('includes long-term brain context only when getBrainContext is injected (dual mode)', async () => {
    const getBrainContext = vi.fn().mockResolvedValue('brain facts')
    const d = deps({ getBrainContext })
    await buildWhatsappBotHandler(d, dmScope, dmInput).handle()
    expect(getBrainContext).toHaveBeenCalledOnce()
    expect(d.generateReply).toHaveBeenCalledWith(
      expect.objectContaining({ brainContext: 'brain facts' }),
    )
  })

  // ── BYON bot mode runs the full assistant (Telegram-style compaction) ──
  // When `runAssistant` is wired (apps/api binds it to `processChannelMessage`),
  // a DM bypasses the lightweight persona path entirely and hands off to the
  // real engine. That engine is the same `processChannelMessage` Telegram /
  // Slack / web chat use, which calls `runProactiveCompaction({ channelClass:
  // 'messaging' })` unconditionally (channel-pipeline.ts) — so routing through
  // it IS inheriting the messaging multi-topic compaction profile, NOT the
  // listener's aggregated-digest drain. These tests pin that routing.
  it('routes a DM to the full assistant (processChannelMessage) when runAssistant is wired', async () => {
    const runAssistant = vi.fn().mockResolvedValue(undefined)
    const d = deps({ runAssistant })
    await buildWhatsappBotHandler(d, dmScope, dmInput).handle()

    // Full-assistant engine owns the turn — no lightweight persona reply, and
    // a DM is answered without a separate trigger rule (Telegram parity).
    expect(runAssistant).toHaveBeenCalledWith(dmInput)
    expect(d.evalTrigger).not.toHaveBeenCalled()
    expect(d.generateReply).not.toHaveBeenCalled()
    expect(d.send).not.toHaveBeenCalled()
  })

  it('access gate drops a DM whose sender is not on the allowlist (before any work)', async () => {
    const runAssistant = vi.fn().mockResolvedValue(undefined)
    const d = deps({ runAssistant })
    const cfg: WhatsappBotConfig = {
      persona: null, sendScope: 'dm', accessMode: 'allowlist', allowedNumbers: ['85291234567'],
    }
    await buildWhatsappBotHandler(d, cfg, { ...dmInput, senderJid: '85299999999@s.whatsapp.net' }).handle()
    expect(runAssistant).not.toHaveBeenCalled()
    expect(d.evalTrigger).not.toHaveBeenCalled()
    expect(d.send).not.toHaveBeenCalled()
  })

  it('routes an opted-in, triggered group message to the full assistant', async () => {
    const runAssistant = vi.fn().mockResolvedValue(undefined)
    const groupScope: WhatsappBotConfig = {
      persona: null,
      sendScope: 'dm_and_groups',
      groupOptIn: ['120@g.us'],
    }
    const d = deps({ runAssistant })
    await buildWhatsappBotHandler(d, groupScope, groupInput).handle()

    // Groups stay trigger-gated even in full-assistant mode.
    expect(d.evalTrigger).toHaveBeenCalledOnce()
    expect(runAssistant).toHaveBeenCalledWith(groupInput)
    expect(d.generateReply).not.toHaveBeenCalled()
  })
})
