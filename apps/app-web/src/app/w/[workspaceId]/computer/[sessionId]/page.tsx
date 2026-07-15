"use client";

/**
 * Take-Over live view — `/w/[workspaceId]/computer/[sessionId]`.
 *
 * The web half of §4.8: a live look at the cloud sandbox browser for one
 * chat session's computer task. Frames arrive over the live stream (SSE
 * straight from the sandbox bridge - sub-second, damage-driven) with the old
 * ~1 fps poll as automatic fallback; clicks and keys forward into the page
 * (scaled to the real viewport), the password never leaves the sandbox page.
 * "I signed in" captures the session to the vault so future tasks skip the
 * login; closing/stopping ends the task (close-to-stop). Channel tasks
 * (Telegram/Slack) deep-link here when they hit a login wall.
 *
 * `?flow=login&site=<site>` marks a Profile-Management "Sign in to a site"
 * task (§7): the site prefills from the query, and a successful capture
 * offers "Done" — completing the task (the sandbox existed only for this
 * sign-in) and returning to the workspace. A chat task never shows Done:
 * completing it would kill the sandbox the assistant is still using.
 *
 * [COMP:app-web/sandbox-takeover] — spec: docs/architecture/engine/computer-use.md §5.
 */

import { use as usePromise, useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useT } from "@/lib/i18n/client";
import { confirmDialog } from "@/components/ui/confirm-dialog";
import { LOCAL_ONLY_KEYS, mapClickToFrame } from "@/lib/computer-takeover";
import {
  SearchableSelect,
  type SearchableSelectItem,
} from "@/components/ui/searchable-select";
import {
  completeComputerTask,
  getComputerFrame,
  getComputerTask,
  listBrowserProfiles,
  markComputerSessionCaptured,
  mintComputerStreamSession,
  resumeComputerTask,
  sendComputerInput,
  sendStreamInput,
  type ComputerTask,
  type TakeoverInput,
  type TakeoverStreamSession,
} from "@/lib/api/computer";

const FRAME_INTERVAL_MS = 1_200;
const WHEEL_FLUSH_MS = 160;

export default function ComputerTakeoverPage(props: {
  params: Promise<{ workspaceId: string; sessionId: string }>;
}) {
  const { workspaceId, sessionId } = usePromise(props.params);
  const t = useT();
  const router = useRouter();

  // Read once from the URL (window.location over useSearchParams keeps this
  // fully-client page out of the Suspense-boundary requirement).
  const [loginFlow] = useState(() => {
    if (typeof window === "undefined") return { isLogin: false, site: "" };
    const params = new URLSearchParams(window.location.search);
    return { isLogin: params.get("flow") === "login", site: params.get("site") ?? "" };
  });

  const [task, setTask] = useState<ComputerTask | null | "loading">("loading");
  const [frameSrc, setFrameSrc] = useState<string | null>(null);
  const [stalled, setStalled] = useState(false);
  // Live stream session: "minting" until the mint answers; null = polled
  // fallback (backend without streaming, or the stream died twice).
  const [stream, setStream] = useState<TakeoverStreamSession | null | "minting">("minting");
  const [site, setSite] = useState("");
  const [capturing, setCapturing] = useState(false);
  const [captureStatus, setCaptureStatus] = useState<
    "idle" | "saved" | "failed" | "profile_required"
  >("idle");
  // Profile the session saves into when the task started identity-less (R2-4).
  const [profileItems, setProfileItems] = useState<SearchableSelectItem[]>([]);
  const [profileId, setProfileId] = useState<string>("");
  const imgRef = useRef<HTMLImageElement | null>(null);
  const naturalSize = useRef<{ w: number; h: number } | null>(null);

  // Arrival = the Take-Over begins: resolve the task and resume the paused
  // sandbox (§4.8 pauses it during the wait, not during the takeover).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const found = await getComputerTask(sessionId).catch(() => null);
      if (cancelled) return;
      setTask(found);
      if (found) {
        setSite(found.injectedSite ?? loginFlow.site);
        await resumeComputerTask(sessionId).catch(() => {});
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionId, loginFlow.site]);

  // Mint the live stream once the task is resolved. Any failure lands on
  // null - the polled fallback below takes over, nothing breaks.
  useEffect(() => {
    if (!task || task === "loading") return;
    let cancelled = false;
    void mintComputerStreamSession(sessionId)
      .then((info) => {
        if (!cancelled) setStream(info);
      })
      .catch(() => {
        if (!cancelled) setStream(null);
      });
    return () => {
      cancelled = true;
    };
  }, [task, sessionId]);

  // Live stream: SSE straight from the sandbox bridge. Frames are JSON with
  // a base64 JPEG in `data`; the stream is damage-driven, so a static page
  // sending nothing is normal, and only transport errors count as stalls.
  useEffect(() => {
    if (!task || task === "loading" || !stream || stream === "minting") return;
    let errors = 0;
    const es = new EventSource(stream.framesUrl);
    const onFrame = (ev: MessageEvent) => {
      errors = 0;
      setStalled(false);
      try {
        const parsed = JSON.parse(String(ev.data)) as { data?: string };
        if (parsed.data) setFrameSrc(`data:image/jpeg;base64,${parsed.data}`);
      } catch {
        /* malformed frame - keep the last good one */
      }
    };
    es.addEventListener("frame", onFrame);
    es.onerror = () => {
      errors += 1;
      setStalled(true);
      // EventSource retries by itself; two straight failures means the
      // bridge is gone - drop to the polled fallback for this visit.
      if (errors >= 2) {
        es.close();
        setStream(null);
      }
    };
    return () => {
      es.removeEventListener("frame", onFrame);
      es.close();
    };
  }, [task, sessionId, stream]);

  // Frame poll loop - the fallback path (stream === null only).
  useEffect(() => {
    if (!task || task === "loading" || stream !== null) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      const frame = await getComputerFrame(sessionId).catch(() => null);
      if (cancelled) return;
      if (frame) {
        setFrameSrc(`data:${frame.mimeType};base64,${frame.data}`);
        setStalled(false);
      } else {
        setStalled(true);
      }
      timer = setTimeout(() => void tick(), FRAME_INTERVAL_MS);
    };
    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [task, sessionId, stream]);

  // One input door: direct to the sandbox bridge when streaming, else the
  // API's per-event route.
  const streamRef = useRef<TakeoverStreamSession | null>(null);
  streamRef.current = stream === "minting" ? null : stream;
  const forwardInput = useCallback(
    (event: TakeoverInput) => {
      const live = streamRef.current;
      if (live) {
        void sendStreamInput(live.inputUrl, event).then((ok) => {
          if (!ok) void sendComputerInput(sessionId, event);
        });
      } else {
        void sendComputerInput(sessionId, event);
      }
    },
    [sessionId],
  );

  const forwardClick = useCallback(
    (e: React.MouseEvent<HTMLImageElement>) => {
      const img = imgRef.current;
      const natural = naturalSize.current;
      if (!img || !natural) return;
      const point = mapClickToFrame(img.getBoundingClientRect(), natural, e.clientX, e.clientY);
      if (!point) return; // letterbox bar — nothing under it in the frame
      forwardInput({ kind: "click", x: point.x, y: point.y });
    },
    [forwardInput],
  );

  const forwardKey = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.metaKey || e.ctrlKey) return; // browser shortcuts stay local
      e.preventDefault();
      const text = e.key;
      if (!text || LOCAL_ONLY_KEYS.has(text)) return;
      forwardInput({ kind: "key", text });
    },
    [forwardInput],
  );

  // Wheel forwarding, accumulated: one relayed scroll per flush window keeps
  // a fling from turning into dozens of round-trips.
  const wheelDelta = useRef(0);
  const wheelTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const forwardWheel = useCallback(
    (e: React.WheelEvent<HTMLDivElement>) => {
      wheelDelta.current += e.deltaY;
      if (wheelTimer.current) return;
      wheelTimer.current = setTimeout(() => {
        const deltaY = Math.round(wheelDelta.current);
        wheelDelta.current = 0;
        wheelTimer.current = null;
        if (deltaY !== 0) forwardInput({ kind: "scroll", deltaY });
      }, WHEEL_FLUSH_MS);
    },
    [forwardInput],
  );
  useEffect(
    () => () => {
      if (wheelTimer.current) clearTimeout(wheelTimer.current);
    },
    [],
  );

  // An identity-less task needs a profile to save into (409 profile_required)
  // — offer the workspace's profiles to pick from.
  useEffect(() => {
    if (!task || task === "loading" || task.profileId) return;
    let cancelled = false;
    void listBrowserProfiles(workspaceId)
      .then((res) => {
        if (cancelled) return;
        setProfileItems(res.profiles.map((p) => ({ value: p.id, label: p.name })));
        if (res.profiles.length === 1) setProfileId(res.profiles[0].id);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [task, workspaceId]);

  const onCaptured = useCallback(async () => {
    const target = site.trim();
    if (!target) return;
    setCapturing(true);
    const result = await markComputerSessionCaptured(
      sessionId,
      target,
      profileId || undefined,
    ).catch(() => ({ ok: false, profileRequired: false }));
    setCapturing(false);
    setCaptureStatus(result.ok ? "saved" : result.profileRequired ? "profile_required" : "failed");
  }, [profileId, sessionId, site]);

  // Login-flow exit: the sandbox existed only for this sign-in, so a
  // successful capture can complete the task (capture + kill) and go home.
  const onLoginDone = useCallback(async () => {
    await completeComputerTask(sessionId, "completed").catch(() => {});
    router.push(`/w/${workspaceId}`);
  }, [router, sessionId, workspaceId]);

  const onStop = useCallback(async () => {
    const confirmed = await confirmDialog({
      title: t.computer.stopConfirmTitle,
      description: t.computer.stopConfirmBody,
      confirmLabel: t.computer.stopConfirmAction,
    });
    if (!confirmed) return;
    await completeComputerTask(sessionId, "failed").catch(() => {});
    router.push(`/w/${workspaceId}`);
  }, [router, sessionId, t, workspaceId]);

  if (task === "loading") {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        {t.computer.connecting}
      </div>
    );
  }

  if (!task) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <p className="max-w-md text-center text-sm text-muted-foreground">{t.computer.noTask}</p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col gap-3 p-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-base font-semibold">{t.computer.liveViewTitle}</h1>
          <p className="mt-0.5 max-w-xl text-xs text-muted-foreground">{t.computer.liveViewSubtitle}</p>
        </div>
        <button
          type="button"
          onClick={() => void onStop()}
          className="shrink-0 rounded-md border border-destructive/40 px-3 py-1.5 text-xs font-medium text-destructive hover:bg-destructive/10"
        >
          {t.computer.stopTask}
        </button>
      </div>

      <div
        role="application"
        aria-label={t.computer.liveViewTitle}
        tabIndex={0}
        onKeyDown={forwardKey}
        onWheel={forwardWheel}
        className="relative flex-1 overflow-hidden rounded-lg border border-border bg-muted/30 outline-none focus:ring-2 focus:ring-ring"
      >
        {frameSrc ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            ref={imgRef}
            src={frameSrc}
            alt=""
            draggable={false}
            onLoad={(e) => {
              naturalSize.current = {
                w: e.currentTarget.naturalWidth,
                h: e.currentTarget.naturalHeight,
              };
            }}
            onClick={forwardClick}
            className="h-full w-full cursor-pointer select-none object-contain"
          />
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            {t.computer.connecting}
          </div>
        )}
        {stalled ? (
          <div className="absolute inset-x-0 bottom-0 bg-background/80 px-3 py-1.5 text-center text-xs text-muted-foreground">
            {t.computer.frameStalled}
          </div>
        ) : null}
      </div>

      <div className="flex flex-wrap items-end gap-2 rounded-lg border border-border p-3">
        <label className="flex min-w-56 flex-1 flex-col gap-1 text-xs font-medium">
          {t.computer.siteInputLabel}
          <input
            value={site}
            onChange={(e) => setSite(e.target.value)}
            placeholder="github.com"
            className="rounded-md border border-border bg-background px-2 py-1.5 text-sm font-normal"
          />
        </label>
        {task.profileId === null && profileItems.length > 0 ? (
          <label className="flex min-w-44 flex-col gap-1 text-xs font-medium">
            {t.computer.profileLabel}
            <SearchableSelect
              value={profileId}
              onValueChange={setProfileId}
              items={profileItems}
              aria-label={t.computer.profileLabel}
              popupClassName="w-64"
            />
          </label>
        ) : null}
        <button
          type="button"
          disabled={capturing || site.trim().length === 0}
          onClick={() => void onCaptured()}
          className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
        >
          {t.computer.signedInCta}
        </button>
        <p className="w-full text-[11px] text-muted-foreground">{t.computer.signedInHint}</p>
        {captureStatus !== "idle" ? (
          <p
            role="status"
            className={
              captureStatus === "saved"
                ? "w-full text-[11px] text-primary"
                : "w-full text-[11px] text-destructive"
            }
          >
            {captureStatus === "saved"
              ? t.computer.captureSuccess
              : captureStatus === "profile_required"
                ? t.computer.profileRequired
                : t.computer.captureFailed}
          </p>
        ) : null}
        {loginFlow.isLogin && captureStatus === "saved" ? (
          <button
            type="button"
            onClick={() => void onLoginDone()}
            className="rounded-md border border-border px-3 py-1.5 text-xs font-medium hover:bg-accent"
          >
            {t.computer.loginDoneCta}
          </button>
        ) : null}
      </div>
    </div>
  );
}
