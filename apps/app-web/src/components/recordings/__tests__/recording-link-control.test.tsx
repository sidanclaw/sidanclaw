// @vitest-environment jsdom
/**
 * [COMP:app-web/recording-chrome] — the "Link a recording" control (migration
 * 339), the empty-state affordance on a page with no recording.
 *
 * What matters: it fetches the workspace recordings LAZILY (most doc pages are
 * not recording pages, so an eager fetch on every page open is pure waste), and
 * a pick links via the SDK and hands the updated page metadata back so the doc
 * shell can mount the chrome.
 */

import { describe, expect, it, afterEach, beforeEach, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const listRecordings = vi.fn();
vi.mock("@/lib/api/recordings", () => ({
  listRecordings: (...a: unknown[]) => listRecordings(...a),
}));

const setPageLinkedRecording = vi.fn();
vi.mock("@/lib/api/views", () => ({
  setPageLinkedRecording: (...a: unknown[]) => setPageLinkedRecording(...a),
}));

// The picker's contract is only "renders items, calls onValueChange with the
// picked id" — the real SearchableSelect pulls a heavy popover tree.
vi.mock("@/components/ui/searchable-select", () => ({
  SearchableSelect: ({
    items,
    onValueChange,
  }: {
    items: { value: string; label: string }[];
    onValueChange: (v: string) => void;
  }) => (
    <select data-testid="picker" onChange={(e) => onValueChange(e.target.value)}>
      <option value="">--</option>
      {items.map((it) => (
        <option key={it.value} value={it.value}>
          {it.label}
        </option>
      ))}
    </select>
  ),
}));

vi.mock("@/lib/i18n/client", () => ({
  useT: () => ({
    recordings: {
      linkTitle: "Link a recording",
      linkPlaceholder: "Choose a recording",
      linkLoading: "Loading recordings...",
      linkSearchPlaceholder: "Search recordings",
      linkCancel: "Cancel",
      linkError: "We could not load your recordings.",
      panelUntitled: "Untitled recording",
    },
  }),
}));

import { RecordingLinkControl } from "../recording-link-control";

let root: Root | null = null;
let container: HTMLElement | null = null;
let linked: unknown = null;

async function mount() {
  linked = null;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <RecordingLinkControl
        viewId="pg-1"
        workspaceId="ws-1"
        onLinked={(m) => {
          linked = m;
        }}
      />,
    );
  });
}

function click(label: string) {
  const btn = [...(container?.querySelectorAll("button") ?? [])].find((b) =>
    b.textContent?.includes(label),
  ) as HTMLButtonElement | undefined;
  return btn;
}

beforeEach(() => {
  vi.clearAllMocks();
  listRecordings.mockResolvedValue([
    { recordingId: "rec-1", title: "Client call", status: "processed", durationMs: 51_252 },
  ]);
  setPageLinkedRecording.mockResolvedValue({ id: "pg-1", linkedRecordingId: "rec-1" });
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe("[COMP:app-web/recording-chrome] recording link control", () => {
  it("does not fetch recordings until the control is expanded", async () => {
    await mount();
    // Most doc pages never touch this — an eager fetch on every page open would
    // hit the recordings API for nothing.
    expect(listRecordings).not.toHaveBeenCalled();
    expect(container?.querySelector('[data-testid="picker"]')).toBeFalsy();
  });

  it("fetches the workspace recordings on expand", async () => {
    await mount();
    await act(async () => click("Link a recording")!.click());
    expect(listRecordings).toHaveBeenCalledWith("ws-1", { limit: 100 });
    expect(container?.querySelector('[data-testid="picker"]')).toBeTruthy();
  });

  it("links the picked recording and hands the updated metadata back", async () => {
    await mount();
    await act(async () => click("Link a recording")!.click());
    const picker = container!.querySelector('[data-testid="picker"]') as HTMLSelectElement;
    await act(async () => {
      picker.value = "rec-1";
      picker.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(setPageLinkedRecording).toHaveBeenCalledWith("pg-1", "rec-1");
    // onLinked drives the chrome in — without it the user links and sees nothing.
    expect(linked).toEqual({ id: "pg-1", linkedRecordingId: "rec-1" });
  });
});
