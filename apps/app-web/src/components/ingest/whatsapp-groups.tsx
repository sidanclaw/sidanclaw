/**
 * WhatsApp group ingest UI for the Studio - Events page.
 *
 * `WhatsappEventSource` renders WhatsApp as one of the Events page's ingest
 * source cards (same chrome as GitHub/Slack/etc.), with the group enable/disable
 * list (`WhatsappGroupManager`) as its body. It self-hides for workspaces that
 * have never connected a WhatsApp number, and shows a "reconnect in Channels"
 * note when the linked device was logged out (pairing stays on the Channels
 * card, where the channel is added).
 *
 * The group list moved here from the WhatsApp channel card as part of the
 * Channels/Events split: Channels owns the chat/broadcast surface (connect +
 * bot/replies), Events owns ingestion. See docs/architecture/channels/whatsapp.md
 * -> "Studio UI".
 *
 * [COMP:app-web/studio-whatsapp-ingest]
 */

"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { ConnectorIcon } from "@/components/connectors/connector-icon";
import { useT } from "@/lib/i18n/client";
import { format } from "@/lib/i18n/format";
import {
  getWhatsappIngest,
  enableWhatsappGroup,
  disableWhatsappGroup,
  type WhatsappGroup,
  type WhatsappGroupRouting,
  type WhatsappIngestStatus,
} from "@/lib/api/whatsapp-ingest";

/**
 * WhatsApp source card for the Events page. Self-fetches connection state and
 * renders null when the workspace has no WhatsApp integration (so it only
 * appears for WhatsApp users). `onPresence` lets the page suppress its generic
 * "no sources" empty state when this card is showing.
 */
export function WhatsappEventSource({
  workspaceId,
  onPresence,
}: {
  workspaceId: string;
  onPresence?: (present: boolean) => void;
}) {
  const t = useT();
  const copy = t.studioPage.ingestRules;
  const wa = copy.whatsapp;
  const [status, setStatus] = useState<WhatsappIngestStatus | null>(null);

  const load = useCallback(() => {
    getWhatsappIngest(workspaceId)
      .then(setStatus)
      .catch(() => setStatus(null));
  }, [workspaceId]);

  useEffect(() => {
    load();
  }, [load]);

  // A WhatsApp integration exists once a number has ever been paired (connected
  // now, or revoked but still on file). Never-connected workspaces see nothing.
  const present =
    status !== null && (status.connected || status.connectedNumber !== null);

  useEffect(() => {
    if (status !== null) onPresence?.(present);
  }, [status, present, onPresence]);

  if (!present || status === null) return null;

  const enabledCount = status.groups.filter((g) => g.enabled).length;
  const channelsHref = `/w/${workspaceId}/studio/channels`;

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card">
      <div className="flex items-center gap-3 px-5 py-4">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted">
          <ConnectorIcon connectorId="whatsapp" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium">{wa.sourceLabel}</span>
            <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
              {copy.scopeWorkspace}
            </span>
          </div>
          <div className="truncate text-[11px] text-muted-foreground">
            {status.connectedNumber ?? copy.natureEvents}
          </div>
        </div>
        <span
          className={
            "shrink-0 rounded-full px-2 py-0.5 text-xs font-medium " +
            (enabledCount > 0
              ? "bg-primary/10 text-primary"
              : "bg-muted text-muted-foreground")
          }
        >
          {enabledCount > 0 ? copy.statusOn : copy.statusOff}
        </span>
      </div>

      {!status.connected ? (
        <div className="px-5 pb-3 text-[11px] text-amber-600 dark:text-amber-400">
          {wa.reconnectInChannels}{" "}
          <Link href={channelsHref} className="font-medium underline">
            {wa.reconnectInChannelsCta}
          </Link>
        </div>
      ) : (
        <div className="border-t border-border bg-muted/20 px-5 py-3">
          <WhatsappGroupManager workspaceId={workspaceId} />
        </div>
      )}
    </div>
  );
}

/**
 * The group enable/disable list. A personal number can be in hundreds of
 * groups; the API returns enabled-and-recently-active first, so the initial
 * render is capped and a search finds any other by name. Routing is digest-only
 * (realtime is soft-disabled to cap token cost).
 */
export function WhatsappGroupManager({ workspaceId }: { workspaceId: string }) {
  const t = useT();
  const wa = t.studioPage.ingestRules.whatsapp;
  const [groups, setGroups] = useState<WhatsappGroup[] | null>(null);
  const [query, setQuery] = useState("");

  const load = useCallback(() => {
    getWhatsappIngest(workspaceId)
      .then((s) => setGroups(s.groups))
      .catch(() => setGroups([]));
  }, [workspaceId]);

  useEffect(() => {
    load();
  }, [load]);

  const CAP = 12;
  const all = groups ?? [];
  const q = query.trim().toLowerCase();
  const matches = q
    ? all.filter((g) => (g.title ?? "").toLowerCase().includes(q))
    : all;
  const shown = q ? matches : matches.slice(0, CAP);
  const more = matches.length - shown.length;

  return (
    <div className="flex flex-col gap-2">
      <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {wa.groupsTitle}
      </div>
      {all.length > CAP && (
        <div className="relative">
          <svg
            aria-hidden
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
          >
            <circle cx="11" cy="11" r="8" />
            <path d="m21 21-4.3-4.3" />
          </svg>
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={wa.groupSearchPlaceholder}
            className="w-full rounded-md border border-border bg-background py-2 pl-9 pr-3 text-sm placeholder:text-muted-foreground focus:border-primary/40 focus:outline-none focus:ring-2 focus:ring-primary/30"
          />
        </div>
      )}
      {groups === null ? (
        <p className="text-xs text-muted-foreground">{wa.working}</p>
      ) : all.length === 0 ? (
        <p className="text-xs leading-relaxed text-muted-foreground">
          {wa.groupsEmpty}
        </p>
      ) : shown.length === 0 ? (
        <p className="text-xs text-muted-foreground">{wa.groupsNoMatch}</p>
      ) : (
        <>
          <ul className="flex flex-col gap-2">
            {shown.map((g) => (
              <WhatsappGroupRow
                key={g.chatJid}
                group={g}
                workspaceId={workspaceId}
                onChange={load}
              />
            ))}
          </ul>
          {more > 0 && (
            <p className="text-[11px] text-muted-foreground">
              {format(wa.groupsMoreHint, { n: more })}
            </p>
          )}
        </>
      )}
    </div>
  );
}

function WhatsappGroupRow({
  group,
  workspaceId,
  onChange,
}: {
  group: WhatsappGroup;
  workspaceId: string;
  onChange: () => void;
}) {
  const t = useT();
  const wa = t.studioPage.ingestRules.whatsapp;
  const [busy, setBusy] = useState(false);

  async function setEnabled(enabled: boolean, routing: WhatsappGroupRouting) {
    setBusy(true);
    try {
      if (enabled) await enableWhatsappGroup(workspaceId, group.chatJid, routing);
      else await disableWhatsappGroup(workspaceId, group.chatJid);
      onChange();
    } finally {
      setBusy(false);
    }
  }

  return (
    <li
      className={
        "flex items-center gap-2.5 rounded-md border px-3 py-2 transition-colors " +
        (group.enabled
          ? "border-emerald-500/40 bg-emerald-500/10"
          : "border-border bg-card")
      }
    >
      <span
        aria-hidden
        className={
          "size-2 shrink-0 rounded-full " +
          (group.enabled ? "bg-emerald-500" : "bg-muted-foreground/30")
        }
      />
      <span
        className={
          "min-w-0 flex-1 truncate text-xs " +
          (group.enabled ? "font-semibold" : "font-medium text-muted-foreground")
        }
      >
        {group.title ?? wa.untitledGroup}
      </span>
      {/* Routing is digest-only: realtime (per-message extraction) is disabled
          to cap token cost, so there's no picker - enabled groups always run on
          the weekday digest. See docs/architecture/channels/whatsapp.md ->
          "Routing (digest-only)". */}
      {group.enabled && (
        <span className="shrink-0 text-[10px] text-muted-foreground">
          {wa.routingScheduled}
        </span>
      )}
      <button
        type="button"
        onClick={() => void setEnabled(!group.enabled, "scheduled")}
        disabled={busy}
        className={
          "shrink-0 rounded-md px-2.5 py-1 text-xs font-medium transition-colors disabled:opacity-50 " +
          (group.enabled
            ? "border border-border text-muted-foreground hover:text-destructive"
            : "bg-primary text-primary-foreground hover:bg-primary/90")
        }
      >
        {busy ? wa.working : group.enabled ? wa.disableAction : wa.enableAction}
      </button>
    </li>
  );
}
