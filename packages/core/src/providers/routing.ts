/**
 * Routing provider — model id → provider instance, per request.
 *
 * `createRoutingProvider(providers)` implements `LLMProvider` and dispatches
 * every `stream()` / `createSession()` call on the request's model id via
 * the model registry (docs/architecture/platform/model-registry.md): the
 * model's registry row names its provider; the routing table holds one
 * ALREADY-WRAPPED instance per configured provider (wrapper composition is
 * per-provider — plan L2 — boot wraps each instance before handing it in).
 *
 * Unknown model id → loud error (never a silent pass-through to some
 * default vendor). Provider configured in the registry but absent from the
 * table (missing API key) → loud error too; menus must never offer such a
 * model in the first place (plan L12 — keyless models are absent, and the
 * boot-time menu derivation enforces it).
 *
 * Fallback is same-class only (plan L2): a registry row may name a
 * `fallbackAlias`; the routing provider wraps that row's dispatch in
 * `wrapFallback` targeting the fallback row's provider — but ONLY when the
 * fallback row shares the primary row's class (an outage never upgrades or
 * downgrades a billing class silently) and its provider is configured.
 * Rows without a same-class fallback simply fail over nothing — a Max
 * outage surfaces as an error rather than billing Max revenue for
 * standard-class serving.
 */
import { registryRow, type ModelRegistryRow } from '@use-brian/shared/model-registry'
import type { LLMProvider, ProviderRequest, ProviderSession, SessionOptions, StreamChunk } from './types.js'
import { wrapFallback, type FallbackAnalytics } from './wrap-fallback.js'

export type RoutingProviderOptions = {
  /** Forwarded to `wrapFallback` for every routed same-class fallback pair —
   * keeps the `llm_provider_fallback` analytics event emitting. */
  analytics?: FallbackAnalytics
}

export function createRoutingProvider(
  providers: Record<string, LLMProvider>,
  options?: RoutingProviderOptions,
): LLMProvider {
  // Effective provider per registry row (fallback-wrapped where the row asks
  // for it), memoized per model alias — wrapFallback allocation happens once.
  const effectiveByAlias = new Map<string, LLMProvider>()

  function effectiveFor(model: string): LLMProvider {
    const row = registryRow(model)
    if (!row) {
      throw new Error(
        `[routing] unknown model id '${model}' — no model-registry row. ` +
        `Add one to packages/shared/src/model-registry.ts (docs/architecture/platform/model-registry.md).`,
      )
    }
    const cached = effectiveByAlias.get(row.alias)
    if (cached) return cached

    const base = providers[row.provider]
    if (!base) {
      throw new Error(
        `[routing] model '${model}' routes to provider '${row.provider}', which is not configured ` +
        `(missing API key?). Keyless models must be absent from every menu (plan L12).`,
      )
    }

    const effective = withFallback(row, base)
    effectiveByAlias.set(row.alias, effective)
    return effective
  }

  function withFallback(row: ModelRegistryRow, base: LLMProvider): LLMProvider {
    if (!row.fallbackAlias) return base
    const fbRow = registryRow(row.fallbackAlias)
    if (!fbRow) {
      throw new Error(`[routing] '${row.alias}' names unknown fallbackAlias '${row.fallbackAlias}'`)
    }
    if (fbRow.class !== row.class) {
      // Same-class only — a mis-declared registry row fails loud at first
      // use rather than silently swapping billing classes during an outage.
      throw new Error(
        `[routing] '${row.alias}' (class ${row.class}) declares cross-class fallback '${fbRow.alias}' (class ${fbRow.class}) — same-class only (plan L2)`,
      )
    }
    const fbProvider = providers[fbRow.provider]
    // Fallback provider not configured (no key) → run without fallback.
    // Availability is key presence (L12); the primary keeps serving.
    if (!fbProvider) return base
    return wrapFallback(base, fbProvider, {
      fallbackModel: row.fallbackAlias,
      ...(options?.analytics ? { analytics: options.analytics } : {}),
    })
  }

  return {
    name: 'routing',
    models: Object.values(providers).flatMap((p) => p.models),

    stream(request: ProviderRequest): AsyncIterable<StreamChunk> {
      return effectiveFor(request.model).stream(request)
    },

    createSession(sessionOpts: SessionOptions): ProviderSession {
      return effectiveFor(sessionOpts.model).createSession(sessionOpts)
    },
  }
}
