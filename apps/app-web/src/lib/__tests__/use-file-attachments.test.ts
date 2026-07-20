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
  RECORDING_AUDIO_MIN_DURATION_SEC,
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

  /** Duration probe stub — keeps the partition pure/DOM-free under test. */
  const probing = (sec: number | null) => () => Promise.resolve(sec);

  it("routes video to media when the host can route", async () => {
    const mp4 = sizedFile("video/mp4", 93 * 1024 * 1024, "call.mp4");
    const r = await partitionUpload([mp4], { maxBytes: MAX, canRouteMedia: true });
    expect(r.media).toEqual([mp4]);
    expect(r.attach).toEqual([]);
    expect(r.rejected).toEqual([]);
  });

  it("rejects video as unsupported when the host cannot route", async () => {
    const mp4 = sizedFile("video/mp4", 5 * 1024 * 1024, "clip.mp4");
    const r = await partitionUpload([mp4], { maxBytes: MAX, canRouteMedia: false });
    expect(r.media).toEqual([]);
    expect(r.attach).toEqual([]);
    expect(r.rejected).toEqual([{ file: mp4, reason: "video_unsupported" }]);
  });

  it("rejects an oversized non-video as too_large", async () => {
    const pdf = sizedFile("application/pdf", MAX + 1, "big.pdf");
    const r = await partitionUpload([pdf], { maxBytes: MAX, canRouteMedia: true });
    expect(r.rejected).toEqual([{ file: pdf, reason: "too_large" }]);
    expect(r.attach).toEqual([]);
  });

  it("keeps a normal file on the attach path", async () => {
    const png = sizedFile("image/png", 1024, "shot.png");
    const r = await partitionUpload([png], { maxBytes: MAX, canRouteMedia: false });
    expect(r.attach).toEqual([png]);
    expect(r.media).toEqual([]);
    expect(r.rejected).toEqual([]);
  });

  it("allows a file exactly at the limit, rejects one byte over", async () => {
    const at = sizedFile("application/pdf", MAX, "at.pdf");
    const over = sizedFile("application/pdf", MAX + 1, "over.pdf");
    const r = await partitionUpload([at, over], { maxBytes: MAX, canRouteMedia: true });
    expect(r.attach).toEqual([at]);
    expect(r.rejected).toEqual([{ file: over, reason: "too_large" }]);
  });

  it("splits a mixed batch into all three lanes", async () => {
    const mp4 = sizedFile("video/mp4", 40 * 1024 * 1024, "v.mp4");
    const big = sizedFile("application/pdf", MAX + 10, "big.pdf");
    const ok = sizedFile("text/plain", 200, "note.txt");
    const r = await partitionUpload([mp4, big, ok], { maxBytes: MAX, canRouteMedia: true });
    expect(r.media).toEqual([mp4]);
    expect(r.rejected).toEqual([{ file: big, reason: "too_large" }]);
    expect(r.attach).toEqual([ok]);
  });

  // Recording-to-brain, chat entry. The fork is DURATION, not bytes: "meeting
  // or note" is a question about length. Uses the real threshold constants so
  // these can't drift from the implementation.
  const REC_MIN = RECORDING_AUDIO_MIN_BYTES;
  const MIN_SEC = RECORDING_AUDIO_MIN_DURATION_SEC;

  it("routes a long recording to media even when the file is small", async () => {
    // The regression that motivated duration routing: a well-compressed meeting
    // is far under the old 5 MB size gate, so it used to attach as a plain file
    // and never reach the recording pipeline.
    const meeting = sizedFile("audio/mp4", 470_000, "meeting.m4a");
    const r = await partitionUpload([meeting], {
      maxBytes: MAX,
      canRouteMedia: true,
      probeDurationSec: probing(45 * 60),
    });
    expect(r.media).toEqual([meeting]);
    expect(r.attach).toEqual([]);
  });

  it("keeps a short voice note inline even when the file is large", async () => {
    // The mirror error: a high-bitrate 30-second note clears 5 MB easily, but a
    // "remind me" should never spawn a brief page + surcharge.
    const note = sizedFile("audio/wav", 30 * 1024 * 1024, "note.wav");
    const r = await partitionUpload([note], {
      maxBytes: MAX,
      canRouteMedia: true,
      probeDurationSec: probing(30),
    });
    expect(r.media).toEqual([]);
    expect(r.rejected).toEqual([{ file: note, reason: "too_large" }]);
  });

  it("routes audio exactly at the duration threshold", async () => {
    const at = sizedFile("audio/mp4", 1024, "at.m4a");
    const r = await partitionUpload([at], {
      maxBytes: MAX,
      canRouteMedia: true,
      probeDurationSec: probing(MIN_SEC),
    });
    expect(r.media).toEqual([at]);
  });

  it("routes a long recording past the 20 MB cache cap", async () => {
    // Bypasses maxBytes — the recording flow uploads direct to GCS, which is the
    // whole reason a meeting can go through chat at all.
    const meeting = sizedFile("audio/mp4", 300 * 1024 * 1024, "long.m4a");
    const r = await partitionUpload([meeting], {
      maxBytes: MAX,
      canRouteMedia: true,
      probeDurationSec: probing(96 * 60),
    });
    expect(r.media).toEqual([meeting]);
    expect(r.rejected).toEqual([]);
  });

  it("falls back to the size proxy when the duration is unreadable", async () => {
    // Unreadable codec / probe timeout: a big file is still obviously a meeting,
    // so it must not silently drop into the 20 MB lane that would reject it.
    const meeting = sizedFile("audio/x-exotic", REC_MIN + 1, "call.xyz");
    const r = await partitionUpload([meeting], {
      maxBytes: MAX,
      canRouteMedia: true,
      probeDurationSec: probing(null),
    });
    expect(r.media).toEqual([meeting]);
  });

  it("falls back to attach for a small file with an unreadable duration", async () => {
    const note = sizedFile("audio/x-exotic", REC_MIN - 1, "note.xyz");
    const r = await partitionUpload([note], {
      maxBytes: MAX,
      canRouteMedia: true,
      probeDurationSec: probing(null),
    });
    expect(r.attach).toEqual([note]);
    expect(r.media).toEqual([]);
  });

  it("does not probe when the host wired no recording pipeline", async () => {
    // Without onRouteMedia audio takes the inline path regardless of length, so
    // the probe is wasted work on a file we already know the lane for.
    const meeting = sizedFile("audio/mp4", 1024, "call.m4a");
    let probed = false;
    const r = await partitionUpload([meeting], {
      maxBytes: MAX,
      canRouteMedia: false,
      probeDurationSec: () => {
        probed = true;
        return Promise.resolve(45 * 60);
      },
    });
    expect(probed).toBe(false);
    expect(r.attach).toEqual([meeting]);
    expect(r.media).toEqual([]);
  });
});
