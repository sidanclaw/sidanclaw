"use client";

/**
 * Feed draft-sessions list route — per-platform refine sessions. Thin
 * wrapper: the meat lives in `@/components/feed/draft-sessions-list`
 * (`[COMP:app-web/feed-draft-sessions]`) so the desktop SPA can import the
 * client component directly (docs/plans/feed-web-consolidation.md §6, §10).
 * The Suspense boundary covers `useSearchParams` (the `?filter=` deep link).
 */

import { Suspense } from "react";
import { DraftSessionsList } from "@/components/feed/draft-sessions-list";

export default function FeedDraftSessionsPage() {
  return (
    <Suspense fallback={<div className="text-sm text-muted-foreground">…</div>}>
      <DraftSessionsList />
    </Suspense>
  );
}
