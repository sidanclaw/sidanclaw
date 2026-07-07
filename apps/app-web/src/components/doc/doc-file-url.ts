/**
 * Resolve a doc-block `FileRef` to a browser-loadable URL.
 *
 * Two backing stores:
 *
 *   - `workspace_files` (the durable doc-media sink) → the signed-read
 *     endpoint `GET /api/doc-files/:workspaceId/:id`, which is
 *     membership-gated and 302-redirects to a signed GCS URL. The endpoint URL
 *     itself is stable and usable directly as an `<img src>` / download anchor,
 *     so this resolves synchronously.
 *   - `file_cache` (legacy fallback, pre-durable-storage refs) → the transient
 *     chat-attachment preview route. That route is UNAUTHENTICATED but
 *     signature-gated (WS3 #8): a bare id no longer returns bytes. We first
 *     mint a short-lived signed preview URL via the authenticated
 *     `GET /api/files/:id/preview-url` (access-scoped server-side), then hand
 *     the returned `?sig=…` URL to the `<img>` — which loads cross-origin
 *     without the SameSite=Lax cookie.
 *
 * [COMP:app-web/doc-file-url]
 */

import { authFetch } from "@/lib/auth-fetch";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

export type FileRef = {
  bucket: string;
  path: string;
  mimeType: string;
  sizeBytes: number;
  name: string;
};

/**
 * Synchronous URL for the durable `workspace_files` bucket only. Returns null
 * for the legacy `file_cache` bucket (which needs the async signed mint) and
 * for any unknown bucket.
 */
export function durableReadUrlFor(ref: FileRef, workspaceId: string): string | null {
  if (ref.bucket === "workspace_files") {
    return `${API_URL}/api/doc-files/${workspaceId}/${encodeURIComponent(ref.path)}`;
  }
  return null;
}

/**
 * Resolve any supported `FileRef` to a browser-loadable URL. Durable refs
 * resolve immediately; a legacy `file_cache` ref triggers an authenticated
 * mint round-trip for a signed preview URL. Returns null when the ref's bucket
 * is unknown or the signed-URL mint fails (caller shows "preview unavailable").
 */
export async function resolveFileRefUrl(
  ref: FileRef,
  workspaceId: string,
): Promise<string | null> {
  const durable = durableReadUrlFor(ref, workspaceId);
  if (durable) return durable;

  if (ref.bucket === "file_cache") {
    try {
      const res = await authFetch(
        `${API_URL}/api/files/${encodeURIComponent(ref.path)}/preview-url?workspaceId=${encodeURIComponent(workspaceId)}`,
      );
      if (!res.ok) return null;
      const data = (await res.json()) as { url?: string };
      // The mint route returns a root-relative `/api/files/...` path; make it
      // absolute against the API origin so it works as a cross-origin src.
      return data.url ? `${API_URL}${data.url}` : null;
    } catch {
      return null;
    }
  }

  return null;
}
