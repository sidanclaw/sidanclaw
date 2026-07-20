/**
 * Startup verification that the files bucket allows a BROWSER upload.
 *
 * The recordings flow PUTs bytes from the browser straight to GCS against a
 * `signedWriteUrl`. That URL mints fine no matter how the bucket is configured
 * — the signature is arithmetic over the key and the clock, and it never
 * consults CORS. The failure is therefore **invisible to every server-side code
 * path**: the route returns 200 with a valid URL, and the browser then fails the
 * preflight and never sends a byte. The recording sits at `awaiting_upload`
 * forever and the user sees a generic "could not process that recording".
 *
 * That is exactly how this shipped broken twice. The bucket's CORS was
 * provisioned once by hand (2026-07-09 incident), documented as a shell snippet
 * in `docs/architecture/features/files.md`, and then silently lost when the
 * rebrand created a fresh `brian-files-prod` — bucket config does not follow a
 * rename. Nothing in the deploy, the tests, or the request path could observe
 * it, because the only observer is a browser that nobody runs in CI.
 *
 * So the check lives at boot, where the process CAN see it. It is a WARNING,
 * never a refusal: a missing PUT-CORS breaks uploads only, and taking the whole
 * API down over it would convert a broken feature into an outage. `pnpm check`
 * cannot cover this — the truth is in cloud state, not the repo.
 *
 * [COMP:files/gcs-cors-check]
 */

/** One entry of a GCS bucket's `cors` array, as the JSON API returns it. */
export type GcsCorsRule = {
  origin?: string[]
  method?: string[]
  responseHeader?: string[]
  maxAgeSeconds?: number
}

export type CorsVerdict =
  | { ok: true }
  | { ok: false; code: 'no_cors' | 'origin_not_allowed' | 'put_not_allowed'; detail: string }

/** GCS matches an origin/method literally or via the `*` wildcard. */
function matches(patterns: readonly string[] | undefined, value: string): boolean {
  if (!patterns) return false
  return patterns.some((p) => p === '*' || p.toLowerCase() === value.toLowerCase())
}

/**
 * Does this bucket CORS config permit a browser at `origin` to PUT?
 *
 * Pure, so the rule logic is unit-testable without a network or a bucket — the
 * IO half (`readBucketCors`) is deliberately separate. Distinguishes the three
 * failure shapes rather than returning a bare boolean, because the fix differs:
 * no config at all is a fresh/renamed bucket, a missing origin is usually a
 * rebrand or a new app domain, and a missing PUT is the GET-only config that
 * serves downloads perfectly while breaking every upload.
 */
export function corsAllowsBrowserUpload(
  rules: readonly GcsCorsRule[] | null | undefined,
  origin: string,
): CorsVerdict {
  if (!rules || rules.length === 0) {
    return { ok: false, code: 'no_cors', detail: 'the bucket has no CORS configuration at all' }
  }
  const forOrigin = rules.filter((r) => matches(r.origin, origin))
  if (forOrigin.length === 0) {
    const seen = rules.flatMap((r) => r.origin ?? []).join(', ') || '(none)'
    return {
      ok: false,
      code: 'origin_not_allowed',
      detail: `no CORS rule lists this origin; configured origins are: ${seen}`,
    }
  }
  // A rule grants its methods to its origins, so PUT must appear on a rule that
  // already matched the origin — PUT on some *other* origin's rule is no use.
  if (!forOrigin.some((r) => matches(r.method, 'PUT'))) {
    const seen = forOrigin.flatMap((r) => r.method ?? []).join(', ') || '(none)'
    return {
      ok: false,
      code: 'put_not_allowed',
      detail: `the rule for this origin allows only: ${seen} — a GET-only CORS serves downloads but fails every upload preflight`,
    }
  }
  return { ok: true }
}

/** The one-line remediation, so the log says what to actually do. */
export function corsFixHint(bucket: string, origin: string): string {
  return (
    `Fix: add a CORS rule allowing PUT from ${origin} to gs://${bucket} ` +
    `(canonical cors.json in docs/architecture/features/files.md -> "Provisioning"). ` +
    `Verify with: gcloud storage buckets describe gs://${bucket} --format="value(cors_config)"`
  )
}

/**
 * Read the live bucket's CORS array. Returns `null` when it cannot be read at
 * all (permissions, network, missing bucket) — the caller treats that as
 * "unknown", never as "misconfigured", so a service account without
 * `storage.buckets.get` produces a soft note rather than a false alarm.
 */
export async function readBucketCors(opts: {
  bucket: string
  projectId?: string
}): Promise<GcsCorsRule[] | null> {
  const { Storage } = await import('@google-cloud/storage')
  const storage = new Storage(opts.projectId ? { projectId: opts.projectId } : undefined)
  const [metadata] = await storage.bucket(opts.bucket).getMetadata()
  return (metadata.cors as GcsCorsRule[] | undefined) ?? []
}

/**
 * Boot-time check: read the bucket, log loudly when a browser cannot upload.
 *
 * Never throws and never blocks — callers fire-and-forget it after the server
 * is listening. An unreadable bucket logs a soft note and returns; only a
 * definitively bad config warns.
 */
export async function verifyBucketCorsAtBoot(opts: {
  bucket: string
  origin: string
  projectId?: string
  log?: Pick<Console, 'warn' | 'log'>
}): Promise<CorsVerdict | null> {
  const log = opts.log ?? console
  let rules: GcsCorsRule[] | null
  try {
    rules = await readBucketCors({ bucket: opts.bucket, ...(opts.projectId ? { projectId: opts.projectId } : {}) })
  } catch (err) {
    log.log(
      `[files] could not read CORS on gs://${opts.bucket} (${(err as Error).message}) — ` +
        `skipping the browser-upload check; grant storage.buckets.get to verify it automatically.`,
    )
    return null
  }
  const verdict = corsAllowsBrowserUpload(rules, opts.origin)
  if (!verdict.ok) {
    log.warn(
      `[files] BROWSER UPLOADS WILL FAIL: gs://${opts.bucket} — ${verdict.detail}. ` +
        `Recording uploads PUT direct from ${opts.origin} and will stall at 'awaiting_upload' ` +
        `with a generic error. ${corsFixHint(opts.bucket, opts.origin)}`,
    )
  }
  return verdict
}
