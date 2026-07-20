/**
 * [COMP:app-web/file-attachments] Chat-attachment upload state.
 *
 * app-web vitest has no jsdom, so we test the hook's pure reconciliation
 * helpers directly (the same no-DOM stance breadcrumb/floating-toolbar tests
 * use). These functions hold the only non-trivial logic: matching an upload
 * response back to the staged chips by order, flagging whole-request failures,
 * and projecting the ready file ids that ride the /api/chat turn.
 */

import { describe, expect, it } from "vitest";
import {
  applyUploadResult,
  imageFilesFromClipboard,
  markStagedError,
  partitionUpload,
  previewUrlsToRevokeOnDetach,
  readyAttachments,
  readyFileIds,
  RECORDING_AUDIO_MIN_BYTES,
  type Attachment,
} from "../use-file-attachments";

function staged(localId: string, fileName = `${localId}.txt`): Attachment {
  return {
    localId,
    fileName,
    mimeType: "text/plain",
    sizeBytes: 10,
    status: "uploading",
  };
}

describe("[COMP:app-web/file-attachments] upload reconciliation", () => {
  it("flips staged chips to done with their server fileId, in order", () => {
    const prev = [staged("a"), staged("b")];
    const next = applyUploadResult(prev, new Set(["a", "b"]), [
      { id: "file_a" },
      { id: "file_b" },
    ]);
    expect(next.map((a) => [a.localId, a.status, a.fileId])).toEqual([
      ["a", "done", "file_a"],
      ["b", "done", "file_b"],
    ]);
  });

  it("marks a per-file error result without a fileId", () => {
    const next = applyUploadResult([staged("a")], new Set(["a"]), [
      { error: "too big" },
    ]);
    expect(next[0].status).toBe("error");
    expect(next[0].error).toBe("too big");
    expect(next[0].fileId).toBeUndefined();
  });

  it("only touches chips from its own staged batch", () => {
    // A concurrent upload left "old" still uploading; this batch is just "b".
    const prev = [staged("old"), staged("b")];
    const next = applyUploadResult(prev, new Set(["b"]), [{ id: "file_b" }]);
    expect(next[0]).toEqual(prev[0]); // untouched
    expect(next[1].status).toBe("done");
    expect(next[1].fileId).toBe("file_b");
  });

  it("leaves a chip untouched when the response is short a row", () => {
    const next = applyUploadResult([staged("a"), staged("b")], new Set(["a", "b"]), [
      { id: "file_a" },
    ]);
    expect(next[0].status).toBe("done");
    expect(next[1].status).toBe("uploading"); // no matching response row
  });

  it("markStagedError fails the whole batch, sparing other chips", () => {
    const prev = [staged("a"), staged("b")];
    const next = markStagedError(prev, new Set(["a"]), "network down");
    expect(next[0]).toMatchObject({ status: "error", error: "network down" });
    expect(next[1].status).toBe("uploading");
  });

  it("readyFileIds returns only done ids, in chip order", () => {
    const list: Attachment[] = [
      { ...staged("a"), status: "done", fileId: "file_a" },
      { ...staged("b"), status: "uploading" },
      { ...staged("c"), status: "error", error: "x" },
      { ...staged("d"), status: "done", fileId: "file_d" },
    ];
    expect(readyFileIds(list)).toEqual(["file_a", "file_d"]);
  });

  it("readyAttachments keeps only done+fileId chips (the ones handed to the message)", () => {
    const list: Attachment[] = [
      { ...staged("a"), status: "done", fileId: "file_a" },
      { ...staged("b"), status: "done" }, // done but no fileId — not ready
      { ...staged("c"), status: "uploading" },
    ];
    expect(readyAttachments(list).map((a) => a.localId)).toEqual(["a"]);
  });
});

describe("[COMP:app-web/file-attachments] detach preview-URL retention", () => {
  function withPreview(a: Attachment, url: string): Attachment {
    return { ...a, previewUrl: url };
  }

  it("revokes ONLY the dropped chips' URLs, keeping the handed-off (ready) ones alive", () => {
    // The just-sent message adopts the ready image's object URL for its
    // thumbnail — detach must NOT revoke it, or the thumbnail breaks on
    // re-render. The dropped uploading/errored chips' URLs are freed.
    const list: Attachment[] = [
      withPreview({ ...staged("ready"), status: "done", fileId: "f1" }, "blob:ready"),
      withPreview({ ...staged("err"), status: "error", error: "x" }, "blob:err"),
      withPreview({ ...staged("up"), status: "uploading" }, "blob:up"),
    ];
    expect(previewUrlsToRevokeOnDetach(list)).toEqual(["blob:err", "blob:up"]);
  });

  it("ignores chips with no previewUrl (non-image files)", () => {
    const list: Attachment[] = [
      { ...staged("pdf"), status: "done", fileId: "f1" }, // no previewUrl
      withPreview({ ...staged("txt"), status: "error", error: "x" }, "blob:txt"),
    ];
    expect(previewUrlsToRevokeOnDetach(list)).toEqual(["blob:txt"]);
  });
});

function fakeFile(type: string, name = "file"): File {
  return { type, name } as unknown as File;
}

function clipboard(opts: { text?: string; files?: File[] }): {
  files: File[];
  getData: (t: string) => string;
} {
  return {
    files: opts.files ?? [],
    getData: (t: string) => (t === "text/plain" ? opts.text ?? "" : ""),
  };
}

describe("[COMP:app-web/file-attachments] paste image extraction", () => {
  const png = fakeFile("image/png", "shot.png");

  it("attaches a bare pasted image (a screenshot has no text/plain)", () => {
    expect(imageFilesFromClipboard(clipboard({ files: [png] }))).toEqual([png]);
  });

  it("returns every pasted image when several ride the clipboard", () => {
    const jpg = fakeFile("image/jpeg", "b.jpg");
    expect(imageFilesFromClipboard(clipboard({ files: [png, jpg] }))).toEqual([png, jpg]);
  });

  it("skips images when the paste carries real text (rich text from Word/Excel)", () => {
    // The tagalong rendered image must NOT hijack a text paste.
    expect(imageFilesFromClipboard(clipboard({ text: "hello", files: [png] }))).toEqual([]);
  });

  it("treats a whitespace-only text payload as no text (still attaches)", () => {
    expect(imageFilesFromClipboard(clipboard({ text: "   \n", files: [png] }))).toEqual([png]);
  });

  it("ignores non-image files (chat paste is for pictures)", () => {
    const pdf = fakeFile("application/pdf", "doc.pdf");
    expect(imageFilesFromClipboard(clipboard({ files: [pdf] }))).toEqual([]);
  });

  it("keeps only the image out of a mixed image + non-image clipboard", () => {
    const pdf = fakeFile("application/pdf", "doc.pdf");
    expect(imageFilesFromClipboard(clipboard({ files: [pdf, png] }))).toEqual([png]);
  });

  it("returns [] for a plain-text paste with no files", () => {
    expect(imageFilesFromClipboard(clipboard({ text: "just text" }))).toEqual([]);
  });

  it("returns [] when there is no clipboard data", () => {
    expect(imageFilesFromClipboard(null)).toEqual([]);
    expect(imageFilesFromClipboard(undefined)).toEqual([]);
  });
});

function sizedFile(type: string, size: number, name = "file"): File {
  return { type, name, size } as unknown as File;
}

describe("[COMP:app-web/file-attachments] upload partition guard", () => {
  const MAX = 20 * 1024 * 1024;

  it("routes video to media when the host can route", () => {
    const mp4 = sizedFile("video/mp4", 93 * 1024 * 1024, "call.mp4");
    const r = partitionUpload([mp4], { maxBytes: MAX, canRouteMedia: true });
    expect(r.media).toEqual([mp4]);
    expect(r.attach).toEqual([]);
    expect(r.rejected).toEqual([]);
  });

  it("rejects video as unsupported when the host cannot route", () => {
    const mp4 = sizedFile("video/mp4", 5 * 1024 * 1024, "clip.mp4");
    const r = partitionUpload([mp4], { maxBytes: MAX, canRouteMedia: false });
    expect(r.media).toEqual([]);
    expect(r.attach).toEqual([]);
    expect(r.rejected).toEqual([{ file: mp4, reason: "video_unsupported" }]);
  });

  it("rejects an oversized non-video as too_large", () => {
    const pdf = sizedFile("application/pdf", MAX + 1, "big.pdf");
    const r = partitionUpload([pdf], { maxBytes: MAX, canRouteMedia: true });
    expect(r.rejected).toEqual([{ file: pdf, reason: "too_large" }]);
    expect(r.attach).toEqual([]);
  });

  it("keeps a normal file on the attach path", () => {
    const png = sizedFile("image/png", 1024, "shot.png");
    const r = partitionUpload([png], { maxBytes: MAX, canRouteMedia: false });
    expect(r.attach).toEqual([png]);
    expect(r.media).toEqual([]);
    expect(r.rejected).toEqual([]);
  });

  it("allows a file exactly at the limit, rejects one byte over", () => {
    const at = sizedFile("application/pdf", MAX, "at.pdf");
    const over = sizedFile("application/pdf", MAX + 1, "over.pdf");
    const r = partitionUpload([at, over], { maxBytes: MAX, canRouteMedia: true });
    expect(r.attach).toEqual([at]);
    expect(r.rejected).toEqual([{ file: over, reason: "too_large" }]);
  });

  it("splits a mixed batch into all three lanes", () => {
    const mp4 = sizedFile("video/mp4", 40 * 1024 * 1024, "v.mp4");
    const big = sizedFile("application/pdf", MAX + 10, "big.pdf");
    const ok = sizedFile("text/plain", 200, "note.txt");
    const r = partitionUpload([mp4, big, ok], { maxBytes: MAX, canRouteMedia: true });
    expect(r.media).toEqual([mp4]);
    expect(r.rejected).toEqual([{ file: big, reason: "too_large" }]);
    expect(r.attach).toEqual([ok]);
  });

  // Recording-to-brain, chat entry: a recording-sized audio routes to the
  // recording pipeline; a short voice note stays inline. Uses the real
  // threshold constant so the test can't drift from it.
  const REC_MIN = RECORDING_AUDIO_MIN_BYTES;

  it("routes recording-sized audio to media when the host can route", () => {
    const meeting = sizedFile("audio/mp4", 30 * 1024 * 1024, "call.m4a");
    const r = partitionUpload([meeting], { maxBytes: MAX, canRouteMedia: true });
    // Bypasses the 20 MB cap — the recording flow uploads direct to GCS, which
    // is the whole reason a meeting can go through chat at all.
    expect(r.media).toEqual([meeting]);
    expect(r.attach).toEqual([]);
    expect(r.rejected).toEqual([]);
  });

  it("keeps a short voice note on the inline attach path", () => {
    const note = sizedFile("audio/webm", REC_MIN - 1, "note.webm");
    const r = partitionUpload([note], { maxBytes: MAX, canRouteMedia: true });
    // A 10-second "remind me" should not spawn a brief page + surcharge.
    expect(r.attach).toEqual([note]);
    expect(r.media).toEqual([]);
  });

  it("does not route audio when the host wired no recording pipeline", () => {
    // Without onRouteMedia, a recording-sized audio under the cap still attaches
    // (inline) rather than vanishing — the composer just has no recording path.
    const meeting = sizedFile("audio/mp4", REC_MIN + 1, "call.m4a");
    const r = partitionUpload([meeting], { maxBytes: MAX, canRouteMedia: false });
    expect(r.attach).toEqual([meeting]);
    expect(r.media).toEqual([]);
  });
});
