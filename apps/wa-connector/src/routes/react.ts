/**
 * Emoji reaction endpoint.
 *
 * Sends a reaction (emoji) to an existing message in a chat.
 * Baileys supports this via sendMessage with { react: { text, key } }.
 *
 * See docs/architecture/channels/whatsapp.md.
 */

import { Router } from 'express'
import { z } from 'zod'
import type { SocketManager } from '../socket-manager.js'

const reactSchema = z.object({
  jid: z.string().min(1),
  messageId: z.string().min(1),
  emoji: z.string().min(1),
})

export function reactRoutes(socketManager: SocketManager): Router {
  const router = Router()

  router.post('/:channelId', async (req, res) => {
    const { channelId } = req.params

    const parsed = reactSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid request', details: parsed.error.flatten() })
      return
    }

    const { jid, messageId, emoji } = parsed.data

    try {
      await socketManager.send(channelId, jid, {
        react: {
          text: emoji,
          key: { remoteJid: jid, id: messageId, fromMe: false },
        },
      } as import('@whiskeysockets/baileys').AnyMessageContent)
      res.json({ ok: true })
    } catch (err) {
      console.error(`[react] Failed for ${channelId}:`, err)
      res.status(500).json({ error: String(err) })
    }
  })

  return router
}
