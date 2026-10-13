"use client";
/**
 * Small pieces the landing sections share: the coloured command words,
 * the "{name}" → node helper, the call to action, caption overrides for
 * small frames, and visibility (hooks and the passes' root margin).
 */
import Link from "next/link";
import { Fragment, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useT } from "@/i18n";
import { AUTH_ENABLED, BILLING_COPY } from "@/lib/auth";
import { useAuthState, useBillingEnabled } from "@/lib/account";
import { track } from "@/lib/analytics";
import type { PresetId, StyleOverrides } from "@/lib/captions/types";
import { buttonClass } from "@/components/ui/Button";
import { cx } from "@/components/ui/cx";
import styles from "./Landing.module.css";

/* ── Voice commands ── */

export type CmdId = "start" | "cut" | "keep" | "finish" | "stop" | "go";

/** The spoken phrase: literal in every language (never translated). */
export const CMD_PHRASE: Record<CmdId, string> = {
  start: "Cleo start",
  cut: "Cleo cut",
  keep: "Cleo keep",
  finish: "Cleo finish",
  stop: "Cleo stop",
  go: "Cleo go",
};

/** Fixed command colours (globals.css --cmd-*, cleocuts-brand). */
export const CMD_COLOR: Record<CmdId, string> = {
  start: "var(--cmd-start)",
  cut: "var(--cmd-cut)",
  keep: "var(--cmd-keep)",
  finish: "var(--cmd-finish)",
  stop: "var(--cmd-stopgo)",
  go: "var(--cmd-stopgo)",
};

/** A command in its colour, in the language's quotation marks. The
 *  phrase is marked English (it is spoken in English in every language),
 *  so screen readers say it as the visitor must.
 *  `inherit`: keep the surrounding weight (headings). */
export function Cmd({ id, inherit = false }: { id: CmdId; inherit?: boolean }) {
  const t = useT();
  return (
    <span className={cx("whitespace-nowrap", !inherit && "font-semibold")} style={{ color: CMD_COLOR[id] }}>
      {rich(t("site.quote", { text: "{cmd}" }), { cmd: <span lang="en">{CMD_PHRASE[id]}</span> })}
    </span>
  );
}

/** The commands as nodes for a translated string's placeholders. */
export function useCmdNodes(): Record<CmdId, React.ReactNode> {
  return {
    start: <Cmd id="start" />,
    cut: <Cmd id="cut" />,
    keep: <Cmd id="keep" />,
    finish: <Cmd id="finish" />,
    stop: <Cmd id="stop" />,
    go: <Cmd id="go" />,
  };
}

/** Replace "{name}" placeholders in a translated string with React nodes. */
export function rich(text: string, nodes: Record<string, React.ReactNode>): React.ReactNode {
  return text.split(/(\{\w+\})/).map((part, i) => {
    const m = /^\{(\w+)\}$/.exec(part);
    return <Fragment key={i}>{m && m[1] in nodes ? nodes[m[1]] : part}</Fragment>;
  });
}

/* ── Captions on small frames ── */

/** Karaoke (Hindi) draws at 0.078 of the width: on the small frames (the
 *  bonus-clip tiles, the hero on phones) it gets 1.6x and two words a
 *  page, so it stays legible. */
export const SMALL_FRAME_OVERRIDES: Partial<Record<PresetId, StyleOverrides>> = {
  karaoke: { sizeScale: 1.6, wordsPerPage: 2 },
};

/* ── Call to action ── */

/** Where the main button goes and what it says: create an account
 *  (free during the beta), the editor when signed in, or straight into
 *  the editor while accounts are off. */
export function useCta(): { href: string; label: string } {
  const t = useT();
  const auth = useAuthState();
  const billingOn = useBillingEnabled();
  if (!AUTH_ENABLED) return { href: "/app", label: t("site.cta.start") };
  if (auth.signedIn) return { href: "/app", label: t("site.cta.openEditor") };
  return { href: "/sign-up", label: t(BILLING_COPY || billingOn ? "site.cta.signup" : "site.cta.signupFree") };
}

export function CtaLink({
  location,
  size = "lg",
  wide = false,
  className,
  ref,
  ...rest
}: {
  location: string;
  size?: "lg" | "pill";
  wide?: boolean;
  className?: string;
  ref?: React.Ref<HTMLAnchorElement>;
  "data-shown"?: boolean;
}) {
  const { href, label } = useCta();
  return (
    <Link
      ref={ref}
      href={href}
      onClick={() => track("cta_click", { location })}
      className={cx(buttonClass("primary", size), styles.cta, wide && styles.ctaWide, className)}
      {...rest}
    >
      {label}
    </Link>
  );
}

/* ── Visibility ── */

/* ── Motion vocabulary ──
 * WAAPI cannot read CSS custom properties, so the page's curves are
 * mirrored here (Landing.module.css .page has the same values and the
 * rule for which to use when). */

/** The brand curve: entrances, rises of 12px or less, fades in. */
export const EASE = "cubic-bezier(0.16, 1, 0.3, 1)";
/** Something already on screen travels. */
export const EASE_MOVE = "cubic-bezier(0.77, 0, 0.175, 1)";
/** Something rises into place. */
export const EASE_DRAWER = "cubic-bezier(0.32, 0.72, 0, 1)";
/** Anything a scroll position drives (the finger is the clock): a
 *  symmetric sine in-out, so a scrubbed wipe or lift reads the same
 *  forwards and backwards. */
export const EASE_SCRUB = "cubic-bezier(0.37, 0, 0.63, 1)";
/** A critically damped spring (response 0.45 s, no overshoot) for hinged
 *  3D folds, about 600ms; EASE_MOVE where linear() is not supported. */
export const SPRING_HINGE =
  typeof CSS !== "undefined" && CSS.supports?.("transition-timing-function", "linear(0, 1)")
    ? "linear(0, 0.205 10%, 0.499 20%, 0.715 30%, 0.848 40%, 0.921 50%, 0.96 60%, 0.981 70%, 0.991 80%, 1)"
    : EASE_MOVE;

/** The demo passes count only what is clear of the fixed chrome: the
 *  sticky header (64 px + its 1 px border) and the phone CTA bar (about
 *  73 px). For the observers that start a pass; the ones that re-arm it
 *  watch the plain viewport. */
export const PASS_ROOT_MARGIN = "-65px 0px -80px 0px";

/** Thresholds for a figure that can be taller than that clear area
 *  (short screens, phones held sideways): every 5 %, so it still reports
 *  as it fills the area (see passShare). */
export const PASS_THRESHOLDS = Array.from({ length: 21 }, (_, i) => i / 20);

/** How much of an element a pass counts as on screen: its visible share,
 *  or, for one taller than the clear area (it can never be wholly in
 *  view there), the share of the area it fills. */
export function passShare(e: IntersectionObserverEntry): number {
  if (!e.isIntersecting) return 0;
  const room = e.rootBounds?.height ?? 0;
  return room > 0 ? Math.max(e.intersectionRatio, e.intersectionRect.height / room) : e.intersectionRatio;
}

/** Is the element on screen? `initial` until the first observation. */
export function useInView<T extends Element>(
  options: IntersectionObserverInit = {},
  initial = false,
): [React.RefObject<T | null>, boolean] {
  const ref = useRef<T>(null);
  const [inView, setInView] = useState(initial);
  const { root, rootMargin, threshold } = options;
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") {
      setInView(true);
      return;
    }
    // The latest entry: several can queue up between two callbacks.
    const io = new IntersectionObserver((entries) => setInView(entries[entries.length - 1].isIntersecting), {
      root,
      rootMargin,
      threshold,
    });
    io.observe(el);
    return () => io.disconnect();
  }, [root, rootMargin, threshold]);
  return [ref, inView];
}

function subscribeVisibility(cb: () => void): () => void {
  document.addEventListener("visibilitychange", cb);
  return () => document.removeEventListener("visibilitychange", cb);
}

/** Is the tab visible? (true on the server) */
export function useDocumentVisible(): boolean {
  return useSyncExternalStore(
    subscribeVisibility,
    () => document.visibilityState !== "hidden",
    () => true,
  );
}

function subscribeReducedMotion(cb: () => void): () => void {
  const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
  mq.addEventListener("change", cb);
  return () => mq.removeEventListener("change", cb);
}

/** prefers-reduced-motion (false on the server). */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(
    subscribeReducedMotion,
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    () => false,
  );
}
