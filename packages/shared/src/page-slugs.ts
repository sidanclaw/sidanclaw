/**
 * Page slug + custom-domain hostname helpers for published-page sites.
 *
 * Shared between the API (validation, suggestion, resolution) and app-web
 * (client-side suggestion preview in the Publish tab). Browser-safe: no Node
 * imports. Spec: docs/architecture/features/custom-domains.md.
 */

export const PAGE_SLUG_MAX_LENGTH = 64;

/** Lowercase kebab: letters/digits separated by single hyphens. */
export const PAGE_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Single-segment paths the site router owns (or that would shadow app-web
 * routes if a custom host ever fell through to the app). Kept small and
 * flat: slugs can never contain `.` or `_`, so file-ish names like
 * robots.txt are unreachable by construction.
 */
export const RESERVED_PAGE_SLUGS: ReadonlySet<string> = new Set([
  'p',
  'api',
  'share',
  'site',
  'assets',
  'static',
  'login',
  'admin',
  'app',
  'w',
]);

export function isValidPageSlug(slug: string): boolean {
  return (
    slug.length > 0 &&
    slug.length <= PAGE_SLUG_MAX_LENGTH &&
    PAGE_SLUG_PATTERN.test(slug) &&
    !RESERVED_PAGE_SLUGS.has(slug)
  );
}

/**
 * Derive a slug suggestion from a page title. Mirrors the
 * fieldKeyFromHeading algorithm (lowercase, collapse non-alphanumerics to
 * hyphens, trim) and de-dupes against `taken` with -2, -3, … suffixes.
 * Falls back to 'page' for titles with no usable characters (e.g. CJK-only
 * titles in v1 — those keep the /p/<id> fallback until a slug is typed).
 */
export function suggestPageSlug(title: string, taken?: ReadonlySet<string>): string {
  let base = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, PAGE_SLUG_MAX_LENGTH)
    .replace(/-+$/g, '');
  if (!base || RESERVED_PAGE_SLUGS.has(base)) base = base ? `${base}-page` : 'page';
  if (!taken?.has(base)) return base;
  for (let n = 2; ; n++) {
    const suffix = `-${n}`;
    const candidate = `${base.slice(0, PAGE_SLUG_MAX_LENGTH - suffix.length)}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

const HOSTNAME_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** `.suffix` entries match the suffix (and the bare apex); anything else is
 *  an exact hostname. No product hostnames live in code — the deployment
 *  passes its own (`PAGE_DOMAIN_BLOCKED_HOSTS` + derived origin hosts). */
export function hostMatchesEntry(hostname: string, entry: string): boolean {
  const e = entry.trim().toLowerCase();
  if (!e) return false;
  if (e.startsWith('.')) {
    const apex = e.slice(1);
    return hostname === apex || hostname.endsWith(e);
  }
  return hostname === e;
}

/**
 * Common multi-part public-suffix second levels (`example.co.uk`,
 * `example.com.au`). Not a bundled public-suffix list — just a guard so the
 * apex-derivation below never turns a registrable domain sitting directly under
 * one of these into a block on the whole suffix (`.co.uk`). Extend via config,
 * never a product hostname.
 */
const PUBLIC_SUFFIX_SECOND_LEVELS = new Set([
  'co', 'com', 'org', 'net', 'gov', 'edu', 'ac', 'or', 'ne', 'go', 'gr',
]);

/**
 * Derive `.apex` suffix-block entries from a deployment's own origin hosts, so
 * a subdomain of the product's OWN domain (which rides the product's wildcard
 * DNS) can never be attached as a "bring your own" custom domain. Such a host
 * resolves for free via the wildcard yet the edge 404s it, so without this it
 * would falsely verify as live — and it isn't a customer domain anyway.
 *
 * An origin with < 3 labels yields nothing: its exact host is already blocked,
 * and stripping a label off a 2-label apex would produce a bare TLD. A parent
 * that looks like a known public suffix (`co.uk`) is skipped so self-hosts on
 * multi-part TLDs don't block their whole registrar namespace. First-party
 * publishing under the product apex therefore needs an explicit operator
 * allowlist or a separate apex — see custom-domains.md.
 */
export function deriveOwnApexBlocks(originHosts: readonly string[]): string[] {
  const out = new Set<string>();
  for (const raw of originHosts) {
    const host = raw.trim().toLowerCase().replace(/\.$/, '');
    const labels = host.split('.').filter(Boolean);
    if (labels.length < 3) continue;
    const parent = labels.slice(1);
    if (parent.length === 2 && PUBLIC_SUFFIX_SECOND_LEVELS.has(parent[0])) continue;
    out.add('.' + parent.join('.'));
  }
  return [...out];
}

// ── Platform-issued subdomain labels (<label>.<apex>) ────────────
// A platform subdomain (docs/architecture/features/platform-subdomains.md) is a
// governed workspace label under the product's own apex, served by the wildcard.
// Its LABEL (the leftmost part, `acme`) is validated/suggested here; the API
// composes `${label}.${apex}` and stores it as a page_domains row.

/** Generic reserved subdomain labels — never product hostnames (those derive
 *  from configured origins in `deriveReservedSubdomainLabels`). */
const RESERVED_SUBDOMAIN_LABELS: readonly string[] = [
  'www', 'app', 'api', 'admin', 'mail', 'smtp', 'imap', 'ftp', 'ns', 'ns1',
  'ns2', 'assets', 'static', 'cdn', 'status', 'blog', 'docs', 'help', 'support',
  'dashboard', 'auth', 'login', 'account', 'billing', 'internal', 'staging',
];

/** A valid DNS label: lowercase, 1-63 chars, alphanumeric with interior
 *  hyphens, no leading/trailing hyphen. (`HOSTNAME_LABEL` already caps at 63.) */
export function isValidSubdomainLabel(label: string): boolean {
  return HOSTNAME_LABEL.test(label);
}

/** Reserved labels a workspace may not claim: the generic set above + the
 *  leftmost label of each of the deployment's own origin hosts (so `app`,
 *  `api`, `admin` from the configured URLs stay unclaimable) + operator extras
 *  (`PLATFORM_SUBDOMAIN_RESERVED`). No product hostnames hardcoded. */
export function deriveReservedSubdomainLabels(
  originHosts: readonly string[] = [],
  extra: readonly string[] = [],
): string[] {
  const out = new Set<string>(RESERVED_SUBDOMAIN_LABELS);
  for (const raw of originHosts) {
    const first = raw.trim().toLowerCase().split('.').filter(Boolean)[0];
    if (first) out.add(first);
  }
  for (const e of extra) {
    const v = e.trim().toLowerCase();
    if (v) out.add(v);
  }
  return [...out];
}

/** The default-subdomain word pool: short, friendly, unambiguous fruit names
 *  (lowercase ascii — valid DNS label prefixes). */
const SUBDOMAIN_FRUITS: readonly string[] = [
  'apple', 'apricot', 'avocado', 'banana', 'blackberry', 'blueberry',
  'cherry', 'coconut', 'cranberry', 'date', 'dragonfruit', 'durian',
  'fig', 'grape', 'guava', 'kiwi', 'kumquat', 'lemon', 'lime', 'lychee',
  'mango', 'melon', 'nectarine', 'olive', 'orange', 'papaya', 'peach',
  'pear', 'persimmon', 'pineapple', 'plum', 'pomelo', 'raspberry',
  'starfruit', 'strawberry', 'tangerine', 'watermelon',
];

/**
 * Generate a default workspace-subdomain label: `<fruit><3 digits>` —
 * `grape209`, `watermelon102`. The digits (100-999) keep collisions rare;
 * the API layer still availability-checks and re-rolls on a clash. `rng`
 * is injectable for tests (defaults to Math.random).
 */
export function generateSubdomainLabel(rng: () => number = Math.random): string {
  const fruit = SUBDOMAIN_FRUITS[Math.floor(rng() * SUBDOMAIN_FRUITS.length)];
  const digits = 100 + Math.floor(rng() * 900);
  return `${fruit}${digits}`;
}

/**
 * Normalize user input ("https://Docs.Acme.com/path" → "docs.acme.com").
 * Returns null when the input is not a usable public hostname. IDN input is
 * punycoded via the WHATWG URL parser (browser- and Node-consistent).
 *
 * Only universally non-routable inputs are rejected here (localhost, IPs,
 * single-label names, bad shapes). Which product hostnames a deployment
 * refuses is CONFIG, not code: pass them via `opts.block` (exact hosts or
 * `.suffix` entries — see `hostMatchesEntry`).
 */
export function normalizeHostname(
  input: string,
  opts?: { block?: readonly string[] },
): string | null {
  const trimmed = input.trim().toLowerCase();
  if (!trimmed) return null;
  let hostname: string;
  try {
    hostname = new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`).hostname;
  } catch {
    return null;
  }
  if (!hostname || hostname.length > 253) return null;
  const labels = hostname.split('.');
  if (labels.length < 2) return null; // single-label (localhost etc.)
  if (!labels.every((label) => HOSTNAME_LABEL.test(label))) return null;
  if (labels.every((label) => /^\d+$/.test(label))) return null; // IPv4
  if (hostname.includes(':')) return null; // IPv6 / port slipped through
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) return null;
  for (const entry of opts?.block ?? []) {
    if (hostMatchesEntry(hostname, entry)) return null;
  }
  return hostname;
}
