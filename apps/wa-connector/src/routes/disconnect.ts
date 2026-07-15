/**
 * Disconnect endpoint. Closes the Baileys socket and optionally deletes
 * GCS credentials.
 *
 * See docs/architecture/channels/whatsapp.md.
 */

import { Router } from 'express'
import type { SocketManager } from '../socket-manager.js'

export function disconnectRoutes(socketManager: SocketManager): Router {
  const router = Router()

  router.post('/:channelId', async (req, res) => {
    const { channelId } = req.params
    const deleteCreds = req.body?.deleteCreds === true

    try {
      await socketManager.disconnect(channelId, deleteCreds)
      res.status(204).end()
    } catch (err) {
      console.error(`[disconnect] Failed for ${channelId}:`, err)
      res.status(500).json({ error: String(err) })
    }
  })

  return router
}
