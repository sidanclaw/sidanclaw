"use client";

/**
 * Recording detail — `/w/[workspaceId]/recordings/[recordingId]`.
 *
 * The first surface where a recording is something you can OPEN: play it, and
 * read the transcript with every line clickable to that moment. It is also the
 * target of the `#t=<seconds>` deep link a `[H:MM:SS]` citation renders (see
 * `components/doc/timecode-decoration.ts`), which is why the mount reads the
 * hash and seeks.
 *
 * A real route rather than a doc-shell panel: panels (`/p?panel=…`) are boards,
 * and this is a single artifact with its own URL that other pages link INTO.
 *
 * [COMP:app-web/recording-detail]
 */

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { formatStamp } from "@sidanclaw/shared";
import { useT } from "@/lib/i18n/client";
import {
  getRecording,
  getRecordingTranscript,
  type RecordingSummary,
  type TranscriptSegment,
} from "@/lib/api/recordings";
import {
  RecordingPlayerProvider,
  useRecordingPlayer,
} from "@/lib/recordings/recording-player-context";

/** Transport + scrubber. Chrome above the transcript, never a doc block. */
function PlayerBar({ title }: { title: string }) {
  const t = useT();
  const { currentMs, durationMs, isPlaying, togglePlay, isLoading, error, seekTo } =
    useRecordingPlayer();

  if (error) {
    return (
      <div className="rounded-md border border-border bg-muted/40 px-4 py-3 text-sm text-muted-foreground">
        {t.recordings.detailAudioError}
      </div>
    );
  }

  return (
    <div className="sticky top-0 z-10 flex items-center gap-3 rounded-md border border-border bg-background/95 px-4 py-3 backdrop-blur">
      <button
        type="button"
        onClick={togglePlay}
        disabled={isLoading}
        aria-label={isPlaying ? t.recordings.detailPause : t.recordings.detailPlay}
        className="shrink-0 rounded-full border border-border px-3 py-1 text-sm disabled:opacity-50"
      >
        {isPlaying ? t.recordings.detailPause : t.recordings.detailPlay}
      </button>
      <span className="shrink-0 tabular-nums text-xs text-muted-foreground">
        {formatStamp(currentMs)} / {formatStamp(durationMs)}
      </span>
      <input
        type="range"
        min={0}
        max={Math.max(durationMs, 1)}
        value={Math.min(currentMs, durationMs || 0)}
        onChange={(e) => seekTo(Number(e.target.value))}
        aria-label={title}
        className="h-1 w-full cursor-pointer"
      />
      {isLoading ? (
        <span className="shrink-0 text-xs text-muted-foreground">
          {t.recordings.detailLoadingAudio}
        </span>
      ) : null}
    </div>
  );
}

/** The transcript. Every line seeks; the active line is highlighted. */
function TranscriptPane({ recordingId }: { recordingId: string }) {
  const t = useT();
  const { seekTo, currentMs } = useRecordingPlayer();
  const [segments, setSegments] = useState<TranscriptSegment[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [nextFrom, setNextFrom] = useState(0);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = useCallback(
    async (from: number) => {
      setLoading(true);
      try {
        const page = await getRecordingTranscript(recordingId, from);
        setSegments((prev) => (from === 0 ? page.segments : [...prev, ...page.segments]));
        setHasMore(page.hasMore);
        setNextFrom(page.toIndex + 1);
      } catch {
        setError(true);
      } finally {
        setLoading(false);
      }
    },
    [recordingId],
  );

  useEffect(() => {
    void load(0);
  }, [load]);

  if (error) {
    return <p className="text-sm text-muted-foreground">{t.recordings.detailTranscriptError}</p>;
  }
  if (!loading && segments.length === 0) {
    return <p className="text-sm text-muted-foreground">{t.recordings.detailNoTranscript}</p>;
  }

  return (
    <div>
      <div className="mb-2 flex items-baseline justify-between">
        <h2 className="text-sm font-medium">{t.recordings.detailTranscript}</h2>
        <span className="text-xs text-muted-foreground">{t.recordings.detailSeekHint}</span>
      </div>
      <ol className="space-y-1">
        {segments.map((s) => {
          // The active line is the last one whose start is behind the playhead.
          const active = currentMs >= s.start_ms && currentMs < s.end_ms;
          return (
            <li key={s.segment_index}>
              <button
                type="button"
                onClick={() => seekTo(s.start_ms)}
                className={`flex w-full gap-3 rounded px-2 py-1 text-left text-sm hover:bg-muted/60 ${
                  active ? "bg-muted" : ""
                }`}
              >
                <span className="shrink-0 tabular-nums text-xs text-muted-foreground">
                  {formatStamp(s.start_ms)}
                </span>
                <span>
                  {s.speaker ? <b className="mr-1">{s.speaker}:</b> : null}
                  {s.segment_text}
                </span>
              </button>
            </li>
          );
        })}
      </ol>
      {hasMore ? (
        <button
          type="button"
          onClick={() => void load(nextFrom)}
          disabled={loading}
          className="mt-3 rounded border border-border px-3 py-1 text-sm disabled:opacity-50"
        >
          {t.recordings.detailLoadMore}
        </button>
      ) : null}
    </div>
  );
}

/** Reads `#t=<seconds>` on mount — the citation deep link's landing. */
function HashSeek() {
  const { seekTo, recordingId } = useRecordingPlayer();
  useEffect(() => {
    if (!recordingId) return;
    const m = /^#t=(\d+(?:\.\d+)?)$/.exec(window.location.hash);
    if (m) seekTo(Number(m[1]) * 1000);
  }, [seekTo, recordingId]);
  return null;
}

export default function RecordingDetailPage() {
  const t = useT();
  const params = useParams<{ workspaceId: string; recordingId: string }>();
  const [rec, setRec] = useState<RecordingSummary | null>(null);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    let live = true;
    getRecording(params.recordingId)
      .then((r) => live && setRec(r))
      .catch(() => live && setMissing(true));
    return () => {
      live = false;
    };
  }, [params.recordingId]);

  if (missing) {
    return (
      <main className="mx-auto max-w-3xl p-6">
        <p className="text-sm text-muted-foreground">{t.recordings.detailNotFound}</p>
      </main>
    );
  }

  const statusNote =
    rec?.status === "queued"
      ? t.recordings.detailStatusQueued
      : rec?.status === "processing"
        ? t.recordings.detailStatusProcessing
        : rec?.status === "failed"
          ? t.recordings.detailStatusFailed
          : null;

  return (
    <RecordingPlayerProvider recordingId={params.recordingId} durationMs={rec?.durationMs ?? 0}>
      <HashSeek />
      <main className="mx-auto max-w-3xl space-y-4 p-6">
        <Link
          href={`/w/${params.workspaceId}/p`}
          className="text-xs text-muted-foreground hover:underline"
        >
          {t.recordings.detailBack}
        </Link>
        <h1 className="text-xl font-semibold">{rec?.title ?? rec?.fileName ?? ""}</h1>

        {statusNote ? <p className="text-sm text-muted-foreground">{statusNote}</p> : null}
        {rec?.truncated ? (
          <p className="text-sm text-muted-foreground">{t.recordings.detailTruncated}</p>
        ) : null}

        <PlayerBar title={rec?.title ?? rec?.fileName ?? ""} />
        <TranscriptPane recordingId={params.recordingId} />
      </main>
    </RecordingPlayerProvider>
  );
}
