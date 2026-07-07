-- 307_blueprint_records.sql
--
-- Blueprint RECORDS -- the missing output object of the blueprint primitive
-- (docs/plans/blueprint-output-contract.md; spec home
-- docs/architecture/brain/structural-synthesis.md -> "The record").
--
-- A blueprint (a `workspace_page_templates` row carrying an `extraction`
-- contract) used to persist its fill ONLY as page blocks. A record is the
-- structured instance: subject + typed field values under the contract, with
-- provenance and sensitivity. The page becomes an optional PROJECTION of the
-- record (`page_id`), rendered per-surface -- never the storage.
--
-- Semantics baked in here:
--   * (workspace_id, anchor_key) is UNIQUE -- fills upsert/converge on the
--     same 23505 pattern the page anchors use; maintain-mode refreshes update
--     one row instead of minting duplicates.
--   * `blueprint_id` is ON DELETE SET NULL + `spec_snapshot` is stored: a
--     filled record is the team's data and outlives its template; the
--     snapshot keeps it self-describing after contract edits.
--   * `status`/`missing`: a thin source never drops a record -- it lands
--     `incomplete` with the absent required keys listed. Consumers check
--     `status = 'complete'` for handoff confidence.
--
-- Store: sidanclaw/packages/api/src/db/blueprint-records-store.ts.
-- RLS mirrors `workspace_page_templates_workspace_member` (membership via
-- `app.current_user_id`).

BEGIN;

CREATE TABLE public.blueprint_records (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    blueprint_id uuid,
    spec_snapshot jsonb NOT NULL,
    subject text NOT NULL,
    anchor_key text NOT NULL,
    fields jsonb DEFAULT '{}'::jsonb NOT NULL,
    status text DEFAULT 'incomplete'::text NOT NULL,
    missing jsonb DEFAULT '[]'::jsonb NOT NULL,
    source_kind text NOT NULL,
    source_id text,
    sensitivity text DEFAULT 'internal'::text NOT NULL,
    page_id uuid,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT blueprint_records_pkey PRIMARY KEY (id),
    CONSTRAINT blueprint_records_workspace_id_fkey
        FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE,
    CONSTRAINT blueprint_records_blueprint_id_fkey
        FOREIGN KEY (blueprint_id) REFERENCES public.workspace_page_templates(id) ON DELETE SET NULL,
    CONSTRAINT blueprint_records_page_id_fkey
        FOREIGN KEY (page_id) REFERENCES public.saved_views(id) ON DELETE SET NULL,
    CONSTRAINT blueprint_records_created_by_fkey
        FOREIGN KEY (created_by) REFERENCES public.users(id),
    CONSTRAINT blueprint_records_status_check
        CHECK ((status = ANY (ARRAY['complete'::text, 'incomplete'::text]))),
    CONSTRAINT blueprint_records_source_kind_check
        CHECK ((source_kind = ANY (ARRAY['recording'::text, 'brain'::text, 'research'::text, 'chat'::text, 'workflow'::text]))),
    CONSTRAINT blueprint_records_subject_check
        CHECK (((length(subject) >= 1) AND (length(subject) <= 512))),
    CONSTRAINT blueprint_records_anchor_key_check
        CHECK (((length(anchor_key) >= 1) AND (length(anchor_key) <= 512)))
);

CREATE UNIQUE INDEX blueprint_records_workspace_anchor_key
    ON public.blueprint_records (workspace_id, anchor_key);
CREATE INDEX blueprint_records_workspace_blueprint_updated_idx
    ON public.blueprint_records (workspace_id, blueprint_id, updated_at DESC);
CREATE INDEX blueprint_records_workspace_source_idx
    ON public.blueprint_records (workspace_id, source_kind, source_id);

CREATE TRIGGER blueprint_records_set_updated_at
    BEFORE UPDATE ON public.blueprint_records
    FOR EACH ROW EXECUTE FUNCTION public.trigger_set_updated_at();

ALTER TABLE public.blueprint_records ENABLE ROW LEVEL SECURITY;

CREATE POLICY blueprint_records_workspace_member ON public.blueprint_records
    USING ((workspace_id IN ( SELECT workspace_members.workspace_id
       FROM public.workspace_members
      WHERE (workspace_members.user_id = (current_setting('app.current_user_id'::text, true))::uuid))));

COMMIT;
