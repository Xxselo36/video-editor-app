/**
 * A thin progress bar (role progressbar, 0–100). The fill never drops
 * below `min` % so a just-started task still shows a sliver.
 */
export function Progress({
  value,
  color,
  min = 0,
  label,
}: {
  value: number;
  color: string;
  min?: number;
  label?: string;
}) {
  const pct = Math.max(min, Math.min(100, value));
  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(Math.max(0, Math.min(100, value)))}
      aria-label={label}
      className="h-1.5 overflow-hidden rounded-full"
      style={{ background: "var(--surface-2)" }}
    >
      <div
        className="h-full transition-all duration-500"
        style={{
          width: `${pct}%`,
          background: color,
          boxShadow: `0 0 12px ${color}80`,
        }}
      />
    </div>
  );
}
