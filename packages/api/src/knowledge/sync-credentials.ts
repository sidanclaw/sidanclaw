/**
 * Sync credential provider — resolves a GitHub PAT for the KB sync worker.
 *
 * Primary path: the source's **bound `connector_instance_id`**. Each KB source
 * persists the connector the user picked when creating it (mig 268), and sync
 * reads that exact instance's credentials. A source therefore always syncs
 * through the connector it was configured with — a *different* GitHub connector
 * in the same workspace can never shadow it (the bug this fixed: a stale
 * workspace-scoped connector winning over a freshly-picked one).
 *
 * Fallback path (legacy NULL only): for sources created before mig 268, or
 * whose bound connector was deleted (the FK is `ON DELETE SET NULL`), resolve
 * by `workspaceId` the old way — a legacy team-native instance
 * (scope='workspace'), then a member-exposed personal instance granted to the
 * workspace. The fallback **tries each candidate and falls through on a
 * credential miss** rather than committing to the first: a disconnected (or
 * since-removed) team-native connector no longer strands a source that has a
 * working personal connector granted to the workspace. The remedy for a stuck
 * legacy source is to re-add it through the picker, which binds it to a chosen
 * connector; mig 274 backfills the binding for the legacy NULL rows in bulk.
 *
 * Limitation: a connector that is `connected=true` but whose PAT GitHub later
 * rejects (401 Bad credentials) cannot be detected here — `getCredentialsSystem`
 * returns its stored secret regardless. Recovering that is a reconnect with a
 * fresh PAT (a product action in Studio → Connectors), not a resolution change.
 *
 * See docs/architecture/features/knowledge-base.md → "Workspace credential scoping".
 */

import type { ConnectorInstanceStore } from '../db/connector-instance-store.js'
import type { ConnectorGrantStore } from '../db/connector-grant-store.js'

export type SyncCredentialProvider = {
  getPat(workspaceId: string, connectorInstanceId: string | null): Promise<string>
}

export function createSyncCredentialProvider(
  instanceStore: ConnectorInstanceStore,
  grantStore: ConnectorGrantStore,
): SyncCredentialProvider {
  return {
    async getPat(workspaceId, connectorInstanceId) {
      // Primary: the connector the source was created with.
      if (connectorInstanceId) {
        const creds = await instanceStore.getCredentialsSystem(connectorInstanceId)
        if (!creds) {
          throw new Error(
            `KB source connector ${connectorInstanceId} (workspace ${workspaceId}) has no stored ` +
            `credentials. Reconnect it in Studio → Connectors, or re-add the source with a connector ` +
            `that is connected.`,
          )
        }
        return creds.client_secret
      }

      // Fallback (legacy NULL): resolve by workspace. Try candidates in
      // priority order — legacy team-native first, then a member-exposed
      // personal connector granted to the workspace — and FALL THROUGH on a
      // credential miss instead of committing to the first. `getCredentialsSystem`
      // filters on `connected = true`, so a disconnected candidate returns null
      // here and we advance to the next; a stale/disconnected team-native
      // connector therefore can't strand a source whose personal connector works.
      let sawCandidate = false

      const teamInstance = await instanceStore.findByWorkspaceProviderSystem(workspaceId, 'github')
      if (teamInstance) {
        sawCandidate = true
        const creds = await instanceStore.getCredentialsSystem(teamInstance.id)
        if (creds) return creds.client_secret
        // Team-native exists but has no usable credentials (disconnected) —
        // fall through to a granted personal connector rather than throwing.
      }

      const granted = await grantStore.findGrantedInstanceByProviderSystem(
        'workspace',
        workspaceId,
        'github',
      )
      if (granted) {
        sawCandidate = true
        const creds = await instanceStore.getCredentialsSystem(granted.id)
        if (creds) return creds.client_secret
      }

      if (!sawCandidate) {
        throw new Error(
          `Workspace ${workspaceId} has no GitHub connector exposed for sync. ` +
          `Connect GitHub in Studio → Connectors and share it with this workspace.`,
        )
      }
      throw new Error(
        `Workspace ${workspaceId} GitHub connector has no stored credentials. ` +
        `Reconnect GitHub in Studio → Connectors.`,
      )
    },
  }
}
