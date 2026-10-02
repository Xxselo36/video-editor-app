// /app/library: the library (features/jobs/LibraryPage.legacy) — on the
// v2 opt-in a redirect to the Projects page at /app (UX12).
import { LibraryRoute } from "@/features/jobs/LibraryRoute";

export default function Library() {
  return <LibraryRoute />;
}
