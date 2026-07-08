/**
 * Minimal line diff for the approvals queue (app-web).
 *
 * Powers the current-vs-proposed view on `staged_skill_update` approval
 * cards (`approvals-panel.tsx`): the curator's `newContent` REPLACES the
 * whole skill body, so the reviewer must see removals as clearly as
 * additions before approving. Pure functions, no dependency — an LCS over
 * lines with a common prefix/suffix trim, and a size guard that degrades
 * to whole-block replace rather than blowing up on huge bodies.
 *
 * Spec: docs/architecture/features/workflow.md → Unified approvals.
 * [COMP:app-web/approvals]
 */

export type DiffLine = { type: "same" | "add" | "del"; text: string };
export type DiffRow = DiffLine | { type: "gap"; count: number };

/** Above this many DP cells the middle section is treated as a whole-block
 *  replace. Skill bodies cap at 50k chars (~1-2k lines), so this only
 *  trips on pathological inputs. */
const MAX_LCS_CELLS = 500_000;

/** Line-level diff of `before` → `after`, in document order. */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = before.split("\n");
  const b = after.split("\n");

  // Trim the common prefix and suffix so the LCS only runs on the changed
  // middle — the dominant case for a body edit.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }

  const out: DiffLine[] = [];
  for (let i = 0; i < start; i++) out.push({ type: "same", text: a[i] });

  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  if (midA.length * midB.length > MAX_LCS_CELLS) {
    for (const text of midA) out.push({ type: "del", text });
    for (const text of midB) out.push({ type: "add", text });
  } else {
    out.push(...lcsDiff(midA, midB));
  }

  for (let i = endA; i < a.length; i++) out.push({ type: "same", text: a[i] });
  return out;
}

/** Classic LCS table + backtrack, del-before-add within a hunk. */
function lcsDiff(a: string[], b: string[]): DiffLine[] {
  const n = a.length;
  const m = b.length;
  // (n+1) x (m+1) table of LCS lengths.
  const table: Uint32Array[] = [];
  for (let i = 0; i <= n; i++) table.push(new Uint32Array(m + 1));
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      table[i][j] =
        a[i - 1] === b[j - 1]
          ? table[i - 1][j - 1] + 1
          : Math.max(table[i - 1][j], table[i][j - 1]);
    }
  }
  // Backtrack from the end; reverse at the close. On a tie, consume the
  // `add` side first — the walk runs backward, so after the reverse each
  // hunk reads del-before-add (removals above additions).
  const reversed: DiffLine[] = [];
  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      reversed.push({ type: "same", text: a[i - 1] });
      i--;
      j--;
    } else if (table[i][j - 1] >= table[i - 1][j]) {
      reversed.push({ type: "add", text: b[j - 1] });
      j--;
    } else {
      reversed.push({ type: "del", text: a[i - 1] });
      i--;
    }
  }
  while (i > 0) reversed.push({ type: "del", text: a[--i] });
  while (j > 0) reversed.push({ type: "add", text: b[--j] });
  return reversed.reverse();
}

/**
 * The first `maxRows` changed lines (adds/dels only, document order) plus
 * how many changed lines were left out. Powers the collapsed skill-update
 * card's inline preview — the reviewer sees the substance of the proposal
 * without opening the full diff.
 */
export function previewChanges(
  lines: readonly DiffLine[],
  maxRows = 6,
): { rows: DiffLine[]; moreChanges: number } {
  const changed = lines.filter((l) => l.type !== "same");
  return {
    rows: changed.slice(0, maxRows),
    moreChanges: Math.max(0, changed.length - maxRows),
  };
}

/** Added/removed line counts for the summary chip. */
export function diffStats(lines: readonly DiffLine[]): {
  added: number;
  removed: number;
} {
  let added = 0;
  let removed = 0;
  for (const line of lines) {
    if (line.type === "add") added++;
    else if (line.type === "del") removed++;
  }
  return { added, removed };
}

/**
 * Collapse long unchanged runs into `{ type: "gap", count }` rows, keeping
 * `context` unchanged lines on each side of every change. Runs must beat
 * the kept context by more than one line to collapse — a one-line gap
 * would be noisier than the line itself.
 */
export function collapseContext(
  lines: readonly DiffLine[],
  context = 2,
): DiffRow[] {
  const out: DiffRow[] = [];
  let run: DiffLine[] = [];

  const flushRun = (isTail: boolean) => {
    const keepHead = out.length === 0 ? 0 : context; // no context before the first change
    const keepTail = isTail ? 0 : context;
    if (run.length > keepHead + keepTail + 1) {
      out.push(...run.slice(0, keepHead));
      out.push({ type: "gap", count: run.length - keepHead - keepTail });
      out.push(...run.slice(run.length - keepTail));
    } else {
      out.push(...run);
    }
    run = [];
  };

  for (const line of lines) {
    if (line.type === "same") {
      run.push(line);
    } else {
      flushRun(false);
      out.push(line);
    }
  }
  flushRun(true);
  return out;
}
