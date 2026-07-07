/**
 * Platform guard for `/w/[id]/feed/[platform]/*` — only the feed engine's
 * known platforms (`FEED_PLATFORMS`) are routable; anything else 404s before
 * a page can fetch with a junk platform segment.
 */

import { notFound } from "next/navigation";
import { isFeedPlatform } from "@/lib/feed-nav";

export default async function FeedPlatformLayout(props: {
  children: React.ReactNode;
  params: Promise<{ platform: string }>;
}) {
  const { platform } = await props.params;
  if (!isFeedPlatform(platform)) notFound();
  return props.children;
}
