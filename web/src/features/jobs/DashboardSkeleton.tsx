// The v1 dashboard's shape while /app works out which page it shows
// (./AppHome) and while the dashboard reads its cards (./DashboardPage).
export function DashboardSkeleton() {
  return (
    <div className="flex flex-col gap-4" data-testid="dashboard-skeleton" aria-busy="true">
      <div className="h-4 w-24 animate-pulse rounded bg-[var(--surface-2)]" />
      <div className="h-9 w-64 animate-pulse rounded bg-[var(--surface-2)]" />
      <div className="mt-6 grid grid-cols-1 gap-2 sm:grid-cols-2">
        <div className="h-28 animate-pulse rounded-2xl bg-[var(--surface-1)]" />
        <div className="h-28 animate-pulse rounded-2xl bg-[var(--surface-1)]" />
      </div>
    </div>
  );
}
