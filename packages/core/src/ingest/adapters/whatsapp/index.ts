/**
 * WhatsApp canonical source adapter — public surface.
 *
 * Aggregates the per-source pieces a canonical adapter contributes:
 *
 *   - `source` — stable identifier matching `connector_instance.provider`
 *   - `normalize` — assembled group window → `EpisodeEnvelope`
 *     (`channel_window` kind, per-participant actors)
 *   - `filterImplementations` — `group_match` / `sender_match` / `is_dm`
 *     (run on the raw window — see filters.ts)
 *   - `defaultRules` — empty (default-drop)
 *
 * Pure TypeScript — no WhatsApp/Baileys calls, no DB (per
 * packages/core/CLAUDE.md). Inbound relay receiving + per-group windowing
 * live downstream in `packages/api-platform`.
 *
 * Only uniquely-named symbols are re-exported here (and bubble up through
 * the core barrel). The bare filter functions (`groupMatch`, `isDm`, …)
 * and the generic `is_dm` param schema/type stay module-local to avoid
 * colliding with the Slack adapter's identically-named exports — tests
 * import them from `./filters.js` directly.
 *
 * [COMP:brain/source-adapters/whatsapp]
 */

export { normalizeWhatsappGroup } from './normalize.js'
export type {
  WhatsappGroupWindow,
  WhatsappIngestContext,
  WhatsappMessage,
} from './types.js'

export {
  whatsappFilterImplementations,
  whatsappFilterParamsSchemas,
  type GroupMatchParams,
  type SenderMatchParams,
  type WhatsappFilterType,
} from './filters.js'

export {
  whatsappDefaultRules,
  type WhatsappDefaultRule,
} from './default-rules.js'

import { normalizeWhatsappGroup } from './normalize.js'
import {
  whatsappFilterImplementations,
  whatsappFilterParamsSchemas,
} from './filters.js'
import { whatsappDefaultRules } from './default-rules.js'

/** Aggregate WhatsApp adapter. Mirrors `slackAdapter`'s shape. */
export const whatsappAdapter = {
  source: 'whatsapp' as const,
  normalize: normalizeWhatsappGroup,
  filterImplementations: whatsappFilterImplementations,
  filterParamsSchemas: whatsappFilterParamsSchemas,
  defaultRules: whatsappDefaultRules,
}

export type WhatsappAdapter = typeof whatsappAdapter
