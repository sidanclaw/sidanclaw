/**
 * [COMP:recordings/player] — the page → recording link.
 *
 * A brief's `anchor_key` is the ONLY thing tying it back to the recording it
 * was synthesized from. Get this wrong and either the citations never light up,
 * or a hand-authored page tries to mount a player for a recording that does not
 * exist.
 */

import { describe, expect, it } from "vitest";
import { recordingIdFromAnchorKey } from "../anchor";

describe("[COMP:recordings/player] recordingIdFromAnchorKey", () => {
  it("extracts the recording from a synthesis brief's anchor", () => {
    expect(recordingIdFromAnchorKey("recording-synthesis:92e52d5a-ef0c-46d7-875e-fce8dc83ec6f")).toBe(
      "92e52d5a-ef0c-46d7-875e-fce8dc83ec6f",
    );
  });

  it("is null for a hand-authored page (no anchor at all)", () => {
    expect(recordingIdFromAnchorKey(null)).toBeNull();
    expect(recordingIdFromAnchorKey(undefined)).toBeNull();
    expect(recordingIdFromAnchorKey("")).toBeNull();
  });

  it("is null for another machine-authored anchor — only recordings mount a player", () => {
    expect(recordingIdFromAnchorKey("research-synthesis:abc")).toBeNull();
    expect(recordingIdFromAnchorKey("workflow:run-1")).toBeNull();
  });

  it("is null for a malformed anchor rather than yielding an empty id", () => {
    // `recording-synthesis:` with nothing after it would otherwise mount a
    // player for the recording `""` and 404 every media request.
    expect(recordingIdFromAnchorKey("recording-synthesis:")).toBeNull();
    expect(recordingIdFromAnchorKey("recording-synthesis:   ")).toBeNull();
  });

  it("does not match a prefix that merely starts similarly", () => {
    expect(recordingIdFromAnchorKey("recording-synthesis-v2:abc")).toBeNull();
  });
});
