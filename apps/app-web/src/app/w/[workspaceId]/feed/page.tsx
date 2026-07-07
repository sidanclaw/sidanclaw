"use client";

/**
 * Feed surface index — the team home dashboard. Thin wrapper: the meat lives
 * in `@/components/feed/feed-home` (`[COMP:app-web/feed-home]`) so the
 * desktop SPA can import the client component directly
 * (docs/plans/feed-web-consolidation.md §6, §10). The Suspense boundary
 * covers `useSearchParams` (the `?connected=` OAuth landing).
 */

import { Suspense } from "react";
import { FeedHome } from "@/components/feed/feed-home";

export default function FeedHomePage() {
  return (
    <Suspense fallback={<div className="text-sm text-muted-foreground">…</div>}>
      <FeedHome />
    </Suspense>
  );
}
