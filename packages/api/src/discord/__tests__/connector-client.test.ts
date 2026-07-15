import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createDiscordConnectorClient } from '../connector-client.js'

describe('[COMP:channels/discord-connector-client] createDiscordConnectorClient', () => {
  const fetchMock = vi.fn()

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockReset()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function okJson(body: unknown) {
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) }
  }

  const client = createDiscordConnectorClient({
    connectorUrl: 'https://connector.example.com/',
    connectorSecret: 'sekret',
  })

  it('POSTs /connect with the bot token + secret header', async () => {
    fetchMock.mockResolvedValueOnce(okJson({ channelId: 'ch1', status: 'connecting' }))
    const res = await client.connect('ch1', { botToken: 'tok', botUserId: 'B1' })

    expect(res).toEqual({ channelId: 'ch1', status: 'connecting' })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://connector.example.com/connect/ch1') // trailing slash trimmed
    expect(init.method).toBe('POST')
    expect(init.headers['X-Connector-Secret']).toBe('sekret')
    expect(JSON.parse(init.body)).toEqual({ botToken: 'tok', botUserId: 'B1' })
  })

  it('url-encodes the channel id in the path', async () => {
    fetchMock.mockResolvedValueOnce(okJson({ channelId: 'a/b', status: 'connecting' }))
    await client.connect('a/b', { botToken: 'tok' })
    expect(fetchMock.mock.calls[0][0]).toBe('https://connector.example.com/connect/a%2Fb')
  })

  it('disconnect POSTs and ignores the body', async () => {
    fetchMock.mockResolvedValueOnce(okJson({ ok: true }))
    await client.disconnect('ch1')
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://connector.example.com/disconnect/ch1')
    expect(init.method).toBe('POST')
  })

  it('status returns null on a 404', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 404, text: async () => 'not_connected' })
    expect(await client.status('ch1')).toBeNull()
  })

  it('status returns the payload on 200', async () => {
    fetchMock.mockResolvedValueOnce(okJson({ channelId: 'ch1', status: 'connected', botUserId: 'B1' }))
    expect(await client.status('ch1')).toMatchObject({ status: 'connected', botUserId: 'B1' })
  })

  it('throws with status text on a non-404 error', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'boom' })
    await expect(client.connect('ch1', { botToken: 't' })).rejects.toThrow(/500 boom/)
  })
})
