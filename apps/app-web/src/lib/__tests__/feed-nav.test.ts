import { describe, expect, it } from "vitest";
import {
  FEED_GROUPS,
  FEED_PLATFORMS,
  feedPath,
  feedPlatformFromPathname,
  feedSectionFromPathname,
  isFeedPlatform,
} from "@/lib/feed-nav";

describe("[COMP:app-web/feed-nav] feed navigation config", () => {
  it("supports exactly the feed engine's platforms", () => {
    expect(FEED_PLATFORMS).toEqual(["threads", "twitter"]);
    expect(isFeedPlatform("threads")).toBe(true);
    expect(isFeedPlatform("twitter")).toBe(true);
    expect(isFeedPlatform("mastodon")).toBe(false);
    expect(isFeedPlatform(null)).toBe(false);
    expect(isFeedPlatform(undefined)).toBe(false);
  });

  it("keeps team rows and platform rows in separate groups", () => {
    const teamGroup = FEED_GROUPS.find((g) => !g.perPlatform);
    const platformGroup = FEED_GROUPS.find((g) => g.perPlatform);
    expect(teamGroup?.sections.map((s) => s.key)).toEqual([
      "home",
      "inbox",
      "voice",
    ]);
    expect(platformGroup?.sections.map((s) => s.key)).toEqual([
      "insights",
      "inspiration",
      "draftSessions",
      "connection",
      "policy",
      "settings",
    ]);
  });

  it("builds feed routes for team and platform scopes", () => {
    expect(feedPath("w1")).toBe("/w/w1/feed");
    expect(feedPath("w1", { segment: "inbox" })).toBe("/w/w1/feed/inbox");
    expect(feedPath("w1", { platform: "threads" })).toBe("/w/w1/feed/threads");
    expect(feedPath("w1", { platform: "twitter", segment: "insights" })).toBe(
      "/w/w1/feed/twitter/insights",
    );
  });

  it("reads the active platform off a pathname (team rows have none)", () => {
    expect(feedPlatformFromPathname("/w/w1/feed/threads/insights")).toBe(
      "threads",
    );
    expect(feedPlatformFromPathname("/w/w1/feed/twitter")).toBe("twitter");
    expect(feedPlatformFromPathname("/w/w1/feed/inbox")).toBeNull();
    expect(feedPlatformFromPathname("/w/w1/feed")).toBeNull();
    expect(feedPlatformFromPathname("/w/w1/brain")).toBeNull();
    expect(feedPlatformFromPathname(null)).toBeNull();
  });

  it("classifies feed sections from pathnames", () => {
    expect(feedSectionFromPathname("/w/w1/feed")).toBe("home");
    expect(feedSectionFromPathname("/w/w1/feed/")).toBe("home");
    expect(feedSectionFromPathname("/w/w1/feed/inbox")).toBe("inbox");
    expect(feedSectionFromPathname("/w/w1/feed/voice")).toBe("voice");
    expect(feedSectionFromPathname("/w/w1/feed/threads/insights")).toBe(
      "insights",
    );
    expect(feedSectionFromPathname("/w/w1/feed/twitter/draft-sessions")).toBe(
      "draftSessions",
    );
    expect(
      feedSectionFromPathname("/w/w1/feed/twitter/draft-sessions/s-1"),
    ).toBe("draftSessions");
    expect(feedSectionFromPathname("/w/w1/feed/threads/settings/members")).toBe(
      "settings",
    );
  });

  it("returns null for unknown segments and non-feed paths", () => {
    // A bare platform root has no section (pages live under a segment).
    expect(feedSectionFromPathname("/w/w1/feed/threads")).toBeNull();
    expect(feedSectionFromPathname("/w/w1/feed/unknown")).toBeNull();
    expect(feedSectionFromPathname("/w/w1/feed/threads/unknown")).toBeNull();
    expect(feedSectionFromPathname("/w/w1/studio/connectors")).toBeNull();
    expect(feedSectionFromPathname(null)).toBeNull();
    expect(feedSectionFromPathname(undefined)).toBeNull();
  });
});
