-- 341: workspace-first domain lifecycle — a domain may exist UNBOUND.
--
-- The UX inverted (2026-07-20 founder decision): domains are connected /
-- claimed in workspace Settings first, with no page required; the "default
-- page" (what serves at `/`) is assigned afterwards, and a page's Share
-- dialog only selects among connected domains + edits its alias. So
-- page_domains.page_id becomes nullable: NULL = connected but not serving a
-- root yet. Serving re-derives per request; an unbound domain 404s at `/`
-- while aliased pages (each a published mini-root) can still serve.
--
-- Spec: docs/architecture/features/platform-subdomains.md + custom-domains.md.

BEGIN;

ALTER TABLE page_domains ALTER COLUMN page_id DROP NOT NULL;

COMMIT;
