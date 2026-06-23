import { describe, it, expect } from 'vitest'

import { groupMatch, senderMatch, isDm, whatsappFilterImplementations } from '../filters.js'
import type { WhatsappGroupWindow } from '../types.js'

const GROUP = '120363000000000000@g.us'
const OTHER_GROUP = '120363999999999999@g.us'
const ALICE = '111@s.whatsapp.net'
const BOB = '222@s.whatsapp.net'

function makeWindow(overrides: Partial<WhatsappGroupWindow> = {}): WhatsappGroupWindow {
  return {
    chat_jid: GROUP,
    messages: [
      { message_id: 'm1', sender_jid: ALICE, text: 'hi', timestamp: 1 },
    ],
    ...overrides,
  }
}

describe('[COMP:brain/source-adapters/whatsapp] WhatsApp filters', () => {
  describe('group_match — the enable gate', () => {
    it('matches when the chat JID is in the enabled list', () => {
      expect(groupMatch(makeWindow(), { values: [GROUP] })).toBe(true)
    })

    it('drops a group not in the enabled list (default-drop)', () => {
      expect(groupMatch(makeWindow(), { values: [OTHER_GROUP] })).toBe(false)
    })
  })

  describe('sender_match — window-aware', () => {
    it('matches when any participant is in the list', () => {
      const window = makeWindow({
        messages: [
          { message_id: 'm1', sender_jid: ALICE, text: 'a', timestamp: 1 },
          { message_id: 'm2', sender_jid: BOB, text: 'b', timestamp: 2 },
        ],
      })
      expect(senderMatch(window, { values: [BOB] })).toBe(true)
    })

    it('does not match when no participant is in the list', () => {
      expect(senderMatch(makeWindow(), { values: [BOB] })).toBe(false)
    })
  })

  describe('is_dm', () => {
    it('is false for a group chat', () => {
      expect(isDm(makeWindow(), {})).toBe(false)
    })

    it('is true for a direct message JID', () => {
      expect(isDm(makeWindow({ chat_jid: ALICE }), {})).toBe(true)
    })
  })

  it('registry exposes group_match / sender_match / is_dm', () => {
    expect(Object.keys(whatsappFilterImplementations).sort()).toEqual([
      'group_match',
      'is_dm',
      'sender_match',
    ])
  })
})
