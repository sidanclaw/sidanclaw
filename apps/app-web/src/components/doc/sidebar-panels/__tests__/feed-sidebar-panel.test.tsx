/**
 * [COMP:app-web/sidebar-panel-feed] Feed rail — static render contract.
 *
 * vitest in app-web is node-only — `renderToString` + module mocks
 * (next/navigation, the sidebar-data provider). Effects never run, so the
 * inbox badge (an effect-driven fetch) stays at zero here; what's asserted
 * is the nav structure: team rows always, the platform group only with a
 * connected profile, hrefs built through `feedPath`, and the URL-derived
 * active platform winning over profile order.
 */

import { describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";

const pathnameRef = vi.hoisted(() => ({ current: "/w/ws-1/feed" }));
const sidebarDataRef = vi.hoisted(
  () => ({ current: { feedProfiles: null } }) as {
    current: { feedProfiles: unknown };
  },
);

vi.mock("next/navigation", () => ({
  usePathname: () => pathnameRef.current,
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock("@/components/doc/doc-sidebar-data", () => ({
  useSidebarData: () => sidebarDataRef.current,
}));
vi.mock("@/lib/auth-fetch", () => ({ authFetch: vi.fn() }));

import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import type { Dictionary } from "@/lib/i18n/dictionaries";
import type { FeedProfile } from "@/lib/api/feed";
import { FeedSidebarPanel } from "../feed-sidebar-panel";

const dict = en as unknown as Dictionary;

function profile(
  platform: FeedProfile["platform"],
  handle: string,
): FeedProfile {
  return {
    assistantId: `a-${handle}`,
    platform,
    platformHandle: handle,
    profilePictureUrl: null,
    enabled: true,
    assistant: { id: `a-${handle}`, name: handle, iconSeed: 0 },
  };
}

function render(profiles: FeedProfile[] | null, pathname: string): string {
  pathnameRef.current = pathname;
  sidebarDataRef.current = { feedProfiles: profiles };
  return renderToString(
    <I18nProvider locale="en" dict={dict}>
      <FeedSidebarPanel workspaceId="ws-1" />
    </I18nProvider>,
  );
}

describe("[COMP:app-web/sidebar-panel-feed] FeedSidebarPanel", () => {
  it("renders the team rows with feedPath hrefs", () => {
    const html = render([profile("threads", "acme")], "/w/ws-1/feed");
    expect(html).toContain('href="/w/ws-1/feed"');
    expect(html).toContain('href="/w/ws-1/feed/inbox"');
    expect(html).toContain('href="/w/ws-1/feed/voice"');
  });

  it("renders platform rows for the first profile by default", () => {
    const html = render([profile("threads", "acme")], "/w/ws-1/feed");
    expect(html).toContain('href="/w/ws-1/feed/threads/insights"');
    expect(html).toContain('href="/w/ws-1/feed/threads/draft-sessions"');
    expect(html).toContain('href="/w/ws-1/feed/threads/settings"');
    // Single profile → static pill (SSR splits `@{handle}` with a comment
    // node, so match the handle alone), no picker trigger.
    expect(html).toContain("acme");
    expect(html).not.toContain(en.feedPage.platformPickerAria);
  });

  it("the URL's platform wins over profile order", () => {
    const html = render(
      [profile("threads", "acme"), profile("twitter", "acmex")],
      "/w/ws-1/feed/twitter/insights",
    );
    expect(html).toContain('href="/w/ws-1/feed/twitter/inspiration"');
    expect(html).toContain("acmex");
    // Two profiles → the picker trigger renders.
    expect(html).toContain(en.feedPage.platformPickerAria);
  });

  it("hides the platform group entirely with no connected profiles", () => {
    const html = render([], "/w/ws-1/feed");
    expect(html).toContain('href="/w/ws-1/feed/inbox"');
    expect(html).not.toContain("/feed/threads/");
    expect(html).not.toContain(en.feedPage.groups.platform);
  });
});
