/**
 * Legacy Autopilot (goals board) route — `/w/[workspaceId]/goals`.
 *
 * The board now renders as a **doc-shell panel tab**
 * (`/w/[workspaceId]/p?panel=goals`, `AutopilotPanel`) so the doc tab strip +
 * sidebar persist around it. This route stays only so old links / bookmarks
 * (and the goal-detail "back to list") keep working: it 307-redirects into the
 * panel. The `[goalId]` detail sub-route is unchanged (still a full page). See
 * docs/architecture/features/doc.md → "Top bar" (panel tabs) and the
 * `[COMP:app-web/goals-board]` component-map row.
 */

import { redirect } from "next/navigation";

export default async function GoalsRoute(props: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await props.params;
  redirect(`/w/${workspaceId}/p?panel=goals`);
}
