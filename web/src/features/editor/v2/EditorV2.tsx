"use client";
/**
 * Entry of the v2 editor (UX7), loaded as its own chunk by the /app page
 * when the browser is on the v2 editor (flag.ts): the editor root (tokens, Geist fonts,
 * `data-editor-root` for the shortcut filter), then the skeleton while the
 * job loads, else the shell.
 */
import { useState } from "react";
import { EditorShell, type EditorShellProps } from "./EditorShell";
import { geist, geistMono } from "./fonts";
import { EditorRootContext, LANDSCAPE_QUERY, PHONE_QUERY, useKeyboardInset, useMediaQuery, useViewportFitCover } from "./hooks";
import { EditorSkeleton } from "./states";
import s from "./editor.module.css";

export type EditorV2Props = { loading: true; onBack?: () => void } | ({ loading?: false } & EditorShellProps);

export default function EditorV2(props: EditorV2Props) {
  const phone = useMediaQuery(PHONE_QUERY);
  const landscape = useMediaQuery(LANDSCAPE_QUERY) && phone;
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  // UX7c: safe areas and the on-screen keyboard on phones
  useViewportFitCover();
  useKeyboardInset(root, phone);
  const cls = [
    s.root,
    geist.variable,
    geistMono.variable,
    phone && s.phone,
    landscape && s.landscape,
    phone && sheetOpen && s.sheetOpen,
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <div ref={setRoot} className={cls} data-editor-root data-testid="editor-v2" data-layout={landscape ? "landscape" : phone ? "phone" : "desktop"}>
      <EditorRootContext.Provider value={root}>
        {props.loading ? (
          <EditorSkeleton phone={phone} onBack={props.onBack} />
        ) : (
          <EditorShell {...props} phone={phone} onSheetChange={setSheetOpen} />
        )}
      </EditorRootContext.Provider>
    </div>
  );
}
