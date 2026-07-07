import { describe, it, expect } from 'vitest'
import { blockSchema, type Block } from '../../views/blocks.js'
import {
  blocksToExtractionSpec,
  extractionSpecSchema,
  extractionSpecToBlocks,
  normalizeExtractionSpec,
  type ExtractionSpec,
} from '../custom-template-types.js'

describe('[COMP:doc/blocks-to-extraction-spec] extraction_slot block + spec deriver', () => {
  it('parses an extraction_slot block via the canonical block schema (typed props optional)', () => {
    const parsed = blockSchema.parse({
      kind: 'extraction_slot',
      id: 'b1',
      instruction: 'Pull product / customers / revenue',
      outputType: 'list',
    })
    expect(parsed).toMatchObject({ kind: 'extraction_slot', instruction: 'Pull product / customers / revenue', outputType: 'list' })

    const typed = blockSchema.parse({
      kind: 'extraction_slot',
      id: 'b2',
      instruction: 'Deal stage',
      fieldKey: 'stage',
      fieldType: 'enum',
      options: ['prospect', 'won', 'lost'],
      required: true,
    })
    expect(typed).toMatchObject({ fieldKey: 'stage', fieldType: 'enum', required: true })
  })

  it('derives a typed contract: each extraction_slot pairs with its nearest preceding heading', () => {
    const blocks: Block[] = [
      { kind: 'heading', id: 'h1', level: 2, text: 'What the business does' },
      { kind: 'extraction_slot', id: 's1', instruction: 'product, customers, revenue', outputType: 'prose' },
      { kind: 'heading', id: 'h2', level: 2, text: 'Open risks' },
      { kind: 'extraction_slot', id: 's2', instruction: 'list the blockers', outputType: 'list' },
    ]
    const spec = blocksToExtractionSpec(blocks, ['company'])
    expect(spec).not.toBeNull()
    expect(spec?.fields).toEqual([
      {
        key: 'what-the-business-does',
        heading: 'What the business does',
        instruction: 'product, customers, revenue',
        type: 'markdown',
        required: false,
        outputType: 'prose',
      },
      {
        key: 'open-risks',
        heading: 'Open risks',
        instruction: 'list the blockers',
        type: 'markdown',
        required: false,
        outputType: 'list',
      },
    ])
    expect(spec?.capture).toEqual(['company'])
  })

  it('honors explicit fieldKey / fieldType / options / required on slots', () => {
    const blocks: Block[] = [
      { kind: 'heading', id: 'h1', level: 2, text: 'Deal stage' },
      {
        kind: 'extraction_slot',
        id: 's1',
        instruction: 'pick one',
        fieldKey: 'stage',
        fieldType: 'enum',
        options: ['prospect', 'won'],
        required: true,
      },
    ]
    const spec = blocksToExtractionSpec(blocks)
    expect(spec?.fields[0]).toMatchObject({
      key: 'stage',
      type: 'enum',
      options: ['prospect', 'won'],
      required: true,
    })
  })

  it('returns null when there are no extraction slots (a plain template skeleton)', () => {
    const blocks: Block[] = [
      { kind: 'heading', id: 'h1', level: 1, text: 'Notes' },
      { kind: 'text', id: 't1', text: 'just a page' },
    ]
    expect(blocksToExtractionSpec(blocks)).toBeNull()
  })

  it('defaults heading + outputType when an extraction slot has no heading above it', () => {
    const blocks: Block[] = [{ kind: 'extraction_slot', id: 's1', instruction: 'no heading above me' }]
    const spec = blocksToExtractionSpec(blocks)
    expect(spec?.fields[0]).toMatchObject({ heading: 'Section', outputType: 'prose', key: 'section' })
  })

  it('de-dupes derived keys when two slots share a heading', () => {
    const blocks: Block[] = [
      { kind: 'heading', id: 'h1', level: 2, text: 'Notes' },
      { kind: 'extraction_slot', id: 's1', instruction: 'a' },
      { kind: 'extraction_slot', id: 's2', instruction: 'b' },
    ]
    const spec = blocksToExtractionSpec(blocks)
    expect(spec?.fields.map((f) => f.key)).toEqual(['notes', 'notes-2'])
  })

  it('extractionSpecToBlocks builds a heading + extraction_slot pair per field (schema-valid)', () => {
    const spec = extractionSpecSchema.parse({
      fields: [
        { key: 'discovery', heading: 'Discovery', instruction: 'who + needs', type: 'markdown', outputType: 'prose' },
        { key: 'budget', heading: 'Budget', instruction: 'annual number', type: 'number', required: true },
      ],
      capture: ['contact'],
    })
    const blocks = extractionSpecToBlocks(spec)
    expect(blocks).toEqual([
      { kind: 'heading', id: 'bp-sec-0-h', level: 2, text: 'Discovery' },
      {
        kind: 'extraction_slot',
        id: 'bp-sec-0-s',
        instruction: 'who + needs',
        outputType: 'prose',
        fieldKey: 'discovery',
        fieldType: 'markdown',
      },
      { kind: 'heading', id: 'bp-sec-1-h', level: 2, text: 'Budget' },
      {
        kind: 'extraction_slot',
        id: 'bp-sec-1-s',
        instruction: 'annual number',
        outputType: undefined,
        fieldKey: 'budget',
        fieldType: 'number',
        required: true,
      },
    ])
    // Every generated block parses under the canonical block schema.
    blocks.forEach((b) => expect(() => blockSchema.parse(b)).not.toThrow())
  })

  it('round-trips: blocksToExtractionSpec(extractionSpecToBlocks(spec)) preserves the fields', () => {
    const spec: ExtractionSpec = extractionSpecSchema.parse({
      fields: [
        { key: 'a', heading: 'A', instruction: 'fill a', type: 'markdown', outputType: 'prose' },
        { key: 'close-date', heading: 'Close date', instruction: 'when', type: 'date', required: true },
        { key: 'stage', heading: 'Stage', instruction: 'pick', type: 'enum', options: ['x', 'y'] },
      ],
      capture: ['company'],
    })
    const back = blocksToExtractionSpec(extractionSpecToBlocks(spec), [...spec.capture])
    expect(back?.fields.map((f) => ({ ...f, outputType: f.outputType ?? 'prose' }))).toEqual(
      spec.fields.map((f) => ({ ...f, outputType: f.outputType ?? 'prose' })),
    )
    expect(back?.capture).toEqual(spec.capture)
  })

  it('lifts the v1 `sections` wire shape into typed markdown fields (parse + normalize)', () => {
    const v1 = {
      sections: [
        { heading: 'What the business does', instruction: 'product + customers', outputType: 'prose' },
        { heading: 'Open risks', instruction: 'blockers', outputType: 'list' },
        { heading: 'Open risks', instruction: 'dupe heading gets a suffixed key' },
      ],
      capture: ['company'],
    }
    const lifted = extractionSpecSchema.parse(v1)
    expect(lifted.fields.map((f) => f.key)).toEqual(['what-the-business-does', 'open-risks', 'open-risks-2'])
    expect(lifted.fields.every((f) => f.type === 'markdown' && f.required === false)).toBe(true)
    expect(lifted.capture).toEqual(['company'])

    // The store-boundary normalizer: v1 lifts, garbage nulls, null stays null.
    expect(normalizeExtractionSpec(v1)?.fields).toHaveLength(3)
    expect(normalizeExtractionSpec({ nonsense: true })).toBeNull()
    expect(normalizeExtractionSpec(null)).toBeNull()
  })

  it('rejects enum fields without options and duplicate keys', () => {
    expect(
      extractionSpecSchema.safeParse({
        fields: [{ key: 'stage', heading: 'Stage', instruction: 'pick', type: 'enum' }],
      }).success,
    ).toBe(false)
    expect(
      extractionSpecSchema.safeParse({
        fields: [
          { key: 'a', heading: 'A', instruction: 'x' },
          { key: 'a', heading: 'A again', instruction: 'y' },
        ],
      }).success,
    ).toBe(false)
  })
})
