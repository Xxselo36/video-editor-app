/**
 * /__test__/captions — caption engine test page (UT2).
 *
 * Only with NEXT_PUBLIC_TEST_PAGES=1 (staging, previews); a 404 otherwise.
 * Renders preset × moment × language on 540×960 canvases and exposes the
 * layout JSON as window.__captionsLayout for the parity suite (UT4) and the
 * manual iPhone check. The folder is "%5F_test__" because Next treats a
 * folder starting with "_" as private (not routed); %5F makes the URL
 * segment "__test__".
 */
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import CaptionsMatrix from "./CaptionsMatrix";

export const metadata: Metadata = {
  title: "Caption engine test",
  robots: { index: false, follow: false },
};

export default function CaptionsTestPage() {
  if (process.env.NEXT_PUBLIC_TEST_PAGES !== "1") notFound();
  return <CaptionsMatrix />;
}
