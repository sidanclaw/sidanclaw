/**
 * Connection status endpoint.
 *
 * See docs/architecture/channels/whatsapp.md.
 */

import { Router } from 'express'
import type { SocketManager } from '../socket-manager.js'

export function statusRoutes(socketManager: SocketManager): Router {
  const router = Router()

  router.get('/:channelId', (req, res) => {
    const { channelId } = req.params
    const managed = socketManager.getStatus(channelId)

    if (!managed) {
      res.json({ status: 'disconnected' })
      return
    }

    res.json({
      status: managed.status,
      phoneNumber: managed.phoneNumber,
      connectedAt: managed.connectedAt,
    })
  })

  return router
}
