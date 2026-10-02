"use client";
/**
 * The ⋯ menu of a project tile (UX12): Download · Copy post text ·
 * Rename · Edit again · Delete. A menu button (aria-haspopup) and a
 * role="menu" list rendered into <body> (the tile clips its content),
 * placed under the button or above it near the bottom of the window.
 * Arrow keys move, Escape / a click outside close it, focus goes back to
 * the button.
 */
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { Dialog } from "@/components/ui/Dialog";
import { createPortal } from "react-dom";
import { Copy, Download, Ellipsis, Pencil, Trash2, Undo2 } from "lucide-react";
import { Icon } from "@/components/ui/Icon";
import { useT } from "@/i18n";
import { mediaUrl, useMediaReady } from "@/lib/api";
import { fetchJob } from "./jobsStore";
import { postTextEntry, postTextKey, type PostTextEntry } from "./postText";
import type { Project } from "./projects";

const ITEM =
  "flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm outline-none hover:bg-[var(--surface-2)] focus-visible:bg-[var(--surface-2)]";

export function ProjectMenu({ p, onAction, onOpen }: {
  p: Project;
  onAction: (a: "rename" | "delete") => void;
  onOpen: (href: string) => void;
}) {
  const t = useT();
  const mediaReady = useMediaReady();
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState<"ok" | "none" | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const name = p.name || t("app.library.untitled");
  const live = p.state !== "expired";
  const canDownload = live && p.hasOutput && mediaReady;
  const canCopy = live && p.hasOutput;
  const canEditAgain = p.state === "edited";

  const close = (refocus = true) => {
    setOpen(false);
    setPos(null);
    if (refocus) button.current?.focus({ preventScroll: true });
  };

  useLayoutEffect(() => {
    if (!open) return;
    const a = button.current?.getBoundingClientRect();
    const el = menu.current;
    if (!a || !el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const left = Math.max(8, Math.min(a.right - w, window.innerWidth - w - 8));
    const below = a.bottom + 4;
    const top = below + h <= window.innerHeight - 8 ? below : Math.max(8, a.top - 4 - h);
    setPos({ left, top });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector<HTMLElement>("[role=menuitem]")?.focus({ preventScroll: true });
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (menu.current?.contains(target) || button.current?.contains(target)) return;
      close(false);
    };
    const onScroll = () => close(false);
    document.addEventListener("pointerdown", onDown, true);
    window.addEventListener("resize", onScroll);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("resize", onScroll);
    };
  }, [open]);

  const onKey = (e: KeyboardEvent) => {
    const items = [...(menu.current?.querySelectorAll<HTMLElement>("[role=menuitem]") ?? [])];
    const i = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const next = (i + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
      items[next]?.focus();
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      items[e.key === "Home" ? 0 : items.length - 1]?.focus();
    } else if (e.key === "Tab") {
      close(false);
    }
  };

  // The post text is fetched when the menu opens, so the click can write
  // it to the clipboard inside its own user gesture — Safari / iOS refuse
  // a clipboard write that comes after an await.
  // Kept for the next open only if it loaded, and only for the same
  // status / output / revision (postText.ts).
  const postText = useRef<PostTextEntry | null>(null);
  const textKey = postTextKey(p);
  useEffect(() => {
    if (!open || !canCopy) return;
    postText.current = postTextEntry(postText.current, textKey, () => fetchJob(p.id));
  }, [open, canCopy, p.id, textKey]);
  // Last resort: the text in a dialog to select and copy by hand.
  const [manual, setManual] = useState<string | null>(null);

  const done = (r: "ok" | "none") => {
    setCopied(r);
    setTimeout(() => setCopied(null), 1600);
  };
  const copyText = () => {
    const entry = postText.current;
    if (!entry) return done("none");
    const clip = typeof navigator !== "undefined" ? navigator.clipboard : undefined;
    if (entry.text !== null) {
      // Known already: written right now, in the gesture.
      if (!entry.text) return done("none");
      const text = entry.text;
      if (!clip) return setManual(text);
      clip.writeText(text).then(() => done("ok"), () => setManual(text));
      return;
    }
    // Still loading: a ClipboardItem with a promise keeps the gesture
    // (Safari); elsewhere write once the text is there.
    if (clip && typeof ClipboardItem !== "undefined" && typeof clip.write === "function") {
      const blob = entry.promise.then((t) => {
        if (!t) throw new Error("no text");
        return new Blob([t], { type: "text/plain" });
      });
      clip.write([new ClipboardItem({ "text/plain": blob })]).then(
        () => done("ok"),
        () => void entry.promise.then((t) => (t ? setManual(t) : done("none"))),
      );
      return;
    }
    void entry.promise.then((t) => {
      if (!t) return done("none");
      if (!clip) return setManual(t);
      clip.writeText(t).then(() => done("ok"), () => setManual(t));
    });
  };

  return (
    <>
      <button
        ref={button}
        type="button"
        data-testid="job-card-menu"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t("app.projects.menuAria", { name })}
        onClick={() => (open ? close() : setOpen(true))}
        className="inline-flex h-8 w-8 items-center justify-center rounded-full transition-colors hover:bg-[var(--surface-2)]"
        style={{ color: "var(--text-muted)" }}
      >
        <Icon icon={Ellipsis} size={18} />
      </button>
      {copied && (
        <span role="status" className="sr-only">
          {copied === "ok" ? t("app.projects.copied") : t("app.projects.copyNone")}
        </span>
      )}
      {open &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            ref={menu}
            role="menu"
            aria-label={t("app.projects.menuAria", { name })}
            data-testid="job-card-menu-list"
            onKeyDown={onKey}
            className="fixed z-50 min-w-[200px] rounded-xl p-1 shadow-xl"
            style={{
              left: pos?.left ?? -9999,
              top: pos?.top ?? -9999,
              background: "var(--surface-1)",
              border: "1px solid var(--border-hover)",
              color: "var(--text-strong)",
            }}
          >
            {canDownload && (
              <a
                role="menuitem"
                tabIndex={-1}
                href={mediaUrl(p.id, "download", { format: "primary" })}
                download
                data-testid="job-card-download"
                className={ITEM}
                onClick={() => close(false)}
              >
                <Icon icon={Download} />
                {t("app.projects.download")}
              </a>
            )}
            {canCopy && (
              <button role="menuitem" tabIndex={-1} type="button" className={ITEM} data-testid="job-card-copy" onClick={copyText}>
                <Icon icon={Copy} />
                {copied === "ok" ? t("app.projects.copied") : copied === "none" ? t("app.projects.copyNone") : t("app.projects.copyText")}
              </button>
            )}
            {canEditAgain && (
              <button
                role="menuitem"
                tabIndex={-1}
                type="button"
                className={ITEM}
                onClick={() => {
                  close(false);
                  onOpen(`/app/edit/${p.id}`);
                }}
              >
                <Icon icon={Undo2} />
                {t("app.projects.editAgain")}
              </button>
            )}
            {live && (
              <button
                role="menuitem"
                tabIndex={-1}
                type="button"
                className={ITEM}
                data-testid="job-card-rename"
                onClick={() => {
                  close(false);
                  onAction("rename");
                }}
              >
                <Icon icon={Pencil} />
                {t("app.projects.rename")}
              </button>
            )}
            <button
              role="menuitem"
              tabIndex={-1}
              type="button"
              className={ITEM}
              style={{ color: "var(--danger)" }}
              data-testid="job-card-delete"
              onClick={() => {
                close(false);
                onAction("delete");
              }}
            >
              <Icon icon={Trash2} />
              {t("app.projects.delete")}
            </button>
          </div>,
          document.body,
        )}
      {manual !== null && (
        <Dialog
          onClose={() => setManual(null)}
          label={t("app.projects.copyText")}
          testId="dialog-copy-text"
          panelClassName="w-full max-w-md rounded-2xl p-5"
          panelStyle={{ background: "var(--surface-1)", border: "1px solid var(--border-hover)" }}
        >
          <p className="mb-2 text-sm" style={{ color: "var(--text-body)" }}>
            {t("app.projects.copyManual")}
          </p>
          <textarea
            readOnly
            value={manual}
            rows={6}
            onFocus={(e) => e.currentTarget.select()}
            className="w-full rounded-lg p-3 text-sm"
            style={{ background: "var(--surface-2)", color: "var(--text-strong)", border: "1px solid var(--border)" }}
          />
        </Dialog>
      )}
    </>
  );
}
