"use client";

/**
 * Blueprints library — the Blueprints section's landing in the Brain surface.
 *
 * Blueprints and skills are sibling specs (one is structural, one procedural),
 * so this reuses the `SkillsLibrary` pattern: a QUIET LIST of full-width
 * borderless rows (`border-b`, `hover:bg-muted/40`, no card borders, no primary
 * blue). Each row carries a blueprint glyph, the name + description, a quiet
 * section-count meta, and a "Blueprint" badge; a trailing Delete asks through
 * `confirmDialog` (NEVER `window.confirm`). A "+ New blueprint" affordance seeds
 * a blank blueprint doc (a heading + an empty extraction slot) and opens it in
 * the editor.
 *
 * A BLUEPRINT is a workspace page template carrying an `extraction` spec; the
 * list API returns every template, so the filter (`filterBlueprints`) keeps only
 * the ones with a spec. The pure filter + the section-count helper live in
 * `lib/blueprints.ts` so they're unit-tested (app-web has no component-render
 * test setup).
 *
 * Spec: docs/architecture/brain/structural-synthesis.md -> "The blueprint
 * object" ("Blueprints are managed in a Brain -> Blueprints library").
 *
 * [COMP:web/blueprints-library]
 */

import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight, ExternalLink, FileStack, Plus, Sparkles, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { cn } from "@/lib/utils";
import { useT, format } from "@/lib/i18n/client";
import type { CustomPageTemplateSummary } from "@sidanclaw/doc-model";
import {
  blueprintSectionCount,
  filterBlueprints,
} from "@/lib/blueprints";
import {
  estimateBlueprintGenerate,
  generateBlueprintFromBrain,
  listBlueprintRecords,
  openBlueprintRecordPage,
  type BlueprintRecordSummary,
} from "@/lib/api/views";
import { docPagePath } from "@/lib/doc-page-url";
import { confirmDialog } from "@/components/ui/confirm-dialog";
import { promptDialog } from "@/components/ui/prompt-dialog";
import { Button } from "@/components/ui/button";

type Props = {
  workspaceId: string;
  /** `null` ⇒ still loading (the Brain page owns the fetch + refresh). */
  blueprints: CustomPageTemplateSummary[] | null;
  /** Free-text needle (the shared Brain `search`); matches name + description. */
  search: string;
  /** Seeds + opens a blank blueprint doc (the Brain page owns the create flow). */
  onNewBlueprint: () => void;
  /** Delete a blueprint after a confirm resolves true (the page does the API call). */
  onDeleteBlueprint: (template: CustomPageTemplateSummary) => void;
};

export function BlueprintsLibrary({
  workspaceId,
  blueprints,
  search,
  onNewBlueprint,
  onDeleteBlueprint,
}: Props) {
  const t = useT();
  const copy = t.brainPage.blueprints;
  const router = useRouter();

  // Generate-from-brain: estimate the credit cost, confirm with the subject,
  // fill the blueprint, then open the produced page. Credit-metered on the
  // server (POST .../generate charges a surcharge on success). See
  // docs/architecture/brain/structural-synthesis.md -> "Generate is user-surfaced".
  async function handleGenerate(blueprint: CustomPageTemplateSummary) {
    let credits: number;
    try {
      const est = await estimateBlueprintGenerate(workspaceId, blueprint.id);
      credits = est.surchargeCredits;
    } catch {
      await confirmDialog({
        title: copy.generateErrorTitle,
        description: copy.generateEstimateError,
        confirmLabel: copy.generateErrorOk,
      });
      return;
    }
    const subject = await promptDialog({
      title: copy.generateTitle,
      // Cost + what the run produces (preflight-confirmation invariant: the
      // confirm states both the price and the output shape — record + page).
      description: `${
        credits === 1 ? copy.generateCostOne : format(copy.generateCostMany, { count: credits })
      } ${copy.generateRendersPage}`,
      placeholder: copy.generateSubjectPlaceholder,
      confirmLabel: copy.generateConfirm,
      cancelLabel: copy.generateCancel,
    });
    if (!subject) return;
    try {
      const result = await generateBlueprintFromBrain(workspaceId, blueprint.id, {
        subject,
        requestId: crypto.randomUUID(),
      });
      if (result.pageId) {
        router.push(docPagePath(workspaceId, result.pageId));
      } else {
        await confirmDialog({
          title: copy.generateErrorTitle,
          description: copy.generateNoPage,
          confirmLabel: copy.generateErrorOk,
        });
      }
    } catch (err) {
      const outOfCredits = String(err).includes("HTTP 402");
      await confirmDialog({
        title: copy.generateErrorTitle,
        description: outOfCredits ? copy.generateCreditLimit : copy.generateFailed,
        confirmLabel: copy.generateErrorOk,
      });
    }
  }

  // Blueprint subset (templates with an extraction spec), name-sorted, then the
  // shared search needle over name + description.
  const list = useMemo(() => {
    const onlyBlueprints = filterBlueprints(blueprints ?? []);
    const needle = search.trim().toLowerCase();
    if (!needle) return onlyBlueprints;
    return onlyBlueprints.filter((b) =>
      `${b.name} ${b.description ?? ""}`.toLowerCase().includes(needle),
    );
  }, [blueprints, search]);

  const hasSearch = search.trim().length > 0;

  return (
    <div className="flex-1 min-h-0 overflow-y-auto bg-background">
      {/* pb-28 clears the fixed chat dock floated over the surface bottom-right. */}
      <div className="flex flex-col pb-28">
        {blueprints === null ? (
          <div className="py-16 text-center text-sm text-muted-foreground">
            …
          </div>
        ) : filterBlueprints(blueprints).length === 0 ? (
          <div className="mx-4 mt-4 flex flex-col items-center gap-1.5 rounded-md border border-dashed border-border bg-card/50 px-4 py-10 text-center">
            <p className="text-sm font-medium text-foreground">
              {copy.emptyTitle}
            </p>
            <p className="max-w-md text-xs leading-relaxed text-muted-foreground">
              {copy.emptyBody}
            </p>
            <Button
              variant="outline"
              size="sm"
              onClick={onNewBlueprint}
              className="mt-2"
            >
              {copy.newBlueprint}
            </Button>
          </div>
        ) : list.length === 0 && hasSearch ? (
          <div className="py-16 text-center text-sm text-muted-foreground">
            {copy.noMatches}
          </div>
        ) : (
          <ul className="flex flex-col">
            {list.map((blueprint) => (
              <BlueprintRow
                key={blueprint.id}
                workspaceId={workspaceId}
                blueprint={blueprint}
                onGenerate={() => void handleGenerate(blueprint)}
                onDelete={() => onDeleteBlueprint(blueprint)}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function BlueprintRow({
  workspaceId,
  blueprint,
  onGenerate,
  onDelete,
}: {
  workspaceId: string;
  blueprint: CustomPageTemplateSummary;
  onGenerate: () => void;
  onDelete: () => void;
}) {
  const t = useT();
  const copy = t.brainPage.blueprints;
  const router = useRouter();
  const sections = blueprintSectionCount(blueprint);

  // Records — the blueprint's typed output rows (schema → rows mental model).
  // Lazily fetched on first expand; the page is only a projection, so a row
  // may have no page until "Open as page" renders one.
  const [expanded, setExpanded] = useState(false);
  const [records, setRecords] = useState<BlueprintRecordSummary[] | null>(null);
  const [recordsError, setRecordsError] = useState(false);
  const [openingId, setOpeningId] = useState<string | null>(null);

  async function toggleRecords() {
    const next = !expanded;
    setExpanded(next);
    if (next && records === null) {
      try {
        setRecordsError(false);
        setRecords(await listBlueprintRecords(workspaceId, blueprint.id));
      } catch {
        setRecordsError(true);
      }
    }
  }

  async function handleOpenPage(record: BlueprintRecordSummary) {
    setOpeningId(record.id);
    try {
      const { pageId } = await openBlueprintRecordPage(workspaceId, record.id);
      router.push(docPagePath(workspaceId, pageId));
    } catch {
      await confirmDialog({
        title: copy.generateErrorTitle,
        description: copy.recordOpenPageFailed,
        confirmLabel: copy.generateErrorOk,
      });
    } finally {
      setOpeningId(null);
    }
  }

  async function handleDelete() {
    const ok = await confirmDialog({
      title: copy.deleteTitle,
      description: format(copy.deleteBody, { name: blueprint.name }),
      confirmLabel: copy.deleteConfirm,
      cancelLabel: copy.deleteCancel,
      variant: "destructive",
    });
    if (ok) onDelete();
  }

  const sourceLabel: Record<BlueprintRecordSummary["sourceKind"], string> = {
    recording: copy.recordSourceRecording,
    brain: copy.recordSourceBrain,
    research: copy.recordSourceResearch,
    chat: copy.recordSourceChat,
    workflow: copy.recordSourceWorkflow,
  };

  return (
    <li className="border-b border-border">
    <div className="group flex items-center">
      {/* Records expander — quiet chevron, same hover language as the actions. */}
      <div className="shrink-0 pl-2">
        <button
          type="button"
          aria-label={format(copy.recordsToggleAria, { name: blueprint.name })}
          aria-expanded={expanded}
          onClick={() => void toggleRecords()}
          className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          {expanded ? (
            <ChevronDown className="size-4" aria-hidden />
          ) : (
            <ChevronRight className="size-4" aria-hidden />
          )}
        </button>
      </div>
      <div className="flex-1 min-w-0 flex items-center gap-3 px-2 py-3">
        {/* Blueprint glyph — the template's own emoji if set, else a stack icon. */}
        {blueprint.icon ? (
          <span aria-hidden className="shrink-0 text-base leading-none">
            {blueprint.icon}
          </span>
        ) : (
          <FileStack
            aria-hidden
            className="size-4 shrink-0 text-muted-foreground"
          />
        )}

        <span className="flex-1 min-w-0 flex flex-col">
          <span className="text-sm font-medium truncate">{blueprint.name}</span>
          {blueprint.description && (
            <span className="text-xs text-muted-foreground truncate">
              {blueprint.description}
            </span>
          )}
        </span>

        {/* Quiet right-side meta — section count, muted text, no box. */}
        <span className="hidden sm:inline shrink-0 text-[11px] text-muted-foreground tabular-nums">
          {sections === 1
            ? copy.sectionsOne
            : format(copy.sectionsMany, { count: sections })}
        </span>

        {/* The one badge — "Blueprint", in the same recipe the skills row uses. */}
        <span className="hidden md:inline-block shrink-0 px-1.5 py-0.5 rounded text-[10px] uppercase tracking-wide font-medium border border-border bg-muted/40 text-muted-foreground">
          {copy.badge}
        </span>
      </div>

      {/* Generate from brain — fill this blueprint from memory into a new page. */}
      <div className="shrink-0 pl-3">
        <button
          type="button"
          aria-label={format(copy.generateAria, { name: blueprint.name })}
          title={copy.generateTitle}
          onClick={onGenerate}
          className={cn(
            "rounded p-1 text-muted-foreground opacity-0 transition-opacity",
            "hover:bg-muted hover:text-foreground group-hover:opacity-100",
            "focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
          )}
        >
          <Sparkles className="size-4" aria-hidden />
        </button>
      </div>

      {/* Delete — confirms through the on-brand dialog, never window.confirm. */}
      <div className="shrink-0 pr-3">
        <button
          type="button"
          aria-label={format(copy.deleteAria, { name: blueprint.name })}
          title={copy.deleteTitle}
          onClick={() => void handleDelete()}
          className={cn(
            "rounded p-1 text-muted-foreground opacity-0 transition-opacity",
            "hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100",
            "focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
          )}
        >
          <Trash2 className="size-4" aria-hidden />
        </button>
      </div>
    </div>

    {/* Records under the blueprint — rows of a schema, quiet sub-list. */}
    {expanded && (
      <div className="pl-11 pr-4 pb-3">
        <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          {copy.recordsTitle}
        </p>
        {recordsError ? (
          <p className="mt-1.5 text-xs text-muted-foreground">{copy.recordsLoadFailed}</p>
        ) : records === null ? (
          <p className="mt-1.5 text-xs text-muted-foreground">…</p>
        ) : records.length === 0 ? (
          <p className="mt-1.5 text-xs text-muted-foreground">{copy.recordsEmpty}</p>
        ) : (
          <ul className="mt-1.5 flex flex-col gap-0.5">
            {records.map((record) => (
              <li
                key={record.id}
                className="group/record flex items-center gap-2 rounded px-1.5 py-1 hover:bg-muted/40"
              >
                <span className="flex-1 min-w-0 truncate text-xs text-foreground">
                  {record.subject}
                </span>
                <span
                  className={cn(
                    "shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium border",
                    record.status === "complete"
                      ? "border-border bg-muted/40 text-muted-foreground"
                      : "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400",
                  )}
                  title={
                    record.status === "incomplete" && record.missing.length > 0
                      ? format(copy.recordMissingHint, { keys: record.missing.join(", ") })
                      : undefined
                  }
                >
                  {record.status === "complete"
                    ? copy.recordStatusComplete
                    : copy.recordStatusIncomplete}
                </span>
                <span className="hidden sm:inline shrink-0 text-[11px] text-muted-foreground">
                  {sourceLabel[record.sourceKind]}
                </span>
                <span className="hidden md:inline shrink-0 text-[11px] text-muted-foreground tabular-nums">
                  {new Date(record.updatedAt).toLocaleDateString()}
                </span>
                <button
                  type="button"
                  aria-label={format(copy.recordOpenPageAria, { subject: record.subject })}
                  title={copy.recordOpenPage}
                  disabled={openingId === record.id}
                  onClick={() => void handleOpenPage(record)}
                  className={cn(
                    "shrink-0 rounded p-1 text-muted-foreground opacity-0 transition-opacity",
                    "hover:bg-muted hover:text-foreground group-hover/record:opacity-100",
                    "focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
                    openingId === record.id && "opacity-60",
                  )}
                >
                  <ExternalLink className="size-3.5" aria-hidden />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    )}
    </li>
  );
}
