-- 280_oss_connectors.sql
--
-- Open the connector storage layer for the OSS edition.
--
-- Background: `connector_instance` and `connector_grant` are the credential-
-- and grant-storage tables behind every built-in connector (Google Calendar,
-- Gmail, GitHub, Notion, Fathom, custom MCP). In the hosted edition they are
-- created by the CLOSED `overlay-v1` baseline, so the open `000_open_schema_v1`
-- baseline omits them. That left the OSS edition with no place to store a
-- connector OAuth grant: `connector-store.ts` / `connector-instance-store.ts` /
-- `connector-grant-store.ts` therefore hard-returned `[]` under
-- `SIDANCLAW_EDITION === 'oss'` to avoid "relation connector_instance does not
-- exist" on every chat turn, and `injectMcpTools` never injected a single
-- connector tool. This migration creates those tables for OSS so the existing
-- (already-open) store + injection code can drive real connectors.
--
-- Hosted-safety: the body is guarded on TWO conditions, both of which must
-- hold. (1) `app.migration_edition = 'oss'` -- the migrate runner sets this
-- session GUC to 'oss' only when no closed overlay dir is injected (hosted sets
-- it to 'hosted'). This matters because the runner applies the OPEN dir BEFORE
-- the overlay, so a plain `to_regclass` guard alone would still fire in hosted
-- (the overlay's connector_instance does not exist yet at this point) and create
-- a reduced table that then collides with the overlay's own CREATE TABLE.
-- (2) `to_regclass(...) IS NULL` -- belt-and-suspenders so a re-run or a
-- pre-existing table is never re-created. In hosted both the GUC differs and the
-- overlay owns the table, so this block is a pure no-op there.
--
-- Column set mirrors what the stores read/write:
--   connector-instance-store.ts (INSERT at createUserInstance / createWorkspaceInstance)
--   connector-store.ts          (the legacy McpConnector shim over the same table)
--   connector-grant-store.ts    (connector_grant)
--
-- Spec: docs/plans/oss-local-brain-wedge.md (the connector seam) lives in the
-- closed platform tree; this open migration is the OSS-only storage half.

BEGIN;

DO $$
BEGIN
  IF current_setting('app.migration_edition', true) = 'oss'
     AND to_regclass('public.connector_instance') IS NULL THEN

    -- ── connector_instance ─────────────────────────────────────
    -- A single OAuth/MCP connection. `scope` is an XOR: a 'user' row is owned by
    -- one user, a 'workspace' row by one workspace (team-native). `credentials`
    -- is the AES-GCM blob encrypted with CHANNEL_CREDENTIAL_KEY (NULL until the
    -- OAuth grant lands); `credentials_type` is the non-secret discriminator
    -- mirrored from the decrypted blob's `type`.
    CREATE TABLE public.connector_instance (
      id uuid DEFAULT gen_random_uuid() NOT NULL,
      scope text NOT NULL,
      user_id uuid,
      workspace_id uuid,
      provider text NOT NULL,
      label text NOT NULL,
      connected_email text,
      url text,
      custom boolean DEFAULT false NOT NULL,
      credentials bytea,
      credentials_type text DEFAULT 'none'::text NOT NULL,
      config jsonb DEFAULT '{}'::jsonb NOT NULL,
      sensitivity text DEFAULT 'internal'::text NOT NULL,
      connected boolean DEFAULT false NOT NULL,
      ingestion_enabled boolean DEFAULT false NOT NULL,
      created_by uuid,
      created_at timestamp with time zone DEFAULT now() NOT NULL,
      updated_at timestamp with time zone DEFAULT now() NOT NULL,
      CONSTRAINT connector_instance_pkey PRIMARY KEY (id),
      CONSTRAINT connector_instance_scope_check
        CHECK (scope = ANY (ARRAY['user'::text, 'workspace'::text])),
      CONSTRAINT connector_instance_credentials_type_check
        CHECK (credentials_type = ANY (ARRAY['oauth'::text, 'bearer'::text, 'custom_header'::text, 'none'::text])),
      CONSTRAINT connector_instance_sensitivity_check
        CHECK (sensitivity = ANY (ARRAY['public'::text, 'internal'::text, 'confidential'::text])),
      -- XOR: user-scoped rows carry user_id (no workspace_id); workspace-scoped
      -- rows carry workspace_id (no user_id).
      CONSTRAINT connector_instance_scope_xor CHECK (
        (scope = 'user' AND user_id IS NOT NULL AND workspace_id IS NULL)
        OR (scope = 'workspace' AND workspace_id IS NOT NULL AND user_id IS NULL)
      ),
      CONSTRAINT connector_instance_user_id_fkey
        FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE,
      CONSTRAINT connector_instance_workspace_id_fkey
        FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE,
      CONSTRAINT connector_instance_created_by_fkey
        FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL
    );

    CREATE INDEX idx_connector_instance_user
      ON public.connector_instance (user_id) WHERE scope = 'user';
    CREATE INDEX idx_connector_instance_workspace
      ON public.connector_instance (workspace_id) WHERE scope = 'workspace';
    CREATE INDEX idx_connector_instance_provider
      ON public.connector_instance (provider);

    CREATE TRIGGER connector_instance_set_updated_at
      BEFORE UPDATE ON public.connector_instance
      FOR EACH ROW EXECUTE FUNCTION public.trigger_set_updated_at();

    ALTER TABLE public.connector_instance ENABLE ROW LEVEL SECURITY;

    -- A caller sees/writes their own user-scoped rows plus the rows of any
    -- workspace they belong to. WITH CHECK mirrors USING so a workspace insert
    -- is rejected unless the acting user (created_by, seeded as
    -- app.current_user_id by queryWithRLS) is a member of that workspace -- the
    -- `ci_team_member` authorization gate the store relies on.
    CREATE POLICY ci_access ON public.connector_instance
      USING (
        (scope = 'user' AND user_id = (current_setting('app.current_user_id'::text, true))::uuid)
        OR (scope = 'workspace' AND workspace_id IN (
              SELECT wm.workspace_id FROM public.workspace_members wm
              WHERE wm.user_id = (current_setting('app.current_user_id'::text, true))::uuid))
      )
      WITH CHECK (
        (scope = 'user' AND user_id = (current_setting('app.current_user_id'::text, true))::uuid)
        OR (scope = 'workspace' AND workspace_id IN (
              SELECT wm.workspace_id FROM public.workspace_members wm
              WHERE wm.user_id = (current_setting('app.current_user_id'::text, true))::uuid))
      );

    -- ── connector_grant ────────────────────────────────────────
    -- "User U exposes their user-scoped instance to workspace W." Only user-
    -- scoped instances are ever granted (team-native instances are workspace-
    -- visible already); the store enforces that invariant at create time.
    CREATE TABLE public.connector_grant (
      id uuid DEFAULT gen_random_uuid() NOT NULL,
      connector_instance_id uuid NOT NULL,
      target_type text NOT NULL,
      target_id uuid NOT NULL,
      granted_by_user_id uuid NOT NULL,
      granted_at timestamp with time zone DEFAULT now() NOT NULL,
      CONSTRAINT connector_grant_pkey PRIMARY KEY (id),
      CONSTRAINT connector_grant_target_type_check
        CHECK (target_type = 'workspace'::text),
      CONSTRAINT connector_grant_unique UNIQUE (connector_instance_id, target_type, target_id),
      CONSTRAINT connector_grant_instance_fkey
        FOREIGN KEY (connector_instance_id) REFERENCES public.connector_instance(id) ON DELETE CASCADE,
      CONSTRAINT connector_grant_granted_by_fkey
        FOREIGN KEY (granted_by_user_id) REFERENCES public.users(id) ON DELETE CASCADE
    );

    CREATE INDEX idx_connector_grant_target
      ON public.connector_grant (target_type, target_id);
    CREATE INDEX idx_connector_grant_grantor
      ON public.connector_grant (granted_by_user_id);

    ALTER TABLE public.connector_grant ENABLE ROW LEVEL SECURITY;

    -- The grantor sees their own grants (cg_grantor_see_own); a member of the
    -- target workspace sees grants pointed at it (cg_target_member). Writes are
    -- restricted to the grantor.
    CREATE POLICY cg_access ON public.connector_grant
      USING (
        granted_by_user_id = (current_setting('app.current_user_id'::text, true))::uuid
        OR (target_type = 'workspace' AND target_id IN (
              SELECT wm.workspace_id FROM public.workspace_members wm
              WHERE wm.user_id = (current_setting('app.current_user_id'::text, true))::uuid))
      )
      WITH CHECK (
        granted_by_user_id = (current_setting('app.current_user_id'::text, true))::uuid
      );

  END IF;
END
$$;

COMMIT;
