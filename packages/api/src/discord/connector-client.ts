/**
 * Client for the discord-connector service (apps/discord-connector).
 *
 * The connector holds the Gateway WebSocket(s); the API drives their lifecycle
 * over HTTP. This is the API-side seam: when a workspace connects a Discord bot
 * (BYO), the setup route calls `connect()` with the decrypted bot token so the
 * connector opens that bot's Gateway socket. On disconnect/revoke it calls
 * `disconnect()`.
 *
 * Inbound messages flow the other way (connector → `/internal/discord/inbound`)
 * and outbound replies go API → Discord REST directly, so neither passes through
 * this client. See docs/architecture/channels/discord.md.
 *
 * Component tag: [COMP:channels/discord-connector-client].
 */

export type DiscordConnectorStatus = {
  channelId: string
  status: 'connecting' | 'connected' | 'disconnected'
  botUserId?: string
  connectedAt?: number
}

export type DiscordConnectorClient = {
  /** Open (or replace) the Gateway connection for a channel's bot. */
  connect(channelId: string, input: { botToken: string; botUserId?: string }): Promise<DiscordConnectorStatus>
  /** Tear down the Gateway connection for a channel. Idempotent. */
  disconnect(channelId: string): Promise<void>
  /** Current connection status, or null if the connector has no socket for it. */
  status(channelId: string): Promise<DiscordConnectorStatus | null>
}

export type DiscordConnectorClientOptions = {
  /** Base URL of the deployed discord-connector (DISCORD_CONNECTOR_URL). */
  connectorUrl: string
  /** Shared secret presented as X-Connector-Secret (DISCORD_CONNECTOR_SECRET). */
  connectorSecret: string
}

export function createDiscordConnectorClient(
  options: DiscordConnectorClientOptions,
): DiscordConnectorClient {
  const base = options.connectorUrl.replace(/\/$/, '')

  async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        'X-Connector-Secret': options.connectorSecret,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`discord-connector ${method} ${path} failed: ${res.status} ${text}`.trim())
    }
    if (res.status === 204) return undefined as T
    return (await res.json()) as T
  }

  return {
    connect(channelId, input) {
      return call<DiscordConnectorStatus>('POST', `/connect/${encodeURIComponent(channelId)}`, input)
    },

    async disconnect(channelId) {
      await call<{ ok: boolean }>('POST', `/disconnect/${encodeURIComponent(channelId)}`)
    },

    async status(channelId) {
      try {
        return await call<DiscordConnectorStatus>('GET', `/status/${encodeURIComponent(channelId)}`)
      } catch (err) {
        // 404 → no live socket for this channel. Treat as "not connected".
        if (err instanceof Error && err.message.includes('404')) return null
        throw err
      }
    },
  }
}
