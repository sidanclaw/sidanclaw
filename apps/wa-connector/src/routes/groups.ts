/**
 * Group roster endpoint. Lists every WhatsApp group the connected number
 * participates in (via Baileys `groupFetchAllParticipating`), so the ingest UI
 * can show groups directly instead of waiting for a message to be observed.
 *
 * See docs/architecture/channels/whatsapp.md.
 */

import { Router } from 'express'
import type { SocketManager } from '../socket-manager.js'

export function groupsRoutes(socketManager: SocketManager): Router {
  const router = Router()

  router.get('/:channelId', async (req, res) => {
    try {
      const groups = await socketManager.listGroups(req.params.channelId)
      res.json({ groups })
    } catch (err) {
      // Socket not connected (or roster fetch failed) — the API caller falls
      // back to the observed-group inventory.
      res.status(409).json({
        error: err instanceof Error ? err.message : String(err),
      })
    }
  })

  return router
}
