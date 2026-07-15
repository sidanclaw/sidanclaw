/**
 * Unit tests for the ingest-rules store.
 *
 * Mocks the DB layer and asserts on SQL shape, params, and the
 * idempotency guard in `seedDefaults`. RLS enforcement is verified at the
 * SQL level by migration 130.
 *
 * Component tag: [COMP:api/ingest-rules-store].
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../client.js', () => ({
  query: vi.fn(),
  queryWithRLS: vi.fn(),
}))

import { createIngestRulesStore } from '../ingest-rules-store.js'
import { queryWithRLS } from '../client.js'

const mockQueryWithRLS = vi.mocked(queryWithRLS)

beforeEach(() => {
  vi.clearAllMocks()
})

describe('[COMP:api/ingest-rules-store] createIngestRulesStore', () => {
  describe('listByConnectorInstance', () => {
    it('reads ingest_rules under RLS, ordered by rule_order', async () => {
      const store = createIngestRulesStore()
      mockQueryWithRLS.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)

      await store.listByConnectorInstance('u_1', 'ci_1')

      expect(mockQueryWithRLS).toHaveBeenCalledTimes(1)
      const [userId, sql, params] = mockQueryWithRLS.mock.calls[0] as [
        string,
        string,
        unknown[],
      ]
      expect(userId).toBe('u_1')
      expect(sql).toContain('FROM ingest_rules')
      expect(sql).toContain('connector_instance_id = $1')
      expect(sql).toContain('ORDER BY rule_order')
      expect(params).toEqual(['ci_1'])
    })
  })

  describe('listByConnectorInstances', () => {
    it('reads rules for many instances in a single RLS query', async () => {
      const store = createIngestRulesStore()
      mockQueryWithRLS.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)

      await store.listByConnectorInstances('u_1', ['ci_1', 'ci_2'])

      expect(mockQueryWithRLS).toHaveBeenCalledTimes(1)
      const [userId, sql, params] = mockQueryWithRLS.mock.calls[0] as [
        string,
        string,
        unknown[],
      ]
      expect(userId).toBe('u_1')
      expect(sql).toContain('FROM ingest_rules')
      expect(sql).toContain('connector_instance_id = ANY($1')
      expect(params).toEqual([['ci_1', 'ci_2']])
    })

    it('returns [] without querying for an empty id list', async () => {
      const store = createIngestRulesStore()

      const rows = await store.listByConnectorInstances('u_1', [])

      expect(rows).toEqual([])
      expect(mockQueryWithRLS).not.toHaveBeenCalled()
    })
  })

  describe('seedDefaults', () => {
    it('is a no-op when the instance already has rules', async () => {
      const store = createIngestRulesStore()
      mockQueryWithRLS.mockResolvedValueOnce({
        rows: [{ count: '4' }],
        rowCount: 1,
      } as never)

      const inserted = await store.seedDefaults('u_1', 'ci_1', 'calendar')

      expect(inserted).toBe(0)
      // Only the count probe ran — no INSERT.
      expect(mockQueryWithRLS).toHaveBeenCalledTimes(1)
    })

    it('seeds DEFAULT_INGEST_RULES when the instance has none', async () => {
      const store = createIngestRulesStore()
      mockQueryWithRLS
        .mockResolvedValueOnce({ rows: [{ count: '0' }], rowCount: 1 } as never)
        .mockResolvedValueOnce({ rows: [], rowCount: 4 } as never)

      const inserted = await store.seedDefaults('u_1', 'ci_1', 'calendar')

      expect(inserted).toBe(4) // calendar ships 4 default rules
      expect(mockQueryWithRLS).toHaveBeenCalledTimes(2)

      const [userId, sql, params] = mockQueryWithRLS.mock.calls[1] as [
        string,
        string,
        unknown[],
      ]
      expect(userId).toBe('u_1')
      expect(sql).toContain('INSERT INTO ingest_rules')
      // $1 = connector_instance_id, $2 = source, then 6 params per rule.
      expect(params[0]).toBe('ci_1')
      expect(params[1]).toBe('calendar')
      expect(params).toHaveLength(2 + 4 * 6)
      // First seeded rule carries rule_order 0.
      expect(params[2]).toBe(0)
    })

    it('seeds the single fathom realtime rule', async () => {
      const store = createIngestRulesStore()
      mockQueryWithRLS
        .mockResolvedValueOnce({ rows: [{ count: '0' }], rowCount: 1 } as never)
        .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never)

      const inserted = await store.seedDefaults('u_1', 'ci_2', 'fathom')

      expect(inserted).toBe(1)
      const [, sql, params] = mockQueryWithRLS.mock.calls[1] as [
        string,
        string,
        unknown[],
      ]
      expect(sql).toContain('INSERT INTO ingest_rules')
      expect(params).toHaveLength(2 + 1 * 6)
    })
  })
})
