/**
 * Workflow lifecycle policy — the pure decision core of the staleness /
 * digestion / archival sweep (mig 308).
 *
 * Workflows age the way skills do (docs/architecture/engine/skill-system.md →
 * "Lifecycle states"): `active` → `stale` after an idle window → `archived`
 * after a longer one — and the one-off class (manual / schedule-once trigger
 * that ran at most once) is eventually hard-deleted after an archived grace
 * period. `pinned` is the user veto that exempts a workflow from every
 * automatic transition. Enabled event / webhook workflows and workflows with
 * a live scheduled fire are ARMED LISTENERS — idle-by-design, never staled
 * or archived while armed.
 *
 * This module is deliberately side-effect free: the sweep worker
 * (packages/api/src/workers/workflow-lifecycle-worker.ts) loads rows, calls
 * `decideLifecycle` per row, and applies the returned action. Every rule
 * lives here so the policy is table-testable without a database.
 *
 * Spec: docs/architecture/features/workflow-lifecycle.md.
 * Component tag: [COMP:workflow/lifecycle]
 */

import type { WorkflowLifecycleState, WorkflowTrigger } from './types.js'

export type WorkflowLifecycleConfig = {
  /** Idle days (no run, no edit) before an eligible workflow turns `stale`. */
  staleAfterDays: number
  /** Total idle days before a `stale` workflow is archived. */
  archiveAfterDays: number
  /**
   * Minimum days a workflow must have been visibly `stale` before it can be
   * archived — so even a years-idle backlog degrades in two observable steps
   * (badge first, disappearance later) instead of vanishing on the first sweep.
   */
  staleDwellDays: number
  /**
   * Days after archival before a one-off workflow (manual / schedule-once,
   * ran at most once) is hard-deleted. Recurring or multi-run workflows are
   * never auto-deleted — they stay archived until a human acts.
   */
  deleteAfterDays: number
}

export const WORKFLOW_LIFECYCLE_DEFAULTS: WorkflowLifecycleConfig = {
  staleAfterDays: 30,
  archiveAfterDays: 90,
  staleDwellDays: 7,
  deleteAfterDays: 30,
}

/**
 * The sweep's per-workflow read model. `lastRunAt` / `runCount` aggregate
 * `workflow_runs`; `hasLiveFire` is "any enabled `scheduled_jobs` row points
 * at this workflow" (a pending future fire or wait continuation — liveness).
 */
export type WorkflowLifecycleRow = {
  id: string
  workspaceId: string
  name: string
  description: string | null
  trigger: WorkflowTrigger
  enabled: boolean
  pinned: boolean
  lifecycleState: WorkflowLifecycleState
  /** When the row entered its current lifecycle state. NULL = never left `active`. */
  lifecycleTransitionedAt: Date | null
  digestedAt: Date | null
  createdAt: Date
  updatedAt: Date
  lastRunAt: Date | null
  runCount: number
  hasLiveFire: boolean
}

export type WorkflowLifecycleDecision =
  | { action: 'none' }
  /** Stale/archived row that is pinned or active again — restore to `active`. */
  | { action: 'reactivate'; reason: string }
  | { action: 'mark_stale'; reason: string }
  | { action: 'archive'; reason: string }
  | { action: 'delete'; reason: string }

/**
 * Does this trigger fire the workflow more than once? A recurring `schedule`
 * (anything but `once`), an `event` subscription, or a `webhook`. `manual`
 * and `schedule: { type: 'once' }` are one-shots. Absent trigger → treated
 * as the `manual` default. (Canonical copy — `workflow/tools.ts` imports it
 * for the reserved-outcome-var warning.)
 */
export function isRecurringTrigger(trigger?: WorkflowTrigger): boolean {
  if (!trigger) return false
  if (trigger.kind === 'event' || trigger.kind === 'webhook') return true
  if (trigger.kind === 'schedule') return trigger.schedule.type !== 'once'
  return false
}

/** The newest sign of life: last run start, else last edit/create. */
export function lastActivityAt(row: Pick<WorkflowLifecycleRow, 'updatedAt' | 'lastRunAt'>): Date {
  if (row.lastRunAt && row.lastRunAt.getTime() > row.updatedAt.getTime()) return row.lastRunAt
  return row.updatedAt
}

/**
 * An armed listener is idle-by-design: an ENABLED workflow whose trigger
 * waits on the outside world (`event` subscription, `webhook` receiver), or
 * one with a live scheduled fire pending (`hasLiveFire` — covers recurring
 * schedules between fires, far-future `once` schedules, and paused-on-`wait`
 * continuations). Never staled or archived while armed.
 */
export function isArmedListener(
  row: Pick<WorkflowLifecycleRow, 'enabled' | 'trigger' | 'hasLiveFire'>,
): boolean {
  if (!row.enabled) return false
  if (row.hasLiveFire) return true
  return row.trigger.kind === 'event' || row.trigger.kind === 'webhook'
}

/**
 * The auto-delete class: a one-shot trigger (manual / schedule-once) that ran
 * at most once — completed one-off work (the migration-159 reminder flotsam
 * is the canonical population). Anything recurring or with real run history
 * is never auto-deleted.
 */
export function isOneOffWorkflow(
  row: Pick<WorkflowLifecycleRow, 'trigger' | 'runCount'>,
): boolean {
  return !isRecurringTrigger(row.trigger) && row.runCount <= 1
}

const DAY_MS = 24 * 60 * 60 * 1000

function daysSince(anchor: Date, now: Date): number {
  return (now.getTime() - anchor.getTime()) / DAY_MS
}

/**
 * Did the workflow RUN strictly after its last lifecycle transition? This is
 * deliberately run-only: `updated_at` cannot distinguish a user edit from
 * system bookkeeping (the `set_updated_at` trigger bumps it on the sweep's
 * own stale-mark, on the digest stamp, and on the storm-guard pause), so a
 * stale row judged by `updated_at` would ping-pong back to active on every
 * sweep write. User edits don't need the sweep at all — the store's RLS
 * `update()` flips `stale → active` synchronously. Degraded rows therefore
 * measure every clock from `lifecycle_transitioned_at` and reactivate only
 * on real runs (or that synchronous edit flip).
 */
export function touchedSinceTransition(
  row: Pick<WorkflowLifecycleRow, 'lastRunAt' | 'lifecycleTransitionedAt'>,
): boolean {
  const transitionedAt = row.lifecycleTransitionedAt
  if (!transitionedAt) return false
  return row.lastRunAt !== null && row.lastRunAt.getTime() > transitionedAt.getTime()
}

/**
 * One row → one transition (at most). The sweep applies decisions
 * independently, so a row walks the ladder one tick at a time:
 * active → stale (staleAfterDays idle) → archived (a further
 * archiveAfterDays − staleAfterDays in stale, floored at staleDwellDays)
 * → deleted (one-offs only, deleteAfterDays after archival). Pinned rows
 * never degrade — a pinned stale/archived row is restored. Fresh activity
 * un-stales a row.
 */
export function decideLifecycle(
  row: WorkflowLifecycleRow,
  now: Date,
  config: WorkflowLifecycleConfig = WORKFLOW_LIFECYCLE_DEFAULTS,
): WorkflowLifecycleDecision {
  if (row.pinned) {
    return row.lifecycleState === 'active'
      ? { action: 'none' }
      : { action: 'reactivate', reason: 'pinned by a user' }
  }

  if (row.lifecycleState === 'archived') {
    if (!isOneOffWorkflow(row)) return { action: 'none' }
    const archivedAt = row.lifecycleTransitionedAt
    if (!archivedAt) return { action: 'none' }
    const archivedDays = daysSince(archivedAt, now)
    if (archivedDays >= config.deleteAfterDays) {
      return {
        action: 'delete',
        reason: `one-off workflow archived ${Math.floor(archivedDays)} days ago`,
      }
    }
    return { action: 'none' }
  }

  if (isArmedListener(row)) {
    return row.lifecycleState === 'stale'
      ? { action: 'reactivate', reason: 'trigger is armed again' }
      : { action: 'none' }
  }

  if (row.lifecycleState === 'active') {
    const idleDays = daysSince(lastActivityAt(row), now)
    if (idleDays >= config.staleAfterDays) {
      return { action: 'mark_stale', reason: `no activity for ${Math.floor(idleDays)} days` }
    }
    return { action: 'none' }
  }

  // lifecycleState === 'stale'
  if (touchedSinceTransition(row)) {
    return { action: 'reactivate', reason: 'recent activity' }
  }
  const staleSince = row.lifecycleTransitionedAt
  if (!staleSince) return { action: 'none' } // defensive: unknowable clock, hold
  const staleDays = daysSince(staleSince, now)
  const archiveWaitDays = Math.max(
    config.staleDwellDays,
    config.archiveAfterDays - config.staleAfterDays,
  )
  if (staleDays >= archiveWaitDays) {
    const totalIdleDays = Math.floor(config.staleAfterDays + staleDays)
    return { action: 'archive', reason: `no activity for at least ${totalIdleDays} days` }
  }
  return { action: 'none' }
}

/**
 * Which rows the digest pass should review this tick: never-digested,
 * non-pinned rows that are already visibly degrading (`stale`, or archived
 * without ever being reviewed — a backfill guard). Active rows are never
 * digested: a workflow in use is not a retirement candidate.
 */
export function pickDigestBatch<T extends WorkflowLifecycleRow>(rows: T[], limit: number): T[] {
  return rows
    .filter((r) => r.digestedAt === null && !r.pinned && r.lifecycleState !== 'active')
    .sort((a, b) => lastActivityAt(a).getTime() - lastActivityAt(b).getTime())
    .slice(0, limit)
}
