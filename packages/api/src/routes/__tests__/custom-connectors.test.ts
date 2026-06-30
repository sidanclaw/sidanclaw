/**
 * Unit tests for the shared custom MCP connector routes (/api/connectors/custom*).
 * Component tag: [COMP:api/custom-connectors-route].
 *
 * This is the OPEN home of the custom-connector feature, mounted by both the
 * open and closed connector routers. Verifies add/edit/delete, the per-auth-type
 * credential blobs (bearer / custom_header / oauth), the PATCH keep-secret rule,
 * and the /test probe — including its security contract: it never echoes the
 * upstream response body (a credentialed-read exfil vector) and surfaces only an
 * HTTP status code or a generic category. The store and the MCP discovery client
 * are mocked, so no DB and no network.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'

const mockDiscover = vi.fn()
vi.mock('../../mcp/client.js', () => ({
  discoverMcpServer: (...a: unknown[]) => mockDiscover(...a),
}))

import { customConnectorRoutes } from '../custom-connectors.js'
import type { ConnectorStore } from '../../db/connector-store.js'

const store = {
  list: vi.fn(),
  getConfig: vi.fn(),
  getAuthCredentials: vi.fn(),
  setConfig: vi.fn(),
  setConnected: vi.fn(),
  upsert: vi.fn(),
  delete: vi.fn(),
}

const storedRow = {
  id: 'ci-1',
  userId: 'u-1',
  connectorId: 'cx-1',
  name: 'My MCP',
  url: 'https://mcp.example/sse',
  custom: true,
  connected: true,
  credentialsType: 'bearer',
}

function app(userId?: string) {
  const a = express()
  a.use(express.json())
  if (userId) {
    a.use((req, _res, next) => {
      ;(req as { userId?: string }).userId = userId
      next()
    })
  }
  a.use('/api/connectors', customConnectorRoutes({ connectorStore: store as unknown as ConnectorStore }))
  return a
}

beforeEach(() => {
  vi.clearAllMocks()
  store.getConfig.mockResolvedValue({})
  store.getAuthCredentials.mockResolvedValue(null)
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('[COMP:api/custom-connectors-route] add / delete', () => {
  it('401 without auth', async () => {
    const res = await request(app()).post('/api/connectors/custom').send({ name: 'x', url: 'https://x' })
    expect(res.status).toBe(401)
  })

  it('rejects a custom connector with no name or url', async () => {
    expect((await request(app('u-1')).post('/api/connectors/custom').send({ name: 'x' })).status).toBe(400)
  })

  it('adds a custom connector', async () => {
    store.upsert.mockResolvedValueOnce({ connectorId: 'uuid-1', name: 'My MCP' })
    const res = await request(app('u-1'))
      .post('/api/connectors/custom')
      .send({ name: 'My MCP', url: 'https://mcp.example/sse' })
    expect(res.status).toBe(200)
    expect(res.body.id).toBe('uuid-1')
    // A fresh custom row is written to the shared connector_instance table.
    expect(store.upsert).toHaveBeenCalledWith(
      'u-1',
      expect.objectContaining({ name: 'My MCP', url: 'https://mcp.example/sse', custom: true, connected: false }),
    )
  })

  it('deletes a custom connector (204) and 404s an unknown one', async () => {
    store.delete.mockResolvedValueOnce(true)
    expect((await request(app('u-1')).delete('/api/connectors/custom/cx-1')).status).toBe(204)
    store.delete.mockResolvedValueOnce(false)
    expect((await request(app('u-1')).delete('/api/connectors/custom/ghost')).status).toBe(404)
  })
})

describe('[COMP:api/custom-connectors-route] auth types', () => {
  it('adds a bearer connector with a typed credential blob and never echoes the secret', async () => {
    store.upsert.mockResolvedValueOnce({ connectorId: 'uuid-1', name: 'My MCP', credentialsType: 'bearer' })
    const res = await request(app('u-1'))
      .post('/api/connectors/custom')
      .send({ name: 'My MCP', url: 'https://mcp.example/sse', authType: 'bearer', bearerToken: 'tok-s3cret' })
    expect(res.status).toBe(200)
    expect(store.upsert).toHaveBeenCalledWith(
      'u-1',
      expect.objectContaining({ credentials: { type: 'bearer', token: 'tok-s3cret' } }),
    )
    expect(JSON.stringify(res.body)).not.toContain('tok-s3cret')
  })

  it('adds a custom_header connector and mirrors the header name into config', async () => {
    store.upsert.mockResolvedValueOnce({ connectorId: 'uuid-2', name: 'My MCP' })
    const res = await request(app('u-1'))
      .post('/api/connectors/custom')
      .send({ name: 'My MCP', url: 'https://mcp.example/sse', authType: 'custom_header', headerName: 'X-Api-Key', headerValue: 'k-s3cret' })
    expect(res.status).toBe(200)
    expect(store.upsert).toHaveBeenCalledWith(
      'u-1',
      expect.objectContaining({ credentials: { type: 'custom_header', header: 'X-Api-Key', value: 'k-s3cret' } }),
    )
    const connectorId = store.upsert.mock.calls[0][1].connectorId
    expect(store.setConfig).toHaveBeenCalledWith('u-1', connectorId, { authHeaderName: 'X-Api-Key' })
    expect(JSON.stringify(res.body)).not.toContain('k-s3cret')
  })

  it('rejects an invalid header name with 400', async () => {
    const res = await request(app('u-1'))
      .post('/api/connectors/custom')
      .send({ name: 'X', url: 'https://x', authType: 'custom_header', headerName: 'X Bad Name', headerValue: 'v' })
    expect(res.status).toBe(400)
    expect(store.upsert).not.toHaveBeenCalled()
  })

  it('rejects a non-none auth type with no secret in add mode', async () => {
    const res = await request(app('u-1'))
      .post('/api/connectors/custom')
      .send({ name: 'X', url: 'https://x', authType: 'bearer' })
    expect(res.status).toBe(400)
    expect(store.upsert).not.toHaveBeenCalled()
  })

  it('keeps the legacy oauth-pair contract when authType is omitted', async () => {
    store.upsert.mockResolvedValueOnce({ connectorId: 'uuid-3' })
    const res = await request(app('u-1'))
      .post('/api/connectors/custom')
      .send({ name: 'X', url: 'https://x', oauthClientId: 'id1', oauthClientSecret: 'sec1' })
    expect(res.status).toBe(200)
    expect(store.upsert).toHaveBeenCalledWith(
      'u-1',
      expect.objectContaining({ credentials: { type: 'oauth', client_id: 'id1', client_secret: 'sec1' } }),
    )
  })
})

describe('[COMP:api/custom-connectors-route] PATCH keep-secret rule', () => {
  it('keeps stored credentials when the type is unchanged and the secret is blank', async () => {
    store.list.mockResolvedValueOnce([storedRow])
    store.upsert.mockResolvedValueOnce({ connectorId: 'cx-1' })
    const res = await request(app('u-1'))
      .patch('/api/connectors/custom/cx-1')
      .send({ name: 'My MCP', url: 'https://mcp.example/sse', authType: 'bearer' })
    expect(res.status).toBe(200)
    const args = store.upsert.mock.calls[0][1]
    expect(args.credentials).toBeUndefined()
    expect(args.clearCredentials).toBeUndefined()
  })

  it('rejects an auth-type change without re-entering the secret', async () => {
    store.list.mockResolvedValueOnce([{ ...storedRow, credentialsType: 'oauth' }])
    const res = await request(app('u-1'))
      .patch('/api/connectors/custom/cx-1')
      .send({ name: 'My MCP', url: 'https://mcp.example/sse', authType: 'bearer' })
    expect(res.status).toBe(400)
    expect(store.upsert).not.toHaveBeenCalled()
  })

  it('rejects a header-name change without re-entering the value', async () => {
    store.list.mockResolvedValueOnce([{ ...storedRow, credentialsType: 'custom_header' }])
    store.getConfig.mockResolvedValueOnce({ authHeaderName: 'X-Api-Key' })
    const res = await request(app('u-1'))
      .patch('/api/connectors/custom/cx-1')
      .send({ name: 'My MCP', url: 'https://mcp.example/sse', authType: 'custom_header', headerName: 'X-Other' })
    expect(res.status).toBe(400)
    expect(store.upsert).not.toHaveBeenCalled()
  })

  it('keeps credentials when the header name is unchanged', async () => {
    store.list.mockResolvedValueOnce([{ ...storedRow, credentialsType: 'custom_header' }])
    store.getConfig.mockResolvedValueOnce({ authHeaderName: 'X-Api-Key' })
    store.upsert.mockResolvedValueOnce({ connectorId: 'cx-1' })
    const res = await request(app('u-1'))
      .patch('/api/connectors/custom/cx-1')
      .send({ name: 'My MCP', url: 'https://mcp.example/sse', authType: 'custom_header', headerName: 'X-Api-Key' })
    expect(res.status).toBe(200)
    expect(store.upsert.mock.calls[0][1].credentials).toBeUndefined()
  })

  it('refuses to edit a non-custom (built-in) connector', async () => {
    store.list.mockResolvedValueOnce([{ ...storedRow, connectorId: 'gmail', custom: false }])
    const res = await request(app('u-1'))
      .patch('/api/connectors/custom/gmail')
      .send({ name: 'Gmail', url: 'https://x', authType: 'none' })
    expect(res.status).toBe(400)
    expect(store.upsert).not.toHaveBeenCalled()
  })

  it('rejects a half-filled OAuth pair instead of silently keeping', async () => {
    store.list.mockResolvedValueOnce([{ ...storedRow, credentialsType: 'oauth' }])
    const res = await request(app('u-1'))
      .patch('/api/connectors/custom/cx-1')
      .send({ name: 'My MCP', url: 'https://mcp.example/sse', authType: 'oauth', oauthClientId: 'only-id' })
    expect(res.status).toBe(400)
    expect(store.upsert).not.toHaveBeenCalled()
  })

  it('to none clears credentials and the mirrored header name', async () => {
    store.list.mockResolvedValueOnce([storedRow])
    store.upsert.mockResolvedValueOnce({ connectorId: 'cx-1' })
    const res = await request(app('u-1'))
      .patch('/api/connectors/custom/cx-1')
      .send({ name: 'My MCP', url: 'https://mcp.example/sse', authType: 'none' })
    expect(res.status).toBe(200)
    expect(store.upsert.mock.calls[0][1].clearCredentials).toBe(true)
    expect(store.setConfig).toHaveBeenCalledWith('u-1', 'cx-1', { authHeaderName: null })
  })

  it('replaces credentials when the new secret is supplied with the type change', async () => {
    store.list.mockResolvedValueOnce([{ ...storedRow, credentialsType: 'oauth' }])
    store.upsert.mockResolvedValueOnce({ connectorId: 'cx-1' })
    const res = await request(app('u-1'))
      .patch('/api/connectors/custom/cx-1')
      .send({ name: 'My MCP', url: 'https://mcp.example/sse', authType: 'bearer', bearerToken: 'newtok' })
    expect(res.status).toBe(200)
    expect(store.upsert.mock.calls[0][1].credentials).toEqual({ type: 'bearer', token: 'newtok' })
  })
})

describe('[COMP:api/custom-connectors-route] connection probe', () => {
  it('success sets connected=true, reports the tool count, and threads the auth headers', async () => {
    store.list.mockResolvedValueOnce([storedRow])
    store.getAuthCredentials.mockResolvedValueOnce({ type: 'custom_header', header: 'X-Api-Key', value: 'k1' })
    store.setConnected.mockResolvedValueOnce({ connectorId: 'cx-1', connected: true })
    mockDiscover.mockResolvedValueOnce({ name: 'My MCP', url: 'https://mcp.example/sse', tools: [{ name: 'a' }, { name: 'b' }] })
    const res = await request(app('u-1')).post('/api/connectors/custom/cx-1/test')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true, toolCount: 2, connected: true })
    expect(store.setConnected).toHaveBeenCalledWith('u-1', 'cx-1', true)
    expect(mockDiscover).toHaveBeenCalledWith('https://mcp.example/sse', 'My MCP', { 'X-Api-Key': 'k1' })
  })

  it('failure sets connected=false and never reflects the upstream body', async () => {
    store.list.mockResolvedValueOnce([storedRow])
    store.setConnected.mockResolvedValueOnce({ connectorId: 'cx-1', connected: false })
    const SECRET_BODY = 'SECRET_PROJECT_TOKEN_ya29.leaked'
    mockDiscover.mockRejectedValueOnce(new Error(`Streamable HTTP error: Error POSTing to endpoint: ${SECRET_BODY}`))
    const res = await request(app('u-1')).post('/api/connectors/custom/cx-1/test')
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(false)
    expect(res.body.connected).toBe(false)
    expect(res.body.error).toBe('Could not reach the MCP server')
    expect(JSON.stringify(res.body)).not.toContain(SECRET_BODY)
    expect(store.setConnected).toHaveBeenCalledWith('u-1', 'cx-1', false)
  })

  it('surfaces only the HTTP status code for an HTTP error', async () => {
    store.list.mockResolvedValueOnce([storedRow])
    store.setConnected.mockResolvedValueOnce({ connectorId: 'cx-1', connected: false })
    const httpErr = Object.assign(new Error('Streamable HTTP error: Error POSTing to endpoint: leaked-body'), { code: 401 })
    mockDiscover.mockRejectedValueOnce(httpErr)
    const res = await request(app('u-1')).post('/api/connectors/custom/cx-1/test')
    expect(res.body.error).toBe('Server returned HTTP 401')
    expect(JSON.stringify(res.body)).not.toContain('leaked-body')
  })

  it('404s an unknown connector and 400s a non-custom one', async () => {
    store.list.mockResolvedValueOnce([])
    expect((await request(app('u-1')).post('/api/connectors/custom/ghost/test')).status).toBe(404)
    store.list.mockResolvedValueOnce([{ ...storedRow, custom: false }])
    expect((await request(app('u-1')).post('/api/connectors/custom/cx-1/test')).status).toBe(400)
    expect(mockDiscover).not.toHaveBeenCalled()
  })
})
