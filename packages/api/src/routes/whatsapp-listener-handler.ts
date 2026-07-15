/**
 * WhatsApp ListenerHandler — the read-only ingest handler in the dispatcher
 * fan-out (`whatsapp-dispatcher.ts`).
 *
 * Wraps the `WhatsappIngestor`: writes every human GROUP message to the brain
 * (Episode → Pipeline B, attributed per real sender) and **never sends**. The
 * read-only Bring-Your-Own-Number ingests team groups and drops everything else,
 * so the handler is built only for group messages; a DM (or any non-group)
 * yields `null` and nothing is ingested.
 *
 * This is the listener half of the listener/bot split (decision #1: the listener
 * is the sole brain writer). The bot half is built separately in Phase 4.
 *
 * [COMP:api/whatsapp-ingest]
 */

import type { WhatsappIngestor } from '../ingest/whatsapp-ingest.js'
import type { WhatsAppHandler } from './whatsapp-dispatcher.js'

/** The inbound fields the listener forwards to the ingestor. */
export type WhatsappListenerInput = {
  channelId: string
  chatJid: string
  senderJid: string
  senderName?: string
  messageId: string
  text: string
  timestamp: number
  isGroup: boolean
}

/**
 * Build the listener handler for one inbound message, or `null` when there is
 * nothing to ingest:
 *   - no ingestor configured, or
 *   - the message is not a group message (the read-only number ingests team
 *     groups only).
 *
 * The returned handler swallows the ingestor's resolved value — the dispatcher
 * only cares that the handler settles; `runHandlers` isolates any failure.
 */
export function buildWhatsappListenerHandler(
  ingestor: WhatsappIngestor | undefined,
  input: WhatsappListenerInput,
): WhatsAppHandler | null {
  if (!ingestor || !input.isGroup) return null
  return {
    kind: 'listener',
    handle: () =>
      ingestor
        .ingest({
          channelId: input.channelId,
          chatJid: input.chatJid,
          senderJid: input.senderJid,
          senderName: input.senderName,
          messageId: input.messageId,
          text: input.text,
          timestamp: input.timestamp,
          isGroup: input.isGroup,
        })
        .then(() => {}),
  }
}
