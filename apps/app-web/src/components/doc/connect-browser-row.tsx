"use client";

/**
 * "My Browser" sidebar row — connect or reconnect the local browser extension
 * from the persistent chrome, without going through Settings.
 *
 * The pairing machinery already exists (`connect-browser-panel.tsx` +
 * `lib/browser-extension-bridge.ts`, my-browser.md P1); what it lacked was a
 * way in. The panel lives four levels deep — Settings → Workspace → Browser
 * profiles → scroll — which is a long way to travel for the two moments that
 * actually matter: connecting the first time, and reconnecting after Chrome
 * has been restarted and the relay socket is gone. Both are one click here.
 *
 * The row sits directly under the icon nav, so it is reachable from every
 * surface (the sidebar is mounted by `WorkspaceChrome`, above the surfaces).
 * It renders nothing at all when the deployment has no relay configured
 * (`status.configured === false`) or before the first status resolves — a
 * permanently dead "Connect" button teaches people to ignore the row.
 *
 * Clicking while disconnected runs the same one-click path the panel uses:
 * mint a token, hand it straight to the extension. Anything other than a
 * clean pair (no extension, wrong build id, refused origin) falls back to
 * opening the panel, which owns the install CTA and the copy-paste fields —
 * this row never becomes a dead end. Clicking while connected opens the panel
 * to manage the connection.
 *
 * [COMP:app-web/connect-browser-row]
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Globe } from "lucide-react";
import { useT } from "@/lib/i18n/client";
import { openWorkspaceSettings } from "@/components/settings-modal/settings-modal";
import {
  chromeMessenger,
  extensionHasControl,
  pairViaExtension,
  requestBrowserControl,
} from "@/lib/browser-extension-bridge";
import {
  getBrowserExtensionStatus,
  pairBrowserExtension,
  type BrowserExtensionStatus,
} from "@/lib/api/computer";

/**
 * The row is mounted for the whole session on every surface, so it polls far
 * more slowly than the Settings panel (5s) — a socket that dropped is not
 * urgent until someone looks. A window focus re-checks immediately, which is
 * the moment that actually matters: the user has just come back from the
 * extension popup or from restarting Chrome.
 */
const STATUS_POLL_MS = 60_000;

export function ConnectBrowserRow({ workspaceId }: { workspaceId: string }) {
  const c = useT().computer.connectBrowser.sidebarRow;

  const [status, setStatus] = useState<BrowserExtensionStatus | null>(null);
  /**
   * Whether the extension holds the optional `debugger` grant. `null` means no
   * extension answered, which is NOT the same as "not granted" — nagging a user
   * to allow something on a machine with no extension installed is worse than
   * saying nothing, so only an explicit `false` shows the allow state.
   */
  const [hasControl, setHasControl] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  // Survives the await in `onConnect` — an unmount mid-pair must not set state.
  const alive = useRef(true);

  const refreshStatus = useCallback(async () => {
    const next = await getBrowserExtensionStatus();
    if (!alive.current) return;
    setStatus(next);
    // Only worth asking the extension once the relay says this user has one
    // connected; off that path the probe is a guaranteed null.
    if (!next.connected) {
      setHasControl(null);
      return;
    }
    const control = await extensionHasControl({ send: chromeMessenger() });
    if (alive.current) setHasControl(control);
  }, []);

  useEffect(() => {
    alive.current = true;
    void refreshStatus();
    const id = setInterval(() => void refreshStatus(), STATUS_POLL_MS);
    const onFocus = () => void refreshStatus();
    window.addEventListener("focus", onFocus);
    return () => {
      alive.current = false;
      clearInterval(id);
      window.removeEventListener("focus", onFocus);
    };
  }, [refreshStatus]);

  const connected = status?.connected === true;
  // Paired, but the user has not granted browser control. Only an explicit
  // `false` counts — see `hasControl`.
  const needsControl = connected && hasControl === false;

  const onClick = useCallback(async () => {
    if (busy) return;
    // Paired but not allowed to drive: the one thing worth doing is asking for
    // the permission. Chrome will not let a web page raise its own prompt, so
    // the extension opens the window that can and the user clicks Allow there.
    if (needsControl) {
      setBusy(true);
      const result = await requestBrowserControl({ send: chromeMessenger() });
      if (alive.current) setBusy(false);
      // `not_installed` here means the extension stopped answering between the
      // probe and the click. The panel is the honest fallback: it owns the
      // install CTA, which is the actual remedy.
      if (result === "not_installed") openWorkspaceSettings("ws-browser-profiles");
      else await refreshStatus();
      return;
    }
    // Connected: nothing to pair, so the click is "let me look at this" —
    // hand it to the panel, which owns profiles + disconnect.
    if (connected || !workspaceId) {
      openWorkspaceSettings("ws-browser-profiles");
      return;
    }
    setBusy(true);
    const pairing = await pairBrowserExtension(workspaceId);
    if (!pairing) {
      // The mint failed (relay down, 503). The panel surfaces the error copy;
      // repeating it in a sidebar row would only shout the same thing twice.
      if (alive.current) setBusy(false);
      openWorkspaceSettings("ws-browser-profiles");
      return;
    }
    const result = await pairViaExtension({
      relayUrl: pairing.relayUrl,
      pairingToken: pairing.pairingToken,
      send: chromeMessenger(),
    });
    if (alive.current) setBusy(false);
    if (result === "paired") {
      await refreshStatus();
      return;
    }
    // Not installed, wrong build id, or refused: the panel has the install CTA
    // and the copy fields, and the token we just minted is still valid there.
    openWorkspaceSettings("ws-browser-profiles");
  }, [busy, connected, needsControl, workspaceId, refreshStatus]);

  // No relay on this deployment (OSS, or unconfigured) — and nothing rendered
  // until the first probe answers, so the label never flips under the cursor.
  if (!status?.configured) return null;

  return (
    <div className="px-2 pb-1.5">
      <button
        type="button"
        onClick={() => void onClick()}
        disabled={busy}
        aria-label={
          needsControl ? c.allowAria : connected ? c.manageAria : c.connectAria
        }
        title={needsControl ? c.allowAria : connected ? c.manageAria : c.connectAria}
        className="flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] text-sidebar-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-foreground disabled:opacity-60"
      >
        <Globe className="size-[15px] shrink-0" />
        <span className="min-w-0 flex-1 truncate">
          {busy
            ? c.connecting
            : needsControl
              ? c.allow
              : connected
                ? c.connected
                : c.connect}
        </span>
        {connected && !needsControl && !busy ? (
          <span className="flex shrink-0 items-center gap-1 text-[10px] font-medium text-muted-foreground">
            <span className="size-1.5 rounded-full bg-primary" aria-hidden />
            {c.connectedBadge}
          </span>
        ) : null}
      </button>
    </div>
  );
}
