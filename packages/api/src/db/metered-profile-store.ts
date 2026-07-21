/**
 * Workspace-saved metered model profiles (migration 343).
 *
 * A profile is `{ name, modelAlias, toolRounds (10-200), thinking? }` —
 * a named shape over a metered-class registry model, pickable per turn /
 * session / assistant override so `deepseek-v4-pro / quick` (10 rounds) and
 * `/ deep` (100 rounds) sit side by side. The profile sets the tool-round
 * budget; billing is the unchanged L8 formula, estimated AT the profile's
 * budget. Spec: docs/architecture/platform/model-registry.md.
 */
import { registryRow } from '@use-brian/shared/model-registry'
import { query } from './client.js'

export type MeteredModelProfile = {
  id: string
  workspaceId: string
  name: string
  modelAlias: string
  toolRounds: number
  thinking: boolean | null
  createdByUserId: string | null
  createdAt: string
  updatedAt: string
}

type ProfileRow = {
  id: string
  workspace_id: string
  name: string
  model_alias: string
  tool_rounds: number
  thinking: boolean | null
  created_by_user_id: string | null
  created_at: string
  updated_at: string
}

function toProfile(r: ProfileRow): MeteredModelProfile {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    name: r.name,
    modelAlias: r.model_alias,
    toolRounds: r.tool_rounds,
    thinking: r.thinking,
    createdByUserId: r.created_by_user_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

export const METERED_PROFILE_MIN_ROUNDS = 10
export const METERED_PROFILE_MAX_ROUNDS = 200

/** Clamp an arbitrary rounds value into the profile-legal range (L15). */
export function clampProfileRounds(rounds: number): number {
  return Math.min(METERED_PROFILE_MAX_ROUNDS, Math.max(METERED_PROFILE_MIN_ROUNDS, Math.round(rounds)))
}

export function createMeteredProfileStore() {
  return {
    async list(workspaceId: string): Promise<MeteredModelProfile[]> {
      const res = await query<ProfileRow>(
        `SELECT * FROM metered_model_profiles WHERE workspace_id = $1 ORDER BY model_alias, name`,
        [workspaceId],
      )
      return res.rows.map(toProfile)
    },

    async get(workspaceId: string, id: string): Promise<MeteredModelProfile | null> {
      const res = await query<ProfileRow>(
        `SELECT * FROM metered_model_profiles WHERE workspace_id = $1 AND id = $2`,
        [workspaceId, id],
      )
      return res.rows[0] ? toProfile(res.rows[0]) : null
    },

    /** Create a profile. The model must be a metered-class registry row —
     * profiles over curated/background/unknown models are rejected loud. */
    async create(params: {
      workspaceId: string
      name: string
      modelAlias: string
      toolRounds: number
      thinking?: boolean | null
      createdByUserId?: string | null
    }): Promise<MeteredModelProfile> {
      const row = registryRow(params.modelAlias)
      if (!row || row.class !== 'metered' || row.status !== 'active') {
        throw new Error(`metered-profile: '${params.modelAlias}' is not an active metered registry model`)
      }
      const res = await query<ProfileRow>(
        `INSERT INTO metered_model_profiles (workspace_id, name, model_alias, tool_rounds, thinking, created_by_user_id)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING *`,
        [
          params.workspaceId,
          params.name.trim().slice(0, 60),
          row.alias,
          clampProfileRounds(params.toolRounds),
          params.thinking ?? null,
          params.createdByUserId ?? null,
        ],
      )
      return toProfile(res.rows[0]!)
    },

    async update(params: {
      workspaceId: string
      id: string
      name?: string
      toolRounds?: number
      thinking?: boolean | null
    }): Promise<MeteredModelProfile | null> {
      const res = await query<ProfileRow>(
        `UPDATE metered_model_profiles
            SET name = COALESCE($3, name),
                tool_rounds = COALESCE($4, tool_rounds),
                thinking = CASE WHEN $5::boolean IS NOT NULL THEN $5::boolean ELSE thinking END,
                updated_at = now()
          WHERE workspace_id = $1 AND id = $2
          RETURNING *`,
        [
          params.workspaceId,
          params.id,
          params.name !== undefined ? params.name.trim().slice(0, 60) : null,
          params.toolRounds !== undefined ? clampProfileRounds(params.toolRounds) : null,
          params.thinking ?? null,
        ],
      )
      return res.rows[0] ? toProfile(res.rows[0]) : null
    },

    async remove(workspaceId: string, id: string): Promise<boolean> {
      const res = await query(
        `DELETE FROM metered_model_profiles WHERE workspace_id = $1 AND id = $2`,
        [workspaceId, id],
      )
      return (res.rowCount ?? 0) > 0
    },
  }
}

export type MeteredProfileStore = ReturnType<typeof createMeteredProfileStore>
