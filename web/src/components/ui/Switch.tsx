import { cx } from "./cx";

const SIZE = {
  /** In a settings list (v1 ConfigureScreen). */
  md: {
    track: "h-6 w-10 p-0.5",
    on: "bg-[var(--brand)]",
    off: "bg-[var(--surface-tint)]",
    knob: "h-5 w-5 bg-white",
    knobOn: "translate-x-4",
  },
  /** In a 56 px option row (the start screen's "Mehr Optionen"). */
  lg: {
    track: "relative h-7 w-12 shrink-0 border",
    on: "border-[var(--brand-solid)] bg-[var(--brand-solid)]",
    off: "border-[var(--border-hover)] bg-[var(--surface-tint)]",
    knob: "absolute left-[3px] top-[3px] h-5 w-5 bg-[var(--text-strong)] shadow-[var(--shadow-sm)] duration-[220ms] ease-[cubic-bezier(.16,1,.3,1)] motion-reduce:transition-none",
    knobOn: "translate-x-5",
  },
} as const;

/** The on/off track. Decorative: the control around it is the switch. */
export function Switch({ checked, size = "md" }: { checked: boolean; size?: keyof typeof SIZE }) {
  const s = SIZE[size];
  return (
    <div aria-hidden className={cx("rounded-full transition-colors", s.track, checked ? s.on : s.off)}>
      <div className={cx("rounded-full transition-transform", s.knob, checked && s.knobOn)} />
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
