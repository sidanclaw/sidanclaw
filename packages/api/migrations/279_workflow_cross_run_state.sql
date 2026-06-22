-- 279_workflow_cross_run_state.sql
--
-- Workflow upgrade: cross-run state + anchor reuse.
--
-- 1. workflow_runs.outcome — the distilled summary a TERMINAL run writes once
--    (status / summary / logs / blockers / todo / state). The next run of the
--    same workflow reads it as `{{lastRun.*}}` (the cross-run loop substrate)
--    and a branch step can route on it. Null until a run terminates.
--
-- 2. saved_views.anchor_key — stable cross-run identity (`<workflowId>:<stepId>`)
--    for an assistant_call `page.reuse = 'per-workflow'` anchor, so a recurring
--    workflow find-or-creates ONE page instead of minting an empty duplicate
--    every fire (the recurring-anchor footgun fix). Unique per workspace.
--
-- Both tables are open-schema. See docs/architecture/features/workflow.md
-- → "Cross-run state" and "assistant_call page anchor".

BEGIN;

ALTER TABLE public.workflow_runs
  ADD COLUMN IF NOT EXISTS outcome jsonb;

ALTER TABLE public.saved_views
  ADD COLUMN IF NOT EXISTS anchor_key text;

-- One anchor page per (workspace, anchor_key). Partial: non-workflow pages
-- (anchor_key IS NULL) are unconstrained. Enforces row-uniqueness only — the
-- find-or-create adapter (boot createAnchorPage) converges on a 23505 race by
-- re-reading the winner. NOTE: this non-CONCURRENT unique-index build briefly
-- takes a write-blocking SHARE lock on saved_views; run it in a low-traffic
-- window once the table is large (trivial at current scale).
CREATE UNIQUE INDEX IF NOT EXISTS idx_saved_views_anchor_key
  ON public.saved_views (workspace_id, anchor_key)
  WHERE anchor_key IS NOT NULL;

COMMIT;
