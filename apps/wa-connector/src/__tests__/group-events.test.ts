/**
 * Unit tests for the official-bot group-membership tap + leave.
 * Component tag: [COMP:wa-connector/group-events].
 *
 * Verifies that a `group-participants.update` where the bot's OWN jid is
 * added/removed forwards a `/internal/whatsapp/group-event` POST carrying the
 * adder (`author`), that unrelated participant changes / promote-demote do not
 * forward, and that groupLeave() drives the Baileys `groupLeave`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'

type FakeSocket = {
  ev: EventEmitter
  end: ReturnType<typeof vi.fn>
  sendMessage: ReturnType<typeof vi.fn>
  sendPresenceUpdate: ReturnType<typeof vi.fn>
  groupLeave: ReturnType<typeof vi.fn>
  user: { id: string }
}

const fakeSockets: FakeSocket[] = []

// The bot's own number (with a Baileys device suffix). Group events carry
// participant jids WITHOUT the suffix; jidNormalizedUser must reconcile them.
const BOT_JID_WITH_DEVICE = '15551234567:7@s.whatsapp.net'
const BOT_JID = '15551234567@s.whatsapp.net'
const ADDER_JID = '85291112222@s.whatsapp.net'
const GROUP_JID = '120363000000000000@g.us'

function makeFakeSocket(): FakeSocket {
  const s: FakeSocket = {
    ev: new EventEmitter(),
    end: vi.fn(),
    sendMessage: vi.fn().mockResolvedValue({ key: { id: 'wamsg-1' } }),
    sendPresenceUpdate: vi.fn().mockResolvedValue(undefined),
    groupLeave: vi.fn().mockResolvedValue(undefined),
    user: { id: BOT_JID_WITH_DEVICE },
  }
  fakeSockets.push(s)
  return s
}

vi.mock('@whiskeysockets/baileys', async (importOriginal) => {
  // Keep the real pure helpers (jidNormalizedUser); override only the socket
  // factory and network-touching exports.
  const actual = await importOriginal<typeof import('@whiskeysockets/baileys')>()
  return {
    ...actual,
    makeWASocket: vi.fn(() => makeFakeSocket()),
    fetchLatestBaileysVersion: vi.fn().mockResolvedValue({ version: [2, 3000, 0] }),
    makeCacheableSignalKeyStore: vi.fn((keys: unknown) => keys),
    DisconnectReason: { loggedOut: 401 },
    downloadMediaMessage: vi.fn(),
  }
})

vi.mock('../gcs-auth-state.js', () => ({
  useGCSAuthState: vi.fn().mockResolvedValue({ state: { creds: {}, keys: {} }, saveCreds: vi.fn() }),
  authStateExists: vi.fn(),
  deleteAuthState: vi.fn().mockResolvedValue(undefined),
  listStoredChannels: vi.fn().mockResolvedValue([]),
  waitForCredsSaveQueue: vi.fn().mockResolvedValue(undefined),
}))

import { createSocketManager } from '../socket-manager.js'

function manager() {
  return createSocketManager({
    bucket: {} as never,
    pool: null,
    apiUrl: 'http://api.test',
    connectorSecret: 'secret',
  })
}

/** Connect + open a socket so the event handlers and groupLeave work. */
async function connected() {
  const mgr = manager()
  await mgr.connect('official-1')
  fakeSockets[0].ev.emit('connection.update', { connection: 'open' })
  return mgr
}

/** Emit one group-participants.update and drain the async handler. */
async function emitGroupUpdate(update: {
  id: string
  author?: string
  participants: string[]
  action: string
}) {
  fakeSockets[0].ev.emit('group-participants.update', update)
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r))
}

/** The group-event POSTs made, parsed from the fetch mock. */
function groupEventForwards(fetchMock: ReturnType<typeof vi.fn>) {
  return fetchMock.mock.calls
    .filter((c) => String(c[0]) === 'http://api.test/internal/whatsapp/group-event')
    .map((c) => JSON.parse((c[1] as { body: string }).body))
}

beforeEach(() => {
  fakeSockets.length = 0
  vi.clearAllMocks()
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('[COMP:wa-connector/group-events] bot added / removed forwarding', () => {
  it('forwards an "added" group-event with the adder when the bot itself is added', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true })
    vi.stubGlobal('fetch', fetchMock)
    await connected()

    await emitGroupUpdate({
      id: GROUP_JID,
      author: ADDER_JID,
      participants: [BOT_JID],
      action: 'add',
    })

    const forwards = groupEventForwards(fetchMock)
    expect(forwards).toHaveLength(1)
    expect(forwards[0]).toEqual({
      channelId: 'official-1',
      groupJid: GROUP_JID,
      action: 'added',
      actorJid: ADDER_JID,
    })
    vi.unstubAllGlobals()
  })

  it('normalizes a device-suffixed self jid so the bot is recognized as added', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true })
    vi.stubGlobal('fetch', fetchMock)
    await connected()

    // Same number, carried with a device suffix in the event participants.
    await emitGroupUpdate({
      id: GROUP_JID,
      author: ADDER_JID,
      participants: ['15551234567:3@s.whatsapp.net'],
      action: 'add',
    })

    expect(groupEventForwards(fetchMock)).toHaveLength(1)
    vi.unstubAllGlobals()
  })

  it('forwards a "removed" group-event when the bot itself is removed', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true })
    vi.stubGlobal('fetch', fetchMock)
    await connected()

    await emitGroupUpdate({
      id: GROUP_JID,
      author: ADDER_JID,
      participants: [BOT_JID],
      action: 'remove',
    })

    const forwards = groupEventForwards(fetchMock)
    expect(forwards).toHaveLength(1)
    expect(forwards[0].action).toBe('removed')
    vi.unstubAllGlobals()
  })

  it('does NOT forward when someone else (not the bot) is added', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true })
    vi.stubGlobal('fetch', fetchMock)
    await connected()

    await emitGroupUpdate({
      id: GROUP_JID,
      author: ADDER_JID,
      participants: ['85299998888@s.whatsapp.net'],
      action: 'add',
    })

    expect(groupEventForwards(fetchMock)).toHaveLength(0)
    vi.unstubAllGlobals()
  })

  it('ignores promote/demote actions even for the bot', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true })
    vi.stubGlobal('fetch', fetchMock)
    await connected()

    await emitGroupUpdate({
      id: GROUP_JID,
      author: ADDER_JID,
      participants: [BOT_JID],
      action: 'promote',
    })

    expect(groupEventForwards(fetchMock)).toHaveLength(0)
    vi.unstubAllGlobals()
  })
})

describe('[COMP:wa-connector/group-events] groupLeave', () => {
  it('drives the Baileys groupLeave on a connected socket', async () => {
    const mgr = await connected()
    await mgr.groupLeave('official-1', GROUP_JID)
    expect(fakeSockets[0].groupLeave).toHaveBeenCalledWith(GROUP_JID)
  })

  it('throws when there is no connected socket', async () => {
    const mgr = manager()
    await expect(mgr.groupLeave('ghost', GROUP_JID)).rejects.toThrow(/No active/)
  })
})
