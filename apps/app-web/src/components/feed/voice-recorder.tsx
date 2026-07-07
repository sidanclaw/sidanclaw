"use client";

/**
 * Voice recorder mic button — ported verbatim from
 * `apps/feed-web/src/components/VoiceRecorder.tsx`
 * (docs/plans/feed-web-consolidation.md §7.3; MediaRecorder / mic handling
 * unchanged, only the user-visible strings moved to `feedPage.tuningChat`).
 *
 * Press-and-hold (pointerdown → pointerup) to record a short voice note.
 * On release, emits a Blob as `audio/webm;codecs=opus`. The chat composer
 * wraps the blob as a File and routes it through the existing
 * `/api/files/upload` flow — the backend transcribes it just-in-time
 * (see docs/architecture/media/transcription.md).
 *
 * Permission denial surfaces as an inline error message under the composer.
 *
 * [COMP:app-web/feed-tuning-chat]
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useT } from "@/lib/i18n/client";
import { format } from "@/lib/i18n/format";

type RecordingState = "idle" | "requesting" | "recording" | "error";

export function VoiceRecorder({
  onRecorded,
  disabled,
}: {
  /** Called with the recorded audio blob when the user releases the button. */
  onRecorded: (blob: Blob) => void;
  disabled?: boolean;
}) {
  const t = useT().feedPage.tuningChat;
  const [state, setState] = useState<RecordingState>("idle");
  const [error, setError] = useState<string | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const streamRef = useRef<MediaStream | null>(null);

  const stopTracks = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }, []);

  useEffect(() => {
    // Cleanup on unmount — don't leave the mic LED on if the user navigates away.
    return () => {
      recorderRef.current?.state === "recording" && recorderRef.current.stop();
      stopTracks();
    };
  }, [stopTracks]);

  async function start() {
    if (state !== "idle" || disabled) return;
    setError(null);
    setState("requesting");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : MediaRecorder.isTypeSupported("audio/mp4")
        ? "audio/mp4"
        : "";
      const recorder = mimeType
        ? new MediaRecorder(stream, { mimeType })
        : new MediaRecorder(stream);
      recorderRef.current = recorder;
      chunksRef.current = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.onstop = () => {
        const effectiveMime = recorder.mimeType || "audio/webm";
        const blob = new Blob(chunksRef.current, { type: effectiveMime });
        chunksRef.current = [];
        stopTracks();
        setState("idle");
        // Drop silent-ish recordings (< 1KB tends to be a stray tap, not speech).
        if (blob.size >= 1024) {
          onRecorded(blob);
        }
      };
      recorder.start();
      setState("recording");
    } catch (err) {
      stopTracks();
      setState("error");
      setError(
        err instanceof DOMException && err.name === "NotAllowedError"
          ? t.micDenied
          : format(t.micError, { message: (err as Error).message }),
      );
      // Return to idle after a beat so the button becomes pressable again.
      setTimeout(() => setState("idle"), 100);
    }
  }

  function stop() {
    if (recorderRef.current?.state === "recording") {
      recorderRef.current.stop();
    } else {
      // Mid-request abort — still clean up.
      stopTracks();
      setState("idle");
    }
  }

  // Safety: if the pointer leaves the button while held, still stop on pointerup
  // from anywhere in the document. Without this, the recording can hang when
  // the user slides their finger off the button before releasing.
  useEffect(() => {
    if (state !== "recording") return;
    const onDocumentUp = () => stop();
    document.addEventListener("pointerup", onDocumentUp);
    document.addEventListener("pointercancel", onDocumentUp);
    return () => {
      document.removeEventListener("pointerup", onDocumentUp);
      document.removeEventListener("pointercancel", onDocumentUp);
    };
  }, [state]);

  const isActive = state === "recording";

  return (
    <div className="relative inline-flex items-center">
      <button
        type="button"
        disabled={disabled}
        onPointerDown={(e) => {
          e.preventDefault();
          void start();
        }}
        className={`p-2 rounded-xl transition-colors shrink-0 ${
          isActive
            ? "text-destructive bg-destructive/10 animate-pulse"
            : "text-muted-foreground hover:text-primary hover:bg-muted"
        } ${disabled ? "opacity-50 cursor-not-allowed" : ""}`}
        title={isActive ? t.micRelease : t.micHold}
        aria-label={isActive ? t.micRecordingAria : t.micRecordAria}
        aria-pressed={isActive}
      >
        <MicIcon active={isActive} />
      </button>
      {error && (
        <span className="absolute -top-9 left-0 whitespace-nowrap rounded-md bg-destructive/10 border border-destructive/30 px-2 py-1 text-xs text-destructive">
          {error}
        </span>
      )}
    </div>
  );
}

function MicIcon({ active }: { active: boolean }) {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={active ? 2.5 : 2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M12 2a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z" />
      <path d="M19 10v1a7 7 0 0 1-14 0v-1" />
      <line x1="12" y1="18" x2="12" y2="22" />
      <line x1="8" y1="22" x2="16" y2="22" />
    </svg>
  );
}
