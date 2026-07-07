/**
 * [COMP:app-web/feed-surface-shell] Readiness gate contract.
 *
 * vitest in app-web is node-only — `renderToString` + static markup, the
 * doc-sidebar-row.test.tsx shape. Effects never run under SSR, so the
 * provider stays in its initial `loading` state and the gate must render
 * the loading status INSTEAD of children — the invariant ported feed pages
 * rely on (they read `useFeedWorkspace()` synchronously).
 */

import { describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";

vi.mock("@/lib/auth-fetch", () => ({ authFetch: vi.fn() }));

import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import type { Dictionary } from "@/lib/i18n/dictionaries";
import { FeedSurfaceShell } from "../feed-surface-shell";

const dict = en as unknown as Dictionary;

describe("[COMP:app-web/feed-surface-shell] FeedSurfaceShell", () => {
  it("gates children behind the loading state (no premature context reads)", () => {
    const html = renderToString(
      <I18nProvider locale="en" dict={dict}>
        <FeedSurfaceShell workspaceId="ws-1">
          <div data-feed-page>should not render while loading</div>
        </FeedSurfaceShell>
      </I18nProvider>,
    );
    expect(html).toContain(en.feedPage.shell.loading);
    expect(html).not.toContain("data-feed-page");
  });
});
