import { describe, it, expect } from "vitest";
import { listPageTemplates } from "@sidanclaw/doc-model";

import { filterTemplates } from "../template-gallery";

// app-web vitest is node-only, so this covers the pure filter the gallery uses
// for keyboard / search; the DOM glue (Dialog, highlight) is not covered here.
describe("[COMP:app-web/template-gallery] filterTemplates", () => {
  const all = listPageTemplates();

  it("returns the whole catalog for an empty query", () => {
    expect(filterTemplates("", all)).toHaveLength(all.length);
    expect(filterTemplates("   ", all)).toHaveLength(all.length);
  });

  it("matches on the template name (case-insensitive)", () => {
    const matches = filterTemplates("MEETING", all);
    expect(matches.some((t) => t.id === "meeting-notes")).toBe(true);
  });

  it("matches on a keyword that is not in the visible name", () => {
    // "scrum" is a keyword of the daily standup template, not its name.
    const matches = filterTemplates("scrum", all);
    expect(matches.some((t) => t.id === "standup")).toBe(true);
  });

  it("matches on the description text", () => {
    const matches = filterTemplates("quarter", all);
    expect(matches.some((t) => t.id === "okrs")).toBe(true);
  });

  it("returns an empty array when nothing matches", () => {
    expect(filterTemplates("zzz-no-such-template", all)).toEqual([]);
  });
});
