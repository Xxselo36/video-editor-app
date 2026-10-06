"use client";
/**
 * What /app/edit/[jobId] shows (UX5): the v2 editor shell (UX7,
 * features/editor/v2) when useEditorV2() says so — NEXT_PUBLIC_EDITOR_V2
 * unset (the default) or "1" unless this browser chose ?editor=v1, or
 * "optin" and ?editor=v2 in this browser — else the v1 editor
 * (ReviewScreen, with the UT1 interim caption overlay). Both get the same
 * job data and callbacks from LegacyEditorPage.
 */
import { useEditorV2 } from "./v2/flag";
import { LegacyEditorPage } from "./legacy/LegacyEditorPage";

export function EditorRoute({ jobId }: { jobId: string }) {
  const v2 = useEditorV2();
  return <LegacyEditorPage jobId={jobId} v2={v2} />;
}
