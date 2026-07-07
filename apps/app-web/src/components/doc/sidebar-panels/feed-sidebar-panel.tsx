"use client";

/**
 * Feed sidebar panel — the grouped section sub-menu rendered in the left
 * sidebar when the active surface is Feed. Structure clones
 * `StudioSidebarPanel`; the platform pill + inbox badge port feed-web's
 * `workspace-sidebar.tsx` behavior (URL wins, then localStorage, then the
 * first profile; badge = cross-platform pending approvals, refetched per
 * route change as a cheap "something may have resolved" proxy).
 *
 * Profiles come from `useSidebarData().feedProfiles` — the same probe that
 * decides the Feed nav row's visibility — so the panel adds no second
 * profiles fetch (docs/plans/feed-web-consolidation.md §3).
 *
 * [COMP:app-web/sidebar-panel-feed]
 */

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { ChevronDown } from "lucide-react";
import { useT } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";
import {
  FEED_GROUPS,
  feedPath,
  feedPlatformFromPathname,
  isFeedPlatform,
  type FeedPlatform,
} from "@/lib/feed-nav";
import { fetchFeedApprovalsCount, type FeedProfile } from "@/lib/api/feed";
import { useSidebarData } from "@/components/doc/doc-sidebar-data";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

const ACTIVE_PLATFORM_KEY = "feed:active-platform";

/**
 * Pick the active platform profile: URL wins when on a platform route, then
 * localStorage, then the first profile. Mirrors feed-web's
 * `pickActivePlatform` — one "currently selected" identity drives the
 * per-platform rows.
 */
function pickActivePlatform(
  profiles: FeedProfile[],
  pathname: string,
): FeedProfile | null {
  if (profiles.length === 0) return null;
  const fromUrl = feedPlatformFromPathname(pathname);
  if (fromUrl) {
    const match = profiles.find((p) => p.platform === fromUrl);
    if (match) return match;
  }
  if (typeof window !== "undefined") {
    const saved = window.localStorage.getItem(ACTIVE_PLATFORM_KEY);
    if (saved) {
      const fromStorage = profiles.find((p) => p.platform === saved);
      if (fromStorage) return fromStorage;
    }
  }
  return profiles[0];
}

export function FeedSidebarPanel({ workspaceId }: { workspaceId: string }) {
  const t = useT();
  const pathname = usePathname() ?? "";
  const router = useRouter();
  const { feedProfiles } = useSidebarData();
  const profiles = useMemo(() => feedProfiles ?? [], [feedProfiles]);

  const [active, setActive] = useState<FeedProfile | null>(() =>
    pickActivePlatform(profiles, pathname),
  );
  // Re-pick whenever URL or profile list changes — keeps the URL the source
  // of truth as the user navigates.
  useEffect(() => {
    setActive(pickActivePlatform(profiles, pathname));
  }, [pathname, profiles]);

  // ── Inbox badge (cross-platform pending approvals) ──────────────────────
  const assistantIds = useMemo(
    () => Array.from(new Set(profiles.map((p) => p.assistantId))),
    [profiles],
  );
  const [inboxCount, setInboxCount] = useState(0);
  useEffect(() => {
    let cancelled = false;
    void fetchFeedApprovalsCount(assistantIds).then((n) => {
      if (!cancelled) setInboxCount(n);
    });
    return () => {
      cancelled = true;
    };
  }, [assistantIds, pathname]);

  function selectPlatform(p: FeedProfile) {
    setActive(p);
    try {
      window.localStorage.setItem(ACTIVE_PLATFORM_KEY, p.platform);
    } catch {
      // Preference only — losing it costs one extra click next session.
    }
    // On a platform-scoped route, swap the platform segment so the user lands
    // on the equivalent surface. Only the section root carries — anything
    // deeper (a `draft-sessions/[sessionId]`) is assistant-scoped and would
    // resolve to content owned by the original assistant, so drop it.
    const current = feedPlatformFromPathname(pathname);
    if (current) {
      const marker = `/feed/${current}`;
      const idx = pathname.indexOf(marker);
      const section =
        idx >= 0
          ? pathname
              .slice(idx + marker.length)
              .split("/")
              .filter(Boolean)[0]
          : undefined;
      router.push(feedPath(workspaceId, { platform: p.platform, segment: section }));
      return;
    }
    router.push(feedPath(workspaceId, { platform: p.platform, segment: "insights" }));
  }

  const rowCls = (activeRow: boolean) =>
    cn(
      "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors",
      activeRow
        ? "doc-nav-active font-medium text-sidebar-accent-foreground"
        : "text-sidebar-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
    );

  return (
    <nav
      aria-label={t.feedPage.sectionsAriaLabel}
      className="flex flex-col gap-4 px-1 pt-1"
    >
      {FEED_GROUPS.map((g) => {
        if (g.perPlatform && !active) return null;
        return (
          <div key={g.key} className="flex flex-col gap-0.5">
            <div className="px-1 pb-1 text-[11px] font-semibold uppercase tracking-wide text-sidebar-foreground/45">
              {t.feedPage.groups[g.key]}
            </div>

            {/* Platform pill — pick which connected account the per-platform
                rows target. Single account: static label. */}
            {g.perPlatform && active ? (
              <PlatformPicker
                profiles={profiles}
                active={active}
                onSelect={selectPlatform}
              />
            ) : null}

            <ul className="flex flex-col gap-0.5">
              {g.sections.map((s) => {
                const href = g.perPlatform
                  ? feedPath(workspaceId, {
                      platform: active!.platform,
                      segment: s.segment,
                    })
                  : feedPath(workspaceId, { segment: s.segment || undefined });
                // The home row (bare `/feed`) is exact-match so it doesn't
                // stay lit on every child route.
                const activeRow =
                  s.key === "home" ? pathname === href : pathname.startsWith(href);
                return (
                  <li key={s.key}>
                    <Link
                      href={href}
                      aria-current={activeRow ? "page" : undefined}
                      className={rowCls(activeRow)}
                    >
                      <span className="min-w-0 flex-1 truncate">
                        {t.feedPage.sections[s.key]}
                      </span>
                      {s.key === "inbox" && inboxCount > 0 ? (
                        <span
                          aria-label={t.feedPage.inboxBadgeAria.replace(
                            "{count}",
                            String(inboxCount),
                          )}
                          className="inline-flex min-w-[18px] shrink-0 items-center justify-center rounded-full bg-primary px-1.5 text-[10px] font-semibold leading-[18px] text-primary-foreground"
                        >
                          {inboxCount > 99 ? "99+" : inboxCount}
                        </span>
                      ) : null}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </nav>
  );
}

function PlatformPicker(props: {
  profiles: FeedProfile[];
  active: FeedProfile;
  onSelect: (p: FeedProfile) => void;
}) {
  const t = useT();
  const { profiles, active, onSelect } = props;
  const others = profiles.filter(
    (p) =>
      !(p.platform === active.platform && p.assistantId === active.assistantId),
  );

  const pill = (
    <span className="flex min-w-0 flex-1 items-center gap-2">
      <PlatformAvatar platform={active.platform} />
      <span className="min-w-0 flex-1 text-left">
        <span className="block truncate text-[13px] font-medium">
          {t.feedPage.platformLabels[active.platform]}
        </span>
        <span className="block truncate text-[11px] text-muted-foreground">
          @{active.platformHandle}
        </span>
      </span>
    </span>
  );

  if (others.length === 0) {
    return (
      <div className="mb-1 flex items-center rounded-md border border-sidebar-border/60 px-2 py-1.5">
        {pill}
      </div>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            aria-label={t.feedPage.platformPickerAria}
            className="mb-1 flex w-full items-center gap-1 rounded-md border border-sidebar-border/60 px-2 py-1.5 transition-colors hover:bg-sidebar-accent"
          >
            {pill}
            <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
          </button>
        }
      />
      <DropdownMenuContent align="start" className="w-56">
        {others.map((p) => (
          <DropdownMenuItem
            key={`${p.platform}-${p.assistantId}`}
            onClick={() => onSelect(p)}
          >
            <span className="flex min-w-0 items-center gap-2">
              <PlatformAvatar platform={p.platform} />
              <span className="min-w-0 text-left">
                <span className="block truncate text-[13px] font-medium">
                  {t.feedPage.platformLabels[p.platform]}
                </span>
                <span className="block truncate text-[11px] text-muted-foreground">
                  @{p.platformHandle}
                </span>
              </span>
            </span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function PlatformAvatar({ platform }: { platform: FeedPlatform }) {
  const cls =
    "flex size-6 shrink-0 items-center justify-center rounded-md text-[11px] font-semibold";
  if (isFeedPlatform(platform) && platform === "twitter") {
    return <span className={cn(cls, "bg-foreground text-background")}>X</span>;
  }
  return <span className={cn(cls, "bg-primary/15 text-primary")}>@</span>;
}
