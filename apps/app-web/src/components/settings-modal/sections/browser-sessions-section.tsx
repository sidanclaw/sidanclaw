"use client";

/**
 * Session Management (computer-use.md §7, plan §4.10): the sites the
 * assistant holds a vaulted, signed-in browser session for — list + revoke.
 * Revoking deletes the saved session bundle only; the user's real account on
 * the site is untouched, and the next task there asks them to sign in again.
 *
 * [COMP:app-web/session-management]
 */

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { useT } from "@/lib/i18n/client";
import { confirmDialog } from "@/components/ui/confirm-dialog";
import {
  listBrowserSessions,
  revokeBrowserSession,
  type VaultedSession,
} from "@/lib/api/computer";

export function BrowserSessionsSection() {
  const t = useT();
  const params = useParams<{ workspaceId?: string }>();
  const workspaceId = params?.workspaceId ?? "";

  const [state, setState] = useState<
    | { kind: "loading" }
    | { kind: "unconfigured" }
    | { kind: "ready"; sessions: VaultedSession[] }
    | { kind: "error" }
  >({ kind: "loading" });

  const reload = useCallback(async () => {
    if (!workspaceId) {
      setState({ kind: "unconfigured" });
      return;
    }
    try {
      const res = await listBrowserSessions(workspaceId);
      setState(res.configured ? { kind: "ready", sessions: res.sessions } : { kind: "unconfigured" });
    } catch {
      setState({ kind: "error" });
    }
  }, [workspaceId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const onRevoke = useCallback(
    async (site: string) => {
      const confirmed = await confirmDialog({
        title: t.computer.sessions.revokeConfirmTitle,
        description: t.computer.sessions.revokeConfirmBody.replace("{site}", site),
        confirmLabel: t.computer.sessions.revokeConfirmAction,
      });
      if (!confirmed) return;
      await revokeBrowserSession(workspaceId, site).catch(() => {});
      void reload();
    },
    [reload, t, workspaceId],
  );

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-sm font-medium">{t.computer.sessions.title}</h3>
        <p className="mt-1 text-xs text-muted-foreground">{t.computer.sessions.description}</p>
      </div>

      {state.kind === "loading" ? (
        <p className="text-xs text-muted-foreground">…</p>
      ) : state.kind === "unconfigured" ? (
        <p className="text-xs text-muted-foreground">{t.computer.sessions.notConfigured}</p>
      ) : state.kind === "error" ? (
        <p className="text-xs text-destructive">{t.computer.sessions.loadFailed}</p>
      ) : state.sessions.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t.computer.sessions.empty}</p>
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {state.sessions.map((session) => (
            <li key={session.site} className="flex items-center justify-between gap-3 px-3 py-2.5">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium">{session.site}</span>
                  <span
                    className={
                      session.status === "active"
                        ? "rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary"
                        : "rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground"
                    }
                  >
                    {session.status === "active"
                      ? t.computer.sessions.statusActive
                      : t.computer.sessions.statusDead}
                  </span>
                </div>
                <p className="mt-0.5 text-[11px] text-muted-foreground">
                  {t.computer.sessions.lastUsed}:{" "}
                  {session.lastUsedAt
                    ? new Date(session.lastUsedAt).toLocaleDateString()
                    : t.computer.sessions.never}
                </p>
              </div>
              <button
                type="button"
                onClick={() => void onRevoke(session.site)}
                className="shrink-0 rounded-md border border-destructive/40 px-2.5 py-1 text-xs font-medium text-destructive hover:bg-destructive/10"
              >
                {t.computer.sessions.revoke}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
