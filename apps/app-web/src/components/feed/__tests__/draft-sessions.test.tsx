/**
 * [COMP:app-web/feed-draft-sessions] Draft sessions (list + detail) —
 * static render contracts + the ported pure helpers.
 *
 * vitest in app-web is node-only — `renderToString` + module mocks (the
 * feed-inbox test shape). Effects never run under SSR, so the list always
 * paints its loading skeleton and the detail its loading-conversation
 * shell; the connect-first / not-connected gates render when the platform
 * has no profile. Everything interactive (streams, SSE, approve/reject)
 * is web-QA. The pure helpers exported from both pages (URL parsing,
 * status derivation, proposeDrafts replay, the SSE frame parser) carry
 * the port's logic contracts and are asserted directly.
 *
 * SSR quirk: adjacent text/expression JSX renders with comment-node
 * separators — assertions stick to substrings that live inside a single
 * expression.
 */

import { describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";

import type { FeedWorkspaceValue } from "@/contexts/feed-profiles-context";

const workspaceRef = vi.hoisted(
  () => ({ current: null }) as { current: unknown },
);
const paramsRef = vi.hoisted(
  () => ({ current: {} }) as { current: Record<string, string> },
);

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  useParams: () => paramsRef.current,
}));
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
import type { FeedProfile } from "@/lib/api/feed";
import {
  DraftSessionsList,
  deriveCardKind,
  deriveStatus,
  displayDraftText,
  parseFilterParam,
  parseReplyUrl,
} from "../draft-sessions-list";
import {
  DraftSessionDetail,
  applyProposeDrafts,
  contentToText,
  explainResolveFailure,
  findParsedPostUrl,
  parsePostUrl,
  parseProposeDraftsInput,
  parseSSEStream,
  parseSeedFromFirstMessage,
  replayDraftHistory,
  stripDraftMarkers,
} from "../draft-session-detail";

const dict = en as unknown as Dictionary;
const td = en.feedPage.draftSessions;

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

function workspace(profiles: FeedProfile[]): FeedWorkspaceValue {
  return {
    workspaceId: "ws-1",
    name: "Acme Team",
    role: "admin",
    canDraft: true,
    me: { id: "u-1" },
    profiles,
    refresh: async () => {},
  };
}

function renderList(profiles: FeedProfile[]): string {
  workspaceRef.current = workspace(profiles);
  paramsRef.current = { workspaceId: "ws-1", platform: "threads" };
  return renderToString(
    <I18nProvider locale="en" dict={dict}>
      <DraftSessionsList />
    </I18nProvider>,
  );
}

function renderDetail(profiles: FeedProfile[]): string {
  workspaceRef.current = workspace(profiles);
  paramsRef.current = {
    workspaceId: "ws-1",
    platform: "threads",
    sessionId: "s-1",
  };
  return renderToString(
    <I18nProvider locale="en" dict={dict}>
      <DraftSessionDetail />
    </I18nProvider>,
  );
}

describe("[COMP:app-web/feed-draft-sessions] Draft sessions", () => {
  // ── List: static render contract ─────────────────────────────

  it("list: renders the header, the composer stack, and the loading skeleton", () => {
    const html = renderList([profile("threads", "acme")]);
    expect(html).toContain("Drafts · Threads");
    expect(html).toContain(td.subtitle);
    // canDraft → the reply-input + new-post pair.
    expect(html).toContain(td.newReply);
    expect(html).toContain(td.newPost);
    // Loading skeleton, not the empty state, no filter strip yet.
    expect(html).toContain("animate-pulse");
    expect(html).not.toContain(td.emptyTitle);
    expect(html).not.toContain('role="tablist"');
  });

  it("list: no profile on the platform paints the connect-first gate linking to the feed home", () => {
    const html = renderList([profile("twitter", "acme")]);
    expect(html).toContain("Connect Threads first");
    expect(html).toContain("/w/ws-1/feed");
    expect(html).not.toContain(td.subtitle);
  });

  // ── Detail: static render contract ───────────────────────────

  it("detail: renders the back label, the default title, and the loading-conversation shell", () => {
    const html = renderDetail([profile("threads", "acme")]);
    expect(html).toContain(en.feedPage.sections.draftSessions);
    expect(html).toContain("Draft · Threads");
    expect(html).toContain(td.loadingConversation);
    expect(html).not.toContain(td.chatEmptyPrefix);
  });

  it("detail: no profile on the platform paints the not-connected gate", () => {
    const html = renderDetail([]);
    expect(html).toContain("Threads not connected");
    expect(html).toContain("Connect Threads");
    expect(html).not.toContain(td.loadingConversation);
  });

  // ── List: pure helpers ───────────────────────────────────────

  it("parseReplyUrl: Threads and X post URLs parse to structured reply candidates", () => {
    expect(
      parseReplyUrl("https://www.threads.com/@jane.doe/post/DX4FjS5Gl5x"),
    ).toEqual({
      platform: "threads",
      handle: "jane.doe",
      externalId: "DX4FjS5Gl5x",
      permalink: "https://www.threads.com/@jane.doe/post/DX4FjS5Gl5x",
    });
    // threads.net + x.com/twitter.com all normalize.
    expect(
      parseReplyUrl("https://threads.net/@bob/post/Cxyz")?.permalink,
    ).toBe("https://www.threads.com/@bob/post/Cxyz");
    expect(parseReplyUrl("https://twitter.com/bob/status/123456")).toEqual({
      platform: "twitter",
      handle: "bob",
      externalId: "123456",
      permalink: "https://x.com/bob/status/123456",
    });
    // Junk: wrong host, missing @, non-numeric status id, non-URL.
    expect(parseReplyUrl("https://example.com/@a/post/B")).toBeNull();
    expect(parseReplyUrl("https://threads.com/jane/post/DX4")).toBeNull();
    expect(parseReplyUrl("https://x.com/bob/status/notanid")).toBeNull();
    expect(parseReplyUrl("not a url")).toBeNull();
  });

  it("deriveStatus: the strongest act-on-me signal wins", () => {
    const counts = (
      pending: number,
      posted: number,
      rejected: number,
      deleted: number,
      draftText: string | null = null,
    ) => ({ draftCounts: { pending, posted, rejected, deleted }, draftText });
    expect(deriveStatus(counts(1, 2, 3, 4))).toBe("ready");
    expect(deriveStatus(counts(0, 1, 1, 1))).toBe("posted");
    expect(deriveStatus(counts(0, 0, 1, 1))).toBe("deleted");
    expect(deriveStatus(counts(0, 0, 1, 0))).toBe("resolved");
    expect(deriveStatus(counts(0, 0, 0, 0, "draft"))).toBe("drafting");
    expect(deriveStatus(counts(0, 0, 0, 0))).toBe("in-progress");
  });

  it("parseFilterParam: known ids pass through, junk falls back to all", () => {
    expect(parseFilterParam("posted")).toBe("posted");
    expect(parseFilterParam("in-progress")).toBe("in-progress");
    expect(parseFilterParam("bogus")).toBe("all");
    expect(parseFilterParam(null)).toBe("all");
  });

  it("displayDraftText + deriveCardKind: saved draft wins over the chat candidate; reply target wins over both", () => {
    expect(
      displayDraftText({
        selectedDraft: { text: "saved", status: "posted" },
        draftText: "chat",
      }),
    ).toBe("saved");
    expect(displayDraftText({ selectedDraft: null, draftText: "chat" })).toBe(
      "chat",
    );
    expect(
      deriveCardKind({
        replyTarget: { authorHandle: "a", text: "t", permalink: null },
        selectedDraft: null,
        draftText: "x",
      }),
    ).toBe("reply");
    expect(
      deriveCardKind({ replyTarget: null, selectedDraft: null, draftText: "x" }),
    ).toBe("original");
    expect(
      deriveCardKind({ replyTarget: null, selectedDraft: null, draftText: null }),
    ).toBe("pending");
  });

  // ── Detail: pure helpers ─────────────────────────────────────

  it("parseSSEStream: splits frames on blank lines and buffers partial frames across chunks", () => {
    const buffer = { text: "" };
    const first = [
      ...parseSSEStream(
        'event: message_delta\ndata: {"a":1}\n\ndata: plain\n\ndata: {"b":2',
        buffer,
      ),
    ];
    expect(first).toEqual([
      { event: "message_delta", data: '{"a":1}' },
      { event: "message", data: "plain" },
    ]);
    // The partial frame stays buffered until its terminator arrives.
    const second = [...parseSSEStream("}\n\n", buffer)];
    expect(second).toEqual([{ event: "message", data: '{"b":2}' }]);
    expect(buffer.text).toBe("");
  });

  it("parseProposeDraftsInput: validates shape, filters malformed items, requires 1-based indices", () => {
    expect(parseProposeDraftsInput(null)).toBeNull();
    expect(parseProposeDraftsInput({ drafts: [] })).toBeNull();
    expect(
      parseProposeDraftsInput({
        rationale: "why",
        drafts: [
          { index: 1, text: "A", label: "Bold" },
          { index: 0, text: "skipped" },
          { index: 2 },
          "junk",
        ],
      }),
    ).toEqual({
      rationale: "why",
      drafts: [{ index: 1, text: "A", label: "Bold" }],
    });
  });

  it("applyProposeDrafts + replayDraftHistory: upsert semantics over the persisted tool_use blocks", () => {
    const base = applyProposeDrafts(new Map(), {
      rationale: "",
      drafts: [{ index: 1, text: "A" }],
    });
    const next = applyProposeDrafts(base, {
      rationale: "",
      drafts: [{ index: 1, text: "A2" }, { index: 2, text: "B" }],
    });
    expect(next.get(1)?.text).toBe("A2");
    expect(next.get(2)?.text).toBe("B");
    // Immutable update — the earlier map is untouched.
    expect(base.get(1)?.text).toBe("A");

    const { draftMap, rationale } = replayDraftHistory([
      { id: "m1", role: "user", content: "hi", timestamp: "t" },
      {
        id: "m2",
        role: "assistant",
        content: [
          {
            type: "tool_use",
            name: "proposeDrafts",
            input: { rationale: "first", drafts: [{ index: 1, text: "A" }] },
          },
        ],
        timestamp: "t",
      },
      {
        id: "m3",
        role: "assistant",
        content: [
          {
            type: "tool_use",
            name: "proposeDrafts",
            input: { rationale: "second", drafts: [{ index: 1, text: "A2" }] },
          },
        ],
        timestamp: "t",
      },
    ]);
    expect(draftMap.get(1)?.text).toBe("A2");
    expect(rationale).toBe("second");
  });

  it("contentToText: strings pass through, text blocks join, images placeholder, junk empties", () => {
    expect(contentToText("plain")).toBe("plain");
    expect(
      contentToText([
        { type: "text", text: "one" },
        { type: "image" },
        { type: "tool_use", name: "x" },
        { type: "text", text: "two" },
      ]),
    ).toBe("one\n[image]\ntwo");
    expect(contentToText({ nope: true })).toBe("");
  });

  it("parseSeedFromFirstMessage: recovers the quoted candidate from both seed phrasings", () => {
    expect(
      parseSeedFromFirstMessage(
        "I want to draft a reply to this Threads post by @jane.doe:\n\n> Rent is too high\n\nPlease draft a reply.",
      ),
    ).toEqual({
      authorHandle: "jane.doe",
      text: "Rent is too high",
      source: "inspiration",
    });
    expect(
      parseSeedFromFirstMessage(
        "Here's a X post that caught my eye, by @bob:\n\n> Ship early\n\nUse it as inspiration.",
      ),
    ).toEqual({ authorHandle: "bob", text: "Ship early", source: "inspiration" });
    expect(parseSeedFromFirstMessage("Just a normal message")).toBeNull();
  });

  it("parsePostUrl + findParsedPostUrl: scans chat text and strips trailing punctuation", () => {
    expect(parsePostUrl("https://www.threads.com/@a/post/ABC")).toEqual({
      platform: "threads",
      handle: "a",
      shortcode: "ABC",
      permalink: "https://www.threads.com/@a/post/ABC",
    });
    expect(parsePostUrl("https://x.com/bob/status/42")).toEqual({
      platform: "twitter",
      handle: "bob",
      statusId: "42",
      permalink: "https://x.com/bob/status/42",
    });
    expect(
      findParsedPostUrl(
        "Draft on this: https://www.threads.com/@a/post/ABC!, thanks",
      )?.permalink,
    ).toBe("https://www.threads.com/@a/post/ABC");
    expect(findParsedPostUrl("no links here")).toBeNull();
  });

  it("explainResolveFailure: maps the backend reason to operator copy", () => {
    expect(explainResolveFailure(td, "invalid_shortcode")).toBe(
      td.resolveInvalidShortcode,
    );
    expect(explainResolveFailure(td, "anything_else")).toBe(td.resolveDefault);
  });

  it("stripDraftMarkers: unwraps <draft> tags and collapses runs of blank lines", () => {
    expect(stripDraftMarkers("<draft>\n hello \n</draft>")).toBe("hello");
    expect(stripDraftMarkers("a\n\n\n\nb")).toBe("a\n\nb");
    expect(stripDraftMarkers("  plain  ")).toBe("plain");
  });
});
