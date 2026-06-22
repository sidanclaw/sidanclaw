/**
 * Fixture test for the doc-architect built-in skill.
 * Component tag: [COMP:engine/doc-architect-skill].
 *
 * Loads the built-in skill registry and asserts the doc-architect skill's
 * frontmatter (productivity category, builtin source, not app-type-gated so
 * it surfaces everywhere) and that its recipe body wires the real canvas
 * doc tools (renderPage / patchPage / createSubPage) and at least one rich
 * block kind. A rename of any of those tools, or a copy-paste that drops the
 * structural-only guardrail, breaks this test rather than silently leaving
 * the skill pointing at dead names.
 */

import { describe, it, expect } from 'vitest'
import { loadBuiltinSkills } from '../loader.js'

const skill = loadBuiltinSkills().find((s) => s.id === 'doc-architect')

describe('[COMP:engine/doc-architect-skill] doc-architect skill', () => {
  it('is registered as a built-in skill', () => {
    expect(skill).toBeDefined()
    expect(skill?.source).toBe('builtin')
  })

  it('is a productivity skill, surfaced in every app (not app-type-gated)', () => {
    expect(skill?.category).toBe('productivity')
    expect(skill?.appliesToAppType).toBeUndefined()
    expect((skill?.whenToUse ?? '').length).toBeGreaterThan(0)
  })

  it('wires the real canvas doc tools in its recipe body', () => {
    const body = skill?.content ?? ''
    expect(body).toContain('renderPage')
    expect(body).toContain('patchPage')
    expect(body).toContain('createSubPage')
  })

  it('teaches at least one rich block kind beyond plain text', () => {
    const body = skill?.content ?? ''
    expect(body).toMatch(/\btable\b/)
    expect(body).toMatch(/\bdata\b/)
    expect(body).toMatch(/\bcallout\b/)
  })

  it('documents when to use and when to skip', () => {
    const body = skill?.content ?? ''
    expect(body).toContain('## When to use')
    expect(body).toMatch(/\*\*Skip\*\* when/)
  })

  it('keeps the structural-only guardrail (never rewrites substance)', () => {
    expect(skill?.content ?? '').toMatch(/never rewrite|reshape the container|structural|never touch substance|never the content/i)
  })
})
