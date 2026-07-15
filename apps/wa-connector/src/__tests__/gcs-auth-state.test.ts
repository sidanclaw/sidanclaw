/**
 * Unit tests for the GCS-backed Baileys auth-state adapter.
 * Component tag: [COMP:wa-connector/gcs-auth-state].
 *
 * Drives useGCSAuthState + the utilities against an in-memory Bucket
 * stub. Verifies a fresh init (no creds in GCS → initAuthCreds), the
 * corrupted-creds restore-from-backup path, the key cache round-trip
 * + tombstone delete, saveCreds writing creds.json (+ backup), and the
 * authStateExists / deleteAuthState / listStoredChannels utilities.
 */

import { describe, it, expect, vi } from 'vitest'
import {
  useGCSAuthState,
  authStateExists,
  deleteAuthState,
  listStoredChannels,
  waitForCredsSaveQueue,
} from '../gcs-auth-state.js'
import type { Bucket } from '@google-cloud/storage'

function notFound() {
  return Object.assign(new Error('Not Found'), { code: 404 })
}

/** Minimal in-memory stand-in for a GCS Bucket. */
function makeBucket(initial: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(initial))
  const bucket = {
    file: (path: string) => ({
      name: path,
      download: async () => {
        const v = store.get(path)
        if (v === undefined) throw notFound()
        return [Buffer.from(v, 'utf-8')]
      },
      save: async (data: string) => {
        store.set(path, data)
      },
      delete: async () => {
        if (!store.has(path)) throw notFound()
        store.delete(path)
      },
      exists: async () => [store.has(path)],
    }),
    getFiles: async ({ prefix }: { prefix: string }) => {
      const names = [...store.keys()].filter((k) => k.startsWith(prefix))
      return [
        names.map((name) => ({
          name,
          delete: async () => {
            store.delete(name)
          },
        })),
      ]
    },
  }
  return { bucket: bucket as unknown as Bucket, store }
}

describe('[COMP:wa-connector/gcs-auth-state] useGCSAuthState', () => {
  it('initializes fresh credentials when GCS has nothing stored', async () => {
    const { bucket } = makeBucket()
    const { state, saveCreds } = await useGCSAuthState(bucket, 'a-1')
    expect(state.creds).toBeTruthy()
    expect(state.creds.registered).toBe(false)
    expect(typeof saveCreds).toBe('function')
  })

  it('restores creds.json from the .bak file when the live creds are corrupted', async () => {
    const goodBackup = JSON.stringify({ marker: 'from-backup' })
    const { bucket, store } = makeBucket({
      'channels/a-2/creds.json': '{ this is not valid json',
      'channels/a-2/creds.json.bak': goodBackup,
    })
    await useGCSAuthState(bucket, 'a-2')
    expect(store.get('channels/a-2/creds.json')).toBe(goodBackup)
  })

  it('round-trips signal keys through the cache and tombstones a null value', async () => {
    const { bucket, store } = makeBucket()
    const { state } = await useGCSAuthState(bucket, 'a-3')
    await state.keys.set({ 'pre-key': { '1': { id: 1 } } } as never)
    const got = await state.keys.get('pre-key', ['1'])
    expect(got['1']).toEqual({ id: 1 })
    expect(store.has('channels/a-3/keys/pre-key-1.json')).toBe(true)

    await state.keys.set({ 'pre-key': { '1': null } } as never)
    expect(store.has('channels/a-3/keys/pre-key-1.json')).toBe(false)
    expect(await state.keys.get('pre-key', ['1'])).toEqual({})
  })

  it('saveCreds writes creds.json and drains through the save queue', async () => {
    const { bucket, store } = makeBucket()
    const { saveCreds } = await useGCSAuthState(bucket, 'a-4')
    await saveCreds()
    await waitForCredsSaveQueue('channels/a-4')
    expect(store.has('channels/a-4/creds.json')).toBe(true)
  })
})

describe('[COMP:wa-connector/gcs-auth-state] utilities', () => {
  it('authStateExists reflects whether creds.json is present', async () => {
    const { bucket } = makeBucket({ 'channels/has/creds.json': '{}' })
    expect(await authStateExists(bucket, 'has')).toBe(true)
    expect(await authStateExists(bucket, 'missing')).toBe(false)
  })

  it('deleteAuthState removes every object under the channel prefix', async () => {
    const { bucket, store } = makeBucket({
      'channels/a-9/creds.json': '{}',
      'channels/a-9/keys/pre-key-1.json': '{}',
      'channels/other/creds.json': '{}',
    })
    await deleteAuthState(bucket, 'a-9')
    expect(store.has('channels/a-9/creds.json')).toBe(false)
    expect(store.has('channels/a-9/keys/pre-key-1.json')).toBe(false)
    expect(store.has('channels/other/creds.json')).toBe(true)
  })

  it('listStoredChannels extracts and dedups channel ids from creds paths', async () => {
    const { bucket } = makeBucket({
      'channels/a-1/creds.json': '{}',
      'channels/a-1/keys/pre-key-1.json': '{}', // not a creds path → ignored
      'channels/a-2/creds.json': '{}',
    })
    const ids = await listStoredChannels(bucket)
    expect([...ids].sort()).toEqual(['a-1', 'a-2'])
  })
})
