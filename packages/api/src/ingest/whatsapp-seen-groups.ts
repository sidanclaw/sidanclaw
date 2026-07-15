/**
 * WhatsApp seen-group inventory — the enable-list + eligibility signal.
 *
 * wa-connector exposes no group-roster endpoint: a linked companion device
 * only receives messages. So the set of groups the owner can enable in
 * Studio is built incrementally from what we observe — every group the
 * connected number is active in gets recorded into
 * `channel_integrations.config.seenChats` at intake time (before the
 * default-drop, see `whatsapp-ingest.ts`). A group is eligible to enable
 * once it appears here: "the connected number is a participant" is exactly
 * "we have received a message from this group" (the locked v1 eligibility
 * model — connected-number presence).
 *
 * Reuses the `SeenChat` shape the Telegram BYO route writes (`telegram-byo.ts`
 * `persistSeenChat`); WhatsApp groups are never forums, so `isForum=false`
 * and `topics=[]`. Writes are throttled by `mergeConfigSystem` returning the
 * unchanged config when nothing new is learned, so a busy group does not
 * hammer the DB.
 *
 * Spec: docs/architecture/channels/whatsapp.md → "Connect + enable";
 * docs/architecture/channels/whatsapp.md §The gate.
 *
 * [COMP:api/whatsapp-seen-groups]
 */

import type {
  ChannelIntegrationStore,
  SeenChat,
} from '../db/channel-integrations.js'

/** Re-record a `seenChats` entry no more than once per hour (matches Telegram). */
const SEEN_GROUP_STALE_MS = 60 * 60 * 1000

/**
 * Sentinel `lastSeenAt` for a group learned from the live roster but never yet
 * observed sending a message. Epoch sorts it *after* any message-active group
 * (the recency ordering the enable UI relies on) while keeping a parseable
 * timestamp so a later real message refreshes it via the stale check. */
const ROSTER_ONLY_LAST_SEEN = new Date(0).toISOString()

export type RecordSeenWhatsappGroupInput = {
  channelIntegrationId: string
  /** Group chat JID (`<id>@g.us`). */
  chatJid: string
  /** Group subject, when the relay supplied one (absent in v1 payloads). */
  subject?: string
}

/**
 * Idempotently record (or refresh) one observed WhatsApp group on the
 * integration's `seenChats`. Adds a new entry the first time a group is
 * seen; otherwise updates the title (if newly known) and refreshes
 * `lastSeenAt` at most hourly. Returns nothing — callers treat it as
 * best-effort and never block ingest on it.
 */
export async function recordSeenWhatsappGroup(
  store: Pick<ChannelIntegrationStore, 'mergeConfigSystem'>,
  input: RecordSeenWhatsappGroupInput,
): Promise<void> {
  await store.mergeConfigSystem(input.channelIntegrationId, (current) => {
    const seen = current.seenChats ?? []
    const now = new Date().toISOString()
    const title = input.subject?.trim() ? input.subject.trim() : null

    const existing = seen.find((c) => c.chatId === input.chatJid)
    if (!existing) {
      const next: SeenChat = {
        chatId: input.chatJid,
        chatTitle: title,
        isForum: false,
        topics: [],
        lastSeenAt: now,
      }
      return { ...current, seenChats: [...seen, next] }
    }

    // Already known — write only when we learn a title or the stamp is stale.
    const stale = Date.now() - Date.parse(existing.lastSeenAt) > SEEN_GROUP_STALE_MS
    const titleImproved = title !== null && title !== existing.chatTitle
    if (!stale && !titleImproved) return current

    return {
      ...current,
      seenChats: seen.map((c) =>
        c.chatId === input.chatJid
          ? { ...c, chatTitle: titleImproved ? title : c.chatTitle, lastSeenAt: now }
          : c,
      ),
    }
  })
}

/**
 * Durably fold the live group roster into `seenChats`.
 *
 * The Studio enable list is `roster ∪ seenChats`, but the wa-connector roster
 * (`groupFetchAllParticipating`) is transient — it returns `[]` on any failure
 * (socket reconnecting, connector flake, timeout). Without this, a flaky
 * re-fetch (e.g. right after a group is enabled) collapses the list to whatever
 * few groups have message activity, the search box vanishes, and the owner
 * can't reach the rest to enable them. Persisting the roster makes `seenChats`
 * the durable inventory it was always meant to be: the list only grows, so a
 * later empty roster fetch can't shrink it.
 *
 * New groups are added with an epoch `lastSeenAt` sentinel so they sort after
 * message-active groups; existing entries only get a title improvement and
 * **never** have their real `lastSeenAt` overwritten. Returns the config
 * unchanged when nothing is new (no DB write). Best-effort — callers never
 * block the response on it.
 *
 * Spec: docs/architecture/channels/whatsapp.md → "Eligibility (durable
 * inventory)".
 */
export async function recordRosteredWhatsappGroups(
  store: Pick<ChannelIntegrationStore, 'mergeConfigSystem'>,
  channelIntegrationId: string,
  roster: ReadonlyArray<{ jid: string; subject?: string }>,
): Promise<void> {
  if (roster.length === 0) return
  await store.mergeConfigSystem(channelIntegrationId, (current) => {
    const byId = new Map((current.seenChats ?? []).map((c) => [c.chatId, c]))
    let changed = false
    for (const g of roster) {
      if (!g.jid) continue
      const title = g.subject?.trim() ? g.subject.trim() : null
      const existing = byId.get(g.jid)
      if (!existing) {
        byId.set(g.jid, {
          chatId: g.jid,
          chatTitle: title,
          isForum: false,
          topics: [],
          lastSeenAt: ROSTER_ONLY_LAST_SEEN,
        })
        changed = true
      } else if (title !== null && title !== existing.chatTitle) {
        byId.set(g.jid, { ...existing, chatTitle: title })
        changed = true
      }
    }
    return changed ? { ...current, seenChats: [...byId.values()] } : current
  })
}
