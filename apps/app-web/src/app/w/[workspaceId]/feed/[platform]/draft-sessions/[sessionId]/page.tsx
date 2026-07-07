"use client";

/**
 * Feed draft-session detail route — the per-draft refine chat. Thin wrapper:
 * the meat lives in `@/components/feed/draft-session-detail`
 * (`[COMP:app-web/feed-draft-sessions]`) so the desktop SPA can import the
 * client component directly (docs/plans/feed-web-consolidation.md §6, §10).
 * The Suspense boundary covers `useSearchParams` (`?account=` + `?seed=`).
 */

import { Suspense } from "react";
import { DraftSessionDetail } from "@/components/feed/draft-session-detail";

export default function FeedDraftSessionDetailPage() {
  return (
    <Suspense fallback={<div className="text-sm text-muted-foreground">…</div>}>
      <DraftSessionDetail />
    </Suspense>
  );
}
