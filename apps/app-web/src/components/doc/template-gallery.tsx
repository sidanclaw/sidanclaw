"use client";

/**
 * Page template gallery — the "/template" slash action's chooser.
 *
 * A centered modal that lists the shared Notion-style page templates
 * (`@sidanclaw/core` `listPageTemplates` — the same catalog the brain-MCP
 * `listPageTemplates` / `createPageFromTemplate` tools read), grouped by
 * category and filtered as you type. Picking one calls `onPick(templateId)`;
 * the editor (`collab-page-editor`) instantiates the template and inserts its
 * blocks at the caret the slash menu was invoked on.
 *
 * One-tap: clicking (or Enter on the highlighted row) resolves immediately,
 * matching `kind-picker-dialog`'s Notion-style interaction. Keyboard: typing
 * filters, ArrowUp/ArrowDown move the highlight, Enter picks, Esc closes
 * (base-ui Dialog owns Esc + click-outside + focus trap).
 *
 * [COMP:app-web/template-gallery]
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { Search } from "lucide-react";
import {
  listPageTemplates,
  type PageTemplateCategory,
  type PageTemplateSummary,
} from "@sidanclaw/doc-model";

import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n/client";

export type TemplateGalleryProps = {
  /** Called with the chosen template id (one-tap). */
  onPick: (templateId: string) => void;
  /** Called when the gallery is dismissed without a pick. */
  onClose: () => void;
};

/** Category render order — mirrors the gallery's grouping intent. */
const CATEGORY_ORDER: readonly PageTemplateCategory[] = [
  "meeting",
  "planning",
  "team",
  "personal",
  "knowledge",
];

/**
 * Pure filter: match `query` (trimmed, case-insensitive) against a template's
 * name, description, and keywords. An empty query returns every row. Exported
 * for unit testing (app-web's vitest is node-only, so the DOM glue is not
 * covered here).
 */
export function filterTemplates(
  query: string,
  all: PageTemplateSummary[],
): PageTemplateSummary[] {
  const q = query.trim().toLowerCase();
  if (!q) return all;
  return all.filter((t) => {
    const haystack = `${t.name} ${t.description} ${t.keywords.join(" ")}`.toLowerCase();
    return haystack.includes(q);
  });
}

export function TemplateGallery({ onPick, onClose }: TemplateGalleryProps) {
  const t = useT().docPage.templateGallery;
  const all = useMemo(() => listPageTemplates(), []);
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const matches = useMemo(() => filterTemplates(query, all), [query, all]);

  // Keep the highlight in range as the filtered list shrinks/grows.
  useEffect(() => {
    setSelectedIndex((i) => (i >= matches.length ? 0 : i));
  }, [matches.length]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIndex((i) => (matches.length ? (i + 1) % matches.length : 0));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex((i) => (matches.length ? (i - 1 + matches.length) % matches.length : 0));
      } else if (e.key === "Enter") {
        e.preventDefault();
        const chosen = matches[selectedIndex];
        if (chosen) onPick(chosen.id);
      }
    },
    [matches, selectedIndex, onPick],
  );

  // Build the visible, grouped rows while preserving the flat match index used
  // for keyboard highlighting (matches order = category order then catalog
  // order, since listPageTemplates is already catalog-ordered).
  let flatIndex = -1;

  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop
          className={cn(
            "fixed inset-0 z-50 bg-background/80 backdrop-blur-sm transition-opacity duration-150",
            "data-[starting-style]:opacity-0 data-[ending-style]:opacity-0",
          )}
        />
        <Dialog.Popup
          aria-label={t.ariaLabel}
          onKeyDown={onKeyDown}
          className={cn(
            "fixed left-1/2 top-1/2 z-50 flex max-h-[80vh] w-[calc(100%-2rem)] max-w-md flex-col",
            "-translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-2xl border border-border",
            "bg-background shadow-xl ring-1 ring-foreground/5 transition-all duration-150",
            "data-[starting-style]:opacity-0 data-[starting-style]:scale-95",
            "data-[ending-style]:opacity-0 data-[ending-style]:scale-95",
          )}
        >
          <Dialog.Title className="px-4 pt-4 text-sm font-semibold text-foreground">
            {t.title}
          </Dialog.Title>
          <div className="px-4 pb-2 pt-2">
            <div className="flex items-center gap-2 rounded-md border border-border bg-muted/40 px-2.5 py-1.5">
              <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              <input
                ref={inputRef}
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t.searchPlaceholder}
                className="w-full bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
              />
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
            {matches.length === 0 ? (
              <p className="px-2 py-6 text-center text-sm text-muted-foreground">{t.empty}</p>
            ) : (
              CATEGORY_ORDER.map((category) => {
                const inCategory = matches.filter((m) => m.category === category);
                if (inCategory.length === 0) return null;
                return (
                  <div key={category} className="pb-1">
                    <div className="px-2 pb-1 pt-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                      {t.categories[category]}
                    </div>
                    {inCategory.map((tpl) => {
                      flatIndex += 1;
                      const idx = flatIndex;
                      return (
                        <button
                          key={tpl.id}
                          type="button"
                          onClick={() => onPick(tpl.id)}
                          onMouseEnter={() => setSelectedIndex(idx)}
                          className={cn(
                            "flex w-full items-start gap-3 rounded-md px-2.5 py-2 text-left",
                            idx === selectedIndex ? "bg-muted" : "hover:bg-muted/60",
                          )}
                        >
                          <span className="mt-0.5 text-lg leading-none" aria-hidden>
                            {tpl.icon}
                          </span>
                          <span className="min-w-0">
                            <span className="block truncate text-sm font-medium text-foreground">
                              {tpl.name}
                            </span>
                            <span className="block truncate text-xs text-muted-foreground">
                              {tpl.description}
                            </span>
                          </span>
                        </button>
                      );
                    })}
                  </div>
                );
              })
            )}
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
