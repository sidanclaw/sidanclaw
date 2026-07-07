-- Workflow lifecycle — staleness, digestion, archival.
--
-- Workflows now age like skills do: a periodic sweep marks long-unused
-- workflows 'stale', offers repeatable patterns to the skill system as
-- staged skill candidates (digestion), archives them after a longer idle
-- window, and eventually hard-deletes the one-off class (manual/once
-- trigger, ran at most once) after an archived grace period. `pinned` is
-- the user veto that exempts a workflow from every automatic transition.
--
-- Spec: docs/architecture/features/workflow-lifecycle.md.
-- [COMP:workflow/lifecycle]

BEGIN;

ALTER TABLE workflows
  -- 'active' | 'stale' | 'archived'. Archived rows are hidden from default
  -- listings (web grid, sidebar, chat listWorkflows) and can be restored.
  ADD COLUMN lifecycle_state TEXT NOT NULL DEFAULT 'active'
    CONSTRAINT workflows_lifecycle_state_check
    CHECK (lifecycle_state = ANY (ARRAY['active'::text, 'stale'::text, 'archived'::text])),
  -- When the row last changed lifecycle_state (audit anchor; the archived →
  -- delete grace period is measured from it). NULL = never transitioned.
  ADD COLUMN lifecycle_transitioned_at TIMESTAMPTZ,
  -- Human-readable cause of the current state (mirrors paused_reason), e.g.
  -- 'no activity for 34 days'. NULL while active.
  ADD COLUMN lifecycle_reason TEXT,
  -- User veto: a pinned workflow is exempt from stale/archive/delete sweeps
  -- (the skills `pinned` invariant, ported).
  ADD COLUMN pinned BOOLEAN NOT NULL DEFAULT false,
  -- Digestion bookkeeping: when the digest pass reviewed this workflow, and
  -- its verdict ('skill_candidate' | 'not_repeatable' — app-level vocabulary,
  -- additive without migration). NULL digested_at = not yet reviewed.
  ADD COLUMN digested_at TIMESTAMPTZ,
  ADD COLUMN digest_verdict TEXT;

-- List-filter + sweep scans: workflows by workspace and lifecycle state.
CREATE INDEX idx_workflows_lifecycle
  ON workflows (workspace_id, lifecycle_state);

COMMIT;
