/**
 * SDK for the computer-use web surface (app-web).
 *
 * Wraps `authFetch` over the routes mounted at `/api/computer` in
 * `packages/api/src/boot.ts`:
 *
 *   GET    /api/computer/tasks/:sessionId            active task summary
 *   POST   /api/computer/tasks/:sessionId/resume     resume for Take-Over
 *   GET    /api/computer/tasks/:sessionId/frame      one screencast frame
 *   POST   /api/computer/tasks/:sessionId/input      relay a click/key/scroll
 *   POST   /api/computer/tasks/:sessionId/captured   vault the signed-in session
 *   POST   /api/computer/tasks/:sessionId/complete   close-to-stop
 *   GET    /api/computer/sessions?workspaceId=       Session Management list
 *   DELETE /api/computer/sessions/:site?workspaceId= revoke a vaulted session
 *
 * Spec: docs/architecture/engine/computer-use.md §5, §7.
 */

import { authFetch } from "@/lib/auth-fetch";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

export type ComputerTask = {
  taskId: string;
  status: "running" | "paused" | "completed" | "failed";
  injectedSite: string | null;
  workspaceId: string;
  createdAt: number;
};

export type TakeoverFrame = { data: string; mimeType: string };

export type TakeoverInput =
  | { kind: "click"; x: number; y: number }
  | { kind: "key"; text: string }
  | { kind: "scroll"; deltaY: number };

export type VaultedSession = {
  site: string;
  capturedAt: string;
  lastUsedAt: string | null;
  status: "active" | "dead";
};

export async function getComputerTask(sessionId: string): Promise<ComputerTask | null> {
  const res = await authFetch(`${API_URL}/api/computer/tasks/${encodeURIComponent(sessionId)}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`computer task lookup failed (${res.status})`);
  return (await res.json()) as ComputerTask;
}

export async function resumeComputerTask(sessionId: string): Promise<void> {
  await authFetch(`${API_URL}/api/computer/tasks/${encodeURIComponent(sessionId)}/resume`, {
    method: "POST",
  });
}

export async function getComputerFrame(sessionId: string): Promise<TakeoverFrame | null> {
  const res = await authFetch(`${API_URL}/api/computer/tasks/${encodeURIComponent(sessionId)}/frame`);
  if (!res.ok || res.status === 204) return null;
  return (await res.json()) as TakeoverFrame;
}

export async function sendComputerInput(sessionId: string, event: TakeoverInput): Promise<boolean> {
  const res = await authFetch(`${API_URL}/api/computer/tasks/${encodeURIComponent(sessionId)}/input`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(event),
  });
  return res.ok;
}

export async function markComputerSessionCaptured(sessionId: string, site: string): Promise<boolean> {
  const res = await authFetch(
    `${API_URL}/api/computer/tasks/${encodeURIComponent(sessionId)}/captured`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ site }),
    },
  );
  return res.ok;
}

export async function completeComputerTask(
  sessionId: string,
  outcome: "completed" | "failed" = "completed",
): Promise<void> {
  await authFetch(`${API_URL}/api/computer/tasks/${encodeURIComponent(sessionId)}/complete`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ outcome }),
  });
}

export async function listBrowserSessions(
  workspaceId: string,
): Promise<{ configured: boolean; sessions: VaultedSession[] }> {
  const res = await authFetch(
    `${API_URL}/api/computer/sessions?workspaceId=${encodeURIComponent(workspaceId)}`,
  );
  if (!res.ok) throw new Error(`browser sessions list failed (${res.status})`);
  return (await res.json()) as { configured: boolean; sessions: VaultedSession[] };
}

export async function revokeBrowserSession(workspaceId: string, site: string): Promise<boolean> {
  const res = await authFetch(
    `${API_URL}/api/computer/sessions/${encodeURIComponent(site)}?workspaceId=${encodeURIComponent(workspaceId)}`,
    { method: "DELETE" },
  );
  return res.ok;
}
