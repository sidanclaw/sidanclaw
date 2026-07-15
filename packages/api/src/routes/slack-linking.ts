/**
 * Slack account linking routes — web-side of the link-code handshake.
 *
 * Parallels routes/telegram-linking.ts: generates a 6-char code the user
 * pastes into a Slack DM with the bot, which then runs mergeShadowUser
 * to fold any orphan Slack shadow into the real user. Reuses the
 * (provider-agnostic) link_codes primitive.
 *
 * See docs/architecture/platform/identity-healing.md.
 * Component tag: [COMP:api/slack-linking-route].
 *
 *   POST /api/assistants/:assistantId/slack/link-code   → generate code
 *   GET  /api/assistants/:assistantId/slack/link-status → poll for result
 */

import { Router } from 'express'
import type { LinkedAccountStore } from '../db/linked-accounts.js'
import type { LinkCodeStore } from '../db/link-codes.js'

type SlackLinkingRouteOptions = {
  linkedAccountStore: LinkedAccountStore
  linkCodeStore: LinkCodeStore
}

type AssistantParams = { assistantId: string }

export function slackLinkingRoutes(options: SlackLinkingRouteOptions): Router {
  const router = Router({ mergeParams: true })
  const { linkedAccountStore, linkCodeStore } = options

  router.post<AssistantParams>('/link-code', async (req, res) => {
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
      console.error('[slack-linking] create code failed:', err)
      res.status(500).json({ error: 'Failed to generate linking code' })
    }
  })

  router.get<AssistantParams>('/link-status', async (req, res) => {
    const userId = req.userId
    if (!userId) {
      res.status(401).json({ error: 'Missing or invalid Authorization header' })
      return
    }
    const { assistantId } = req.params

    try {
      const linked = await linkedAccountStore.findByAssistant(assistantId, 'slack')
      if (linked) {
        res.json({ status: 'linked', linkedAccount: linked })
        return
      }

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
      res.json({
        status: 'pending',
        code: code.code,
        expiresAt: code.expiresAt,
      })
    } catch (err) {
      console.error('[slack-linking] status check failed:', err)
      res.status(500).json({ error: 'Failed to check link status' })
    }
  })

  return router
}
