import type { ReactNode } from "react";

export type TabItem<T extends string> = { id: T; label: ReactNode; icon?: ReactNode };

/**
 * A row of equal-width tabs (role tablist / tab). Each tab carries
 * `data-testid="<testIdPrefix>-<id>"`. The panels are the caller's.
 */
export function Tabs<T extends string>({
  tabs,
  active,
  onChange,
  testIdPrefix,
}: {
  tabs: TabItem<T>[];
  active: T;
  onChange: (id: T) => void;
  testIdPrefix?: string;
}) {
  return (
    <div
      role="tablist"
      className="flex overflow-hidden rounded-xl"
      style={{
        background: "var(--surface-1)",
        border: "1px solid var(--border)",
      }}
    >
      {tabs.map((tab, i) => {
        const isActive = active === tab.id;
        return (
          <button
            key={tab.id}
            type="button"
            onClick={() => onChange(tab.id)}
            role="tab"
            aria-selected={isActive}
            data-testid={testIdPrefix ? `${testIdPrefix}-${tab.id}` : undefined}
            className="flex-1 px-3 py-2.5 text-sm font-medium transition-colors"
            style={{
              background: isActive ? "var(--brand-tint)" : "transparent",
              color: isActive ? "var(--brand-strong)" : "var(--text-muted)",
              borderRight: i < tabs.length - 1 ? "1px solid var(--border)" : "none",
            }}
          >
            {tab.icon && <span className="mr-1.5">{tab.icon}</span>}
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}
