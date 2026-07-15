/**
 * Postgres-backed Baileys auth state adapter (BYON channels).
 *
 * The companion to `gcs-auth-state.ts`: same `{ state, saveCreds }` contract,
 * same in-memory cache + coalescing save queue, but persists to the
 * `wa_auth_state` table instead of GCS. Used for **bring-your-own-number
 * (BYON) ingest channels** only — official responder channels keep using GCS.
 *
 * Storage shape: one row per (channel_id, key). `key = 'creds'` holds the
 * device credentials; every other key is a signal-protocol entry stored under
 * `${type}-${id}` (e.g. `pre-key-1`, `session-…`). `value` is `jsonb`, encoded
 * with Baileys' `BufferJSON` so Buffers round-trip.
 *
 * See docs/architecture/channels/whatsapp.md → "Credential storage".
 * Component tag: [COMP:wa-connector/pg-auth-state].
 */

import type pg from 'pg'
import type {
  AuthenticationCreds,
  AuthenticationState,
  SignalDataTypeMap,
} from '@whiskeysockets/baileys'
import { initAuthCreds, BufferJSON } from '@whiskeysockets/baileys'

// ── Credential save queue (coalesces write storms, keyed by channelId) ──

const credsSaveQueues = new Map<string, Promise<void>>()

function enqueueSaveCreds(channelId: string, saveFn: () => Promise<void>): void {
  const prev = credsSaveQueues.get(channelId) ?? Promise.resolve()
  const next = prev
    .then(() => saveFn())
    .catch((err) => {
      console.warn(`[pg-auth] creds save queue error for ${channelId}:`, err)
    })
    .finally(() => {
      if (credsSaveQueues.get(channelId) === next) credsSaveQueues.delete(channelId)
    })
  credsSaveQueues.set(channelId, next)
}

export function waitForCredsSaveQueuePg(channelId?: string): Promise<void> {
  if (channelId) {
    return credsSaveQueues.get(channelId) ?? Promise.resolve()
  }
  return Promise.all(credsSaveQueues.values()).then(() => {})
}

// ── BufferJSON <-> jsonb helpers ──
// We bracket the round-trip with BufferJSON so Baileys' Buffer fields survive
// as `{ type: 'Buffer', data: [...] }`.
//
// encode() MUST return a JSON **string**, never a re-parsed JS value:
// node-postgres serializes a top-level array param as a Postgres array
// literal (`{"0",...}`), not JSON, so an array-valued signal key (e.g. what
// the Signal session update writes on the first outbound encrypt) fails the
// jsonb column with 22P02 and the whole send 500s. A string param is passed
// through verbatim and the explicit `::jsonb` cast in UPSERT_SQL parses it —
// uniform for objects and arrays.

function encode(value: unknown): string {
  return JSON.stringify(value, BufferJSON.replacer)
}

function decode(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value), BufferJSON.reviver)
}

// ── SQL ──

const UPSERT_SQL = `
  INSERT INTO wa_auth_state (channel_id, key, value, updated_at)
  VALUES ($1, $2, $3::jsonb, now())
  ON CONFLICT (channel_id, key)
  DO UPDATE SET value = EXCLUDED.value, updated_at = now()`

const DELETE_KEY_SQL = `DELETE FROM wa_auth_state WHERE channel_id = $1 AND key = $2`
const DELETE_CHANNEL_SQL = `DELETE FROM wa_auth_state WHERE channel_id = $1`
const SELECT_CREDS_SQL = `SELECT value FROM wa_auth_state WHERE channel_id = $1 AND key = 'creds'`
const SELECT_KEYS_SQL = `SELECT key, value FROM wa_auth_state WHERE channel_id = $1 AND key <> 'creds'`
const SELECT_ONE_SQL = `SELECT value FROM wa_auth_state WHERE channel_id = $1 AND key = $2`
const EXISTS_SQL = `SELECT 1 FROM wa_auth_state WHERE channel_id = $1 AND key = 'creds' LIMIT 1`
const LIST_SQL = `SELECT DISTINCT channel_id FROM wa_auth_state WHERE key = 'creds'`

// ── Main adapter ──

export async function usePostgresAuthState(
  pool: pg.Pool,
  channelId: string,
): Promise<{ state: AuthenticationState; saveCreds: () => Promise<void> }> {
  // Load or initialize credentials.
  let creds: AuthenticationCreds
  const credsRes = await pool.query<{ value: unknown }>(SELECT_CREDS_SQL, [channelId])
  if (credsRes.rows[0]) {
    try {
      creds = decode(credsRes.rows[0].value) as AuthenticationCreds
    } catch {
      creds = initAuthCreds()
    }
  } else {
    creds = initAuthCreds()
  }

  // Pre-load existing signal keys into the in-memory cache.
  const keyCache = new Map<string, unknown>()
  const keysRes = await pool.query<{ key: string; value: unknown }>(SELECT_KEYS_SQL, [channelId])
  for (const row of keysRes.rows) {
    try {
      keyCache.set(row.key, decode(row.value))
    } catch {
      // skip unparseable keys
    }
  }

  const saveCreds = () => {
    return new Promise<void>((resolve) => {
      enqueueSaveCreds(channelId, async () => {
        try {
          await pool.query(UPSERT_SQL, [channelId, 'creds', encode(creds)])
        } catch (err) {
          console.warn(`[pg-auth] failed saving creds for ${channelId}:`, err)
        }
        resolve()
      })
    })
  }

  return {
    state: {
      creds,
      keys: {
        get: async <T extends keyof SignalDataTypeMap>(type: T, ids: string[]) => {
          const result: { [id: string]: SignalDataTypeMap[T] } = {}
          for (const id of ids) {
            const key = `${type}-${id}`
            const cached = keyCache.get(key)
            if (cached) {
              result[id] = cached as SignalDataTypeMap[T]
              continue
            }
            // Fallback: read the single key from Postgres.
            const res = await pool.query<{ value: unknown }>(SELECT_ONE_SQL, [channelId, key])
            if (res.rows[0]) {
              try {
                const parsed = decode(res.rows[0].value)
                keyCache.set(key, parsed)
                result[id] = parsed as SignalDataTypeMap[T]
              } catch {
                // skip unparseable
              }
            }
          }
          return result
        },
        set: async (data: Record<string, Record<string, unknown | null>>) => {
          const writes: Promise<unknown>[] = []
          for (const [type, entries] of Object.entries(data)) {
            for (const [id, value] of Object.entries(entries)) {
              const key = `${type}-${id}`
              if (value) {
                keyCache.set(key, value)
                writes.push(pool.query(UPSERT_SQL, [channelId, key, encode(value)]))
              } else {
                keyCache.delete(key)
                writes.push(pool.query(DELETE_KEY_SQL, [channelId, key]))
              }
            }
          }
          await Promise.all(writes)
        },
      },
    },
    saveCreds,
  }
}

// ── Utilities (mirror gcs-auth-state.ts) ──

export async function authStateExistsPg(pool: pg.Pool, channelId: string): Promise<boolean> {
  const res = await pool.query(EXISTS_SQL, [channelId])
  return res.rowCount! > 0
}

export async function deleteAuthStatePg(pool: pg.Pool, channelId: string): Promise<void> {
  await pool.query(DELETE_CHANNEL_SQL, [channelId])
}

/** List every channel id that has stored credentials (key='creds'). */
export async function listStoredChannelsPg(pool: pg.Pool): Promise<string[]> {
  const res = await pool.query<{ channel_id: string }>(LIST_SQL)
  return res.rows.map((r) => r.channel_id)
}
