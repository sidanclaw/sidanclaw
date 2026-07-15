/**
 * Connection discovery endpoint.
 *
 * `GET /connections` lists every registered socket with its live state, so an
 * external sender (e.g. the TheGrind MCP) can discover the channel id for a
 * deployment instead of pinning the UUID in config — or simply verify that the
 * `auto` / `pn:<digits>` send aliases would resolve. Secret-gated like every
 * non-health route (the global X-Connector-Secret middleware in index.ts).
 *
 * See docs/architecture/channels/whatsapp.md → "wa-connector HTTP API".
 * Component tag: [COMP:wa-connector/send].
 */

import { Router } from 'express'
import type { SocketManager } from '../socket-manager.js'

export function connectionsRoutes(socketManager: SocketManager): Router {
  const router = Router()

  router.get('/', (_req, res) => {
    res.json({ connections: socketManager.listConnections() })
  })

  return router
}
