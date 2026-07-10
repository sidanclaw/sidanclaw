import { Router } from 'express'
import { z } from 'zod'
import type {
  SandboxOrchestrator,
  SandboxProvider,
  SessionVault,
} from '@sidanclaw/core'

/**
 * Computer-use web surface (computer-use.md §5, §7):
 *
 *  - the Take-Over live view's backend — frame polling + input relay +
 *    capture/resume around an interactive login (§4.8);
 *  - Session Management — list + revoke vaulted sites (§4.10).
 *
 * Mounted behind `requireAuth` in boot. Every task route checks the task
 * belongs to the caller; vault routes are inherently caller-scoped.
 */

const InputEventSchema = z.union([
  z.object({ kind: z.literal('click'), x: z.number(), y: z.number() }),
  z.object({ kind: z.literal('key'), text: z.string().min(1).max(64) }),
  z.object({ kind: z.literal('scroll'), deltaY: z.number() }),
])

export function computerRoutes(deps: {
  orchestrator: SandboxOrchestrator | null
  provider: SandboxProvider | null
  vault: SessionVault | null
}): Router {
  const router = Router()

  async function ownedTask(sessionId: string, userId: string) {
    if (!deps.orchestrator) return null
    const task = await deps.orchestrator.getActiveTask(sessionId)
    if (!task || task.userId !== userId) return null
    return task
  }

  router.get('/tasks/:sessionId', async (req, res) => {
    const task = await ownedTask(req.params.sessionId, req.userId as string)
    if (!task) {
      res.status(404).json({ error: 'No active computer task for this session' })
      return
    }
    res.json({
      taskId: task.taskId,
      status: task.status,
      injectedSite: task.injectedSite,
      workspaceId: task.workspaceId,
      createdAt: task.createdAt,
    })
  })

  // The live view opening = the user arrived for the Take-Over → resume the
  // paused sandbox (§4.8: pause covers the WAIT, not the takeover itself).
  router.post('/tasks/:sessionId/resume', async (req, res) => {
    const task = await ownedTask(req.params.sessionId, req.userId as string)
    if (!task || !deps.orchestrator) {
      res.status(404).json({ error: 'No active computer task for this session' })
      return
    }
    await deps.orchestrator.resumeAfterTakeover(req.params.sessionId)
    res.json({ ok: true })
  })

  // Screencast frame poll (~1 fps from the client). Polling over SSE keeps
  // Cloud Run connection lifetimes trivial at the takeover's low frame rate.
  router.get('/tasks/:sessionId/frame', async (req, res) => {
    const task = await ownedTask(req.params.sessionId, req.userId as string)
    if (!task || !deps.provider) {
      res.status(404).json({ error: 'No active computer task for this session' })
      return
    }
    try {
      const takeover = deps.provider.browser(task.sandboxId).takeover()
      const frame = await takeover.nextFrame()
      await takeover.close()
      if (!frame) {
        res.status(204).end()
        return
      }
      res.json(frame)
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : 'frame capture failed' })
    }
  })

  router.post('/tasks/:sessionId/input', async (req, res) => {
    const task = await ownedTask(req.params.sessionId, req.userId as string)
    if (!task || !deps.provider) {
      res.status(404).json({ error: 'No active computer task for this session' })
      return
    }
    const parsed = InputEventSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid input event' })
      return
    }
    try {
      const takeover = deps.provider.browser(task.sandboxId).takeover()
      await takeover.input(parsed.data)
      await takeover.close()
      res.json({ ok: true })
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : 'input relay failed' })
    }
  })

  // "I signed in" — capture the authenticated session into the vault (§4.4)
  // so every later task on this site skips the login.
  router.post('/tasks/:sessionId/captured', async (req, res) => {
    const task = await ownedTask(req.params.sessionId, req.userId as string)
    if (!task || !deps.orchestrator) {
      res.status(404).json({ error: 'No active computer task for this session' })
      return
    }
    const body = z.object({ site: z.string().min(1).max(253) }).safeParse(req.body)
    if (!body.success) {
      res.status(400).json({ error: 'site is required' })
      return
    }
    try {
      await deps.orchestrator.captureSession(req.params.sessionId, body.data.site)
      res.json({ ok: true })
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : 'session capture failed' })
    }
  })

  // Close-to-stop (§4.15/§4.8): ends the task now — capture + pull + kill.
  router.post('/tasks/:sessionId/complete', async (req, res) => {
    const task = await ownedTask(req.params.sessionId, req.userId as string)
    if (!task || !deps.orchestrator) {
      res.status(404).json({ error: 'No active computer task for this session' })
      return
    }
    const outcome = req.body?.outcome === 'failed' ? 'failed' : 'completed'
    const done = await deps.orchestrator.completeTask(req.params.sessionId, outcome)
    res.json({ ok: true, status: done?.status ?? outcome })
  })

  // ── Session Management (§4.10) ───────────────────────────────

  router.get('/sessions', async (req, res) => {
    if (!deps.vault) {
      res.json({ configured: false, sessions: [] })
      return
    }
    const workspaceId = String(req.query.workspaceId ?? '')
    if (!workspaceId) {
      res.status(400).json({ error: 'workspaceId is required' })
      return
    }
    const sessions = await deps.vault.list({ userId: req.userId as string, workspaceId })
    res.json({ configured: true, sessions })
  })

  router.delete('/sessions/:site', async (req, res) => {
    if (!deps.vault) {
      res.status(404).json({ error: 'Session vault is not configured' })
      return
    }
    const workspaceId = String(req.query.workspaceId ?? '')
    if (!workspaceId) {
      res.status(400).json({ error: 'workspaceId is required' })
      return
    }
    await deps.vault.revoke({
      userId: req.userId as string,
      workspaceId,
      site: req.params.site,
    })
    res.json({ ok: true })
  })

  return router
}
