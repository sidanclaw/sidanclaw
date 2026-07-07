-- Knowledge source write-capability cache.
--
-- Whether the source's bound GitHub PAT can push to the repo, probed via
-- `GET /repos/{owner}/{repo}` → `permissions.push`. Refreshed by the sync
-- worker every tick (self-heals a swapped PAT within one interval), probed
-- inline at source creation, and flipped to false on a call-time 403 from
-- the assistant KB write tools. NULL = never probed — treated as read-only
-- (fail closed) until the first probe lands.
--
-- Consumed by the KB write-tool injection gate: repo-synced knowledge
-- entries are assistant-editable only when a writable source backs them.
-- Spec: docs/architecture/features/knowledge-base.md → "Assistant direct
-- edits". [COMP:api/kb-write-capability]

BEGIN;

ALTER TABLE workspace_knowledge_sources
  ADD COLUMN write_access BOOLEAN,
  ADD COLUMN write_access_checked_at TIMESTAMPTZ;

COMMIT;
