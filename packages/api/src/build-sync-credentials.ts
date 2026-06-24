/**
 * OPEN knowledge-sync credential provider — the open default for
 * `ports.buildSyncCredentials`.
 *
 * The knowledge-sync worker needs a GitHub PAT to pull a source repo. The hosted
 * tier resolves it through a closed provider (api-platform); when that port is
 * absent the open build falls back to a stub that throws "GitHub knowledge sync
 * is not configured in this build". This module is the open equivalent: it reads
 * the PAT straight from the connected GitHub *connector*, because the unified
 * connectors model stores every GitHub PAT as a `connector_instance` credential
 * (see routes/connectors.ts → store-credentials). So once the single-player user
 * connects GitHub in Studio → Connectors, knowledge sync reuses that same token.
 *
 * Resolution order for `getPat(workspaceId, connectorInstanceId)`:
 *   1. The instance the source is explicitly bound to (`connectorInstanceId`).
 *   2. A GitHub connector exposed (granted) to the workspace — shared-workspace.
 *   3. The workspace owner's personal GitHub connector — solo / single-player.
 * None connected → throw a clear "connect GitHub" error.
 *
 * `apps/api/src/index.ts` passes this as `ports.buildSyncCredentials`; the hosted
 * platform supplies its own over the same deps, so boot is unchanged. Mirrors
 * the open `build-episode-ingestors.ts` wiring. See oss-local-brain-wedge.md.
 */

import type { SyncCredentials } from '@sidanclaw/core'
import { query } from './db/client.js'
import type { createConnectorInstanceStore } from './db/connector-instance-store.js'
import type { createConnectorGrantStore } from './db/connector-grant-store.js'
import type { ConnectorCredentials } from './db/connector-store.js'

/** Pull the bearer secret from a connector credentials blob (GitHub PAT lives in client_secret / token). */
function patFromCredentials(creds: ConnectorCredentials | null): string | null {
  if (!creds) return null
  if (creds.type === 'oauth') return creds.client_secret || null
  if (creds.type === 'bearer') return creds.token || null
  return null
}

export function buildSyncCredentials(deps: {
  connectorInstanceStore: ReturnType<typeof createConnectorInstanceStore>
  connectorGrantStore: ReturnType<typeof createConnectorGrantStore>
}): SyncCredentials {
  const { connectorInstanceStore, connectorGrantStore } = deps

  const patForInstance = async (id: string): Promise<string | null> =>
    patFromCredentials(await connectorInstanceStore.getAuthCredentialsSystem(id))

  return {
    async getPat(workspaceId, connectorInstanceId) {
      // 1. Source bound to a specific connector instance.
      if (connectorInstanceId) {
        const pat = await patForInstance(connectorInstanceId)
        if (pat) return pat
      }

      // 2. A GitHub connector exposed (granted) to the workspace.
      const granted = await connectorGrantStore.findGrantedInstanceByProviderSystem(
        'workspace',
        workspaceId,
        'github',
      )
      if (granted) {
        const pat = await patForInstance(granted.id)
        if (pat) return pat
      }

      // 3. Solo / single-player: the workspace owner's personal GitHub connector.
      const owner = await query<{ ownerUserId: string | null }>(
        `SELECT owner_user_id AS "ownerUserId" FROM workspaces WHERE id = $1`,
        [workspaceId],
      )
      const ownerUserId = owner.rows[0]?.ownerUserId
      if (ownerUserId) {
        const insts = await connectorInstanceStore.findByUserProviderSystem(ownerUserId, 'github')
        const chosen = insts.find((i) => i.connected) ?? insts[0]
        if (chosen) {
          const pat = await patForInstance(chosen.id)
          if (pat) return pat
        }
      }

      throw new Error(
        'No connected GitHub connector found for knowledge sync — connect GitHub in Studio → Connectors.',
      )
    },
  }
}
