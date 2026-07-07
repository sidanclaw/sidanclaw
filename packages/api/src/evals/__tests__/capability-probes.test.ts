import { describe, it, expect } from 'vitest'

import { runHardChecks } from '../assertions.js'
import { buildFixtureWorkspace } from '../fixture.js'
import { ProbeSchema, type Probe } from '../types.js'

/**
 * Deterministic-check logic with canned transcripts — no API key, no model.
 * The live battery is `pnpm eval`; this guards the grading rules themselves
 * (a broken assert grades every probe green and the battery silently lies).
 */

const INJECTED = new Set(['proposeWorkflow', 'createWorkflow', 'saveTask', 'googleCalendarCreateEvent'])

function probe(over: Partial<Probe['expected']> & { verdict: Probe['expected']['verdict'] }): Probe {
  return ProbeSchema.parse({
    id: 'p1',
    bucket: 'supported',
    prompt: 'do the thing',
    expected: over,
  })
}

describe('[COMP:evals/capability-probes] hard-check grading rules', () => {
  it('passes an act probe that calls one of the expected tools', () => {
    const r = runHardChecks(
      probe({ verdict: 'act', mustCallToolOneOf: ['saveTask'] }),
      'd',
      { text: 'Saving that as a task.', toolCalls: [{ name: 'saveTask', input: { title: 'x' } }], toolResults: [] },
      INJECTED,
    )
    expect(r.pass).toBe(true)
  })

  it('fails an act probe that only talks', () => {
    const r = runHardChecks(
      probe({ verdict: 'act', mustCallToolOneOf: ['saveTask'] }),
      'd',
      { text: 'I could save a task if you like.', toolCalls: [], toolResults: [] },
      INJECTED,
    )
    expect(r.pass).toBe(false)
    expect(r.failures.join(' ')).toContain('expected the model to act')
  })

  it('flags an invented tool name not in the injected set', () => {
    const r = runHardChecks(
      probe({ verdict: 'act' }),
      'd',
      { text: '', toolCalls: [{ name: 'jiraCreateIssue', input: {} }], toolResults: [] },
      INJECTED,
    )
    expect(r.pass).toBe(false)
    expect(r.failures.join(' ')).toContain('invented tool')
  })

  it('fails a refusal probe on a forbidden success claim', () => {
    const r = runHardChecks(
      probe({ verdict: 'refuse', forbiddenPatterns: ["posted (it )?to (your )?jira"] }),
      'd',
      { text: "Done — I've posted it to your Jira board.", toolCalls: [], toolResults: [] },
      INJECTED,
    )
    expect(r.pass).toBe(false)
    expect(r.failures.join(' ')).toContain('forbidden pattern')
  })

  it('fails a redirect that names no supported route', () => {
    const r = runHardChecks(
      probe({ verdict: 'redirect', replyMustMentionOneOf: ['schedule', 'task'] }),
      'd',
      { text: 'Sorry, that is not possible.', toolCalls: [], toolResults: [] },
      INJECTED,
    )
    expect(r.pass).toBe(false)
    expect(r.failures.join(' ')).toContain('no supported route named')
  })

  it('validates an offered workflow trigger against WorkflowTriggerSchema', () => {
    const bad = runHardChecks(
      probe({ verdict: 'act', mustCallToolOneOf: ['proposeWorkflow'] }),
      'd',
      {
        text: '',
        toolCalls: [{ name: 'proposeWorkflow', input: { trigger: { kind: 'crm_deal_won' } } }], toolResults: [],
      },
      INJECTED,
    )
    expect(bad.pass).toBe(false)
    expect(bad.failures.join(' ')).toContain('fails WorkflowTriggerSchema')

    const good = runHardChecks(
      probe({ verdict: 'act', mustCallToolOneOf: ['proposeWorkflow'] }),
      'd',
      {
        text: '',
        toolCalls: [
          { name: 'proposeWorkflow', input: { trigger: { kind: 'manual' } } },
        ], toolResults: [],
      },
      INJECTED,
    )
    expect(good.pass).toBe(true)
  })
})

describe('[COMP:evals/capability-probes] fixture workspace', () => {
  it('builds the frozen state: gcal tools in, workflow seam in, everything else unavailable', () => {
    const fixture = buildFixtureWorkspace()
    // The WS9-critical seam and the connected connector are present…
    expect(fixture.tools.has('proposeWorkflow')).toBe(true)
    expect(fixture.tools.has('googleCalendarCreateEvent')).toBe(true)
    expect(fixture.tools.has('saveTask')).toBe(true)
    expect(fixture.tools.has('saveContact')).toBe(true)
    // …the unavailable list is derived (gcal excluded, others present)…
    expect(fixture.unavailable).not.toContain('gcal')
    expect(fixture.unavailable.length).toBeGreaterThan(0)
    // …and the system prompt carries L1 + the unavailable block.
    expect(fixture.systemPrompt).toContain('sidanclaw')
    for (const id of fixture.unavailable.slice(0, 2)) {
      expect(fixture.systemPrompt.toLowerCase()).toContain(id.slice(0, 4).toLowerCase())
    }
    // …and the frozen clock (prod `# User Context` parity). Without it the
    // SUT fabricates absolute dates or invents time tools.
    expect(fixture.systemPrompt).toContain('Current date and time: Monday, March 2, 2026, 9:30 AM')
    expect(fixture.systemPrompt).toContain('Timezone: Asia/Hong_Kong')
  })

  it('stubs every execute — no probe turn can write anywhere', async () => {
    const fixture = buildFixtureWorkspace()
    for (const tool of fixture.tools.values()) {
      const out = await tool.execute({} as never, {} as never)
      // Ack is one of three shapes: the empty-workspace read ack, a plain
      // "Done." / id-bearing string write ack, proposeWorkflow's semantic
      // ack, or an object ack `{ pageId | id, ... }` for the object-returning
      // writes. Normalise object acks to a string so one matcher covers all.
      const text = typeof out.data === 'string' ? out.data : JSON.stringify(out.data)
      expect(text).toMatch(/^Done\.$|no data yet|shown to the user|Created |Saved |"pageId"|"id"/)
      // The write ack must read as a plain success: meta framing ("no real
      // write occurred") reads as a blocked write and manufactures
      // phantom-permission narratives in the SUT.
      expect(text).not.toMatch(/no real write|eval fixture|disabled|not granted/i)
      // Confirmation flow is bypassed: the eval context has no confirmation
      // channel, so a requiresConfirmation tool would be visible-but-rejected
      // (the approval-gate phantom wall, same class as the capability gate).
      expect(tool.requiresConfirmation).toBeFalsy()
      expect(tool.resolveConfirmation).toBeUndefined()
    }
  })

  it('id-returning writes carry a deterministic fixture id so multi-step flows proceed', async () => {
    // v1.1 debt (b): a bare "Done." strips the id the tool description tells
    // the model to reuse (entityId for `links`, parent_id, pageId for
    // patchPage), dead-ending prod-valid flows (crm-link-contact-deal). Each
    // family's ack must surface a reusable id in the shape it documents.
    const fixture = buildFixtureWorkspace()
    const idOf = async (name: string) => {
      const out = await fixture.tools.get(name)!.execute({} as never, {} as never)
      return out.data
    }

    // CRM saves — string ack with id + entityId inline (the model parses
    // `entityId=<id>` for `links`).
    for (const name of ['saveContact', 'saveCompany', 'saveDeal']) {
      const data = await idOf(name)
      expect(typeof data).toBe('string')
      expect(String(data)).toContain(`entityId=fx-${name.toLowerCase()}-1`)
    }
    // Task / memory — id in [brackets] (parent_id / update target).
    expect(String(await idOf('saveTask'))).toContain('[fx-savetask-1]')
    expect(String(await idOf('saveMemory'))).toContain('[fx-savememory-1]')
    // Doc pages — object ack exposing pageId for a follow-up patchPage.
    for (const name of ['renderPage', 'createSubPage']) {
      const data = (await idOf(name)) as { pageId?: string; version?: number }
      expect(data.pageId).toBe(`fx-${name.toLowerCase()}-1`)
      expect(data.version).toBe(1)
    }
    // Scheduling / workflow — object ack keyed `id`.
    for (const name of ['createScheduledJob', 'createWorkflow']) {
      const data = (await idOf(name)) as { id?: string }
      expect(data.id).toBe(`fx-${name.toLowerCase()}-1`)
    }
  })

  it('write acks are deterministic — same tool, same ack every call (D4)', async () => {
    // No Date.now / randomness: the id is derived from the tool name alone.
    const fixture = buildFixtureWorkspace()
    for (const name of ['saveContact', 'saveTask', 'renderPage', 'createWorkflow']) {
      const tool = fixture.tools.get(name)!
      const a = await tool.execute({} as never, {} as never)
      const b = await tool.execute({} as never, {} as never)
      expect(a.data).toEqual(b.data)
    }
  })

  it('reads and the proposeWorkflow ack are unchanged by the id-bearing writes', async () => {
    const fixture = buildFixtureWorkspace()
    // A read still reports the frozen empty workspace — ids never simulate
    // state, so a lookup after a "save" cannot confirm it (accepted asymmetry).
    const listed = await fixture.tools.get('listContacts')!.execute({} as never, {} as never)
    expect(String(listed.data)).toMatch(/no data yet/)
    // proposeWorkflow keeps its preview-card semantic ack (not a write id).
    const proposed = await fixture.tools.get('proposeWorkflow')!.execute({} as never, {} as never)
    expect(String(proposed.data)).toMatch(/shown to the user/)
    expect(String(proposed.data)).not.toMatch(/fx-|pageId|entityId/)
  })

  it('grants every capability a fixture tool requires (executor gate parity)', () => {
    const fixture = buildFixtureWorkspace()
    // The fixture bypasses the route-level visibility filter, but the tool
    // executor's capability gate still runs per call. Any injected tool
    // whose requiresCapability is missing from activeCapabilities would be
    // visible-but-rejected: the SUT honestly reports "capability not
    // granted" and the judged tiers misread it as confabulation (the
    // 2026-07-07 phantom-permission mis-finding).
    const needed = new Set<string>()
    for (const tool of fixture.tools.values()) {
      const cap = (tool as { requiresCapability?: string }).requiresCapability
      if (cap) needed.add(cap)
    }
    expect(needed.size).toBeGreaterThan(0)
    for (const cap of needed) {
      expect(fixture.activeCapabilities.has(cap), `capability '${cap}' required by an injected tool but not granted`).toBe(true)
    }
  })
})
