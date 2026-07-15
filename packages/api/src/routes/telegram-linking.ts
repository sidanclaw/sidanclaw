/**
 * Telegram account linking routes — web-side of the linking handshake.
 *
 * See docs/architecture/platform/auth.md → "Linked Accounts".
 * Component tag: [COMP:api/telegram-linking-route].
 *
 * These routes are user-facing (mounted behind requireAuth) and drive the
 * Telegram linking wizard in the assistant detail page:
 *
 *   POST /api/assistants/:assistantId/telegram/link-code   → generate code
 *   GET  /api/assistants/:assistantId/telegram/link-status  → poll for result
 */

import { Router } from 'express'
import type { LinkedAccountStore } from '../db/linked-accounts.js'
import type { LinkCodeStore } from '../db/link-codes.js'

type TelegramLinkingRouteOptions = {
  linkedAccountStore: LinkedAccountStore
  linkCodeStore: LinkCodeStore
}

type AssistantParams = { assistantId: string }

export function telegramLinkingRoutes(options: TelegramLinkingRouteOptions): Router {
  const router = Router({ mergeParams: true })
  const { linkedAccountStore, linkCodeStore } = options

  // ── Generate a linking code ─────────────────────────────────

  router.post<AssistantParams>('/link-code', async (req, res) => {
    console.log('[telegram-linking] POST /link-code hit — userId:', req.userId, 'assistantId:', req.params.assistantId)
    const userId = req.userId
    if (!userId) {
      res.status(401).json({ error: 'Missing or invalid Authorization header' })
      return
    }
    const { assistantId } = req.params

    try {
      const code = await linkCodeStore.create({ userId, assistantId })
      res.json({ code: code.code, expiresAt: code.expiresAt })
    } catch (err) {
      console.error('[telegram-linking] create code failed:', err)
      res.status(500).json({ error: 'Failed to generate linking code' })
    }
  })

  // ── Poll link status ────────────────────────────────────────

  router.get<AssistantParams>('/link-status', async (req, res) => {
    const userId = req.userId
    if (!userId) {
      res.status(401).json({ error: 'Missing or invalid Authorization header' })
      return
    }
    const { assistantId } = req.params

    try {
      // Check if this assistant already has an official bot link (fast path)
      const telegramLink = await linkedAccountStore.findByAssistant(assistantId, 'telegram')
      if (telegramLink) {
        res.json({ status: 'linked', linkedAccount: telegramLink })
        return
      }

      // Check latest code status
      const code = await linkCodeStore.getByUserAndAssistant(userId, assistantId)
      if (!code) {
        res.json({ status: 'no_code' })
        return
      }

      if (code.claimedAt) {
        res.json({ status: 'linked' })
        return
      }

      if (new Date(code.expiresAt) < new Date()) {
        res.json({ status: 'expired' })
        return
      }

      res.json({ status: 'pending', expiresAt: code.expiresAt })
    } catch (err) {
      console.error('[telegram-linking] status check failed:', err)
      res.status(500).json({ error: 'Failed to check link status' })
    }
  })

  return router
}
