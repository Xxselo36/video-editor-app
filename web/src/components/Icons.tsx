/**
 * Hand-picked minimal icon set. Simple line style, consistent stroke,
 * warm friendly feel — not corporate-flat, not overly decorated.
 */

type IconProps = {
  size?: number;
  className?: string;
  strokeWidth?: number;
};

const base = (size: number) => ({
  width: size,
  height: size,
  viewBox: "0 0 24 24",
  fill: "none",
  xmlns: "http://www.w3.org/2000/svg",
  "aria-hidden": true as const,
});

export function IconPhone({ size = 24, className = "", strokeWidth = 1.75 }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <rect
        x="6.5"
        y="2.5"
        width="11"
        height="19"
        rx="2.5"
        stroke="currentColor"
        strokeWidth={strokeWidth}
      />
      <path
        d="M10.5 18.5h3"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeLinecap="round"
      />
    </svg>
  );
}

export function IconMic({ size = 24, className = "", strokeWidth = 1.75 }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <rect
        x="9"
        y="3"
        width="6"
        height="11"
        rx="3"
        stroke="currentColor"
        strokeWidth={strokeWidth}
      />
      <path
        d="M6 11a6 6 0 0 0 12 0M12 17v4M9 21h6"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeLinecap="round"
      />
    </svg>
  );
}

export function IconVlog({ size = 24, className = "", strokeWidth = 1.75 }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <rect
        x="3"
        y="5"
        width="14"
        height="14"
        rx="2.5"
        stroke="currentColor"
        strokeWidth={strokeWidth}
      />
      <path
        d="M17 10l4-2v8l-4-2v-4Z"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function IconCaptions({ size = 24, className = "", strokeWidth = 1.75 }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <rect
        x="3"
        y="4.5"
        width="18"
        height="15"
        rx="2"
        stroke="currentColor"
        strokeWidth={strokeWidth}
      />
      <path
        d="M7 11.5h4M13 11.5h4M7 15h6"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeLinecap="round"
      />
    </svg>
  );
}

export function IconSliders({ size = 24, className = "", strokeWidth = 1.75 }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path
        d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeLinecap="round"
      />
      <circle cx="15" cy="6" r="2" stroke="currentColor" strokeWidth={strokeWidth} fill="var(--surface-1)" />
      <circle cx="10" cy="12" r="2" stroke="currentColor" strokeWidth={strokeWidth} fill="var(--surface-1)" />
      <circle cx="18" cy="18" r="2" stroke="currentColor" strokeWidth={strokeWidth} fill="var(--surface-1)" />
    </svg>
  );
}

export function IconSparkle({ size = 24, className = "", strokeWidth = 1.75 }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path
        d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3Z"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeLinejoin="round"
      />
      <path
        d="M18.5 16l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7.7-1.8Z"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function IconArrowRight({ size = 20, className = "", strokeWidth = 2 }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path
        d="M5 12h14M13 5l7 7-7 7"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function IconCheck({ size = 20, className = "", strokeWidth = 2 }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path
        d="M5 12l4 4 10-10"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
