// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";

// Legacy `file_cache` refs resolve through an authenticated signed-URL mint
// (`GET /api/files/:id/preview-url`) — stub `authFetch` so the resolver returns
// a deterministic signed URL without a network call.
const mockAuthFetch = vi.fn();
vi.mock("@/lib/auth-fetch", () => ({
  authFetch: (...args: unknown[]) => mockAuthFetch(...args),
}));

import { BlockImage } from "../block-image";
import { BlockFile } from "../block-file";

/**
 * The `image` / `file` embed cases (`node-views/embed-view.tsx`) mount these
 * components with the active `workspaceId`. Empty (`ref: null`) shows the
 * upload picker; a durable `workspace_files` ref resolves through the
 * signed-read endpoint `GET /api/doc-files/:workspaceId/:id` and renders an
 * `<img>` (image) or a download `<a>` (file). A legacy `file_cache` ref instead
 * resolves through the signed preview-URL mint (WS3 #8). Mounted with raw
 * `createRoot` + `act` (app-web has no `@testing-library/react`).
 *
 * [COMP:app-web/image-embed]
 */
describe("[COMP:app-web/image-embed] Durable image/file embed render", () => {
  let container: HTMLDivElement;
  let root: Root;

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function mount(node: React.ReactNode) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() =>
      root.render(
        <I18nProvider locale="en" dict={en}>
          {node}
        </I18nProvider>,
      ),
    );
  }

  const wsRef = {
    bucket: "workspace_files",
    path: "wf_1",
    mimeType: "image/png",
    sizeBytes: 4,
    name: "shot.png",
  };

  it("renders the picker affordance when the image block has no ref yet", () => {
    mount(
      <BlockImage
        block={{ kind: "image", id: "b1", ref: null }}
        blockId="b1"
        workspaceId="ws_1"
      />,
    );
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain(en.docPage.mediaBlock.uploadImage);
  });

  it("renders an <img> pointing at the signed-read endpoint for a workspace_files ref", () => {
    mount(
      <BlockImage
        block={{ kind: "image", id: "b1", ref: wsRef }}
        blockId="b1"
        workspaceId="ws_1"
      />,
    );
    const img = container.querySelector("img");
    expect(img).not.toBeNull();
    expect(img?.getAttribute("src")).toContain("/api/doc-files/ws_1/wf_1");
  });

  it("renders a download link to the signed-read endpoint for a file block", () => {
    mount(
      <BlockFile
        block={{
          kind: "file",
          id: "f1",
          ref: { ...wsRef, path: "wf_2", mimeType: "application/pdf", name: "spec.pdf" },
        }}
        blockId="f1"
        workspaceId="ws_1"
      />,
    );
    const anchor = container.querySelector("a");
    expect(anchor).not.toBeNull();
    expect(anchor?.getAttribute("href")).toContain("/api/doc-files/ws_1/wf_2");
    expect(anchor?.hasAttribute("download")).toBe(true);
    expect(container.textContent).toContain("spec.pdf");
  });

  it("resolves a legacy file_cache image ref through the signed preview-URL mint", async () => {
    mockAuthFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ url: "/api/files/fc_1/preview?sig=signed-token" }),
    });
    mount(
      <BlockImage
        block={{
          kind: "image",
          id: "b1",
          ref: {
            bucket: "file_cache",
            path: "fc_1",
            mimeType: "image/png",
            sizeBytes: 4,
            name: "legacy.png",
          },
        }}
        blockId="b1"
        workspaceId="ws_1"
      />,
    );
    // Let the async mint round-trip settle, then flush React effects.
    await act(async () => {
      await Promise.resolve();
    });
    // Minted against the correct id + workspace.
    expect(mockAuthFetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/files/fc_1/preview-url?workspaceId=ws_1"),
    );
    const img = container.querySelector("img");
    expect(img?.getAttribute("src")).toContain("/api/files/fc_1/preview?sig=signed-token");
  });
});
