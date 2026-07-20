-- 340: platform-issued workspace subdomains (<label>.<apex>) reuse page_domains.
--
-- A 'platform' provider row is served by the platform's own wildcard DNS (no
-- per-domain DNS or verification — status is 'live' at creation). It differs
-- from a BYO 'manual'/'vercel' row only in how it is issued: a governed claim
-- route mints the label from a reserved-checked namespace. subdomain_label
-- holds the bare label ('acme' for acme.usebrian.page); exactly one platform
-- subdomain per workspace. Everything downstream (page_slugs, resolveSitePath,
-- rendering) is reused unchanged.
--
-- Spec: docs/architecture/features/platform-subdomains.md.

BEGIN;

-- Allow the new provider kind.
ALTER TABLE page_domains DROP CONSTRAINT page_domains_provider_check;
ALTER TABLE page_domains ADD CONSTRAINT page_domains_provider_check
  CHECK (provider IN ('manual', 'vercel', 'platform'));

-- Bare label for platform rows; NULL for BYO rows. Must be a valid DNS label.
ALTER TABLE page_domains ADD COLUMN subdomain_label text;
ALTER TABLE page_domains ADD CONSTRAINT page_domains_subdomain_label_shape_check
  CHECK (
    subdomain_label IS NULL
    OR (
      subdomain_label = lower(subdomain_label)
      AND subdomain_label ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$'
    )
  );

-- A platform row has a label; a BYO row does not. Kept in lockstep.
ALTER TABLE page_domains ADD CONSTRAINT page_domains_platform_label_check
  CHECK ((provider = 'platform') = (subdomain_label IS NOT NULL));

-- One platform subdomain per workspace (BYO domains stay capped separately via
-- PAGE_DOMAINS_MAX_PER_WORKSPACE, which counts only non-platform rows).
CREATE UNIQUE INDEX page_domains_one_platform_per_workspace
  ON page_domains (workspace_id) WHERE provider = 'platform';

COMMIT;
