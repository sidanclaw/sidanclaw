/**
 * GCS-backed Baileys auth state adapter.
 *
 * Replaces Baileys' filesystem-based `useMultiFileAuthState()` with Google
 * Cloud Storage. Keeps an in-memory cache of all keys and writes through
 * to GCS with a coalescing queue to prevent write storms.
 *
 * Ported from OpenClaw `auth-store.ts` + `session.ts` credential save queue.
 * See docs/architecture/channels/whatsapp.md.
 */

import type { Bucket } from '@google-cloud/storage'
import type {
  AuthenticationCreds,
  AuthenticationState,
  SignalDataTypeMap,
} from '@whiskeysockets/baileys'
import { initAuthCreds, BufferJSON } from '@whiskeysockets/baileys'

// ── Credential save queue (ported from OpenClaw session.ts lines 40-56) ──

const credsSaveQueues = new Map<string, Promise<void>>()

function enqueueSaveCreds(
  prefix: string,
  saveFn: () => Promise<void>,
): void {
  const prev = credsSaveQueues.get(prefix) ?? Promise.resolve()
  const next = prev
    .then(() => saveFn())
    .catch((err) => {
      console.warn(`[gcs-auth] creds save queue error for ${prefix}:`, err)
    })
    .finally(() => {
      if (credsSaveQueues.get(prefix) === next) credsSaveQueues.delete(prefix)
    })
  credsSaveQueues.set(prefix, next)
}

export function waitForCredsSaveQueue(prefix?: string): Promise<void> {
  if (prefix) {
    return credsSaveQueues.get(prefix) ?? Promise.resolve()
  }
  return Promise.all(credsSaveQueues.values()).then(() => {})
}

// ── GCS helpers ──

async function gcsRead(bucket: Bucket, path: string): Promise<string | null> {
  try {
    const [contents] = await bucket.file(path).download()
    return contents.toString('utf-8')
  } catch (err: unknown) {
    if (err && typeof err === 'object' && 'code' in err && (err as { code: number }).code === 404) {
      return null
    }
    throw err
  }
}

async function gcsWrite(bucket: Bucket, path: string, data: string): Promise<void> {
  await bucket.file(path).save(data, { contentType: 'application/json' })
}

async function gcsDelete(bucket: Bucket, path: string): Promise<void> {
  try {
    await bucket.file(path).delete()
  } catch (err: unknown) {
    if (err && typeof err === 'object' && 'code' in err && (err as { code: number }).code === 404) {
      return // already gone
    }
    throw err
  }
}

async function gcsExists(bucket: Bucket, path: string): Promise<boolean> {
  const [exists] = await bucket.file(path).exists()
  return exists
}

// ── Backup / restore (ported from OpenClaw auth-store.ts) ──

async function maybeRestoreCredsFromBackup(
  bucket: Bucket,
  prefix: string,
): Promise<void> {
  const credsPath = `${prefix}/creds.json`
  const backupPath = `${prefix}/creds.json.bak`

  const raw = await gcsRead(bucket, credsPath)
  if (raw) {
    try {
      JSON.parse(raw)
      return // creds are valid
    } catch {
      // corrupted, try backup
    }
  }

  const backupRaw = await gcsRead(bucket, backupPath)
  if (!backupRaw) return

  try {
    JSON.parse(backupRaw)
    await gcsWrite(bucket, credsPath, backupRaw)
    console.warn(`[gcs-auth] restored corrupted creds.json from backup for ${prefix}`)
  } catch {
    // backup also corrupted — nothing to do
  }
}

async function backupCreds(
  bucket: Bucket,
  prefix: string,
): Promise<void> {
  const credsPath = `${prefix}/creds.json`
  const backupPath = `${prefix}/creds.json.bak`

  const raw = await gcsRead(bucket, credsPath)
  if (!raw) return

  try {
    JSON.parse(raw) // validate before backing up
    await gcsWrite(bucket, backupPath, raw)
  } catch {
    // don't clobber a good backup with corrupted data
  }
}

// ── Main adapter ──

export async function useGCSAuthState(
  bucket: Bucket,
  channelId: string,
): Promise<{ state: AuthenticationState; saveCreds: () => Promise<void> }> {
  const prefix = `channels/${channelId}`
  const credsPath = `${prefix}/creds.json`

  // Attempt restore from backup on init
  await maybeRestoreCredsFromBackup(bucket, prefix)

  // Load or initialize credentials
  let creds: AuthenticationCreds
  const credsRaw = await gcsRead(bucket, credsPath)
  if (credsRaw) {
    try {
      creds = JSON.parse(credsRaw, BufferJSON.reviver)
    } catch {
      creds = initAuthCreds()
    }
  } else {
    creds = initAuthCreds()
  }

  // In-memory key cache
  const keyCache = new Map<string, unknown>()

  // Pre-load existing keys from GCS
  const keysPrefix = `${prefix}/keys/`
  try {
    const [files] = await bucket.getFiles({ prefix: keysPrefix })
    await Promise.all(
      files.map(async (file) => {
        const raw = await gcsRead(bucket, file.name)
        if (raw) {
          const key = file.name.slice(keysPrefix.length)
          try {
            keyCache.set(key, JSON.parse(raw, BufferJSON.reviver))
          } catch {
            // skip unparseable keys
          }
        }
      }),
    )
  } catch {
    // no keys yet — fresh state
  }

  const saveCreds = () => {
    return new Promise<void>((resolve) => {
      enqueueSaveCreds(prefix, async () => {
        try {
          await backupCreds(bucket, prefix)
          const data = JSON.stringify(creds, BufferJSON.replacer, 2)
          await gcsWrite(bucket, credsPath, data)
        } catch (err) {
          console.warn(`[gcs-auth] failed saving creds for ${prefix}:`, err)
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
            // Fallback: read from GCS
            const raw = await gcsRead(bucket, `${keysPrefix}${key}.json`)
            if (raw) {
              try {
                const parsed = JSON.parse(raw, BufferJSON.reviver)
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
          const writes: Promise<void>[] = []
          for (const [type, entries] of Object.entries(data)) {
            for (const [id, value] of Object.entries(entries)) {
              const key = `${type}-${id}`
              if (value) {
                keyCache.set(key, value)
                writes.push(
                  gcsWrite(
                    bucket,
                    `${keysPrefix}${key}.json`,
                    JSON.stringify(value, BufferJSON.replacer),
                  ),
                )
              } else {
                keyCache.delete(key)
                writes.push(gcsDelete(bucket, `${keysPrefix}${key}.json`))
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

// ── Utilities ──

export async function authStateExists(
  bucket: Bucket,
  channelId: string,
): Promise<boolean> {
  return gcsExists(bucket, `channels/${channelId}/creds.json`)
}

export async function deleteAuthState(
  bucket: Bucket,
  channelId: string,
): Promise<void> {
  const prefix = `channels/${channelId}/`
  const [files] = await bucket.getFiles({ prefix })
  if (files.length > 0) {
    await Promise.all(files.map((file) => file.delete().catch(() => {})))
  }
}

/**
 * List all channel IDs that have stored credentials in the bucket.
 */
export async function listStoredChannels(bucket: Bucket): Promise<string[]> {
  const [files] = await bucket.getFiles({ prefix: 'channels/' })
  const ids = new Set<string>()
  for (const file of files) {
    // Format: channels/{channelId}/creds.json
    const match = file.name.match(/^channels\/([^/]+)\/creds\.json$/)
    if (match) {
      ids.add(match[1])
    }
  }
  return Array.from(ids)
}
