/**
 * Cleo brand mark.
 *
 * A soft crescent hugging a violet spark — reads as the "C" of Cleo
 * plus the voice-trigger / spoken-word energy that's the product's USP.
 * Uses the design-token colors so it retints when we retheme.
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
        <linearGradient id="cleoBrand" x1="0" y1="0" x2="32" y2="32">
          <stop offset="0%" stopColor="#c4b5fd" />
          <stop offset="100%" stopColor="#8b5cf6" />
        </linearGradient>
      </defs>
      {/* C-shape (open on the right) */}
      <path
        d="M25 8.6c-1.8-2.4-4.7-4-8-4-5.5 0-10 4.5-10 10s4.5 10 10 10c3.3 0 6.2-1.6 8-4"
        stroke="url(#cleoBrand)"
        strokeWidth="3"
        strokeLinecap="round"
        fill="none"
      />
      {/* Spark inside — represents the voice-trigger moment */}
      <circle cx="21" cy="16" r="2.2" fill="url(#cleoBrand)" />
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
      <span className="text-xl font-bold tracking-tight text-white">Cleo</span>
    </span>
  );
}
