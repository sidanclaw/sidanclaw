/**
 * Unit tests for the OPEN knowledge-sync credential provider.
 * Component tag: [COMP:api/sync-credentials-open].
 *
 * Verifies the three-step GitHub PAT resolution (bound instance → workspace
 * grant → workspace-owner personal connector) and the "not connected" throw.
 * The workspace-owner lookup goes through db `query`, which is mocked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }))
vi.mock('../db/client.js', () => ({ query: queryMock }))

import { buildSyncCredentials } from '../build-sync-credentials.js'
import type { ConnectorInstanceStore, ConnectorInstance } from '../db/connector-instance-store.js'
import type { ConnectorGrantStore } from '../db/connector-grant-store.js'

const WS = '00000000-0000-0000-0000-0000000000ws'

function inst(over: Partial<ConnectorInstance> = {}): ConnectorInstance {
  return {
    id: 'inst-1', scope: 'user', userId: 'owner-1', workspaceId: null,
    provider: 'github', label: 'GitHub', connectedEmail: null, url: null,
    custom: false, config: {}, sensitivity: 'internal', connected: true,
    ingestionEnabled: false, credentialsType: 'oauth', createdBy: 'owner-1',
    createdAt: new Date(0), updatedAt: new Date(0), ...over,
  }
}

function build(over: {
  getAuthCredentialsSystem?: ReturnType<typeof vi.fn>
  findByUserProviderSystem?: ReturnType<typeof vi.fn>
  findGrantedInstanceByProviderSystem?: ReturnType<typeof vi.fn>
} = {}) {
  const getAuthCredentialsSystem = over.getAuthCredentialsSystem ?? vi.fn().mockResolvedValue(null)
  const findByUserProviderSystem = over.findByUserProviderSystem ?? vi.fn().mockResolvedValue([])
  const findGrantedInstanceByProviderSystem =
    over.findGrantedInstanceByProviderSystem ?? vi.fn().mockResolvedValue(null)
  const connectorInstanceStore = { getAuthCredentialsSystem, findByUserProviderSystem } as unknown as ConnectorInstanceStore
  const connectorGrantStore = { findGrantedInstanceByProviderSystem } as unknown as ConnectorGrantStore
  return {
    creds: buildSyncCredentials({ connectorInstanceStore, connectorGrantStore }),
    getAuthCredentialsSystem, findByUserProviderSystem, findGrantedInstanceByProviderSystem,
  }
}

describe('[COMP:api/sync-credentials-open] buildSyncCredentials', () => {
  beforeEach(() => { vi.clearAllMocks(); queryMock.mockResolvedValue({ rows: [] }) })

  it('uses the PAT of the instance the source is bound to', async () => {
    const { creds, getAuthCredentialsSystem, findGrantedInstanceByProviderSystem } = build({
      getAuthCredentialsSystem: vi.fn().mockResolvedValue({ type: 'oauth', client_id: '', client_secret: 'ghp_bound' }),
    })
    expect(await creds.getPat(WS, 'inst-bound')).toBe('ghp_bound')
    expect(getAuthCredentialsSystem).toHaveBeenCalledWith('inst-bound')
    expect(findGrantedInstanceByProviderSystem).not.toHaveBeenCalled()
  })

  it('falls back to a GitHub connector granted to the workspace', async () => {
    const { creds, findGrantedInstanceByProviderSystem } = build({
      findGrantedInstanceByProviderSystem: vi.fn().mockResolvedValue(inst({ id: 'granted-1' })),
      getAuthCredentialsSystem: vi.fn().mockResolvedValue({ type: 'bearer', token: 'ghp_granted' }),
    })
    expect(await creds.getPat(WS, null)).toBe('ghp_granted')
    expect(findGrantedInstanceByProviderSystem).toHaveBeenCalledWith('workspace', WS, 'github')
  })

  it('falls back to the workspace owner personal GitHub connector (solo/OSS)', async () => {
    queryMock.mockResolvedValue({ rows: [{ ownerUserId: 'owner-1' }] })
    const { creds, findByUserProviderSystem } = build({
      findByUserProviderSystem: vi.fn().mockResolvedValue([inst({ id: 'owner-gh', connected: true })]),
      getAuthCredentialsSystem: vi.fn().mockResolvedValue({ type: 'oauth', client_id: '', client_secret: 'ghp_owner' }),
    })
    expect(await creds.getPat(WS, null)).toBe('ghp_owner')
    expect(findByUserProviderSystem).toHaveBeenCalledWith('owner-1', 'github')
  })

  it('throws a clear error when no GitHub connector is connected', async () => {
    const { creds } = build()
    await expect(creds.getPat(WS, null)).rejects.toThrow(/connect GitHub/i)
  })
})
