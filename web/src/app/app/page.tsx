// /app: the dashboard (features/jobs/DashboardPage). Route files only
// mount a feature (UX5, PLAN_TECH §1.2).
import { DashboardPage } from "@/features/jobs/DashboardPage";

export default function AppHome() {
  return <DashboardPage />;
}
