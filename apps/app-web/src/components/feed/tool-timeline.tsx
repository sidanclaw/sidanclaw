"use client";

/**
 * Compact, in-progress timeline of tool calls for the current draft-refine
 * turn — ported faithfully from `apps/feed-web/src/components/tool-timeline.tsx`
 * (docs/plans/feed-web-consolidation.md §7.4).
 *
 * Mirrors the apps/web tool-timeline pattern but trimmed for the
 * draft-session surface — no worker nesting (draft sessions rarely use
 * spawnWorker), no expand/collapse for a typically-short timeline.
 *
 * Port deltas (disposition rules §6): every label flows through
 * `useT().feedPage.toolTimeline`; the pure describers (`describeFeedTool`,
 * `defaultToolDescription`) take the dictionary as their first argument so
 * the SSE handler in `draft-session-detail.tsx` (not a component) can call
 * them.
 *
 * [COMP:app-web/feed-tool-timeline]
 */

import { useEffect, useRef, useState } from "react";
import { useT } from "@/lib/i18n/client";
import { format } from "@/lib/i18n/format";

export type ToolTimelineDict = ReturnType<
  typeof useT
>["feedPage"]["toolTimeline"];

export type ToolEntry = {
  id: string;
  name: string;
  description?: string;
  url?: string;
  status: "running" | "done" | "retried";
};

function toolLabels(t: ToolTimelineDict): Record<string, string> {
  return {
    proposeDrafts: t.toolProposeDrafts,
    searchMemory: t.toolSearchMemory,
    saveMemory: t.toolSaveMemory,
    getMemory: t.toolGetMemory,
    trackCommitment: t.toolTrackCommitment,
    resolveCommitment: t.toolResolveCommitment,
    webSearch: t.toolWebSearch,
    urlReader: t.toolUrlReader,
    threadsCreatePost: t.toolThreadsCreatePost,
    threadsReply: t.toolThreadsReply,
    threadsGetInsights: t.toolThreadsGetInsights,
    twitterPostTweet: t.toolTwitterPostTweet,
    twitterReply: t.toolTwitterReply,
    spawnWorker: t.toolSpawnWorker,
    useSkill: t.toolUseSkill,
    mcp_search: t.toolMcpSearch,
    mcp_call: t.toolMcpCall,
  };
}

// exported for tests
export function defaultToolDescription(
  t: ToolTimelineDict,
  name: string,
): string {
  const labels = toolLabels(t);
  if (labels[name]) return labels[name];
  const mcpMatch = name.match(/^mcp_([^_]+)_(.+)$/);
  if (mcpMatch) return format(t.mcpVia, { tool: mcpMatch[2], server: mcpMatch[1] });
  return format(t.usingTool, { name });
}

export function describeFeedTool(
  t: ToolTimelineDict,
  name: string,
  input: Record<string, unknown>,
): { description: string; url?: string } | undefined {
  if (name === "proposeDrafts") {
    const drafts = Array.isArray(input.drafts) ? input.drafts : null;
    const n = drafts?.length ?? 0;
    return {
      description:
        n > 0
          ? n === 1
            ? t.draftingOne
            : format(t.draftingMany, { count: n })
          : t.drafting,
    };
  }
  if (name === "webSearch" && typeof input.query === "string") {
    return { description: format(t.searchingQuery, { query: input.query }) };
  }
  if (name === "urlReader" && typeof input.url === "string") {
    try {
      const host = new URL(input.url).hostname.replace(/^www\./, "");
      return { description: format(t.readingHost, { host }), url: input.url };
    } catch {
      return { description: t.toolUrlReader, url: input.url };
    }
  }
  if (name === "useSkill" && typeof input.skill === "string") {
    const title = input.skill
      .split("-")
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(" ");
    return { description: format(t.usingSkill, { title }) };
  }
  if (name === "saveMemory" && typeof input.title === "string") {
    return { description: format(t.savingTitle, { title: input.title }) };
  }
  if (name === "trackCommitment" && typeof input.summary === "string") {
    const short = input.summary.length > 60
      ? `${input.summary.slice(0, 57)}…`
      : input.summary;
    return { description: format(t.trackingSummary, { summary: short }) };
  }
  return undefined;
}

// `streaming` differentiates a step that finished mid-turn (subtle dot)
// from a step in a fully-completed turn (bold checkmark). The same
// big-green-check used for both states made the panel read as "all done"
// even when more work was still coming.
function StatusIcon({ status, streaming }: { status: ToolEntry["status"]; streaming?: boolean }) {
  if (status === "running") {
    return (
      <span className="inline-block w-3 h-3 border-2 border-primary/30 border-t-primary rounded-full animate-spin shrink-0" />
    );
  }
  if (status === "retried") {
    return (
      <span className="inline-flex items-center justify-center w-3 h-3 shrink-0 text-muted-foreground/40">
        <svg width="9" height="9" viewBox="0 0 16 16" fill="currentColor">
          <path d="M13.65 2.35A8 8 0 1 0 16 8h-2a6 6 0 1 1-1.76-4.24L10 6h6V0l-2.35 2.35z" />
        </svg>
      </span>
    );
  }
  if (streaming) {
    return (
      <span className="inline-flex items-center justify-center w-3 h-3 shrink-0">
        <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/40" />
      </span>
    );
  }
  return (
    <span className="inline-flex items-center justify-center w-3 h-3 rounded-full bg-primary/15 text-primary shrink-0">
      <svg
        width="8"
        height="8"
        viewBox="0 0 9 9"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M1.5 4.5L3.5 6.5L7.5 2.5" />
      </svg>
    </span>
  );
}

function WorkingIndicator() {
  const t = useT().feedPage.toolTimeline;
  return (
    <div className="flex items-center gap-2 min-w-0 text-muted-foreground/70 animate-in fade-in duration-300">
      <span className="inline-flex items-center justify-center w-3 h-3 shrink-0">
        <span className="flex gap-0.5">
          <span className="w-1 h-1 rounded-full bg-muted-foreground/60 animate-bounce" style={{ animationDelay: "0ms" }} />
          <span className="w-1 h-1 rounded-full bg-muted-foreground/60 animate-bounce" style={{ animationDelay: "150ms" }} />
          <span className="w-1 h-1 rounded-full bg-muted-foreground/60 animate-bounce" style={{ animationDelay: "300ms" }} />
        </span>
      </span>
      <span className="text-muted-foreground/60 italic text-[12px] leading-snug">{t.working}</span>
    </div>
  );
}

function ToolRow({ tool, animating, streaming }: { tool: ToolEntry; animating: boolean; streaming?: boolean }) {
  const t = useT().feedPage.toolTimeline;
  const description = tool.description ?? defaultToolDescription(t, tool.name);
  const baseClass =
    tool.status === "done"
      ? "text-muted-foreground/70"
      : tool.status === "retried"
        ? "text-muted-foreground/40"
        : "text-muted-foreground";
  return (
    <div
      className={`flex items-center gap-2 min-w-0 transition-all duration-300 ${
        animating ? "animate-rise-in" : ""
      } ${baseClass}`}
    >
      <StatusIcon status={tool.status} streaming={streaming} />
      <span
        className={`${tool.status === "retried" ? "line-through" : ""} truncate min-w-0 text-[12px] leading-snug`}
      >
        {tool.url ? (
          <a
            href={tool.url}
            target="_blank"
            rel="noopener noreferrer"
            className="hover:underline truncate block"
            title={tool.url}
          >
            {description}
          </a>
        ) : (
          description
        )}
      </span>
    </div>
  );
}

/**
 * Compact, in-progress timeline of tool calls for the current turn.
 *
 * `done=true` collapses every entry behind a "Show steps" toggle so the
 * persisted message bubble doesn't carry a wall of stale rows.
 */
export function ToolTimeline({
  tools,
  done,
}: {
  tools: ToolEntry[];
  done?: boolean;
}) {
  const t = useT().feedPage.toolTimeline;
  const [expanded, setExpanded] = useState(false);
  const prevLengthRef = useRef(0);
  const [animatingId, setAnimatingId] = useState<string | null>(null);

  useEffect(() => {
    if (tools.length > prevLengthRef.current) {
      const newest = tools[tools.length - 1];
      if (newest) {
        setAnimatingId(newest.id);
        const timer = setTimeout(() => setAnimatingId(null), 320);
        prevLengthRef.current = tools.length;
        return () => clearTimeout(timer);
      }
    }
    prevLengthRef.current = tools.length;
  }, [tools.length, tools]);

  if (tools.length === 0) return null;

  if (done) {
    return (
      <div className="text-sm">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="flex items-center gap-1.5 text-[11px] text-muted-foreground/60 hover:text-muted-foreground transition-colors"
        >
          <svg
            width="9"
            height="9"
            viewBox="0 0 10 10"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={`transition-transform duration-200 ${expanded ? "rotate-90" : ""}`}
          >
            <path d="M3 1.5L7 5L3 8.5" />
          </svg>
          <span>
            {expanded
              ? t.hideSteps
              : tools.length === 1
                ? t.showStepsOne
                : format(t.showSteps, { count: tools.length })}
          </span>
        </button>
        <div
          className={`overflow-hidden transition-all duration-300 ease-in-out ${
            expanded ? "max-h-[2000px] opacity-100 mt-1.5" : "max-h-0 opacity-0"
          }`}
        >
          <div className="flex flex-col gap-1">
            {tools.map((tool) => (
              <ToolRow key={tool.id} tool={tool} animating={false} streaming={false} />
            ))}
          </div>
        </div>
      </div>
    );
  }

  // Streaming: keep the last completed step + the running step visible; older
  // completed steps hide behind a "more" toggle so the panel stays compact.
  const completedItems = tools.filter((t) => t.status !== "running");
  const runningItem = tools.find((t) => t.status === "running");
  const lastCompleted = completedItems[completedItems.length - 1] ?? null;
  const visible: ToolEntry[] = [];
  if (lastCompleted) visible.push(lastCompleted);
  if (runningItem) visible.push(runningItem);
  const hiddenCount = completedItems.length - (lastCompleted ? 1 : 0);
  // No tool currently running but turn not yet `done` → model is between
  // tools (generating text or planning the next call). Without this row
  // the panel reads as "all checked off / nothing happening".
  const showWorking = !runningItem && completedItems.length > 0;

  return (
    <div className="text-sm">
      {hiddenCount > 0 && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="flex items-center gap-1.5 text-[11px] text-muted-foreground/60 hover:text-muted-foreground transition-colors mb-1"
        >
          <svg
            width="9"
            height="9"
            viewBox="0 0 10 10"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={`transition-transform duration-200 ${expanded ? "rotate-90" : ""}`}
          >
            <path d="M3 1.5L7 5L3 8.5" />
          </svg>
          <span>
            {expanded
              ? t.hide
              : hiddenCount === 1
                ? t.moreStepsOne
                : format(t.moreSteps, { count: hiddenCount })}
          </span>
        </button>
      )}

      <div
        className={`overflow-hidden transition-all duration-300 ease-in-out ${
          expanded ? "max-h-[2000px] opacity-100" : "max-h-0 opacity-0"
        }`}
      >
        <div className="flex flex-col gap-1 mb-1">
          {completedItems.slice(0, -1).map((tool) => (
            <ToolRow key={tool.id} tool={tool} animating={false} streaming />
          ))}
        </div>
      </div>

      <div className="flex flex-col gap-1">
        {visible.map((tool) => (
          <ToolRow
            key={tool.id}
            tool={tool}
            animating={tool.id === animatingId}
            streaming
          />
        ))}
        {showWorking && <WorkingIndicator />}
      </div>
    </div>
  );
}
