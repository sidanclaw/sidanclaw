/**
 * The stateless sandbox orchestrator (spec §5): resolves a chat session's
 * active cloud task (creating one, budget-gated, with vault re-injection),
 * probes for silently-dead sessions, and owns task completion — capture
 * session deltas to the vault, pull downloads, kill the sandbox. Holds no
 * live browser: every op goes back through `SandboxProvider.connect(id)`.
 *
 * The task store is a port: the platform backs it with the `sandbox_tasks`
 * table; tests and OSS use the in-memory impl below (sandboxes are
 * task-scoped and disposable, so lost in-memory state costs a re-login at
 * worst — the vault is the durable thing).
 */
import { randomUUID } from 'node:crypto'
import type { SandboxTaskBinding } from './cloud-browser-provider.js'
import type { SandboxMeter } from './metering.js'
import type {
  BrowserCallContext,
  SandboxProvider,
  SessionVault,
} from './types.js'

export type SandboxTaskStatus = 'running' | 'paused' | 'completed' | 'failed'

export type SandboxTaskRecord = {
  taskId: string
  sandboxId: string
  userId: string
  workspaceId: string
  sessionId: string
  status: SandboxTaskStatus
  /** Registrable domain whose vault bundle was injected at start (probe target). */
  injectedSite: string | null
  authorizedBudgetUsd: number
  createdAt: number
  lastActivityAt: number
}

export type SandboxTaskStore = {
  getActiveBySession(sessionId: string): Promise<SandboxTaskRecord | null>
  create(record: SandboxTaskRecord): Promise<void>
  update(taskId: string, patch: Partial<SandboxTaskRecord>): Promise<void>
  /** Tasks still running/paused whose last activity is older than the cutoff. */
  listStale(cutoffMs: number): Promise<SandboxTaskRecord[]>
  /**
   * Per-task spend accumulator for the §4.9 dollar cap (the closed impl
   * backs it with `sandbox_tasks.spent_usd`). Optional — absent, boot falls
   * back to an in-memory accumulator.
   */
  addSpend?(taskId: string, usd: number): Promise<{ spentUsd: number; authorizedBudgetUsd: number }>
}

export function createInMemorySandboxTaskStore(): SandboxTaskStore & {
  tasks: Map<string, SandboxTaskRecord>
} {
  const tasks = new Map<string, SandboxTaskRecord>()
  return {
    tasks,
    async getActiveBySession(sessionId) {
      for (const task of tasks.values()) {
        if (task.sessionId === sessionId && (task.status === 'running' || task.status === 'paused')) {
          return task
        }
      }
      return null
    },
    async create(record) {
      tasks.set(record.taskId, record)
    },
    async update(taskId, patch) {
      const existing = tasks.get(taskId)
      if (existing) tasks.set(taskId, { ...existing, ...patch })
    },
    async listStale(cutoffMs) {
      return [...tasks.values()].filter(
        (t) => (t.status === 'running' || t.status === 'paused') && t.lastActivityAt < cutoffMs,
      )
    },
  }
}

/** URL shapes that mean "the session is not signed in here" (silent-death probe, §6). */
const LOGIN_WALL_PATTERN = /\/(login|signin|sign-in|checkpoint|authwall|sessions\/new)([/?#]|$)/i

export function looksLikeLoginWall(url: string): boolean {
  return LOGIN_WALL_PATTERN.test(url)
}

export function registrableSiteOf(url: string): string | null {
  try {
    const host = new URL(url).hostname.toLowerCase()
    const parts = host.split('.')
    return parts.length <= 2 ? host : parts.slice(-2).join('.')
  } catch {
    return null
  }
}

export type SandboxOrchestratorDeps = {
  provider: SandboxProvider
  taskStore: SandboxTaskStore
  /** Closed platform impl; null → no session reuse (first-party OSS posture). */
  vault?: SessionVault | null
  /**
   * Pre-task gates (Phase 4 wires the real credit gate + budget
   * authorization; the defaults are permissive-but-bounded).
   */
  budget?: {
    /** Throws (with a user-facing message) when the workspace is out of credit. */
    checkCreditBudget?: (ctx: BrowserCallContext) => Promise<void>
    /** The per-session dollar cap authorized for a new task. */
    authorizeBudgetUsd?: (ctx: BrowserCallContext) => Promise<number>
  }
  /** Region hint for create (impossible-travel guard, §4.6). */
  regionFor?: (ctx: BrowserCallContext) => string | undefined
  /** Dormant BYOP hook (§4.6): a proxy URL for a specific site, when one is configured. */
  proxyUrlFor?: (site: string | null) => string | undefined
  /** Per-task non-browser egress allowlist (deny-by-default posture, §8). */
  egressAllowlistFor?: (ctx: BrowserCallContext) => string[]
  /** Sink for auto-pulled downloads (workspace-scoped ABOVE the provider seam). */
  saveDownload?: (
    ctx: { userId: string; workspaceId: string; sessionId: string },
    file: { path: string; bytes: Uint8Array },
  ) => Promise<void>
  /**
   * The §4.9 meter. When present, every task touch records the sandbox-
   * seconds delta since the last touch and enforces the per-session dollar
   * cap: crossing it fails the task gracefully mid-flight, not at the end.
   */
  meter?: SandboxMeter | null
  maxLifetimeSeconds?: number
  now?: () => number
}

export const DEFAULT_SESSION_BUDGET_USD = 2

export type SandboxOrchestrator = {
  /** The binding CloudBrowserProvider resolves through (creates on demand). */
  binding: SandboxTaskBinding & {
    onNavigated(ctx: BrowserCallContext, url: string): Promise<void>
  }
  getActiveTask(sessionId: string): Promise<SandboxTaskRecord | null>
  /** Pause during a Take-Over wait (RAM freed, cookies preserved — §4.8). */
  pauseForTakeover(sessionId: string): Promise<void>
  resumeAfterTakeover(sessionId: string): Promise<void>
  /** Capture the (post-login) session for a site into the vault. */
  captureSession(sessionId: string, site: string): Promise<void>
  /** Task end: capture session deltas → pull downloads → kill (§4.10). */
  completeTask(sessionId: string, outcome?: 'completed' | 'failed'): Promise<SandboxTaskRecord | null>
  /** Reaper sweep: kill + fail tasks idle past the abandonment window. */
  reapStale(abandonmentMs: number): Promise<number>
}

export function createSandboxOrchestrator(deps: SandboxOrchestratorDeps): SandboxOrchestrator {
  const now = deps.now ?? Date.now

  async function injectVaultBundle(
    ctx: BrowserCallContext,
    sandboxId: string,
    site: string | null,
  ): Promise<string | null> {
    if (!deps.vault || !site) return null
    const bundle = await deps.vault.get({ userId: ctx.userId, workspaceId: ctx.workspaceId, site })
    if (!bundle) return null
    await deps.provider.browser(sandboxId).injectStorageState(bundle)
    await deps.vault.touch({ userId: ctx.userId, workspaceId: ctx.workspaceId, site })
    return site
  }

  /**
   * Meter the sandbox-seconds delta since the task's last touch and enforce
   * the per-session dollar cap (§4.9). Cap crossed → the task fails
   * gracefully NOW (capture/pull/kill) and the caller gets a clear error.
   * Paused spans are excluded: a paused sandbox holds no compute.
   */
  async function meterTouch(task: SandboxTaskRecord, wasRunning: boolean): Promise<void> {
    if (!deps.meter || !wasRunning) return
    const seconds = Math.max(0, (now() - task.lastActivityAt) / 1000)
    const { capExceeded } = await deps.meter.recordSandboxSeconds(task, seconds)
    if (capExceeded) {
      await completeTaskInternal(task, 'failed')
      throw new Error(
        `This browser task reached its authorized budget (about $${task.authorizedBudgetUsd.toFixed(2)}) and was stopped. Ask the user to raise the workspace's computer-use budget to continue.`,
      )
    }
  }

  async function resolve(ctx: BrowserCallContext, hint?: { url?: string }): Promise<{ sandboxId: string }> {
    const existing = await deps.taskStore.getActiveBySession(ctx.sessionId)
    if (existing) {
      await meterTouch(existing, existing.status === 'running')
      if (existing.status === 'paused') {
        await deps.provider.resume(existing.sandboxId)
        await deps.taskStore.update(existing.taskId, { status: 'running', lastActivityAt: now() })
      } else {
        await deps.taskStore.update(existing.taskId, { lastActivityAt: now() })
      }
      return { sandboxId: existing.sandboxId }
    }

    await deps.budget?.checkCreditBudget?.(ctx)
    const authorizedBudgetUsd =
      (await deps.budget?.authorizeBudgetUsd?.(ctx)) ?? DEFAULT_SESSION_BUDGET_USD

    const taskId = randomUUID()
    const site = hint?.url ? registrableSiteOf(hint.url) : null
    const { sandboxId } = await deps.provider.create({
      workspaceId: ctx.workspaceId,
      taskId,
      region: deps.regionFor?.(ctx),
      proxyUrl: deps.proxyUrlFor?.(site),
      egressAllowlist: deps.egressAllowlistFor?.(ctx) ?? [],
      maxLifetimeSeconds: deps.maxLifetimeSeconds,
    })
    // Session reuse (§4.4): inject the vaulted bundle BEFORE the first
    // navigation so the site is already signed in.
    const injectedSite = await injectVaultBundle(ctx, sandboxId, site)

    await deps.taskStore.create({
      taskId,
      sandboxId,
      userId: ctx.userId,
      workspaceId: ctx.workspaceId,
      sessionId: ctx.sessionId,
      status: 'running',
      injectedSite,
      authorizedBudgetUsd,
      createdAt: now(),
      lastActivityAt: now(),
    })
    return { sandboxId }
  }

  async function onNavigated(ctx: BrowserCallContext, url: string): Promise<void> {
    // Silent-death probe (§6): a re-injected session that still lands on a
    // login wall is dead server-side — mark it so the UI can prompt re-auth
    // instead of silently reusing a corpse next task.
    const task = await deps.taskStore.getActiveBySession(ctx.sessionId)
    if (!task?.injectedSite || !deps.vault) return
    const site = registrableSiteOf(url)
    if (site === task.injectedSite && looksLikeLoginWall(url)) {
      await deps.vault.markDead({ userId: ctx.userId, workspaceId: ctx.workspaceId, site })
      await deps.taskStore.update(task.taskId, { injectedSite: null })
    }
  }

  async function captureFor(task: SandboxTaskRecord, site: string): Promise<void> {
    if (!deps.vault) return
    const bundle = await deps.provider.browser(task.sandboxId).captureStorageState(site)
    await deps.vault.put({
      userId: task.userId,
      workspaceId: task.workspaceId,
      site,
      bundle,
    })
  }

  async function completeTaskInternal(
    task: SandboxTaskRecord,
    outcome: 'completed' | 'failed',
  ): Promise<SandboxTaskRecord> {
    // Final sandbox-seconds delta (running spans only) — recorded WITHOUT
    // cap-recursion (a task being torn down cannot be torn down again).
    if (deps.meter && task.status === 'running') {
      const seconds = Math.max(0, (now() - task.lastActivityAt) / 1000)
      await deps.meter.recordSandboxSeconds(task, seconds).catch(() => ({}))
    }
    // Order matters (§4.10): capture the session while the sandbox lives,
    // pull downloads into our store, THEN kill. Killing loses nothing —
    // the sandbox FS is scratch by design (§4.12).
    try {
      if (task.injectedSite) await captureFor(task, task.injectedSite)
    } catch {
      /* capture is best-effort — an expired page must not block teardown */
    }
    try {
      if (deps.saveDownload) {
        const downloads = await deps.provider.bridge.pullDownloads(task.sandboxId)
        for (const file of downloads) {
          await deps.saveDownload(
            { userId: task.userId, workspaceId: task.workspaceId, sessionId: task.sessionId },
            file,
          )
        }
      }
    } catch {
      /* downloads are best-effort too */
    }
    await deps.provider.kill(task.sandboxId)
    await deps.taskStore.update(task.taskId, { status: outcome, lastActivityAt: now() })
    return { ...task, status: outcome }
  }

  return {
    binding: { resolve, onNavigated },

    getActiveTask: (sessionId) => deps.taskStore.getActiveBySession(sessionId),

    async pauseForTakeover(sessionId) {
      const task = await deps.taskStore.getActiveBySession(sessionId)
      if (!task || task.status !== 'running') return
      await deps.provider.pause(task.sandboxId)
      await deps.taskStore.update(task.taskId, { status: 'paused', lastActivityAt: now() })
    },

    async resumeAfterTakeover(sessionId) {
      const task = await deps.taskStore.getActiveBySession(sessionId)
      if (!task || task.status !== 'paused') return
      await deps.provider.resume(task.sandboxId)
      await deps.taskStore.update(task.taskId, { status: 'running', lastActivityAt: now() })
    },

    async captureSession(sessionId, site) {
      const task = await deps.taskStore.getActiveBySession(sessionId)
      if (!task) return
      await captureFor(task, site)
      await deps.taskStore.update(task.taskId, { injectedSite: site, lastActivityAt: now() })
    },

    async completeTask(sessionId, outcome = 'completed') {
      const task = await deps.taskStore.getActiveBySession(sessionId)
      if (!task) return null
      return completeTaskInternal(task, outcome)
    },

    async reapStale(abandonmentMs) {
      const stale = await deps.taskStore.listStale(now() - abandonmentMs)
      for (const task of stale) {
        // Meter the abandoned span too (a leaked sandbox still billed us).
        if (deps.meter && task.status === 'running') {
          const seconds = Math.max(0, (now() - task.lastActivityAt) / 1000)
          await deps.meter.recordSandboxSeconds(task, seconds).catch(() => ({}))
        }
        try {
          await deps.provider.kill(task.sandboxId)
        } catch {
          /* already gone */
        }
        await deps.taskStore.update(task.taskId, { status: 'failed', lastActivityAt: now() })
      }
      return stale.length
    },
  }
}
