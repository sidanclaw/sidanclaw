"use client";

/**
 * "Link a recording" — the empty-state control on a page that has NO recording
 * (neither a synthesis `anchor_key` nor a manual link).
 *
 * A hand-authored page can point at any recording already in the workspace and
 * surface its player, transcript, and action items — the same chrome a
 * synthesized brief gets, but chosen rather than derived. This is the entry
 * point; the link itself lives in `saved_views.linked_recording_id`
 * (migration 339), and the doc shell resolves the anchor-derived recording
 * first, so this only ever appears when there is nothing to fall back to.
 *
 * The recording list is fetched LAZILY, on first expand — most doc pages are
 * not recording pages, so an unconditional fetch on every page open would be
 * pure waste. A themed `SearchableSelect`, never a native picker.
 *
 * [COMP:app-web/recording-chrome]
 */

import { useCallback, useState } from "react";
import { useT } from "@/lib/i18n/client";
import { listRecordings } from "@/lib/api/recordings";
import { setPageLinkedRecording, type ViewMetadata } from "@/lib/api/views";
import { recordingTitle, formatDuration } from "@/lib/recordings/recordings-board";
import { SearchableSelect, type SearchableSelectItem } from "@/components/ui/searchable-select";

export function RecordingLinkControl({
  viewId,
  workspaceId,
  onLinked,
}: {
  viewId: string;
  workspaceId: string;
  /** The updated page metadata after a successful link — drives the chrome in. */
  onLinked: (meta: ViewMetadata) => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<SearchableSelectItem[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [saving, setSaving] = useState(false);

  const expand = useCallback(async () => {
    setOpen(true);
    if (items) return; // already fetched
    setLoading(true);
    try {
      const rows = await listRecordings(workspaceId, { limit: 100 });
      setItems(
        rows.map((r) => {
          const dur = formatDuration(r.durationMs);
          return {
            value: r.recordingId,
            // Title first, duration as a quiet suffix — enough to disambiguate
            // two calls with the same name without a second column.
            label: dur
              ? `${recordingTitle(r, t.recordings.panelUntitled)} · ${dur}`
              : recordingTitle(r, t.recordings.panelUntitled),
          };
        }),
      );
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [items, workspaceId, t]);

  const pick = useCallback(
    async (recordingId: string) => {
      if (!recordingId) return;
      setSaving(true);
      try {
        const meta = await setPageLinkedRecording(viewId, recordingId);
        onLinked(meta);
      } catch {
        setError(true);
      } finally {
        setSaving(false);
      }
    },
    [viewId, onLinked],
  );

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => void expand()}
        className="mb-4 inline-flex w-fit items-center gap-1.5 rounded-md border border-dashed border-border px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-muted/60"
      >
        <span aria-hidden>＋</span>
        {t.recordings.linkTitle}
      </button>
    );
  }

  return (
    <div className="mb-4 flex flex-wrap items-center gap-2 rounded-md border border-border bg-muted/20 px-3 py-2">
      <span className="text-sm font-medium">{t.recordings.linkTitle}</span>
      {error ? (
        <span className="text-sm text-muted-foreground">{t.recordings.linkError}</span>
      ) : (
        <SearchableSelect
          value=""
          onValueChange={(v) => void pick(v)}
          items={items ?? []}
          disabled={loading || saving}
          placeholder={loading ? t.recordings.linkLoading : t.recordings.linkPlaceholder}
          searchPlaceholder={t.recordings.linkSearchPlaceholder}
          aria-label={t.recordings.linkTitle}
          className="w-64"
          popupClassName="w-72"
        />
      )}
      <button
        type="button"
        onClick={() => setOpen(false)}
        disabled={saving}
        className="rounded px-2 py-0.5 text-xs text-muted-foreground hover:bg-muted disabled:opacity-50"
      >
        {t.recordings.linkCancel}
      </button>
    </div>
  );
}
