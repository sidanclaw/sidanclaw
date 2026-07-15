/**
 * WhatsApp inbound dispatcher — capability-selected handler fan-out.
 *
 * Replaces the historical either/or branch in `whatsapp.ts` `/inbound`
 * (listener XOR responder). The dispatcher resolves a channel's capabilities
 * and fans the inbound message out to a *set* of handlers, read ADDITIVELY:
 *
 *   - `'ingest'` capability → the read-only **listener** (writes every human
 *     message to the brain, never sends).
 *   - `'chat'`   capability → the **bot** (replies when a trigger fires).
 *
 * A channel with both runs both, in parallel, with isolated failures — one
 * handler throwing never kills the other. With today's data no channel carries
 * both (a Bring-Your-Own-Number channel is `['ingest']`-only; the legacy
 * responder is not an ingest channel), so the fan-out reproduces current
 * behavior exactly — see `whatsapp.test.ts` § "BYON read-only gating".
 *
 * Phase 1 wires only the listener as a first-class handler; the `'chat'`
 * capability is still served by the legacy inline responder in `whatsapp.ts`.
 * Phase 4 plugs a real BotHandler into the `bot` slot of the registry and the
 * responder code moves behind it. Phase 6 swaps the capability resolver for a
 * per-assistant `enabled_capabilities` read (decision #4: one number per
 * assistant). See docs/architecture/channels/whatsapp.md.
 *
 * [COMP:api/whatsapp-dispatcher]
 */

/** Handler kinds that can subscribe to one WhatsApp inbound stream. */
export type WhatsAppHandlerKind = 'listener' | 'bot'

/**
 * Capabilities resolved for a channel, read additively (not either/or). Both
 * may be true → dual mode. Phase 1 derives these from the BYON ingest signal;
 * later phases read `channels.enabled_capabilities` directly.
 */
export type WhatsAppCapabilities = {
  /** `'ingest'` — the read-only listener writes to the brain. */
  listener: boolean
  /** `'chat'` — the bot may reply when triggered. */
  bot: boolean
}

/**
 * One subscriber to the inbound stream. The concrete message is closed over
 * when the handler is built per inbound message, so the dispatcher stays
 * agnostic to the WhatsApp payload shape.
 */
export interface WhatsAppHandler {
  readonly kind: WhatsAppHandlerKind
  handle(): Promise<void>
}

/** A null slot means "no handler for this kind yet" (e.g. bot in Phase 1). */
export type WhatsAppHandlerRegistry = {
  listener?: WhatsAppHandler | null
  bot?: WhatsAppHandler | null
}

/**
 * Select the handlers to run from resolved capabilities, additively and in a
 * stable order (listener before bot). A capability with no registered handler
 * is skipped rather than erroring.
 */
export function selectHandlers(
  caps: WhatsAppCapabilities,
  registry: WhatsAppHandlerRegistry,
): WhatsAppHandler[] {
  const handlers: WhatsAppHandler[] = []
  if (caps.listener && registry.listener) handlers.push(registry.listener)
  if (caps.bot && registry.bot) handlers.push(registry.bot)
  return handlers
}

/**
 * Run handlers concurrently with isolated failures: a handler that throws is
 * logged and swallowed so it cannot abort its siblings. Resolves once all
 * handlers settle. Never rejects.
 */
export async function runHandlers(handlers: WhatsAppHandler[]): Promise<void> {
  await Promise.all(
    handlers.map((h) =>
      h.handle().catch((err) => {
        console.error(`[whatsapp-dispatcher] ${h.kind} handler failed:`, err)
      }),
    ),
  )
}
