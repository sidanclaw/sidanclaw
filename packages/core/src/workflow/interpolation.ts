/**
 * `{{vars.X}}`, `{{input.X}}` and `{{lastRun.X}}` substitution for
 * assistant_call.prompt and tool_call.arguments.
 *
 * `vars` / `input` are this run's accumulated state + trigger payload;
 * `lastRun` is the distilled outcome of the workflow's most recent terminal
 * run (`{{lastRun.summary}}` / `.todo` / `.blockers` / `.state.X` / `.logs` /
 * `.status`) — the cross-run loop substrate. Absent on the first run, so any
 * `{{lastRun.X}}` resolves to empty string. See
 * docs/architecture/features/workflow.md → "Cross-run state".
 *
 * Substitution only — no expressions, no operators. Anything richer goes
 * through a `branch` step.
 *
 * - String fields: each `{{path}}` is replaced. If the resolved value is a
 *   primitive, its string form is used; if it's an object/array, JSON is
 *   inlined. Missing paths → empty string + a soft warning recorded on the
 *   step (but not a failure — we tolerate "{{vars.summary}}" missing because
 *   a previous step's storeOutputAs was empty).
 * - Object / array fields: deep-walked. Non-string leaves pass through.
 *
 * [COMP:workflow/interpolation]
 */

const TOKEN = /\{\{\s*([a-zA-Z][a-zA-Z0-9_.]*)\s*\}\}/g

export type InterpolationScope = {
  vars: Record<string, unknown>
  input: Record<string, unknown>
  /**
   * Distilled outcome of the prior terminal run (the `WorkflowRunOutcome`
   * shape from `types.ts`). Undefined on the first run / when no prior
   * terminal run exists — every `{{lastRun.X}}` then resolves to empty string.
   */
  lastRun?: Record<string, unknown>
}

/** Substitute `{{...}}` tokens in a single string. */
export function interpolateString(s: string, scope: InterpolationScope): string {
  return s.replace(TOKEN, (_, path: string) => {
    const v = resolvePath(scope, path)
    if (v === undefined || v === null) return ''
    if (typeof v === 'string') return v
    if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return String(v)
    try {
      return JSON.stringify(v)
    } catch {
      return ''
    }
  })
}

/** Deep-walk: objects and arrays interpolated recursively, strings substituted. */
export function interpolateValue<T>(value: T, scope: InterpolationScope): T {
  if (typeof value === 'string') return interpolateString(value, scope) as unknown as T
  if (Array.isArray(value)) {
    return value.map((v) => interpolateValue(v, scope)) as unknown as T
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = interpolateValue(v, scope)
    }
    return out as unknown as T
  }
  return value
}

function resolvePath(scope: InterpolationScope, path: string): unknown {
  const segments = path.split('.')
  const head = segments[0]
  if (head !== 'vars' && head !== 'input' && head !== 'lastRun') return undefined
  let cursor: unknown = scope[head]
  for (let i = 1; i < segments.length; i++) {
    if (cursor === null || cursor === undefined) return undefined
    if (typeof cursor !== 'object') return undefined
    cursor = (cursor as Record<string, unknown>)[segments[i]]
  }
  return cursor
}
