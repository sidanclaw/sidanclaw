/**
 * Filter-dim kind mapping for the Brain graph canvas
 * (docs/architecture/brain/graph-view.md → "Filter dim").
 *
 * `primitivesToGraphKinds` translates the sidebar's primitive filter chips
 * into the graph-node kind selection `BrainGraphView.filterKinds` keeps at
 * full opacity. The canvas-side ghosting itself is per-frame paint (gstack
 * QA); the mapping — including the "no chips → null" and "unmappable
 * primitives contribute nothing" contracts the no-anchor guard depends on —
 * is pure and tested here.
 */

import { describe, expect, it } from "vitest";
import {
  BRAIN_PRIMITIVES,
  PRIMITIVE_GRAPH_KINDS,
  primitivesToGraphKinds,
} from "../api/brain";

describe("[COMP:app-web/brain-graph] primitivesToGraphKinds", () => {
  it("returns null when no filter chips are active (no dim)", () => {
    expect(primitivesToGraphKinds([])).toBeNull();
  });

  it("maps each entity/knowledge/memory chip to its graph-node kind", () => {
    expect(primitivesToGraphKinds(["people"])).toEqual(new Set(["person"]));
    expect(primitivesToGraphKinds(["companies"])).toEqual(
      new Set(["company"]),
    );
    expect(primitivesToGraphKinds(["deals"])).toEqual(new Set(["deal"]));
    expect(primitivesToGraphKinds(["knowledge"])).toEqual(
      new Set(["knowledge"]),
    );
    expect(primitivesToGraphKinds(["memories"])).toEqual(new Set(["memory"]));
  });

  it("unions multi-chip selections (the screenshot case: People + Companies)", () => {
    expect(primitivesToGraphKinds(["people", "companies"])).toEqual(
      new Set(["person", "company"]),
    );
  });

  it("returns an empty set for primitives with no graph nodes — the view's no-anchor guard then skips dimming", () => {
    expect(primitivesToGraphKinds(["tasks"])).toEqual(new Set());
    expect(primitivesToGraphKinds(["files", "sessions"])).toEqual(new Set());
  });

  it("drops unmappable primitives from a mixed selection instead of poisoning it", () => {
    expect(primitivesToGraphKinds(["people", "tasks"])).toEqual(
      new Set(["person"]),
    );
  });

  it("covers every BrainPrimitive: each chip either maps to a kind or is a documented no-graph primitive", () => {
    const noGraphPrimitives = ["tasks", "files", "sessions"];
    for (const p of BRAIN_PRIMITIVES) {
      if (noGraphPrimitives.includes(p)) {
        expect(PRIMITIVE_GRAPH_KINDS[p]).toBeUndefined();
      } else {
        expect(PRIMITIVE_GRAPH_KINDS[p]).toBeDefined();
      }
    }
  });
});
