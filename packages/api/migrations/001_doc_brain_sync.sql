-- 001_doc_brain_sync.sql
--
-- Doc-page → brain ingestion (the "Sync to brain" per-page toggle).
--
-- Spec: docs/plans/canvas-brain-distillation.md ("canvas" there == today's
-- "doc" surface). The plan's on-request `ingestPage` becomes ALSO auto on save
-- when this toggle is enabled (the one user-requested deviation).
--
-- Three columns on `saved_views`:
--   - `brain_sync_enabled` — the per-page opt-in. When true, an authored-content
--     change on save/settle auto-ingests the page into the brain. Default false
--     so the feature is strictly opt-in (the plan's "reversible direction":
--     start strict, loosen by toggling on).
--   - `brain_last_ingest_hash` — the authored-content hash of the last ingest.
--     The auto-on-save trigger only fires when the current authored hash differs,
--     so a debounced save that didn't touch authored prose never re-ingests
--     (the dedup half of the re-ingest-storm guard).
--   - `brain_last_ingest_at` — when the last ingest ran. The trigger also waits
--     for a cooldown since this timestamp, so a burst of authored saves within a
--     few minutes collapses to at most one ingest (the cooldown half of the
--     guard).
--
-- These are NULLable (hash/at) because a page that has never been ingested has
-- neither; `brain_sync_enabled` is NOT NULL DEFAULT false so the toggle column
-- is always concrete.

BEGIN;

ALTER TABLE public.saved_views
  ADD COLUMN brain_sync_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN brain_last_ingest_hash text,
  ADD COLUMN brain_last_ingest_at timestamp with time zone;

-- Page-as-source registration writes one `kb_chunks` row per authored block,
-- keyed by `source_path = '<pageId>#<blockId>'` (see doc-page-source-store.ts).
-- A re-ingest UPSERTs by that key, so the (page, block) pair must be unique
-- among `doc_page` chunks. A PARTIAL unique index scopes the constraint to the
-- `doc_page` source so other sources (kb_sync, import) keep sharing/reusing
-- `source_path` freely. `ON CONFLICT (source_path) WHERE source='doc_page'` in
-- the store targets exactly this index.
CREATE UNIQUE INDEX kb_chunks_doc_page_source_path_key
  ON public.kb_chunks (source_path)
  WHERE source = 'doc_page';

COMMIT;
