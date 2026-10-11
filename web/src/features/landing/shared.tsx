"use client";
/**
 * Small pieces the landing sections share: the coloured command words,
 * the "{name}" → node helper, the call to action and visibility hooks.
 */
import Link from "next/link";
import { Fragment, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useT } from "@/i18n";
import { AUTH_ENABLED, BILLING_COPY } from "@/lib/auth";
import { useAuthState, useBillingEnabled } from "@/lib/account";
import { track } from "@/lib/analytics";
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

/** A command in its colour, in the language's quotation marks.
 *  `inherit`: keep the surrounding weight (headings). */
export function Cmd({ id, inherit = false }: { id: CmdId; inherit?: boolean }) {
  const t = useT();
  return (
    <span className={cx("whitespace-nowrap", !inherit && "font-semibold")} style={{ color: CMD_COLOR[id] }}>
      {t("site.quote", { text: CMD_PHRASE[id] })}
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
