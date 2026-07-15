/**
 * Unit tests for `ensureWhatsappConnectorInstance` — provisions the
 * workspace-scoped `connector_instance` paired with a WhatsApp
 * `channel_integrations` row.
 *
 * Locks in:
 *   - idempotency: an already-linked integration returns its existing CI
 *     id and writes nothing
 *   - default-drop: NO `ingest_rules` are seeded (WhatsApp defaults are
 *     empty), so a freshly-connected number ingests nothing until a group
 *     is enabled
 *   - the link is wired (channel_integrations.connector_instance_id)
 *
 * [COMP:api/whatsapp-connector-instance]
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const query = vi.fn()
const queryWithRLS = vi.fn()

vi.mock('../../db/client.js', () => ({
  query: (...args: unknown[]) => query(...args),
  queryWithRLS: (...args: unknown[]) => queryWithRLS(...args),
}))

const { ensureWhatsappConnectorInstance } = await import('../whatsapp-connector-instance.js')

const CI_ID = 'ci_wa_new'
const INTEGRATION_ID = 'int_1'
const ACTOR = 'u_owner'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('[COMP:api/whatsapp-connector-instance] ensureWhatsappConnectorInstance', () => {
  it('short-circuits when the integration already has a CI', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 'ci_existing', workspace_id: 'w_1' }] })

    const id = await ensureWhatsappConnectorInstance({
      channelIntegrationId: INTEGRATION_ID,
      actingUserId: ACTOR,
    })

    expect(id).toBe('ci_existing')
    // No CI insert, no rule seed, no link update.
    expect(queryWithRLS).not.toHaveBeenCalled()
    expect(query).toHaveBeenCalledTimes(1)
  })

  it('creates the CI, seeds NO rules (default-drop), and links it', async () => {
    // 1. linked lookup → not yet linked
    query.mockResolvedValueOnce({ rows: [{ id: null, workspace_id: 'w_1' }] })
    // 2. meta lookup
    query.mockResolvedValueOnce({ rows: [{ team_name: 'WhatsApp', team_id: null, has_ingest: true }] })
    // 3. CI insert (queryWithRLS)
    queryWithRLS.mockResolvedValueOnce({ rows: [{ id: CI_ID }] })
    // 4. link update (query) — no rule seed in between
    query.mockResolvedValueOnce({ rows: [] })

    const id = await ensureWhatsappConnectorInstance({
      channelIntegrationId: INTEGRATION_ID,
      actingUserId: ACTOR,
    })

    expect(id).toBe(CI_ID)

    // CI insert ran with provider 'whatsapp'.
    expect(queryWithRLS).toHaveBeenCalledTimes(1)
    const ciSql = queryWithRLS.mock.calls[0][1] as string
    expect(ciSql).toContain('INSERT INTO connector_instance')
    expect(ciSql).toContain("'whatsapp'")

    // Default-drop: ingest_rules is NEVER inserted (empty defaults).
    const allSql = [
      ...query.mock.calls.map((c) => String(c[0])),
      ...queryWithRLS.mock.calls.map((c) => String(c[1])),
    ]
    expect(allSql.some((s) => s.includes('INSERT INTO ingest_rules'))).toBe(false)

    // The link is wired.
    const linkUpdate = query.mock.calls.find((c) =>
      String(c[0]).includes('UPDATE channel_integrations SET connector_instance_id'),
    )
    expect(linkUpdate).toBeTruthy()
    expect(linkUpdate?.[1]).toEqual([CI_ID, INTEGRATION_ID])
  })

  it('throws when the integration row is missing', async () => {
    query.mockResolvedValueOnce({ rows: [] })
    await expect(
      ensureWhatsappConnectorInstance({ channelIntegrationId: 'missing', actingUserId: ACTOR }),
    ).rejects.toThrow(/no channel_integrations row/)
  })
})
