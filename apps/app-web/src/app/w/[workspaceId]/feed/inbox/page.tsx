"use client";

/**
 * Feed inbox route — the cross-platform approval inbox. Thin wrapper: the
 * meat lives in `@/components/feed/feed-inbox` (`[COMP:app-web/feed-inbox]`)
 * so the desktop SPA can import the client component directly
 * (docs/plans/feed-web-consolidation.md §6, §10). No `useSearchParams`, so
 * no Suspense boundary is needed.
 */

import { FeedInbox } from "@/components/feed/feed-inbox";

export default function FeedInboxPage() {
  return <FeedInbox />;
}
