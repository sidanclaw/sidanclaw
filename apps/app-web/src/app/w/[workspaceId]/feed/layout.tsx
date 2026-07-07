"use client";

/**
 * Feed surface layout — every `/w/[id]/feed/*` route renders inside the
 * `FeedSurfaceShell` (profiles context + readiness gate). Hosted-only: the
 * OSS edition 404s the whole subtree (belt to the sidebar row's suspenders —
 * the nav row is also hidden when the workspace has no connected profiles).
 *
 * Ported operator app: docs/plans/feed-web-consolidation.md;
 * spec: docs/architecture/feed/operator-app.md.
 *
 * [COMP:app-web/feed-surface-shell]
 */

import { notFound, useParams } from "next/navigation";
import { isOssEdition } from "@/lib/edition";
import { FeedSurfaceShell } from "@/components/feed/feed-surface-shell";

export default function FeedLayout({ children }: { children: React.ReactNode }) {
  const params = useParams<{ workspaceId: string }>();
  const workspaceId = params?.workspaceId ?? "";
  if (isOssEdition()) notFound();
  return <FeedSurfaceShell workspaceId={workspaceId}>{children}</FeedSurfaceShell>;
}
