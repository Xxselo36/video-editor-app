/**
 * CleoCuts brand mark.
 *
 * Rounded confident C with a glowing spark inside — the "listening"
 * moment when you say "Cleo cut". The spark uses a radial gradient so
 * it reads as a light source rather than a flat dot; the C outer is a
 * heavier stroke than v1 for stronger presence at small sizes.
 */
export function LogoMark({
  size = 28,
  className = "",
}: {
  size?: number;
  className?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden="true"
    >
      <defs>
        {/* Main stroke gradient — 3-stop for a slight highlight bend */}
        <linearGradient id="cleoBrand" x1="4" y1="4" x2="28" y2="28">
          <stop offset="0%" stopColor="#e9d5ff" />
          <stop offset="50%" stopColor="#a78bfa" />
          <stop offset="100%" stopColor="#6d28d9" />
        </linearGradient>
        {/* Spark — radial glow gradient for that "light source" feel */}
        <radialGradient id="cleoSpark" cx="0.35" cy="0.35" r="0.75">
          <stop offset="0%" stopColor="#faf5ff" />
          <stop offset="40%" stopColor="#d8b4fe" />
          <stop offset="100%" stopColor="#7c3aed" />
        </radialGradient>
        {/* Soft outer glow around the spark for depth */}
        <radialGradient id="cleoSparkGlow" cx="0.5" cy="0.5" r="0.5">
          <stop offset="0%" stopColor="rgba(196,181,253,0.55)" />
          <stop offset="100%" stopColor="rgba(196,181,253,0)" />
        </radialGradient>
      </defs>

      {/* Faint spark aura */}
      <circle cx="20" cy="16" r="5.5" fill="url(#cleoSparkGlow)" />

      {/* Bold rounded C — thicker stroke, tuned arc with slight
          asymmetry at the opening so it reads as intentional letter. */}
      <path
        d="M24.5 9.5C22.4 6.8 19.4 5 16 5C9.9 5 5 9.9 5 16C5 22.1 9.9 27 16 27C19.4 27 22.4 25.2 24.5 22.5"
        stroke="url(#cleoBrand)"
        strokeWidth="3.75"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />

      {/* Spark — offset up-right of true center for visual weight */}
      <circle cx="20" cy="15.5" r="2.6" fill="url(#cleoSpark)" />
    </svg>
  );
}

export function LogoWord({
  size = 28,
  className = "",
}: {
  size?: number;
  className?: string;
}) {
  return (
    <span className={`flex items-center gap-2 ${className}`}>
      <LogoMark size={size} />
      <span
        className="text-xl font-bold tracking-tight"
        style={{ color: "var(--text-strong)", letterSpacing: "-0.02em" }}
      >
        CleoCuts
      </span>
    </span>
  );
}
