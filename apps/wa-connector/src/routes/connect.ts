/**
 * QR pairing endpoint. Returns an SSE stream with QR codes, connection
 * status, and errors.
 *
 * Ported from OpenClaw `login-qr.ts` — the QR/timeout/error-code logic
 * is preserved, but the CLI display is replaced with SSE events.
 *
 * See docs/architecture/channels/whatsapp.md.
 */

import { Router } from 'express'
import type { SocketManager } from '../socket-manager.js'

const QR_TIMEOUT_MS = 3 * 60 * 1000 // 3 minutes

export function connectRoutes(socketManager: SocketManager): Router {
  const router = Router()

  router.post('/:channelId', (req, res) => {
    const { channelId } = req.params
    // `?backend=db` → BYON ingest channel (Postgres creds). Anything else →
    // official responder channel (GCS, the default). The API sets this per the
    // channel type it provisioned.
    const backend = req.query.backend === 'db' ? 'db' : 'gcs'
    console.log(`[connect] channelId=${channelId} query.backend=${JSON.stringify(req.query.backend)} → ${backend}`)

    // Set up SSE
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    })

    function sendEvent(event: string, data: unknown) {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    }

    let closed = false
    const cleanup = () => {
      closed = true
    }
    req.on('close', cleanup)

    // Timeout after 3 minutes
    const timeout = setTimeout(() => {
      if (!closed) {
        sendEvent('timeout', { message: 'QR code expired. Try again.' })
        res.end()
        cleanup()
      }
    }, QR_TIMEOUT_MS)

    // Start the socket with QR listeners
    socketManager
      .connect(
        channelId,
        {
          onQr: (qr) => {
            if (!closed) {
              sendEvent('qr', { qr })
            }
          },
          onConnected: (phoneNumber) => {
            if (!closed) {
              clearTimeout(timeout)
              sendEvent('connected', { phoneNumber })
              res.end()
              cleanup()
            }
          },
          onError: (error) => {
            if (!closed) {
              clearTimeout(timeout)
              sendEvent('error', { error })
              res.end()
              cleanup()
            }
          },
        },
        backend,
      )
      .catch((err) => {
        if (!closed) {
          clearTimeout(timeout)
          sendEvent('error', { error: String(err) })
          res.end()
          cleanup()
        }
      })
  })

  return router
}
