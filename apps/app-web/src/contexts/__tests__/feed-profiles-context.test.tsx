/**
 * [COMP:app-web/feed-profiles-context] Draft-permission derivation + the
 * provider's SSR-safe initial state.
 *
 * vitest in app-web is node-only (no jsdom) — effects never run, so the
 * fetch path is exercised indirectly: `deriveCanDraft` (the pure permission
 * rule) directly, and the provider via `renderToString` asserting the
 * loading-state contract the surface shell's gate depends on.
 */

import { describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";

vi.mock("@/lib/auth-fetch", () => ({ authFetch: vi.fn() }));

import {
  FeedProfilesProvider,
  deriveCanDraft,
  useFeedWorkspaceState,
} from "@/contexts/feed-profiles-context";

describe("[COMP:app-web/feed-profiles-context] deriveCanDraft", () => {
  it("grants owner and admin unconditionally", () => {
    expect(deriveCanDraft({ role: "owner", myUserId: "u1" })).toBe(true);
    expect(
      deriveCanDraft({
        role: "admin",
        myUserId: "u1",
        members: [{ userId: "u1", canDraft: false }],
      }),
    ).toBe(true);
  });

  it("reads the member's own can_draft toggle", () => {
    const members = [
      { userId: "u1", canDraft: true },
      { userId: "u2", canDraft: false },
    ];
    expect(deriveCanDraft({ role: "member", myUserId: "u1", members })).toBe(
      true,
    );
    expect(deriveCanDraft({ role: "member", myUserId: "u2", members })).toBe(
      false,
    );
  });

  it("falls back to false when the member row is missing", () => {
    expect(deriveCanDraft({ role: "member", myUserId: "u9", members: [] })).toBe(
      false,
    );
    expect(deriveCanDraft({ role: "member", myUserId: "u9" })).toBe(false);
  });
});

function StateProbe() {
  const state = useFeedWorkspaceState();
  return <span data-status={state.status}>{state.status}</span>;
}

describe("[COMP:app-web/feed-profiles-context] provider initial state", () => {
  it("starts in loading (SSR-safe: no fetch before effects)", () => {
    const html = renderToString(
      <FeedProfilesProvider workspaceId="ws-1">
        <StateProbe />
      </FeedProfilesProvider>,
    );
    expect(html).toContain('data-status="loading"');
  });
});
