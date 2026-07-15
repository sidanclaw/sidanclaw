/**
 * Typing indicator endpoint. Sends WhatsApp "composing" presence.
 *
 * See docs/architecture/channels/whatsapp.md.
 */

import { Router } from 'express'
import type { SocketManager } from '../socket-manager.js'

export function typingRoutes(socketManager: SocketManager): Router {
  const router = Router()

  router.post('/:channelId', async (req, res) => {
    const { channelId } = req.params
    const { jid } = req.body as { jid?: string }

    if (!jid) {
      res.status(400).json({ error: 'jid is required' })
      return
    }

    const managed = socketManager.getStatus(channelId)
    if (!managed || managed.status !== 'connected') {
      res.status(404).json({ error: 'No active connection' })
      return
    }

    try {
      await managed.sock.sendPresenceUpdate('composing', jid)
      res.json({ ok: true })
    } catch {
      // Best effort — don't fail the request
      res.json({ ok: true })
    }
  })

  return router
}
