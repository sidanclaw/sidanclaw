BEGIN;

CREATE TABLE IF NOT EXISTS public.ingest_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connector_instance_id uuid NOT NULL,
  source text NOT NULL,
  rule_order integer NOT NULL,
  filter_type text NOT NULL,
  filter_params jsonb NOT NULL DEFAULT '{}'::jsonb,
  routing_mode text NOT NULL,
  routing_schedule text,
  routing_timezone text NOT NULL DEFAULT 'UTC',
  alert boolean NOT NULL DEFAULT false,
  episode_sensitivity text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.pending_ingest_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  rule_id uuid NOT NULL,
  source text NOT NULL,
  fires_at timestamptz NOT NULL,
  events jsonb NOT NULL DEFAULT '[]'::jsonb,
  processed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  episode_sensitivity text
);

CREATE TABLE IF NOT EXISTS public.wa_auth_state (
  channel_id text NOT NULL,
  key text NOT NULL,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (channel_id, key)
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ingest_rules_connector_instance_id_rule_order_key' AND conrelid = 'public.ingest_rules'::regclass) THEN
    ALTER TABLE public.ingest_rules ADD CONSTRAINT ingest_rules_connector_instance_id_rule_order_key UNIQUE (connector_instance_id, rule_order);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ingest_rules_connector_instance_id_fkey' AND conrelid = 'public.ingest_rules'::regclass) THEN
    ALTER TABLE public.ingest_rules ADD CONSTRAINT ingest_rules_connector_instance_id_fkey FOREIGN KEY (connector_instance_id) REFERENCES public.connector_instance(id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ingest_rules_routing_mode_check' AND conrelid = 'public.ingest_rules'::regclass) THEN
    ALTER TABLE public.ingest_rules ADD CONSTRAINT ingest_rules_routing_mode_check CHECK (routing_mode = ANY (ARRAY['realtime', 'scheduled', 'drop', 'reply']));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ingest_rules_check' AND conrelid = 'public.ingest_rules'::regclass) THEN
    ALTER TABLE public.ingest_rules ADD CONSTRAINT ingest_rules_check CHECK (((routing_mode = 'scheduled') AND routing_schedule IS NOT NULL) OR ((routing_mode = ANY (ARRAY['realtime', 'drop', 'reply'])) AND routing_schedule IS NULL));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ingest_rules_episode_sensitivity_check' AND conrelid = 'public.ingest_rules'::regclass) THEN
    ALTER TABLE public.ingest_rules ADD CONSTRAINT ingest_rules_episode_sensitivity_check CHECK (episode_sensitivity IS NULL OR episode_sensitivity = ANY (ARRAY['public', 'internal', 'confidential']));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pending_ingest_batches_rule_id_fkey' AND conrelid = 'public.pending_ingest_batches'::regclass) THEN
    ALTER TABLE public.pending_ingest_batches ADD CONSTRAINT pending_ingest_batches_rule_id_fkey FOREIGN KEY (rule_id) REFERENCES public.ingest_rules(id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pending_ingest_batches_workspace_id_fkey' AND conrelid = 'public.pending_ingest_batches'::regclass) THEN
    ALTER TABLE public.pending_ingest_batches ADD CONSTRAINT pending_ingest_batches_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pending_ingest_batches_episode_sensitivity_check' AND conrelid = 'public.pending_ingest_batches'::regclass) THEN
    ALTER TABLE public.pending_ingest_batches ADD CONSTRAINT pending_ingest_batches_episode_sensitivity_check CHECK (episode_sensitivity IS NULL OR episode_sensitivity = ANY (ARRAY['public', 'internal', 'confidential']));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_ingest_rules_eval ON public.ingest_rules (connector_instance_id, rule_order);
CREATE INDEX IF NOT EXISTS idx_pending_batches_due ON public.pending_ingest_batches (fires_at) WHERE processed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_wa_auth_state_channel ON public.wa_auth_state (channel_id);

ALTER TABLE public.ingest_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pending_ingest_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wa_auth_state ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'public.ingest_rules'::regclass AND polname = 'ingest_rules_member') THEN
    CREATE POLICY ingest_rules_member ON public.ingest_rules USING (connector_instance_id IN (SELECT id FROM public.connector_instance));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'public.pending_ingest_batches'::regclass AND polname = 'pending_ingest_batches_system') THEN
    CREATE POLICY pending_ingest_batches_system ON public.pending_ingest_batches USING (current_setting('app.system_bypass', true) = 'true') WITH CHECK (current_setting('app.system_bypass', true) = 'true');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'public.wa_auth_state'::regclass AND polname = 'wa_auth_state_system') THEN
    CREATE POLICY wa_auth_state_system ON public.wa_auth_state USING (current_setting('app.system_bypass', true) = 'true') WITH CHECK (current_setting('app.system_bypass', true) = 'true');
  END IF;
END $$;

COMMIT;
