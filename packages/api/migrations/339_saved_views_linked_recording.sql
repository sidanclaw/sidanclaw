-- 339_saved_views_linked_recording.sql
--
-- Manually link an existing recording to a doc page.
--
-- A recording brief already links back to its recording through `anchor_key`
-- (`recording-synthesis:<recordingId>`), and the doc shell mounts the player +
-- transcript + action items off that. But `anchor_key` is a SYNTHESIS identity:
-- it carries a `(workspace_id, anchor_key)` UNIQUE index (migration 307's
-- sibling on saved_views) and is the find-or-create key the synthesis engine
-- reuses, so a second page cannot borrow it, and a hand-authored page has none.
--
-- This column is the manual sibling: a nullable pointer a user sets to surface
-- an existing recording (its player, its transcript, its action items) on any
-- page they choose. The doc shell resolves the anchor-derived recording FIRST
-- and falls back to this — a real synthesis brief always wins, so linking never
-- overrides the page's own recording.
--
-- FK to `recordings(id)` with ON DELETE SET NULL: the link can only point at a
-- real recording, and it clears itself if that recording is erased rather than
-- dangling at a dead id. Same-WORKSPACE is NOT enforced here (the FK cannot see
-- workspace) — the PATCH route checks it by fetching the recording under the
-- caller's viewpoint, so a link can never reach a recording the user cannot see.

BEGIN;

ALTER TABLE public.saved_views
    ADD COLUMN linked_recording_id uuid REFERENCES public.recordings(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.saved_views.linked_recording_id IS
    'Manually-linked recording (migration 339). Nullable. The doc shell mounts the recording chrome from anchor_key FIRST, then this. Same-workspace enforced by the PATCH route, not the FK.';

COMMIT;
