export type WhatsappConnectorClient = {
  disconnect(channelId: string): Promise<void>
}

export function createWhatsappConnectorClient(input: {
  connectorUrl: string
  connectorSecret: string
}): WhatsappConnectorClient {
  return {
    async disconnect(channelId) {
      const response = await fetch(`${input.connectorUrl}/disconnect/${encodeURIComponent(channelId)}`, {
        method: 'POST',
        headers: { 'X-Connector-Secret': input.connectorSecret },
      })
      if (!response.ok && response.status !== 404) {
        throw new Error(`WhatsApp disconnect failed (${response.status})`)
      }
    },
  }
}
