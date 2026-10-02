// /app: the dashboard, or on the v2 opt-in the Projects page (UX12,
// features/jobs/AppHome). Route files only mount a feature (UX5,
// PLAN_TECH §1.2).
import { AppHome as Home } from "@/features/jobs/AppHome";

export default function AppHome() {
  return <Home />;
}
