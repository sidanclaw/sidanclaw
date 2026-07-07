/**
 * Legacy Approvals route — `/w/[workspaceId]/approvals`.
 *
 * The approvals queue now renders as a **doc-shell panel tab**
 * (`/w/[workspaceId]/p?panel=approvals`, `ApprovalsPanel`) so the doc tab
 * strip + sidebar persist around it. This route stays only so old links /
 * bookmarks keep working: it 307-redirects into the panel. See
 * docs/architecture/features/doc.md → "Top bar" (panel tabs) and the
 * `[COMP:app-web/approvals]` component-map row.
 */

import { redirect } from "next/navigation";

export default async function ApprovalsRoute(props: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await props.params;
  redirect(`/w/${workspaceId}/p?panel=approvals`);
}
