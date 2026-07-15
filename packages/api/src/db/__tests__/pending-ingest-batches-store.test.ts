/**
 * Unit tests for `appendBatchEvent`'s size-based early flush.
 * Component tag: [COMP:brain/pending-ingest-batches-store].
 *
 * Injects a fake pool so the flush decision (pull a future `fires_at` back to
 * `now()` once the accumulated window text crosses `EARLY_FLUSH_CHARS`) is
 * exercised without a real database. The accumulated char count is modelled by
 * the fake's `RETURNING length(events::text)` response.
 *
 * See docs/architecture/brain/ingest-pipeline.md → "Batch flush — cron
 * backstop + size trigger".
 */

import { describe, it, expect } from 'vitest'
import {
  appendBatchEvent,
  EARLY_FLUSH_TOKENS,
  EARLY_FLUSH_CHARS,
} from '../pending-ingest-batches-store.js'

type Call = { text: string; params?: unknown[] }

/**
 * Fake pool covering the three statements `appendBatchEvent` issues. `chars`
 * is the value returned for `length(events::text)`; `existingId` controls
 * whether the find-or-create SELECT hits an existing row (UPDATE) or misses
 * it (INSERT). Every query is recorded so the test can assert whether the
 * `fires_at = now()` early-flush UPDATE was issued.
 */
function makeFakePool(opts: { chars: number; existingId?: string }) {
  const calls: Call[] = []
  const pool = {
    async query<R extends Record<string, unknown>>(
      text: string,
      params?: unknown[],
    ): Promise<{ rows: R[] }> {
      calls.push({ text, params })
      let rows: unknown[] = []
      if (text.includes('SELECT id FROM pending_ingest_batches')) {
        rows = opts.existingId ? [{ id: opts.existingId }] : []
      } else if (text.includes('UPDATE pending_ingest_batches SET events')) {
        rows = [{ id: opts.existingId, chars: opts.chars }]
      } else if (text.includes('INSERT INTO pending_ingest_batches')) {
        rows = [{ id: 'batch-new', chars: opts.chars }]
      }
      // The early-flush UPDATE (and anything else) returns no rows.
      return { rows: rows as R[] }
    },
  }
  return { pool, calls }
}

const baseInput = {
  workspaceId: 'ws-1',
  ruleId: 'rule-1',
  source: 'whatsapp',
  // Future cron firing — the early flush should be able to pull it earlier.
  firesAt: new Date('2099-01-01T09:00:00Z'),
  event: { normalized: { text: 'hi' } },
}

function firesAtFlush(calls: Call[]): Call | undefined {
  return calls.find((c) => c.text.includes('SET fires_at = now()'))
}

describe('[COMP:brain/pending-ingest-batches-store] appendBatchEvent early flush', () => {
  it('pulls fires_at to now() once accumulated text crosses 32k tokens', async () => {
    const { pool, calls } = makeFakePool({ chars: EARLY_FLUSH_CHARS, existingId: 'batch-1' })
    await appendBatchEvent(baseInput, pool)

    const flush = firesAtFlush(calls)
    expect(flush).toBeDefined()
    // Scoped to the appended batch and only moves a still-future fires_at.
    expect(flush!.text).toContain('fires_at > now()')
    expect(flush!.params).toEqual(['batch-1'])
  })

  it('leaves fires_at at the cron time when below the threshold', async () => {
    const { pool, calls } = makeFakePool({
      chars: EARLY_FLUSH_CHARS - 1,
      existingId: 'batch-1',
    })
    await appendBatchEvent(baseInput, pool)
    expect(firesAtFlush(calls)).toBeUndefined()
  })

  it('flushes a freshly-created (INSERT) batch that already crosses the bound', async () => {
    const { pool, calls } = makeFakePool({ chars: EARLY_FLUSH_CHARS + 5_000 })
    await appendBatchEvent(baseInput, pool)
    const flush = firesAtFlush(calls)
    expect(flush).toBeDefined()
    expect(flush!.params).toEqual(['batch-new'])
  })

  it('keeps the token bound and char proxy coupled at ~4 chars/token', () => {
    expect(EARLY_FLUSH_TOKENS).toBe(32_000)
    expect(EARLY_FLUSH_CHARS).toBe(EARLY_FLUSH_TOKENS * 4)
  })
})
