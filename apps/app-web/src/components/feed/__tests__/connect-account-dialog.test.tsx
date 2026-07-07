/**
 * [COMP:app-web/feed-connect-account-dialog] Connect-account dialog —
 * static render contract.
 *
 * vitest in app-web is node-only. The dialog body renders through a base-ui
 * portal that only mounts once opened (a click), so the static assertions
 * are the closed-state contract: the admin/owner gate `useConnectAccount`
 * exposes (drives every connect entry point on the home surface), and that
 * a closed dialog leaks no copy into the page. The open flow (voice pick /
 * create → OAuth redirect) is web-QA.
 */

import { describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";

const workspaceRef = vi.hoisted(
  () => ({ current: null }) as { current: unknown },
);

vi.mock("@/lib/auth-fetch", () => ({
  authFetch: vi.fn(),
  getAccessToken: () => null,
}));
vi.mock("@/contexts/feed-profiles-context", () => ({
  useFeedWorkspace: () => workspaceRef.current,
}));

import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import type { Dictionary } from "@/lib/i18n/dictionaries";
import { useConnectAccount } from "../connect-account-dialog";

const dict = en as unknown as Dictionary;

function Probe() {
  const { isAdmin, dialog } = useConnectAccount();
  return (
    <div>
      <span>{isAdmin ? "can-connect-yes" : "can-connect-no"}</span>
      {dialog}
    </div>
  );
}

function render(role: "owner" | "admin" | "member"): string {
  workspaceRef.current = {
    workspaceId: "ws-1",
    name: "Acme Team",
    role,
    canDraft: true,
    me: { id: "u-1" },
    profiles: [],
    refresh: async () => {},
  };
  return renderToString(
    <I18nProvider locale="en" dict={dict}>
      <Probe />
    </I18nProvider>,
  );
}

describe("[COMP:app-web/feed-connect-account-dialog] useConnectAccount", () => {
  it("grants the connect entry point to owners and admins", () => {
    expect(render("owner")).toContain("can-connect-yes");
    expect(render("admin")).toContain("can-connect-yes");
  });

  it("denies it to members", () => {
    expect(render("member")).toContain("can-connect-no");
  });

  it("a closed dialog leaks no copy into the page", () => {
    const html = render("admin");
    expect(html).not.toContain(en.feedPage.connect.title);
    expect(html).not.toContain(en.feedPage.connect.authorize);
  });
});
