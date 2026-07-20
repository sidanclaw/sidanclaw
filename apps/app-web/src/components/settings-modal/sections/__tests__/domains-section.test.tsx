/**
 * [COMP:app-web/settings-domains] Settings -> Domains — static render
 * contracts (node-only vitest: `renderToString` + module mocks, the
 * feed-settings test shape). Effects never run under SSR, so the section
 * itself stays in its loading contract; the row components are asserted
 * directly. The claim/rename/reset/check round-trips are web-QA.
 */

import { describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";

vi.mock("next/navigation", () => ({
  useParams: () => ({ workspaceId: "ws-1" }),
}));
vi.mock("@/lib/auth-fetch", () => ({
  authFetch: vi.fn(),
  getAccessToken: () => null,
}));
vi.mock("@/components/ui/confirm-dialog", () => ({
  confirmDialog: vi.fn(async () => false),
}));

import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import type { Dictionary } from "@/lib/i18n/dictionaries";
import type { ViewListRow, WorkspaceDomainRow } from "@/lib/api/views";
import {
  CustomDomainRow,
  DomainsSection,
  SubdomainClaim,
  SubdomainRow,
} from "../domains-section";

const dict = en as unknown as Dictionary;
const td = en.chrome.settingsModal.domains;
const ts = en.docPage.share.site;

function row(over: Partial<WorkspaceDomainRow> = {}): WorkspaceDomainRow {
  return {
    id: "pd-1",
    workspaceId: "ws-1",
    pageId: null,
    hostname: "grape209.usebrian.page",
    status: "live",
    provider: "platform",
    subdomainLabel: "grape209",
    verificationError: null,
    lastCheckedAt: null,
    createdBy: "u-1",
    createdAt: "now",
    updatedAt: "now",
    pageName: null,
    ...over,
  };
}

const PAGES: ViewListRow[] = [
  { id: "pg-1", name: "Handbook" } as ViewListRow,
  { id: "pg-2", name: "Pricing" } as ViewListRow,
];

function render(node: React.ReactElement): string {
  return renderToString(
    <I18nProvider locale="en" dict={dict}>
      {node}
    </I18nProvider>,
  );
}

describe("[COMP:app-web/settings-domains] DomainsSection", () => {
  it("renders the loading contract under SSR (the load effect never runs)", () => {
    const html = render(<DomainsSection />);
    expect(html).toContain("...");
    expect(html).not.toContain(td.subdomainHeading);
  });
});

describe("[COMP:app-web/settings-domains] SubdomainRow (claimed)", () => {
  it("shows hostname link, Live chip, rename/reset/release, and the home-page picker", () => {
    const html = render(
      <SubdomainRow workspaceId="ws-1" row={row()} pages={PAGES} onChanged={async () => {}} />,
    );
    expect(html).toContain("grape209.usebrian.page");
    expect(html).toContain("https://grape209.usebrian.page");
    expect(html).toContain(ts.statusLive);
    expect(html).toContain(td.rename);
    expect(html).toContain(td.reset);
    expect(html).toContain(td.release);
    // unbound: home-page picker shows the none placeholder
    expect(html).toContain(td.defaultPageLabel);
    expect(html).toContain(td.defaultPageNone);
  });
});

describe("[COMP:app-web/settings-domains] SubdomainClaim (unclaimed)", () => {
  it("renders the claim input with the apex suffix, reroll, and Claim", () => {
    const html = render(
      <SubdomainClaim workspaceId="ws-1" apex="usebrian.page" onChanged={async () => {}} />,
    );
    // SSR splits the `.` + `{apex}` interpolation with a comment node.
    expect(html).toContain("usebrian.page");
    expect(html).toContain(td.claim);
    expect(html).toContain(td.reroll);
  });
});

describe("[COMP:app-web/settings-domains] CustomDomainRow", () => {
  it("shows a pending BYO row with check + remove, its error, and the picker", () => {
    const html = render(
      <CustomDomainRow
        workspaceId="ws-1"
        row={row({
          provider: "manual",
          subdomainLabel: null,
          hostname: "docs.acme.com",
          status: "pending_dns",
          verificationError: "no CNAME (or matching A record) pointing at edge.example.com",
        })}
        pages={PAGES}
        onChanged={async () => {}}
      />,
    );
    expect(html).toContain("docs.acme.com");
    expect(html).toContain(ts.statusPending);
    expect(html).toContain(ts.recheck);
    expect(html).toContain(ts.removeDomain);
    expect(html).toContain("no CNAME");
    expect(html).toContain(td.defaultPageLabel);
  });

  it("hides the check action once live and shows the bound home page", () => {
    const html = render(
      <CustomDomainRow
        workspaceId="ws-1"
        row={row({
          provider: "vercel",
          subdomainLabel: null,
          hostname: "docs.acme.com",
          pageId: "pg-1",
        })}
        pages={PAGES}
        onChanged={async () => {}}
      />,
    );
    expect(html).toContain(ts.statusLive);
    expect(html).not.toContain(ts.recheck);
    expect(html).toContain("Handbook");
  });
});
