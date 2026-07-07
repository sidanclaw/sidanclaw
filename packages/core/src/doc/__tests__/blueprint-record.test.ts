import { describe, it, expect } from 'vitest'
import { blockSchema } from '../../views/blocks.js'
import { extractionSpecSchema, type ExtractionField } from '../custom-template-types.js'
import {
  blueprintRecordToBlocks,
  formatFieldValueText,
  recordCompleteness,
  validateFieldValue,
} from '../blueprint-record.js'

const SPEC = extractionSpecSchema.parse({
  fields: [
    { key: 'summary', heading: 'Summary', instruction: 'sum it', type: 'markdown', required: true },
    { key: 'budget', heading: 'Budget', instruction: 'annual', type: 'number', required: true },
    { key: 'close-date', heading: 'Close date', instruction: 'when', type: 'date' },
    { key: 'active', heading: 'Active', instruction: 'is it', type: 'boolean' },
    { key: 'stage', heading: 'Stage', instruction: 'pick', type: 'enum', options: ['Prospect', 'Won'] },
    { key: 'account', heading: 'Account', instruction: 'who', type: 'entityRef', entityKind: 'company' },
  ],
})
const field = (key: string): ExtractionField => {
  const f = SPEC.fields.find((f) => f.key === key)
  if (!f) throw new Error(`no field ${key}`)
  return f
}

describe('[COMP:doc/blueprint-record] blueprint record contract helpers', () => {
  it('validates + canonicalizes values per type', () => {
    expect(validateFieldValue(field('summary'), '  text ')).toEqual({ ok: true, value: 'text' })
    expect(validateFieldValue(field('summary'), '').ok).toBe(false)
    expect(validateFieldValue(field('summary'), null).ok).toBe(false)

    expect(validateFieldValue(field('budget'), 42)).toEqual({ ok: true, value: 42 })
    expect(validateFieldValue(field('budget'), ' 42.5 ')).toEqual({ ok: true, value: 42.5 })
    expect(validateFieldValue(field('budget'), 'lots').ok).toBe(false)

    expect(validateFieldValue(field('close-date'), '2026-07-07')).toEqual({ ok: true, value: '2026-07-07' })
    expect(validateFieldValue(field('close-date'), '07/07/2026').ok).toBe(false)
    expect(validateFieldValue(field('close-date'), '2026-13-99').ok).toBe(false)

    expect(validateFieldValue(field('active'), true)).toEqual({ ok: true, value: true })
    expect(validateFieldValue(field('active'), 'false')).toEqual({ ok: true, value: false })
    expect(validateFieldValue(field('active'), 'yep').ok).toBe(false)

    // Enum matching is case-insensitive but canonicalizes to the option casing.
    expect(validateFieldValue(field('stage'), 'won')).toEqual({ ok: true, value: 'Won' })
    expect(validateFieldValue(field('stage'), 'Lost').ok).toBe(false)

    // entityRef accepts a bare name or an object; kind defaults from the field.
    expect(validateFieldValue(field('account'), 'Acme')).toEqual({
      ok: true,
      value: { name: 'Acme', kind: 'company' },
    })
    expect(validateFieldValue(field('account'), { name: 'Acme', entityId: 'e1' })).toEqual({
      ok: true,
      value: { name: 'Acme', entityId: 'e1', kind: 'company' },
    })
    expect(validateFieldValue(field('account'), { name: 'Acme', kind: 'contact' }).ok).toBe(false)
    expect(validateFieldValue(field('account'), {}).ok).toBe(false)
  })

  it('computes completeness from required coverage only', () => {
    expect(recordCompleteness(SPEC.fields, { summary: 'x', budget: 1 })).toEqual({
      status: 'complete',
      missing: [],
    })
    expect(recordCompleteness(SPEC.fields, { summary: 'x', stage: 'Won' })).toEqual({
      status: 'incomplete',
      missing: ['budget'],
    })
  })

  it('projects a record onto schema-valid page blocks, skipping unwritten fields', () => {
    let n = 0
    const genId = () => `blk-${n++}`
    const blocks = blueprintRecordToBlocks(
      SPEC.fields,
      {
        summary: 'One line.\n\n- a\n- b',
        budget: 120000,
        active: true,
        account: { name: 'Acme', kind: 'company' },
      },
      genId,
    )
    // Headings appear only for written fields, in contract order.
    const headings = blocks.filter((b) => b.kind === 'heading').map((b) => (b as { text: string }).text)
    expect(headings).toEqual(['Summary', 'Budget', 'Active', 'Account'])
    // Markdown expands into multiple blocks; typed values render as one text line.
    expect(blocks.some((b) => b.kind === 'bulleted_list_item' || b.kind === 'text')).toBe(true)
    blocks.forEach((b) => expect(() => blockSchema.parse(b)).not.toThrow())
    // Typed value formatting.
    expect(formatFieldValueText(field('active'), true)).toBe('Yes')
    expect(formatFieldValueText(field('account'), { name: 'Acme' })).toBe('Acme')
  })
})
