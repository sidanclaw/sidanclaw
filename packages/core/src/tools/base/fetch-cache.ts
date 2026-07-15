/**
 * In-memory fetch result cache with 15-minute TTL.
 *
 * Module-level `Map` keyed by normalized URL. Short-circuits the fetch
 * provider stack on hit.
 *
 * This is the fast, primary dedup layer. The DB-backed CacheStore
 * (`tool_result_cache` table, 24h TTL) is a write-through layer added
 * by `createFetchStack()` when `cacheStore` + `sessionId` are provided.
 * The DB cache ensures `retrieveCachedResults('urlReader')` works after
 * compaction or process restart.
 *
 * URL normalization strips common tracking parameters so two visits to the
 * same logical page (one with `?utm_source=...`, one without) dedupe into
 * a single entry. Fragment is dropped entirely.
 */

import type { FetchResult } from './fetch-stack.js'

const TTL_MS = 15 * 60 * 1000 // 15 minutes
const MAX_ENTRIES = 256 // LRU soft cap to prevent unbounded growth
// Byte budget for cached content. The entry cap alone doesn't bound memory —
// 256 full article/PDF bodies can be hundreds of MB in a process that lives
// for weeks. Oversized single results skip the cache entirely (the DB-backed
// CacheStore layer still covers retrieveCachedResults for those).
const MAX_TOTAL_CONTENT_BYTES = 32 * 1024 * 1024 // 32 MB across all entries
const MAX_ENTRY_CONTENT_BYTES = 1024 * 1024 // 1 MB per entry

type CacheEntry = {
  result: Omit<FetchResult, 'source'>
  expiresAt: number
  /** UTF-16 code units × 2 — cheap upper-bound proxy for heap bytes. */
  contentBytes: number
}

const cache = new Map<string, CacheEntry>()
let totalContentBytes = 0

function evict(key: string): void {
  const entry = cache.get(key)
  if (!entry) return
  totalContentBytes -= entry.contentBytes
  cache.delete(key)
}

/**
 * Common tracking parameters stripped during cache key normalization.
 * Not exhaustive — covers the 90th percentile and avoids false cache misses
 * on links shared across marketing channels.
 */
const TRACKING_PARAMS = new Set([
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'fbclid',
  'gclid',
  'mc_cid',
  'mc_eid',
  'ref',
  'referrer',
])

function normalizeUrl(rawUrl: string): string {
  try {
    const u = new URL(rawUrl)
    for (const param of Array.from(u.searchParams.keys())) {
      if (TRACKING_PARAMS.has(param.toLowerCase())) {
        u.searchParams.delete(param)
      }
    }
    u.hash = ''
    return u.toString()
  } catch {
    return rawUrl
  }
}

export function readFetchCache(url: string): Omit<FetchResult, 'source'> | null {
  const key = normalizeUrl(url)
  const entry = cache.get(key)
  if (!entry) return null
  if (Date.now() > entry.expiresAt) {
    evict(key)
    return null
  }
  return entry.result
}

export function writeFetchCache(url: string, result: FetchResult): void {
  const contentBytes = result.content.length * 2
  // A single oversized body would evict most of the cache for one entry
  // that is unlikely to be re-read within the TTL — don't cache it at all.
  if (contentBytes > MAX_ENTRY_CONTENT_BYTES) return

  const key = normalizeUrl(url)
  // Replacing an existing entry: retire its bytes before adding the new ones.
  evict(key)
  // Drop the `source` field when caching — a cache hit always sets source='cache'.
  const { source: _source, ...rest } = result
  cache.set(key, { result: rest, expiresAt: Date.now() + TTL_MS, contentBytes })
  totalContentBytes += contentBytes

  // Soft caps: evict oldest insertions (Map preserves insertion order) until
  // both the entry count and the content byte budget hold.
  while (cache.size > MAX_ENTRIES || totalContentBytes > MAX_TOTAL_CONTENT_BYTES) {
    const firstKey = cache.keys().next().value
    if (firstKey === undefined) break
    evict(firstKey)
  }
}

/** Test helper — resets the cache between tests. Not exported from public index. */
export function __resetFetchCache(): void {
  cache.clear()
  totalContentBytes = 0
}
