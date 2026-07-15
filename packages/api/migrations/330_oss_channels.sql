-- 330_oss_channels.sql (renumbered from 315 — that prefix was already taken
-- by the closed overlay's 315_computer_use.sql; the numeric sequence is
-- shared across both migration dirs)
--
-- Open the BYO channel storage layer for the OSS edition.
--
-- Background: the channel runtime (workspace channels management, the
-- Telegram/Slack BYO webhooks, the Discord connector inbound, and the
-- channel shadow-identity cache) moved from the closed platform into the
-- open core (see docs/architecture/channels/adapter-pattern.md). Its four
-- tables — `channels`, `channel_integrations`, `channel_assistants`,
-- `channel_user_cache` — are created by the CLOSED `overlay-v1` baseline in
-- the hosted edition, so the open `000_open_schema_v1` baseline omits them.
-- Without them the OSS edition has no place to store a connected bot: the
-- routes are mounted (bootOpenApi) but every query would fail with
-- "relation channels does not exist". This migration creates those tables
-- for OSS so the (already-open) stores + routes can drive real channels.
--
-- Hosted-safety: same double guard as 280_oss_connectors.sql.
-- (1) `app.migration_edition = 'oss'` — the migrate runner sets this session
-- GUC to 'oss' only when no closed overlay dir is injected. The runner
-- applies the OPEN dir BEFORE the overlay, so a plain `to_regclass` guard
-- alone would still fire in hosted and collide with the overlay's own
-- CREATE TABLE. (2) `to_regclass(...) IS NULL` — belt-and-suspenders so a
-- re-run never re-creates. In hosted both conditions differ, pure no-op.
--
-- Column set mirrors the closed overlay baseline (including the
-- `whatsapp_bot_send_scope` column added there by closed migration 283, so
-- the two editions' shapes stay identical). RLS policies mirror the overlay:
-- `sensitivity_rank()` and `trigger_set_updated_at()` already exist in the
-- open baseline.

BEGIN;

DO $$
BEGIN
  IF current_setting('app.migration_edition', true) = 'oss'
     AND to_regclass('public.channels') IS NULL THEN

    -- ── channels ───────────────────────────────────────────────
    -- A workspace-owned messaging surface (one row per connected bot).
    CREATE TABLE public.channels (
      id uuid DEFAULT gen_random_uuid() NOT NULL,
      workspace_id uuid NOT NULL,
      channel_type text NOT NULL,
      clearance text DEFAULT 'internal'::text NOT NULL,
      enabled_capabilities text[] DEFAULT '{}'::text[] NOT NULL,
      status text DEFAULT 'active'::text NOT NULL,
      display_name text NOT NULL,
      created_at timestamp with time zone DEFAULT now() NOT NULL,
      updated_at timestamp with time zone DEFAULT now() NOT NULL,
      whatsapp_bot_send_scope text,
      CONSTRAINT channels_pkey PRIMARY KEY (id),
      CONSTRAINT channels_channel_type_check
        CHECK (channel_type = ANY (ARRAY['telegram'::text, 'slack'::text, 'whatsapp'::text, 'discord'::text, 'email'::text])),
      CONSTRAINT channels_clearance_check
        CHECK (clearance = ANY (ARRAY['public'::text, 'internal'::text, 'confidential'::text])),
      CONSTRAINT channels_enabled_capabilities_check
        CHECK (enabled_capabilities <@ ARRAY['chat'::text, 'broadcast'::text, 'ingest'::text]),
      CONSTRAINT channels_status_check
        CHECK (status = ANY (ARRAY['active'::text, 'revoked'::text, 'invalid'::text])),
      CONSTRAINT channels_whatsapp_bot_send_scope_check
        CHECK (whatsapp_bot_send_scope IS NULL OR whatsapp_bot_send_scope = ANY (ARRAY['dm'::text, 'dm_and_groups'::text])),
      CONSTRAINT channels_workspace_id_fkey
        FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE
    );

    CREATE INDEX idx_channels_workspace ON public.channels USING btree (workspace_id, channel_type);

    CREATE TRIGGER channels_set_updated_at
      BEFORE UPDATE ON public.channels
      FOR EACH ROW EXECUTE FUNCTION public.trigger_set_updated_at();

    ALTER TABLE public.channels ENABLE ROW LEVEL SECURITY;

    -- A member sees only channels whose clearance ranks at or below their
    -- own workspace-member clearance (mirrors the hosted policy).
    CREATE POLICY channels_workspace_member ON public.channels
      USING ((EXISTS ( SELECT 1
        FROM public.workspace_members wm
        WHERE ((wm.workspace_id = channels.workspace_id)
          AND (wm.user_id = (current_setting('app.current_user_id'::text, true))::uuid)
          AND (public.sensitivity_rank(channels.clearance) <= public.sensitivity_rank(wm.clearance))))));

    -- ── channel_integrations ───────────────────────────────────
    -- Per-channel bot credentials (AES-GCM blob encrypted with
    -- CHANNEL_CREDENTIAL_KEY) + behavior config.
    CREATE TABLE public.channel_integrations (
      id uuid DEFAULT gen_random_uuid() NOT NULL,
      channel_type text NOT NULL,
      team_id text,
      team_name text,
      bot_user_id text,
      credentials bytea NOT NULL,
      status text DEFAULT 'active'::text NOT NULL,
      created_at timestamp with time zone DEFAULT now() NOT NULL,
      updated_at timestamp with time zone DEFAULT now() NOT NULL,
      last_event_at timestamp with time zone,
      config jsonb DEFAULT '{}'::jsonb NOT NULL,
      connection_metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
      bot_username text,
      channel_id uuid NOT NULL,
      connector_instance_id uuid,
      CONSTRAINT channel_integrations_pkey PRIMARY KEY (id),
      CONSTRAINT channel_integrations_channel_id_key UNIQUE (channel_id),
      CONSTRAINT valid_ci_status
        CHECK (status = ANY (ARRAY['active'::text, 'revoked'::text, 'invalid'::text])),
      CONSTRAINT channel_integrations_channel_id_fkey
        FOREIGN KEY (channel_id) REFERENCES public.channels(id) ON DELETE CASCADE
    );

    COMMENT ON COLUMN public.channel_integrations.connection_metadata IS
      'Non-secret runtime state for persistent-connection channels (WhatsApp). Contains phone_number, last_connected_at. Not encrypted.';

    CREATE INDEX idx_channel_integrations_ci_link
      ON public.channel_integrations USING btree (connector_instance_id)
      WHERE (connector_instance_id IS NOT NULL);

    CREATE TRIGGER set_updated_at_channel_integrations
      BEFORE UPDATE ON public.channel_integrations
      FOR EACH ROW EXECUTE FUNCTION public.trigger_set_updated_at();

    ALTER TABLE public.channel_integrations ENABLE ROW LEVEL SECURITY;

    CREATE POLICY channel_integrations_channel_member ON public.channel_integrations
      USING ((channel_id IN ( SELECT channels.id FROM public.channels)));

    -- ── channel_assistants ─────────────────────────────────────
    -- Per-surface assistant routing (which assistant answers which Slack
    -- conversation / Telegram chat / topic).
    CREATE TABLE public.channel_assistants (
      id uuid DEFAULT gen_random_uuid() NOT NULL,
      channel_id uuid NOT NULL,
      assistant_id uuid NOT NULL,
      external_surface_id text,
      created_at timestamp with time zone DEFAULT now() NOT NULL,
      model_alias text DEFAULT 'pro'::text NOT NULL,
      CONSTRAINT channel_assistants_pkey PRIMARY KEY (id),
      CONSTRAINT channel_assistants_model_alias_check
        CHECK (model_alias = ANY (ARRAY['standard'::text, 'pro'::text, 'max'::text])),
      CONSTRAINT channel_assistants_assistant_id_fkey
        FOREIGN KEY (assistant_id) REFERENCES public.assistants(id) ON DELETE CASCADE,
      CONSTRAINT channel_assistants_channel_id_fkey
        FOREIGN KEY (channel_id) REFERENCES public.channels(id) ON DELETE CASCADE
    );

    CREATE UNIQUE INDEX idx_channel_assistants_default
      ON public.channel_assistants USING btree (channel_id)
      WHERE (external_surface_id IS NULL);
    CREATE UNIQUE INDEX idx_channel_assistants_surface
      ON public.channel_assistants USING btree (channel_id, external_surface_id)
      WHERE (external_surface_id IS NOT NULL);

    -- Guard: an assistant can only be routed on a channel in its own
    -- workspace (mirrors the overlay's SECURITY DEFINER trigger).
    CREATE OR REPLACE FUNCTION public.channel_assistants_workspace_match()
     RETURNS trigger
     LANGUAGE plpgsql
     SECURITY DEFINER
     SET search_path TO 'public', 'pg_temp'
    AS $fn$
    BEGIN
      IF (SELECT workspace_id FROM assistants WHERE id = NEW.assistant_id)
         <> (SELECT workspace_id FROM channels WHERE id = NEW.channel_id) THEN
        RAISE EXCEPTION 'channel_assistants: assistant and channel must share a workspace';
      END IF;
      RETURN NEW;
    END;
    $fn$;

    CREATE TRIGGER channel_assistants_workspace_match_trg
      BEFORE INSERT OR UPDATE OF channel_id, assistant_id ON public.channel_assistants
      FOR EACH ROW EXECUTE FUNCTION public.channel_assistants_workspace_match();

    ALTER TABLE public.channel_assistants ENABLE ROW LEVEL SECURITY;

    CREATE POLICY channel_assistants_workspace_member ON public.channel_assistants
      USING ((channel_id IN ( SELECT channels.id FROM public.channels)));

    -- ── channel_user_cache ─────────────────────────────────────
    -- Shadow-identity resolution cache (webhook-time lookup — no RLS, like
    -- the overlay original).
    CREATE TABLE public.channel_user_cache (
      provider text NOT NULL,
      provider_user_id text NOT NULL,
      email text,
      display_name text,
      user_id uuid NOT NULL,
      assistant_id uuid NOT NULL,
      cached_at timestamp with time zone DEFAULT now() NOT NULL,
      CONSTRAINT channel_user_cache_pkey PRIMARY KEY (provider, provider_user_id, assistant_id)
    );

    CREATE INDEX idx_cuc_assistant ON public.channel_user_cache USING btree (assistant_id);
    CREATE INDEX idx_cuc_user ON public.channel_user_cache USING btree (user_id);

  END IF;
END
$$;

-- ── Shape convergence for pre-existing OSS channel tables ─────────────
-- Two parallel authors bootstrapped this substrate against different overlay
-- vintages: 326_agentmail_email_channel.sql's create lacks
-- `whatsapp_bot_send_scope` (closed 283), and this file's create originally
-- lacked 'email' in the type CHECK (closed 327). On any OSS database where
-- `channels` already exists (created by 326, or by this file under its old
-- 315 number), converge to the full shape. Hosted is untouched: the edition
-- GUC differs, and the overlay already carries both via 283 + 327.
DO $$
BEGIN
  IF current_setting('app.migration_edition', true) = 'oss'
     AND to_regclass('public.channels') IS NOT NULL THEN

    ALTER TABLE public.channels
      ADD COLUMN IF NOT EXISTS whatsapp_bot_send_scope text;

    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = 'channels_whatsapp_bot_send_scope_check'
        AND conrelid = 'public.channels'::regclass
    ) THEN
      ALTER TABLE public.channels
        ADD CONSTRAINT channels_whatsapp_bot_send_scope_check
        CHECK (whatsapp_bot_send_scope IS NULL OR whatsapp_bot_send_scope = ANY (ARRAY['dm'::text, 'dm_and_groups'::text]));
    END IF;

    ALTER TABLE public.channels
      DROP CONSTRAINT IF EXISTS channels_channel_type_check;
    ALTER TABLE public.channels
      ADD CONSTRAINT channels_channel_type_check
      CHECK (channel_type = ANY (ARRAY['telegram'::text, 'slack'::text, 'whatsapp'::text, 'discord'::text, 'email'::text]));

  END IF;
END
$$;

COMMIT;
