/**
 * Built-in connector lifecycle routes — `/api/connectors`.
 *
 * The OSS-open half of the connector surface. The hosted edition mounts a
 * richer closed `/api/connectors` route (custom MCP CRUD, directory browse,
 * Google Drive authorized-files, per-assistant tool policy); this open module
 * implements only the built-in OAuth/PAT connector lifecycle that the open
 * `apps/app-web` OAuth callbacks and Studio → Connectors page already drive:
 *
 *   GET    /api/connectors                         — list the caller's connectors
 *   POST   /api/connectors/:provider/store-credentials — persist an OAuth/PAT grant
 *   POST   /api/connectors/:provider/disconnect    — flip the primary instance offline
 *   PATCH  /api/connectors/instances/:id           — rename a connector instance
 *   DELETE /api/connectors/instances/:id           — delete a specific instance
 *   DELETE /api/connectors/:provider               — delete the primary instance
 *
 * Mounted behind `requireAuth`, so `req.userId` is always set. All persistence
 * goes through the RLS-gated `connectorInstanceStore` / `connectorStore`, which
 * encrypt the per-user OAuth refresh-token / PAT into `connector_instance.
 * credentials` under `CHANNEL_CREDENTIAL_KEY`. The injected token is read back
 * by `mcp/inject.ts` (`readRefreshToken` / `getPat` both read
 * `credentials.client_secret`), which is why every provider stores its secret
 * as the `client_secret` of an `oauth`-typed blob.
 *
 * The supported provider set is derived from `OFFICIAL_CONNECTORS` (never a
 * hardcoded slug list — see CLAUDE.md "all built-ins" drift anti-pattern).
 * `auth_type: 'none'` connectors (e.g. Workspace Files) are first-party and
 * carry no external credential, so they are rejected here.
 *
 * Out of scope for the open edition (handled by the closed route): custom MCP
 * connectors (`/custom`), the connector directory (`/directory`), Google Drive
 * authorized-files (`/gdrive/*`), and per-assistant tool policy (`/tools`).
 *
 * Component tag: [COMP:api/connectors-route].
 */

import { Router } from 'express'
import { OFFICIAL_CONNECTORS } from '@sidanclaw/shared'
import type { ConnectorStore, ConnectorCredentials } from '../db/connector-store.js'
import type { ConnectorInstanceStore } from '../db/connector-instance-store.js'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

type ConnectorRouteOptions = {
  connectorStore: ConnectorStore
  connectorInstanceStore: ConnectorInstanceStore
}

/** Built-in connector that carries an external credential (excludes auth_type 'none'). */
function credentialedConnector(provider: string) {
  const entry = OFFICIAL_CONNECTORS.find((c) => c.id === provider)
  if (!entry || entry.auth_type === 'none') return null
  return entry
}

/**
 * The credentials blob shape every built-in stores: the per-user secret (OAuth
 * refresh token for `oauth` providers, PAT for `api_key` providers) lands in
 * `client_secret`, which is what `mcp/inject.ts` reads back. `client_id` is
 * unused at injection time (Google's app client id comes from
 * `getConnectorConfig`), so it is left blank.
 */
function credentialsFor(secret: string): ConnectorCredentials {
  return { type: 'oauth', client_id: '', client_secret: secret }
}

export function connectorRoutes(opts: ConnectorRouteOptions): Router {
  const { connectorStore, connectorInstanceStore } = opts
  const router = Router()

  // ── GET / — list the caller's connectors ─────────────────────
  router.get('/', async (req, res) => {
    const userId = req.userId
    if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return }
    try {
      const instances = await connectorInstanceStore.listForUser(userId)
      res.json({
        connectors: instances.map((i) => ({
          id: i.provider,
          connectorId: i.provider,
          connectorInstanceId: i.id,
          scope: i.scope,
          name: i.label,
          label: i.label,
          connected: i.connected,
          custom: i.custom,
          url: i.url,
          connectedEmail: i.connectedEmail,
          credentialsType: i.credentialsType,
          sensitivity: i.sensitivity,
        })),
      })
    } catch (err) {
      console.error('[connectors] list failed:', err)
      res.status(500).json({ error: 'Failed to list connectors' })
    }
  })

  // ── POST /:provider/store-credentials — persist an OAuth/PAT grant ──
  //
  // Request body (any one secret field, per the open OAuth callbacks +
  // Studio PAT form):
  //   refreshToken | pat | accessToken | token  — the per-user secret (required)
  //   email?    — the connected account email (stored on the instance)
  //   label?    — display nickname (defaults to the provider's display name)
  //   instanceId? — target an existing instance (re-auth / multi-account update)
  //   createNew?  — true: always create a NEW instance (multi-account "add another")
  router.post('/:provider/store-credentials', async (req, res) => {
    const userId = req.userId
    if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return }

    const provider = req.params.provider
    const entry = credentialedConnector(provider)
    if (!entry) {
      res.status(400).json({ error: `Unsupported connector: ${provider}` })
      return
    }

    const body = (req.body ?? {}) as {
      refreshToken?: string
      pat?: string
      accessToken?: string
      token?: string
      email?: string
      label?: string
      instanceId?: string
      createNew?: boolean
    }
    const secret = (body.refreshToken ?? body.pat ?? body.accessToken ?? body.token ?? '').trim()
    if (!secret) {
      res.status(400).json({ error: 'Missing credential (refreshToken/pat/accessToken/token)' })
      return
    }
    if (body.instanceId !== undefined && !UUID_RE.test(body.instanceId)) {
      res.status(400).json({ error: 'Invalid instanceId' })
      return
    }

    const credentials = credentialsFor(secret)
    const email = body.email ?? null
    const label = body.label?.trim() || undefined

    try {
      // Multi-account "add another" — always a fresh instance.
      if (body.createNew) {
        const created = await connectorInstanceStore.createUserInstance({
          userId,
          provider,
          label: label ?? entry.name,
          connectedEmail: email,
          connected: true,
          credentials,
        })
        res.json({ ok: true, connectorInstanceId: created.id })
        return
      }

      // Re-auth / update a specific existing instance.
      if (body.instanceId) {
        const updated = await connectorInstanceStore.update(userId, body.instanceId, {
          connected: true,
          connectedEmail: email,
          credentials,
          ...(label ? { label } : {}),
        })
        if (!updated) { res.status(404).json({ error: 'Connector instance not found' }); return }
        res.json({ ok: true, connectorInstanceId: updated.id })
        return
      }

      // Primary (one-per-provider) path: update the first matching instance or
      // create it. Mirrors the legacy `connectorStore.upsert` semantic but also
      // records `connected_email`, which the shim drops.
      const existing = (await connectorInstanceStore.listByUser(userId, userId))
        .find((i) => i.provider === provider)
      if (existing) {
        const updated = await connectorInstanceStore.update(userId, existing.id, {
          connected: true,
          connectedEmail: email,
          credentials,
          ...(label ? { label } : {}),
        })
        res.json({ ok: true, connectorInstanceId: updated?.id ?? existing.id })
        return
      }

      const created = await connectorInstanceStore.createUserInstance({
        userId,
        provider,
        label: label ?? entry.name,
        connectedEmail: email,
        connected: true,
        credentials,
      })
      res.json({ ok: true, connectorInstanceId: created.id })
    } catch (err) {
      // The store throws when CHANNEL_CREDENTIAL_KEY is unset — surface it as a
      // 503 so the launcher-misconfiguration case is distinguishable from a bug.
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('CHANNEL_CREDENTIAL_KEY')) {
        console.error('[connectors] store-credentials: encryption key not configured')
        res.status(503).json({ error: 'Connector credential storage is not configured (CHANNEL_CREDENTIAL_KEY)' })
        return
      }
      console.error('[connectors] store-credentials failed:', err)
      res.status(500).json({ error: 'Failed to store credentials' })
    }
  })

  // ── POST /:provider/disconnect — flip the primary instance offline ──
  router.post('/:provider/disconnect', async (req, res) => {
    const userId = req.userId
    if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return }
    try {
      const row = await connectorStore.setConnected(userId, req.params.provider, false)
      if (!row) { res.status(404).json({ error: 'Connector not found' }); return }
      res.json({ ok: true })
    } catch (err) {
      console.error('[connectors] disconnect failed:', err)
      res.status(500).json({ error: 'Failed to disconnect' })
    }
  })

  // ── PATCH /instances/:id — rename a connector instance ───────
  router.patch('/instances/:id', async (req, res) => {
    const userId = req.userId
    if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return }
    const { id } = req.params
    if (!UUID_RE.test(id)) { res.status(400).json({ error: 'Invalid instance id' }); return }
    const label = ((req.body ?? {}) as { label?: string }).label?.trim()
    if (!label) { res.status(400).json({ error: 'label is required' }); return }
    try {
      const updated = await connectorInstanceStore.update(userId, id, { label })
      if (!updated) { res.status(404).json({ error: 'Connector instance not found' }); return }
      res.json({ ok: true, label: updated.label })
    } catch (err) {
      console.error('[connectors] rename failed:', err)
      res.status(500).json({ error: 'Failed to rename connector' })
    }
  })

  // ── DELETE /instances/:id — delete a specific instance ───────
  router.delete('/instances/:id', async (req, res) => {
    const userId = req.userId
    if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return }
    const { id } = req.params
    if (!UUID_RE.test(id)) { res.status(400).json({ error: 'Invalid instance id' }); return }
    try {
      const deleted = await connectorInstanceStore.delete(userId, id)
      if (!deleted) { res.status(404).json({ error: 'Connector instance not found' }); return }
      res.json({ ok: true })
    } catch (err) {
      console.error('[connectors] delete instance failed:', err)
      res.status(500).json({ error: 'Failed to delete connector' })
    }
  })

  // ── DELETE /:provider — delete the primary instance (legacy shim) ──
  router.delete('/:provider', async (req, res) => {
    const userId = req.userId
    if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return }
    try {
      const deleted = await connectorStore.delete(userId, req.params.provider)
      if (!deleted) { res.status(404).json({ error: 'Connector not found' }); return }
      res.json({ ok: true })
    } catch (err) {
      console.error('[connectors] delete failed:', err)
      res.status(500).json({ error: 'Failed to delete connector' })
    }
  })

  return router
}
