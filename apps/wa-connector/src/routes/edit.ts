/**
 * Outbound message edit endpoint.
 *
 * Edits a previously sent message via Baileys' edit protocol.
 * The adapter sends { text, edit: WAMessageKey } to replace message content.
 *
 * See docs/architecture/channels/whatsapp.md.
 */

import { Router } from 'express'
import { z } from 'zod'
import type { SocketManager } from '../socket-manager.js'

const editSchema = z.object({
  jid: z.string().min(1),
  messageId: z.string().min(1),
  text: z.string().min(1),
})

export function editRoutes(socketManager: SocketManager): Router {
  const router = Router()

  router.post('/:channelId', async (req, res) => {
    const { channelId } = req.params

    const parsed = editSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid request', details: parsed.error.flatten() })
      return
    }

    const { jid, messageId, text } = parsed.data

    try {
      const content = {
        text,
        edit: { remoteJid: jid, id: messageId, fromMe: true },
      }

      await socketManager.send(
        channelId,
        jid,
        content as import('@whiskeysockets/baileys').AnyMessageContent,
      )
      res.json({ ok: true })
    } catch (err) {
      console.error(`[edit] Failed for ${channelId}:`, err)
      res.status(500).json({ error: String(err) })
    }
  })

  return router
}
