/**
 * Local-filesystem implementation of {@link GcsFilesClient}. It is used as the
 * self-hosted application default when `LOCAL_FILES_DIR` is configured, and as
 * the dev/test fallback when `GCS_FILES_BUCKET` is unset. Stores each blob at
 * `<baseDir>/<key>` with a sidecar `<...>.meta.json` carrying the mime + custom
 * metadata, so the workspace-file tools (`fileWrite`, `saveFileToBrain`, …)
 * work end-to-end without GCS — otherwise the whole file primitive is silently
 * disabled locally and the model can't actually save an uploaded file.
 *
 * Production use requires `LOCAL_FILES_DIR` to point at a durable mounted
 * volume. Without an explicit path, boot only uses the ephemeral `/tmp`
 * fallback off Cloud Run; Cloud Run remains fail-closed.
 */

import { createWriteStream, mkdirSync, promises as fs, writeFileSync } from 'node:fs'
import type { Writable } from 'node:stream'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import type { GcsBlob, GcsFilesClient, GcsObjectMetadata } from './gcs-client.js'

const DEFAULT_META: GcsObjectMetadata = { workspaceId: '', mime: 'application/octet-stream' }

export function resolveLocalFilesBaseDir(configured?: string): string {
  return path.resolve(configured?.trim() || path.join(tmpdir(), 'sidanclaw-files'))
}

export function createLocalFilesClient(opts: { baseDir: string }): GcsFilesClient {
  const { baseDir } = opts
  const blobPath = (key: string): string => path.join(baseDir, key)
  const metaPath = (key: string): string => `${path.join(baseDir, key)}.meta.json`

  const client: GcsFilesClient = {
    async writeBlob(key, bytes, metadata) {
      const p = blobPath(key)
      await fs.mkdir(path.dirname(p), { recursive: true })
      await fs.writeFile(p, bytes)
      await fs.writeFile(metaPath(key), JSON.stringify(metadata))
    },

    async appendBlob(key, bytes) {
      const existing = await client.readBlob(key)
      const next = existing ? Buffer.concat([existing.bytes, bytes]) : bytes
      await client.writeBlob(key, next, existing?.metadata ?? DEFAULT_META)
    },

    async readBlob(key): Promise<GcsBlob | null> {
      try {
        const bytes = await fs.readFile(blobPath(key))
        let metadata = DEFAULT_META
        try {
          metadata = JSON.parse(await fs.readFile(metaPath(key), 'utf8')) as GcsObjectMetadata
        } catch {
          // Missing/corrupt sidecar — fall back to the default mime.
        }
        return { bytes, mime: metadata.mime, metadata }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw err
      }
    },

    async statBlob(key) {
      try {
        // stat(), not readFile() — the point of statBlob is size WITHOUT
        // pulling the object into memory.
        const st = await fs.stat(blobPath(key))
        let metadata = DEFAULT_META
        try {
          metadata = JSON.parse(await fs.readFile(metaPath(key), 'utf8')) as GcsObjectMetadata
        } catch {
          // Missing/corrupt sidecar — fall back to the default mime.
        }
        return { sizeBytes: st.size, mime: metadata.mime, updatedAt: st.mtime }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw err
      }
    },

    async deleteBlob(key) {
      await fs.rm(blobPath(key), { force: true })
      await fs.rm(metaPath(key), { force: true })
    },

    async signedReadUrl(key) {
      // No signing locally. The workspace-file tools never call this (they read
      // via readBlob); it exists only to satisfy the interface for the
      // doc-block preview path, which is GCS-only anyway.
      return `file://${blobPath(key)}`
    },

    async signedWriteUrl(key) {
      // No signed PUT locally — the recording upload flow is GCS-only. Returned
      // for interface parity; a local caller should writeBlob directly instead.
      return `file://${blobPath(key)}`
    },

    writeStream(key, opts): Writable {
      const p = blobPath(key)
      // Setup is synchronous so the returned stream is the actual file sink;
      // its `finish` event therefore means bytes have reached the filesystem.
      mkdirSync(path.dirname(p), { recursive: true })
      writeFileSync(metaPath(key), JSON.stringify(opts.metadata ?? { workspaceId: '', mime: opts.mime }))
      return createWriteStream(p)
    },
  }

  return client
}
