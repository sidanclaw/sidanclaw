/**
 * [COMP:app-web/feed-tool-timeline] Draft-refine tool timeline — render
 * contract + pure describers.
 *
 * vitest in app-web is node-only — `renderToString` + the I18nProvider.
 * The component is stateless-per-render under SSR (the rise-in animation
 * effect never runs), so the assertions cover: label resolution through
 * `feedPage.toolTimeline`, the streaming window (last completed + running
 * visible, older steps behind the "more" toggle, the between-tools
 * "Working…" row), and the collapsed `done` summary. The pure describers
 * (`defaultToolDescription`, `describeFeedTool`) are asserted directly —
 * they run outside React in the detail page's SSE handler.
 */

import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import type { Dictionary } from "@/lib/i18n/dictionaries";
import {
  ToolTimeline,
  defaultToolDescription,
  describeFeedTool,
  type ToolEntry,
} from "../tool-timeline";

const dict = en as unknown as Dictionary;
const tt = en.feedPage.toolTimeline;

function render(tools: ToolEntry[], done?: boolean): string {
  return renderToString(
    <I18nProvider locale="en" dict={dict}>
      <ToolTimeline tools={tools} done={done} />
    </I18nProvider>,
  );
}

function entry(
  id: string,
  name: string,
  status: ToolEntry["status"],
  description?: string,
): ToolEntry {
  return { id, name, status, description };
}

describe("[COMP:app-web/feed-tool-timeline] ToolTimeline", () => {
  it("renders nothing for an empty timeline", () => {
    expect(render([])).toBe("");
  });

  it("streaming: shows the last completed + the running step, hides older ones behind the more-toggle", () => {
    const html = render([
      entry("t1", "searchMemory", "done"),
      entry("t2", "webSearch", "done"),
      entry("t3", "proposeDrafts", "running"),
    ]);
    // Visible window: t2 then t3, in that order.
    const searchIdx = html.indexOf(tt.toolWebSearch);
    const draftIdx = html.indexOf(tt.toolProposeDrafts);
    expect(searchIdx).toBeGreaterThan(-1);
    expect(draftIdx).toBeGreaterThan(searchIdx);
    // One older completed step collapses into the singular more-label.
    expect(html).toContain(tt.moreStepsOne);
    // A tool is running, so the between-tools Working row is absent.
    expect(html).not.toContain(tt.working);
  });

  it("streaming with no running tool: paints the Working indicator", () => {
    const html = render([entry("t1", "searchMemory", "done")]);
    expect(html).toContain(tt.toolSearchMemory);
    expect(html).toContain(tt.working);
  });

  it("done: collapses every step behind the Show-steps toggle (plural + explicit description win)", () => {
    const html = render(
      [
        entry("t1", "searchMemory", "done"),
        entry("t2", "webSearch", "done", "Searching “rent”"),
      ],
      true,
    );
    expect(html).toContain("Show 2 steps");
    // Rows still render (inside the collapsed container), explicit
    // description wins over the name-derived label.
    expect(html).toContain(tt.toolSearchMemory);
    expect(html).toContain("Searching “rent”");
    expect(html).not.toContain(tt.toolWebSearch);
  });

  it("defaultToolDescription: known names, mcp_<server>_<tool> pattern, and the generic fallback", () => {
    expect(defaultToolDescription(tt, "threadsCreatePost")).toBe(
      tt.toolThreadsCreatePost,
    );
    expect(defaultToolDescription(tt, "mcp_notion_createPage")).toBe(
      "Calling createPage via notion",
    );
    expect(defaultToolDescription(tt, "somethingNew")).toBe(
      "Using somethingNew",
    );
  });

  it("describeFeedTool: proposeDrafts pluralizes on the draft count", () => {
    expect(
      describeFeedTool(tt, "proposeDrafts", { drafts: [{}] })?.description,
    ).toBe(tt.draftingOne);
    expect(
      describeFeedTool(tt, "proposeDrafts", { drafts: [{}, {}, {}] })
        ?.description,
    ).toBe("Drafting 3 options…");
    expect(describeFeedTool(tt, "proposeDrafts", {})?.description).toBe(
      tt.drafting,
    );
  });

  it("describeFeedTool: webSearch, urlReader (host + url), useSkill title-case, saveMemory, trackCommitment truncation", () => {
    expect(
      describeFeedTool(tt, "webSearch", { query: "hong kong rent" })
        ?.description,
    ).toBe("Searching “hong kong rent”");

    const read = describeFeedTool(tt, "urlReader", {
      url: "https://www.example.com/post/1",
    });
    expect(read).toEqual({
      description: "Reading example.com",
      url: "https://www.example.com/post/1",
    });
    // Unparseable URL falls back to the generic link label but keeps the url.
    expect(describeFeedTool(tt, "urlReader", { url: "not a url" })).toEqual({
      description: tt.toolUrlReader,
      url: "not a url",
    });

    expect(
      describeFeedTool(tt, "useSkill", { skill: "market-analysis" })
        ?.description,
    ).toBe("Using Market Analysis");

    expect(
      describeFeedTool(tt, "saveMemory", { title: "Voice rule" })?.description,
    ).toBe("Saving “Voice rule”");

    const long = "a".repeat(70);
    expect(
      describeFeedTool(tt, "trackCommitment", { summary: long })?.description,
    ).toBe(`Tracking: ${"a".repeat(57)}…`);
    // Unhandled tools defer to defaultToolDescription (undefined here).
    expect(describeFeedTool(tt, "searchMemory", {})).toBeUndefined();
  });
});
