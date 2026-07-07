"use client";

/**
 * Promise-based account picker for the feed draft flow — ported faithfully
 * from `apps/feed-web/src/components/account-picker-dialog.tsx`
 * (docs/plans/feed-web-consolidation.md §7.1, disposition rules §6).
 *
 * A workspace can hold several connected accounts on the same platform (each
 * is a distinct `kind='app'` assistant — `distribution_profiles` is keyed by
 * `(assistant_id, platform)`). The platform-scoped route only carries the
 * platform, so when more than one account exists on the target platform we
 * must ask the operator which account a draft / reply is for rather than
 * silently resolving the first match. See
 * docs/architecture/feed/draft-sessions.md → "Choosing the account".
 *
 * Port deltas: `WorkspaceProfile` → `FeedProfile` (`@/lib/api/feed`); copy
 * via `useT().feedPage`.
 *
 * Usage:
 *   const { pickAccount, dialog } = useAccountPicker();
 *   // render {dialog} once
 *   const chosen = await pickAccount({ title, description, accounts });
 *   if (!chosen) return; // cancelled
 *
 * [COMP:app-web/feed-connect-account-dialog]
 */

import { Dialog } from "@base-ui/react/dialog";
import { useCallback, useState } from "react";
import { cn } from "@/lib/utils";
import type { FeedProfile } from "@/lib/api/feed";
import { useT } from "@/lib/i18n/client";

export type AccountPickerOptions = {
  title: string;
  description?: string;
  accounts: FeedProfile[];
};

type Pending = AccountPickerOptions & {
  resolve: (value: FeedProfile | null) => void;
};

export function useAccountPicker() {
  const t = useT().feedPage;
  const [pending, setPending] = useState<Pending | null>(null);

  const pickAccount = useCallback(
    (opts: AccountPickerOptions): Promise<FeedProfile | null> => {
      return new Promise<FeedProfile | null>((resolve) => {
        setPending({
          ...opts,
          resolve: (value) => {
            setPending(null);
            resolve(value);
          },
        });
      });
    },
    [],
  );

  const dialog = (
    <Dialog.Root
      open={pending !== null}
      onOpenChange={(next) => {
        if (!next) pending?.resolve(null);
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop
          className={cn(
            "fixed inset-0 z-50 bg-black/55 backdrop-blur-sm",
            "data-[open]:animate-fade-in",
            "data-[closed]:opacity-0 data-[closed]:transition-opacity data-[closed]:duration-150",
          )}
        />
        <Dialog.Popup
          className={cn(
            "fixed left-1/2 top-1/2 z-50 -translate-x-1/2 -translate-y-1/2",
            "w-[calc(100vw-2rem)] max-w-md outline-none",
            "rounded-2xl border border-border bg-card shadow-2xl",
            "data-[open]:animate-pop-in",
            "data-[closed]:opacity-0 data-[closed]:scale-[0.97] data-[closed]:transition-all data-[closed]:duration-150",
          )}
        >
          <div className="px-5 pt-5 pb-2">
            <Dialog.Title className="text-base font-semibold">
              {pending?.title}
            </Dialog.Title>
            {pending?.description && (
              <Dialog.Description className="mt-2 text-sm text-muted-foreground leading-relaxed">
                {pending.description}
              </Dialog.Description>
            )}
          </div>
          <div className="px-5 py-3 space-y-2">
            {(pending?.accounts ?? []).map((acct) => {
              const isX = acct.platform === "twitter";
              return (
                <button
                  key={acct.assistantId}
                  type="button"
                  onClick={() => pending?.resolve(acct)}
                  className="press w-full flex items-center gap-3 rounded-xl border border-border bg-background/60 px-3 py-2.5 text-left hover:bg-accent"
                >
                  <span
                    className={cn(
                      "w-8 h-8 shrink-0 rounded-full flex items-center justify-center text-xs font-semibold",
                      isX ? "bg-foreground text-background" : "bg-primary/20 text-primary",
                    )}
                  >
                    {acct.platformHandle.charAt(0).toUpperCase() || "?"}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-semibold text-foreground truncate">
                      @{acct.platformHandle}
                    </span>
                    <span className="block text-[11px] text-muted-foreground">
                      {t.platformLabels[acct.platform]}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
          <div className="flex justify-end gap-2 px-5 py-4 border-t border-border">
            <button
              type="button"
              onClick={() => pending?.resolve(null)}
              className="press inline-flex items-center justify-center h-9 px-4 rounded-xl text-sm font-medium text-foreground bg-transparent border border-border hover:bg-accent"
            >
              {t.accountPicker.cancel}
            </button>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );

  return { pickAccount, dialog };
}
