import { cx } from "./cx";

/** The on/off track. Decorative: the control around it is the switch. */
export function Switch({ checked }: { checked: boolean }) {
  return (
    <div
      aria-hidden
      className={cx(
        "h-6 w-10 rounded-full p-0.5 transition-colors",
        checked ? "bg-[var(--brand)]" : "bg-[var(--surface-tint)]",
      )}
    >
      <div
        className={cx("h-5 w-5 rounded-full bg-white transition-transform", checked && "translate-x-4")}
      />
    </div>
  );
}

/** A full-width row that toggles a setting: label, optional hint, track. */
export function SwitchRow({
  label,
  desc,
  checked,
  onChange,
}: {
  label: string;
  desc?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className="flex w-full items-center justify-between rounded-xl border border-[var(--border)] px-4 py-3 text-left hover:border-[var(--border-strong)]"
    >
      <div>
        <div className="text-sm">{label}</div>
        {desc && <div className="text-[10px] text-[var(--text-muted)]">{desc}</div>}
      </div>
      <Switch checked={checked} />
    </button>
  );
}
