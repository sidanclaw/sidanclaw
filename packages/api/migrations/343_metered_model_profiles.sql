-- 343_metered_model_profiles.sql  (OPEN table)
--
-- Workspace-saved metered model profiles (docs/plans/model-registry.md L15,
-- docs/architecture/platform/model-registry.md): `{ name, modelAlias,
-- toolRounds (10-200), thinking? }` — pickable per turn / session / assistant
-- override so one metered model can run side-by-side shapes
-- (`deepseek-v4-pro / quick` at 10 rounds vs `/ deep` at 100). The profile
-- sets the tool-round budget; the L8 billing formula is unchanged, and the
-- pre-flight estimate is computed AT the profile's budget so `quick` and
-- `deep` confirm at visibly different prices. `model_alias` references a
-- model-registry row by alias (code-owned, no FK).

BEGIN;

CREATE TABLE metered_model_profiles (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id       UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name               TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  model_alias        TEXT NOT NULL,
  tool_rounds        INT  NOT NULL CHECK (tool_rounds BETWEEN 10 AND 200),
  thinking           BOOLEAN,
  created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, model_alias, name)
);

CREATE INDEX idx_metered_profiles_ws ON metered_model_profiles (workspace_id);

-- RLS: workspace-membership read/write (profiles are workspace settings).
-- NULL-safe two-arg current_setting (unset GUC -> NULL -> zero rows on the
-- system/unauth path).
ALTER TABLE metered_model_profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY metered_model_profiles_workspace_member ON metered_model_profiles
  USING (workspace_id IN (
    SELECT workspace_members.workspace_id
      FROM workspace_members
     WHERE workspace_members.user_id = (current_setting('app.current_user_id'::text, true))::uuid
  ));

COMMIT;
