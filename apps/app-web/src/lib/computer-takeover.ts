/**
 * Take-Over live-view input geometry ([COMP:app-web/sandbox-takeover]).
 *
 * The live frame renders `object-contain` inside a flex-sized box, so the
 * <img> element includes letterbox bars whenever its aspect ratio differs
 * from the frame's. Click forwarding must map through the fitted content
 * rect — a linear map across the whole element lands clicks offset from
 * where the user aimed (the pre-fix take-over bug).
 * Spec: docs/architecture/engine/computer-use.md §4.8.
 */

/**
 * Map a client-space click to frame coordinates through the `object-contain`
 * fit. Returns null for clicks in the letterbox bars (nothing under them).
 */
export function mapClickToFrame(
  rect: { left: number; top: number; width: number; height: number },
  natural: { w: number; h: number },
  clientX: number,
  clientY: number,
): { x: number; y: number } | null {
  if (rect.width <= 0 || rect.height <= 0 || natural.w <= 0 || natural.h <= 0) return null;
  const scale = Math.min(rect.width / natural.w, rect.height / natural.h);
  const contentW = natural.w * scale;
  const contentH = natural.h * scale;
  const offsetX = (rect.width - contentW) / 2;
  const offsetY = (rect.height - contentH) / 2;
  const x = (clientX - rect.left - offsetX) / scale;
  const y = (clientY - rect.top - offsetY) / scale;
  if (x < 0 || y < 0 || x > natural.w || y > natural.h) return null;
  return { x, y };
}

/**
 * Wheel relay pacing: the first event of a scroll gesture forwards
 * IMMEDIATELY (leading edge - the old trailing-only accumulator added a
 * fixed 160 ms before anything moved), then further deltas accumulate into
 * one relayed scroll per flush window so a fling never turns into dozens of
 * round-trips.
 */
export function createWheelForwarder(
  send: (deltaY: number) => void,
  flushMs = 160,
): { add: (deltaY: number) => void; dispose: () => void } {
  let acc = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const flush = () => {
    timer = null;
    const delta = Math.round(acc);
    acc = 0;
    if (delta !== 0) {
      send(delta);
      timer = setTimeout(flush, flushMs); // keep windows spaced while the fling lasts
    }
  };
  return {
    add(deltaY: number) {
      if (timer === null) {
        const lead = Math.round(deltaY);
        if (lead !== 0) send(lead);
        timer = setTimeout(flush, flushMs);
      } else {
        acc += deltaY;
      }
    },
    dispose() {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      acc = 0;
    },
  };
}

/**
 * Normalize an address-bar entry for a take-over `goto` (§5). A bare host gets
 * `https://`; only http(s) survives — a `file:`/`chrome:`/`javascript:` target
 * returns null so the toolbar never forwards it (the seam re-checks too).
 */
export function normalizeNavigateUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const u = new URL(withScheme);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.toString();
  } catch {
    return null;
  }
}

/** Keys that carry no input on their own — never worth a relay round-trip. */
export const LOCAL_ONLY_KEYS = new Set([
  "Shift",
  "Control",
  "Alt",
  "Meta",
  "CapsLock",
  "NumLock",
  "ScrollLock",
  "Dead",
  "Process",
  "Unidentified",
]);
