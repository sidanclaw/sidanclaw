-- 282_workflow_run_trigger_page.sql
--
-- Page-triggered workflow run feedback.
--
-- workflow_runs.trigger_page_id — the doc page that CHANGED and fired this run
-- (`input.event.pageId`), when the run was started by a `page` event source.
-- It lets a page surface the runs it triggered (status + outcome summary) and
-- link back to them, the back-reference for the page → workflow event trigger.
-- Null for every other run (manual / schedule / webhook / connector / channel).
--
-- Populated going forward by createDbWorkflowRunStore().createRun (it already
-- holds the run input), and backfilled below for runs already triggered by a
-- page. The partial index covers the page → runs access path
-- (idx_workflow_runs_trigger_page); workspace_id leads it so the lookup stays
-- inside the reader's RLS scope.
--
-- See docs/architecture/features/workflow.md → "Page-triggered run feedback".

BEGIN;

ALTER TABLE public.workflow_runs
  ADD COLUMN IF NOT EXISTS trigger_page_id uuid;

CREATE INDEX IF NOT EXISTS idx_workflow_runs_trigger_page
  ON public.workflow_runs (workspace_id, trigger_page_id, started_at DESC)
  WHERE trigger_page_id IS NOT NULL;

-- One-time backfill: stamp the changed page onto runs already started by a
-- page event source. Safe to re-run (idempotent on the same rows).
UPDATE public.workflow_runs
   SET trigger_page_id = (input->'event'->>'pageId')::uuid
 WHERE trigger_page_id IS NULL
   AND input->'trigger'->>'sourceType' = 'page'
   AND input->'event'->>'pageId' IS NOT NULL;

COMMIT;
