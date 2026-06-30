-- 283_saved_views_created_event_pending.sql
--
-- Deferred page `created` workflow event.
--
-- saved_views.created_event_pending — true while an interactively-created draft
-- (the doc-editor "blank page" / "from template" flows, via POST /views/draft)
-- is waiting to fire its `created` page-event-trigger. The store skips the
-- immediate emit for these drafts; the client commits the event after the user
-- has engaged (debounced typing) or navigates away, via POST
-- /views/:id/commit-created → `commitCreatedEvent`, which flips the flag back to
-- false atomically and emits `created` only if it won the flip (single-fire,
-- reload-safe, multi-instance-safe).
--
-- Programmatic creates (brain-MCP createPage, the workflow page anchor, the
-- legacy /views/new form) never set this and keep firing `created` immediately
-- — they have no "typing" to wait on. Defaults false so every existing row and
-- every non-deferred create is treated as already-emitted.
--
-- See docs/architecture/features/workflow.md → "Page event source" →
-- "Deferred created (interactive drafts)".

BEGIN;

ALTER TABLE public.saved_views
  ADD COLUMN IF NOT EXISTS created_event_pending boolean NOT NULL DEFAULT false;

COMMIT;
