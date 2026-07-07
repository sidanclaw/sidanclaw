/**
 * Zod helper schemas for first-party tool input tolerance.
 *
 * The production failure class: models emit stringly-typed values for boolean
 * and number params (e.g. `include_archived: "true"`, `limit: "10"`) and
 * domain-name / slug strings for UUID params (e.g.
 * `listEntityTypes({ workspaceId: "fls.com.hk" })`). These helpers accept the
 * model-typical forms and coerce them correctly, or reject them with an
 * actionable error message.
 *
 * Do NOT use `z.coerce.boolean()` for booleans: `Boolean("false") === true`,
 * which silently inverts the intent. Use `tolerantBoolean()` instead.
 *
 * See docs/architecture/engine/tool-input-tolerance.md.
 *
 * [COMP:engine/tool-input-tolerance]
 */

import { z } from 'zod'

// ── tolerantBoolean ──────────────────────────────────────────────────────────

/**
 * Accepts a real boolean OR the strings `"true"` / `"false"` (any case) and
 * maps them to the correct boolean value. Rejects everything else.
 *
 * Use instead of `z.boolean()` on any tool param that a model plausibly passes
 * as a string (flags, toggles, include_* options).
 *
 * NEVER use `z.coerce.boolean()` — `Boolean("false") === true` would flip
 * `include_archived: "false"` to `true`.
 */
export function tolerantBoolean(): z.ZodType<boolean, z.ZodTypeDef, unknown> {
  return z.preprocess((v) => {
    if (typeof v === 'boolean') return v
    if (typeof v === 'string') {
      const lower = v.trim().toLowerCase()
      if (lower === 'true') return true
      if (lower === 'false') return false
    }
    return v
  }, z.boolean())
}

// ── tolerantNumber / tolerantInt ─────────────────────────────────────────────

/**
 * Accepts a real number OR a numeric string and coerces to a number.
 * Optional `min` / `max` refinements applied after coercion.
 *
 * Use for any tool param that a model may pass as a quoted number
 * (e.g. `limit: "25"`).
 */
export function tolerantNumber(opts?: { min?: number; max?: number }): z.ZodType<number> {
  let schema = z.coerce.number()
  if (opts?.min !== undefined) schema = schema.min(opts.min) as typeof schema
  if (opts?.max !== undefined) schema = schema.max(opts.max) as typeof schema
  return schema
}

/**
 * Accepts a real integer OR a numeric string and coerces to an integer.
 * Rejects non-integer values (e.g. 2.7). Optional `min` / `max` applied after
 * coercion.
 *
 * Use for count / limit params that a model may pass as a quoted number.
 */
export function tolerantInt(opts?: { min?: number; max?: number }): z.ZodType<number> {
  let schema = z.coerce.number().int('must be an integer')
  if (opts?.min !== undefined) schema = schema.min(opts.min) as typeof schema
  if (opts?.max !== undefined) schema = schema.max(opts.max) as typeof schema
  return schema
}

// ── uuidId ───────────────────────────────────────────────────────────────────

/**
 * UUID-validated string with an actionable error message that tells the model
 * to pass the UUID id (from a prior list/get call), never a name, domain, or
 * slug. Prevents DB errors like `invalid input syntax for type uuid`.
 *
 * `label` (optional) names the kind of id expected, improving the error
 * message (e.g. `"workspace"` → "workspaceId must be a UUID, not a name or
 * domain — use the id from a prior list/get call").
 */
export function uuidId(label?: string): z.ZodString {
  const prefix = label ? `${label}Id` : 'id'
  return z
    .string()
    .uuid(
      `${prefix} must be a UUID (e.g. "a1b2c3d4-..."), not a name, domain, or slug — pass the id from a prior list/get call`,
    )
}

// ── tolerantObject ───────────────────────────────────────────────────────────

/**
 * Accepts an object matching `schema` OR a JSON string that parses to such an
 * object. Useful for workflow step arrays where the model occasionally emits
 * JSON-serialised step objects instead of plain objects.
 *
 * JSON parse failures fall through to normal Zod validation (the raw string
 * hits the schema and produces the usual error); invalid JSON strings are also
 * passed through unchanged, so the error message stays informative.
 */
export function tolerantObject<T extends z.ZodTypeAny>(
  schema: T,
): z.ZodType<z.infer<T>, z.ZodTypeDef, unknown> {
  return z.preprocess((v) => {
    if (typeof v === 'string') {
      try {
        const parsed = JSON.parse(v)
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
          return parsed
        }
        // Parsed but not an object — let the raw value reach the schema so the
        // error names the actual type.
        return parsed
      } catch {
        // Invalid JSON — pass the raw string through for a normal schema error.
        return v
      }
    }
    return v
  }, schema)
}
