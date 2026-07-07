/**
 * Unit tests for the approvals-queue line differ.
 * Component tag: [COMP:app-web/approvals] (folded into the approvals row —
 * the differ exists for the staged_skill_update card's current-vs-proposed
 * view).
 */

import { describe, it, expect } from "vitest";
import {
  collapseContext,
  diffLines,
  diffStats,
  type DiffLine,
} from "../line-diff";

const join = (lines: readonly DiffLine[]) =>
  lines.map((l) => `${l.type === "add" ? "+" : l.type === "del" ? "-" : " "}${l.text}`);

describe("[COMP:app-web/approvals] diffLines", () => {
  it("marks identical documents as all-same", () => {
    const lines = diffLines("a\nb\nc", "a\nb\nc");
    expect(lines.every((l) => l.type === "same")).toBe(true);
    expect(lines).toHaveLength(3);
  });

  it("diffs a middle-line edit as del + add with surrounding same", () => {
    const lines = diffLines("# Title\nold step\ntail", "# Title\nnew step\ntail");
    expect(join(lines)).toEqual([" # Title", "-old step", "+new step", " tail"]);
  });

  it("handles pure additions and pure removals", () => {
    expect(diffStats(diffLines("a\nb", "a\nb\nc\nd"))).toEqual({
      added: 2,
      removed: 0,
    });
    expect(diffStats(diffLines("a\nb\nc\nd", "a\nd"))).toEqual({
      added: 0,
      removed: 2,
    });
  });

  it("detects a fragment replacing the whole body (the clobber case)", () => {
    const current = "# Skill\n\n## When to use\nwhen\n\n## Steps\n1. one\n2. two";
    const fragment = "## Steps\n1. one\n2. two";
    const stats = diffStats(diffLines(current, fragment));
    // The title + when-to-use block reads as removed — visible in the diff.
    expect(stats.removed).toBeGreaterThanOrEqual(4);
    expect(stats.added).toBe(0);
  });

  it("stays in document order (same-prefix, changes, same-suffix)", () => {
    const lines = diffLines("p1\np2\nmid\ns1\ns2", "p1\np2\nMID\ns1\ns2");
    expect(lines[0]).toEqual({ type: "same", text: "p1" });
    expect(lines.at(-1)).toEqual({ type: "same", text: "s2" });
    expect(lines.filter((l) => l.type !== "same")).toEqual([
      { type: "del", text: "mid" },
      { type: "add", text: "MID" },
    ]);
  });
});

describe("[COMP:app-web/approvals] collapseContext", () => {
  it("collapses long unchanged runs into gap rows, keeping context", () => {
    const doc = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
    const edited = doc.replace("line 10", "LINE 10");
    const rows = collapseContext(diffLines(doc, edited), 2);

    const gaps = rows.filter((r) => r.type === "gap");
    expect(gaps).toHaveLength(2); // before and after the single change
    // Head gap: lines 0..7 collapsed (context keeps lines 8-9 above the change).
    expect(gaps[0]).toEqual({ type: "gap", count: 8 });
    // The change itself survives with its context.
    const texts = rows.filter((r): r is DiffLine => r.type !== "gap").map((r) => r.text);
    expect(texts).toContain("line 9");
    expect(texts).toContain("LINE 10");
    expect(texts).toContain("line 11");
  });

  it("keeps short unchanged runs inline (no one-line gaps)", () => {
    const rows = collapseContext(
      diffLines("a\nb\nc", "A\nb\nC"), // 1 unchanged line between 2 changes
      2,
    );
    expect(rows.some((r) => r.type === "gap")).toBe(false);
  });
});
