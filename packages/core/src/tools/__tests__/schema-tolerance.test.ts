/**
 * Tool-input tolerance helpers — the fix for the stringly-typed-args failure
 * class observed in production (2026-07-07 ability audit §2.2): models emit
 * `include_archived: "true"`, `limit: "10"`, JSON-serialised workflow steps,
 * and domain strings where UUIDs belong.
 *
 * Spec: docs/architecture/engine/tool-input-tolerance.md
 */

import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import {
  tolerantBoolean,
  tolerantNumber,
  tolerantInt,
  uuidId,
  tolerantObject,
} from '../schema-tolerance.js'

describe('[COMP:engine/tool-input-tolerance] schema tolerance helpers', () => {
  describe('tolerantBoolean', () => {
    it('accepts real booleans', () => {
      expect(tolerantBoolean().parse(true)).toBe(true)
      expect(tolerantBoolean().parse(false)).toBe(false)
    })

    it('maps "true"/"false" strings correctly — including the z.coerce.boolean trap', () => {
      expect(tolerantBoolean().parse('true')).toBe(true)
      // THE trap: Boolean('false') === true. This must map to false.
      expect(tolerantBoolean().parse('false')).toBe(false)
      expect(tolerantBoolean().parse('TRUE')).toBe(true)
      expect(tolerantBoolean().parse(' False ')).toBe(false)
    })

    it('rejects non-boolean words', () => {
      expect(() => tolerantBoolean().parse('yes')).toThrow()
      expect(() => tolerantBoolean().parse(1)).toThrow()
    })
  })

  describe('tolerantNumber / tolerantInt', () => {
    it('accepts numbers and numeric strings', () => {
      expect(tolerantNumber().parse(25)).toBe(25)
      expect(tolerantNumber().parse('25')).toBe(25)
      expect(tolerantInt({ min: 1, max: 100 }).parse('10')).toBe(10)
    })

    it('enforces int and bounds after coercion', () => {
      expect(() => tolerantInt().parse('2.7')).toThrow()
      expect(() => tolerantInt({ min: 1, max: 100 }).parse('101')).toThrow()
      expect(() => tolerantNumber().parse('ten')).toThrow()
    })
  })

  describe('uuidId', () => {
    it('accepts a UUID and rejects a domain with an instructive message', () => {
      expect(uuidId('workspace').parse('a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d')).toBe(
        'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
      )
      // The prod failure: listEntityTypes({ workspaceId: "fls.com.hk" }).
      const res = uuidId('workspace').safeParse('fls.com.hk')
      expect(res.success).toBe(false)
      if (!res.success) {
        expect(res.error.issues[0]?.message).toContain('not a name, domain, or slug')
      }
    })
  })

  describe('tolerantObject', () => {
    const shape = z.object({ id: z.string(), type: z.literal('assistant_call') })

    it('accepts a real object and a JSON-string object', () => {
      const obj = { id: 's1', type: 'assistant_call' as const }
      expect(tolerantObject(shape).parse(obj)).toEqual(obj)
      expect(tolerantObject(shape).parse(JSON.stringify(obj))).toEqual(obj)
    })

    it('invalid JSON string still errors cleanly (raw value reaches the schema)', () => {
      expect(() => tolerantObject(shape).parse('{not json')).toThrow()
      expect(() => tolerantObject(shape).parse('"just a string"')).toThrow()
    })
  })
})
