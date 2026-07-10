/**
 * Per-site backend routing (§4.15 / spec §2): account-sensitive or
 * hard-anti-bot sites go to the user's own Chrome (local extension — real
 * session, real IP, no account-ban risk); everything else goes to the cloud
 * sandbox when one is configured. Same discrete tool surface either way.
 */

/**
 * Sites where automating from a datacenter IP risks the user's real account.
 * Registrable domains — subdomains match by suffix. Workspace-level additions
 * are a later knob; keep the default list short and defensible.
 */
export const DEFAULT_ACCOUNT_SENSITIVE_DOMAINS: readonly string[] = [
  'linkedin.com',
]

/** Suffix-match a hostname against a registrable domain (`m.linkedin.com` → true). */
export function hostMatchesDomain(hostname: string, domain: string): boolean {
  const h = hostname.toLowerCase()
  const d = domain.toLowerCase()
  return h === d || h.endsWith(`.${d}`)
}

export function isAccountSensitiveUrl(
  url: string,
  domains: readonly string[] = DEFAULT_ACCOUNT_SENSITIVE_DOMAINS,
): boolean {
  let hostname: string
  try {
    hostname = new URL(url).hostname
  } catch {
    return false
  }
  return domains.some((d) => hostMatchesDomain(hostname, d))
}

export type BrowserBackendKind = 'local' | 'cloud'

/**
 * Pick the backend for a navigation target.
 *
 *  - account-sensitive → `local`, always (even when cloud is available)
 *  - otherwise → `cloud` when a SandboxProvider is configured, else `local`
 *    (the Phase-1 posture: extension-only, no E2B)
 */
export function routeBrowserBackend(params: {
  url: string
  cloudAvailable: boolean
  accountSensitiveDomains?: readonly string[]
}): BrowserBackendKind {
  if (isAccountSensitiveUrl(params.url, params.accountSensitiveDomains)) return 'local'
  return params.cloudAvailable ? 'cloud' : 'local'
}
