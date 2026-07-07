/**
 * Public exports for the introspection toolkit — the read-only
 * workspace-visibility tools (`listPendingApprovals` / `listScheduledJobs`
 * / `listResearchRuns` / `listWorkspaceSessions` / `readSessionTranscript`)
 * that close the P1 gaps in the assistant ability audit.
 *
 * Spec: docs/architecture/engine/introspection-tools.md.
 */

export { createIntrospectionTools } from './tools.js'
export type {
  IntrospectionDeps,
  IntrospectionPendingApproval,
  IntrospectionScheduledJob,
  IntrospectionWorkerRun,
  WorkerRunStatus,
  IntrospectionSessionSummary,
  IntrospectionTranscriptMessage,
  PendingApprovalsIntrospectionPort,
  ScheduledJobsIntrospectionPort,
  WorkerRunsIntrospectionPort,
  SessionHistoryIntrospectionPort,
} from './types.js'
