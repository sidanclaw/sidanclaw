-- 306_bulk_ingest_surcharges.sql  (OPEN table -> sidanclaw/packages/api/migrations/)
--
-- The bulk-ingest item surcharge ledger (cost-and-pricing.md § Credit
-- operation menu: "Bulk ingest item - 0.5 credits per Pipeline B run").
-- Specced at launch, wired 2026-07-07 (overnight-review-queue entry 2).
--
-- Same dedicated-ledger rationale as recording_surcharges (281) and
-- synthesis_surcharges (300): the live credit gate is DERIVED - getPeriodCredits
-- SUMs usage_tracking rows carrying a user_message_id or trigger_key =
-- 'main_response'. An ingest run has neither, so its charge cannot ride the
-- derived ledger; a per-episode surcharge row composes additively
-- (SUM(credits) WHERE charged_at >= periodStart). It writes NO usage_tracking
-- row - the engine's own overhead:extraction COGS row stays the only
-- usage_tracking entry (no phantom double-count).
--
-- Idempotency key: episode_id (UNIQUE). "Charged on extraction success" -
-- a reprocessed / retried episode charges once. Billable source kinds are
-- policy, decided platform-side (file_upload / manual_paste /
-- bulk_profile_import; conversational + connector drips and the
-- recording-surcharge-covered kinds are exempt) - the ledger stores whatever
-- the charge path sends, with source_kind kept for audit.
--
-- Next free migration number is 306 (305 is the closed usage-source CHECK
-- extension in packages/api-platform/migrations/).

BEGIN;

CREATE TABLE bulk_ingest_surcharges (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id       UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  -- Plain (no FK) audit reference: deleting the episode keeps the charge row.
  episode_id         UUID NOT NULL,
  source_kind        TEXT NOT NULL,
  credits            NUMERIC NOT NULL CHECK (credits >= 0),
  charged_by_user_id UUID,
  charged_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (episode_id)
);

CREATE INDEX idx_bulk_ingest_surcharges_ws_period ON bulk_ingest_surcharges (workspace_id, charged_at);

-- RLS: workspace-membership read (the billing/usage UI). Writes run on the
-- system pool (the ingest pipeline's on-success charge). NULL-safe two-arg
-- current_setting (unset GUC -> NULL -> zero rows on the system/unauth path).
ALTER TABLE bulk_ingest_surcharges ENABLE ROW LEVEL SECURITY;
CREATE POLICY bulk_ingest_surcharges_workspace_member ON bulk_ingest_surcharges
  USING (workspace_id IN (
    SELECT workspace_members.workspace_id
      FROM workspace_members
     WHERE workspace_members.user_id = (current_setting('app.current_user_id'::text, true))::uuid
  ));

COMMIT;
