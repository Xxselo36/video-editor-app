"use client";
/**
 * Rename and delete a project (UX12): the dialogs of the ⋯ menu, on
 * Projects (its tiles) and on the Vorschau (its title row). The store
 * (./jobsStore) changes on the server and on this device.
 */
import { useId, useRef, useState } from "react";
import { Button, PRESS } from "@/components/ui/Button";
import { cx } from "@/components/ui/cx";
import { Dialog } from "@/components/ui/Dialog";
import { useT } from "@/i18n";
import { deleteProject, renameProject } from "./jobsStore";
import type { Project } from "./projects";

// The dialogs' actions: compact (both fit one row on a 320 px phone in
// every language), 44 px tall to a finger, pressed they give a little; a
// row that wraps rather than overflows in a wider font.
const ACTION = cx(PRESS, "pointer-coarse:min-h-11");
const ACTIONS = "flex flex-wrap justify-end gap-2";

/** `onRenamed`: the name the server took (the Vorschau shows it at once). */
export function RenameDialog({ p, onClose, onRenamed }: { p: Project; onClose: () => void; onRenamed?: (name: string) => void }) {
  const t = useT();
  const titleId = useId();
  const input = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(p.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const save = async () => {
    const v = value.trim();
    if (!v || v === p.name) return onClose();
    setBusy(true);
    setError(false);
    const ok = await renameProject(p.id, v);
    setBusy(false);
    if (!ok) return setError(true);
    onClose();
    onRenamed?.(v);
  };
  return (
    <Dialog onClose={onClose} labelledBy={titleId} testId="dialog-rename" initialFocus={input}
      panelClassName="w-full max-w-sm rounded-2xl p-5"
      panelStyle={{ background: "var(--surface-1)", border: "1px solid var(--border-hover)" }}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
        className="flex flex-col gap-4"
      >
        <h2 id={titleId} className="text-base font-semibold" style={{ color: "var(--text-strong)" }}>
          {t("app.projects.renameTitle")}
        </h2>
        <label className="flex flex-col gap-1.5 text-xs" style={{ color: "var(--text-muted)" }}>
          {t("app.projects.renameLabel")}
          <input
            ref={input}
            value={value}
            maxLength={120}
            onChange={(e) => setValue(e.target.value)}
            onFocus={(e) => e.currentTarget.select()}
            data-testid="rename-input"
            // 16 px on touch screens: iOS zooms into a smaller field.
            className="rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[var(--brand)] pointer-coarse:text-base"
            style={{ background: "var(--surface-2)", color: "var(--text-strong)", border: "1px solid var(--border)" }}
          />
        </label>
        {error && (
          <p role="alert" className="text-xs" style={{ color: "var(--danger)" }}>
            {t("app.projects.renameFailed")}
          </p>
        )}
        <div className={ACTIONS}>
          <Button variant="tint" size="sm" className={ACTION} onClick={onClose}>
            {t("app.projects.cancel")}
          </Button>
          <Button type="submit" size="sm" className={ACTION} disabled={busy} data-testid="rename-save">
            {t("app.projects.save")}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/** "busy" (409): it still runs; `onDeleted` after the server removed it. */
export function DeleteDialog({ p, onClose, onDeleted }: { p: Project; onClose: () => void; onDeleted?: () => void }) {
  const t = useT();
  const titleId = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<"busy" | "failed" | null>(null);
  const name = p.name || t("app.library.untitled");
  const remove = async () => {
    setBusy(true);
    setError(null);
    const r = await deleteProject(p.id);
    setBusy(false);
    if (r !== "ok") return setError(r);
    onClose();
    onDeleted?.();
  };
  return (
    <Dialog onClose={onClose} labelledBy={titleId} testId="dialog-delete"
      panelClassName="w-full max-w-sm rounded-2xl p-5"
      panelStyle={{ background: "var(--surface-1)", border: "1px solid var(--border-hover)" }}>
      <div className="flex flex-col gap-3">
        <h2 id={titleId} className="break-words text-base font-semibold" style={{ color: "var(--text-strong)" }}>
          {t("app.projects.deleteTitle", { name })}
        </h2>
        <p className="text-sm" style={{ color: "var(--text-body)" }}>
          {t("app.projects.deleteBody")}
        </p>
        {error && (
          <p role="alert" className="text-xs" style={{ color: "var(--danger)" }}>
            {t(error === "busy" ? "app.projects.deleteBusy" : "library.deleteFailed")}
          </p>
        )}
        <div className={cx("mt-1", ACTIONS)}>
          <Button variant="tint" size="sm" className={ACTION} onClick={onClose}>
            {t("app.projects.cancel")}
          </Button>
          {/* Dark text on the red: white on --danger is 3.0:1, --surface-0 6.5:1 (AA). */}
          <Button
            size="sm"
            disabled={busy}
            onClick={() => void remove()}
            data-testid="delete-confirm"
            className={cx(ACTION, "!bg-[var(--danger)] !text-[var(--surface-0)]")}
          >
            {t("app.projects.delete")}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
