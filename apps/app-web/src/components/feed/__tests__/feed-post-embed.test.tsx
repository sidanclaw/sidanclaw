/**
 * [COMP:app-web/feed-post-embed] Post-preview tiles + external post card —
 * static render contract.
 *
 * vitest in app-web is node-only — `renderToString` + module mocks. Effects
 * never run under SSR, so `ExternalPostCard` stays in its loading state
 * (seed-data shell when fallbacks exist, bare skeleton otherwise) and
 * `NativeEmbed` never touches the platform scripts — what's asserted is the
 * CSS-tile markup contract shared by the inbox and (later phases) the
 * draft-sessions surfaces. The iframe embed lifecycle is web-QA.
 *
 * SSR quirk: adjacent JSX text/expressions render with comment-node
 * separators (`@<!-- -->handle`), so assertions match substrings that don't
 * span those boundaries.
 */

import { describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";

vi.mock("@/lib/auth-fetch", () => ({
  authFetch: vi.fn(),
  getAccessToken: () => null,
}));

import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import type { Dictionary } from "@/lib/i18n/dictionaries";
import {
  EmbedSkeleton,
  LazyMount,
  NativeEmbed,
  PostDraftPreview,
  QuotedPostPreview,
  ReplyConnector,
} from "../native-post-embed";
import { ExternalPostCard } from "../external-post-card";

const dict = en as unknown as Dictionary;

function render(node: React.ReactElement): string {
  return renderToString(
    <I18nProvider locale="en" dict={dict}>
      {node}
    </I18nProvider>,
  );
}

describe("[COMP:app-web/feed-post-embed] post preview tiles", () => {
  it("PostDraftPreview (full): renders the author handle, DRAFT badge, and body", () => {
    const html = render(
      <PostDraftPreview
        platform="threads"
        authorHandle="acme"
        text="Our launch is live!"
      />,
    );
    expect(html).toContain("acme");
    expect(html).toContain(en.feedPage.postEmbed.draftBadge);
    expect(html).toContain("Our launch is live!");
  });

  it("PostDraftPreview (compact): a single avatar+text row, no badge chrome", () => {
    const html = render(
      <PostDraftPreview
        platform="twitter"
        authorHandle="acmex"
        text="reply body"
        compact
      />,
    );
    expect(html).toContain("reply body");
    expect(html).not.toContain(en.feedPage.postEmbed.draftBadge);
  });

  it("QuotedPostPreview: parent author + quoted text + the view-on source link", () => {
    const html = render(
      <QuotedPostPreview
        platform="threads"
        authorHandle="someone"
        text="the parent post"
        permalink="https://www.threads.com/@someone/post/abc"
      />,
    );
    expect(html).toContain("someone");
    expect(html).toContain(en.feedPage.postEmbed.replyingTo);
    expect(html).toContain("the parent post");
    expect(html).toContain("https://www.threads.com/@someone/post/abc");
  });

  it("QuotedPostPreview: no text falls back to the pretty permalink teaser, no body to the unavailable note", () => {
    const withPermalink = render(
      <QuotedPostPreview
        platform="twitter"
        authorHandle="someone"
        text=""
        permalink="https://www.x.com/someone/status/123"
      />,
    );
    expect(withPermalink).toContain("x.com/someone/status/123");

    const bare = render(
      <QuotedPostPreview platform="twitter" authorHandle="someone" text="" />,
    );
    expect(bare).toContain(en.feedPage.postEmbed.postBodyUnavailable);
  });

  it("ReplyConnector: carries the reply-draft label", () => {
    expect(render(<ReplyConnector />)).toContain(
      en.feedPage.postEmbed.replyDraft,
    );
  });

  it("NativeEmbed: SSR paints the skeleton shell and the reload affordance", () => {
    const html = render(
      <NativeEmbed
        platform="threads"
        permalink="https://www.threads.com/@a/post/b"
      />,
    );
    expect(html).toContain(en.feedPage.postEmbed.reloadPost);
    expect(html).toContain("skeleton");
  });

  it("LazyMount: renders the placeholder until the viewport gate opens", () => {
    const html = render(
      <LazyMount placeholder={<EmbedSkeleton />}>
        <div>never-on-ssr</div>
      </LazyMount>,
    );
    expect(html).toContain("skeleton");
    expect(html).not.toContain("never-on-ssr");
  });
});

describe("[COMP:app-web/feed-post-embed] ExternalPostCard", () => {
  it("loading with seed data: pre-paints the card shell with the fallback author + text", () => {
    const html = render(
      <ExternalPostCard
        assistantId="a-1"
        platform="threads"
        permalink="https://www.threads.com/@someone/post/abc"
        fallbackAuthorHandle="someone"
        fallbackText="seeded parent body"
      />,
    );
    expect(html).toContain("someone");
    expect(html).toContain("seeded parent body");
    // Loading shell: no engagement counters, no error footer.
    expect(html).not.toContain(en.feedPage.postEmbed.postBodyUnavailable);
  });

  it("loading without seed data: renders the bare embed skeleton", () => {
    const html = render(
      <ExternalPostCard
        assistantId="a-1"
        platform="twitter"
        permalink="https://www.x.com/someone/status/123"
      />,
    );
    expect(html).toContain("skeleton");
  });
});
