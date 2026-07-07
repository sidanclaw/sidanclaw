/**
 * Introspection store ports — back the read-only workspace-visibility
 * toolkit that closes the P1 gaps in the assistant ability audit
 * (docs/plans/assistant-ability-audit.md §1.3 / §6-a). Five tools let the
 * workspace primary answer operational-state questions about its own
 * workspace: what is waiting on the user (pending approvals), what will
 * the assistant do and when (scheduled jobs), what happened to a research
 * job (worker runs), and — the session-history pair (§6-a) — what the
 * workspace's assistants have been talking about (list sessions) and what
 * was said in one of those sessions (read transcript).
 *
 * Pure orchestration in `tools.ts` consumes these ports; the DB-backed
 * adapters live in `packages/api/src/db/*`:
 *   - pending approvals  → `pending-approvals-store.ts` (`listPendingForWorkspace`, reused as-is, RLS-gated)
 *   - scheduled jobs     → `job-store.ts` (`JobStore.search`, reused as-is, workspace-visibility arm)
 *   - worker runs        → `worker-runs-store.ts` (`WorkerRunsStore.listRecentForWorkspace`, added for this toolkit)
 *   - session history    → `sessions.ts` (`listSessionsForWorkspaceSystem` / `getSessionForWorkspaceSystem`, added for this toolkit)
 *
 * Every port is READ-ONLY and workspace-scoped: the tool passes
 * `ToolContext.workspaceId` (never model input) and the adapters guard
 * reads to that workspace. Approvals + scheduled-job reads carry the
 * caller's `userId` so RLS / owner-scoping applies exactly as the web UI
 * sees it — a member never reads another member's private reminders or
 * approval rows through the primary. The session-history reads scope via
 * the `assistants.workspace_id` join, which structurally excludes other
 * members' PERSONAL assistants (their `workspace_id` is NULL or a
 * different workspace) — the §6-a workspace boundary.
 *
 * Spec: docs/architecture/engine/introspection-tools.md.
 */

import type { StructuredSchedule } from '../scheduling/schedule.js'

// ── Pending approvals ────────────────────────────────────────────────

/**
 * The slice of a `pending_approvals` row the toolkit renders. A structural
 * subset of the api store's `PendingApproval` so
 * `PendingApprovalsIntrospectionPort` is satisfied by the existing
 * `listPendingForWorkspace` return with no shape adapter.
 */
export type IntrospectionPendingApproval = {
  id: string
  /** Discriminator — workflow_step / tool_invocation / staged_write / question / … */
  kind: string
  /** The tool this approval will run on approve. NULL for kinds that carry no tool. */
  toolName: string | null
  createdAt: Date
  /** Detached-pattern approvals may never expire → null. */
  expiresAt: Date | null
  /** Frozen tool input — read only for a short gist, never echoed wholesale. */
  arguments: Record<string, unknown>
  /** Per-kind payload — `description` is the human gist when present. */
  approvalPayload: Record<string, unknown>
}

/**
 * Port for the pending-approvals read. Fulfilled AS-IS by
 * `packages/api/src/db/pending-approvals-store.ts` →
 * `listPendingForWorkspace(userId, workspaceId)` (RLS-gated: workspace
 * members only, `status = 'pending'`, newest first). The api store is not
 * edited for this toolkit — the method already exists.
 */
export type PendingApprovalsIntrospectionPort = {
  listPendingForWorkspace(
    userId: string,
    workspaceId: string,
  ): Promise<IntrospectionPendingApproval[]>
}

// ── Scheduled jobs ───────────────────────────────────────────────────

/**
 * The slice of a `scheduled_jobs` row the toolkit renders. A structural
 * subset of the core `ScheduledJob`, so the port below is satisfied by the
 * existing `JobStore.search` return.
 */
export type IntrospectionScheduledJob = {
  id: string
  /** The job's instructions — the gist of what it does. */
  instructions: string
  schedule: StructuredSchedule
  nextRunAt: Date
  lastRunAt: Date | null
  lastStatus: string | null
  enabled: boolean
  /** Set when the job is a workflow trigger / wait wake-up. NULL = plain reminder. */
  workflowId: string | null
  /** `'workflow'` for trigger rows; a messaging/doc channel for reminders. */
  channelType: string
}

/**
 * Port for the scheduled-jobs read. Fulfilled AS-IS by
 * `packages/api/src/db/job-store.ts` → `JobStore.search`, whose
 * workspace-visibility arm already returns the caller's own reminders PLUS
 * every workflow-TRIGGER job of a workflow in the workspace, regardless of
 * creator (a member never sees teammates' private reminders). We take only
 * the first page — the toolkit answers "what will you do and when", not a
 * paginated audit — so `nextCursor` is ignored.
 */
export type ScheduledJobsIntrospectionPort = {
  search(params: {
    assistantId: string
    userId: string
    workspaceId?: string
    limit: number
  }): Promise<{ jobs: IntrospectionScheduledJob[] }>
}

// ── Research (worker) runs ───────────────────────────────────────────

export type WorkerRunStatus = 'running' | 'completed' | 'failed' | 'stopped'

/**
 * One recent `worker_runs` row — a research fan-out worker spawned from a
 * session. NOTE: the `worker_runs` table carries no `workflow_run_id`
 * column, so there is no direct originating-workflow-run handle; the
 * originating `session_id` is the join key to any workflow run that spawned
 * the worker (see the doc's "Origin handle" note). `finishedAt` is only
 * meaningful for terminal statuses — for a `running` row `updated_at` is
 * the last-checkpoint time, not a finish, so the toolkit reports it as
 * "(running)".
 */
export type IntrospectionWorkerRun = {
  id: string
  status: WorkerRunStatus
  /** The worker's task label (`description`). */
  description: string
  /** The worker's seed prompt — a fallback gist when the description is thin. */
  prompt: string
  /** Originating session — the origin handle (no workflow_run_id on this table). */
  sessionId: string
  /** Spawn time. */
  createdAt: Date
  /** Last update — a real finish time only for terminal rows. */
  updatedAt: Date
}

/**
 * Port for the worker-runs read. Fulfilled by
 * `packages/api/src/db/worker-runs-store.ts` →
 * `WorkerRunsStore.listRecentForWorkspace(workspaceId, limit)`, a
 * system-scoped read added for this toolkit (worker rows carry no user
 * column; visibility is bounded by the workspace the tool passes from
 * `ToolContext`). Newest first.
 */
export type WorkerRunsIntrospectionPort = {
  listRecentForWorkspace(
    workspaceId: string,
    limit: number,
  ): Promise<IntrospectionWorkerRun[]>
}

// ── Session history (§6-a) ───────────────────────────────────────────

/**
 * One session-list row — a session of one of the workspace's assistants.
 * The workspace primary may read these transcripts (audit §6-a); the row
 * carries the owning assistant's display name so the model can say "your
 * Product assistant's Telegram chat" instead of an opaque id. A structural
 * subset of what `listSessionsForWorkspaceSystem` returns, joined onto
 * `assistants` for the name + the `workspace_id = $1` scope.
 */
export type IntrospectionSessionSummary = {
  id: string
  /** Owning assistant id — the join key back to `assistants`. */
  assistantId: string
  /** Owning assistant display name (from the `assistants` join). */
  assistantName: string
  /** `web` / `telegram` / `slack` / `cron` / `workflow` / … */
  channelType: string
  status: string
  /** Session start. */
  createdAt: Date
  /** Last activity — the cheap `last_active_at` column, no message scan. */
  lastActiveAt: Date
}

/**
 * One transcript message gist — role plus a text-only, capped gist of the
 * message. Tool-use / tool-result blocks are collapsed to one-line markers
 * (`[tool: <name>]` / `[tool result]`) by the store adapter, never the full
 * payload — the transcript is for orientation, not exfiltration. Each gist
 * is ≤ ~300 chars.
 */
export type IntrospectionTranscriptMessage = {
  role: string
  /** Text-only gist of the message content (markers for tool blocks). */
  gist: string
}

/**
 * Port for the session-history reads (§6-a). Fulfilled by
 * `packages/api/src/db/sessions.ts`:
 *   - `list`  → `listSessionsForWorkspaceSystem(workspaceId, { limit, channelType? })`,
 *              newest-active first, joined to `assistants` for the name +
 *              the `assistants.workspace_id = $1` scope. That join is the
 *              §6-a boundary: another member's PERSONAL assistant (NULL /
 *              different `workspace_id`) is never returned.
 *   - `read`  → `getSessionTranscriptForWorkspaceSystem(sessionId, workspaceId, { limit })`,
 *              the messages of ONE session ONLY IF that session belongs to a
 *              workspace assistant of `workspaceId`. A session outside the
 *              workspace resolves to `null` — the tool renders an identical
 *              not-found message whether the id is unknown or simply out of
 *              scope, so the pair is not an existence oracle.
 *
 * Both are system-scoped (no RLS `userId`): the workspace passed by the tool
 * from `ToolContext` is the only bound, and the `assistants` join enforces
 * it. Newest-active first for the list; last-N (chronological) for the read.
 */
export type SessionHistoryIntrospectionPort = {
  listSessionsForWorkspaceSystem(
    workspaceId: string,
    opts: { limit: number; channelType?: string },
  ): Promise<IntrospectionSessionSummary[]>
  getSessionTranscriptForWorkspaceSystem(
    sessionId: string,
    workspaceId: string,
    opts: { limit: number },
  ): Promise<IntrospectionTranscriptMessage[] | null>
}

// ── Aggregate deps ───────────────────────────────────────────────────

/**
 * The ports `createIntrospectionTools` needs. Wired at api boot from the
 * DB-backed stores. Kept as narrow per-concern ports (not one fat store) so
 * a surface that only needs one read can supply stubs for the others.
 */
export type IntrospectionDeps = {
  pendingApprovals: PendingApprovalsIntrospectionPort
  scheduledJobs: ScheduledJobsIntrospectionPort
  workerRuns: WorkerRunsIntrospectionPort
  /** Session-history reads (§6-a) — list workspace sessions + read one transcript. */
  sessionHistory: SessionHistoryIntrospectionPort
}
