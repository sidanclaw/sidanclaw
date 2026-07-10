/**
 * Computer use — governed browser + isolated Python behind provider seams.
 * Spec: docs/architecture/engine/computer-use.md.
 */
export * from './types.js'
export * from './browser-router.js'
export { createLocalBrowserProvider } from './local-browser-provider.js'
export { createCloudBrowserProvider, type SandboxTaskBinding } from './cloud-browser-provider.js'
export { StubSandboxProvider, type StubSandboxProviderOptions } from './providers/stub.js'
export {
  createSandboxOrchestrator,
  createInMemorySandboxTaskStore,
  looksLikeLoginWall,
  registrableSiteOf,
  DEFAULT_SESSION_BUDGET_USD,
  type SandboxOrchestrator,
  type SandboxOrchestratorDeps,
  type SandboxTaskRecord,
  type SandboxTaskStatus,
  type SandboxTaskStore,
} from './orchestrator.js'
export { createE2bCloudProvider, type E2bCloudProviderConfig, SCRATCH_DIR, DOWNLOADS_DIR } from './providers/e2b/index.js'
export {
  createE2bRuntime,
  type E2bRuntime,
  type E2bSandboxHandle,
  type E2bCommandResult,
  type E2bCreateOptions,
} from './providers/e2b/runtime.js'
export {
  createSandboxReaper,
  DEFAULT_ABANDONMENT_MS,
  DEFAULT_REAPER_INTERVAL_MS,
  type SandboxReaperEvent,
} from './reaper.js'
export {
  createSandboxMeter,
  createInMemorySpendAccumulator,
  resolveUnattendedComputerUse,
  SANDBOX_SECONDS_MODEL,
  PROXY_GB_MODEL,
  SANDBOX_SECONDS_RATE_USD,
  PROXY_GB_RATE_USD,
  type SandboxMeter,
  type SandboxMeterDeps,
  type MeterRecordResult,
} from './metering.js'
export {
  createComputeTools,
  type ComputeToolEvent,
  type CreateComputeToolsOptions,
  type SandboxFilesPort,
} from './compute-tools.js'
export {
  createComputerTools,
  SEND_LIKE_LABEL_PATTERN,
  DEFAULT_FUSE_MAX_CALLS,
  DEFAULT_FUSE_MAX_WALL_MS,
  type ComputerToolEvent,
  type ComputerToolPolicy,
  type CreateComputerToolsOptions,
  type ResolveComputerToolPolicy,
} from './tools.js'
