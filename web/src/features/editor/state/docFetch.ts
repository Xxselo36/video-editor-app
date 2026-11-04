/**
 * GET /jobs/{id}/doc (UT3, UT5): the edit document with what the caption
 * layer needs. Read by the v2 editor (v2/useDocSession.ts) and by the
 * Vorschau's preview (features/project/PreviewVideo.tsx), which draws
 * the export's captions over the cut preview without the editor.
 */
import { apiFetch } from "@/lib/api";
import type { EditDoc } from "./doc";

/**
 * UT5 (GET /jobs/{id}/doc): `engine` — the export's caption engine
 * ("optin": the browser's ?captions=v2 decides); `presetsLive` — the
 * presets the Style panel offers; `recommended` — up to three for this
 * transcript. The doc's style starts as the server's `render_style`
 * (what an export draws now: before the first editor save, a v1
 * caption preset decides).
 */
export type DocCaptions = { engine: "v1" | "v2" | "optin"; presetsLive: string[] | null; recommended: string[] };

export function docCaptions(j: Record<string, unknown>): DocCaptions {
  const e = j.caption_engine;
  const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : null);
  return {
    engine: e === "v2" || e === "optin" ? e : "v1",
    presetsLive: strings(j.presets_live),
    recommended: strings(j.recommended) ?? [],
  };
}

export const isStyle = (v: unknown): v is EditDoc["style"] =>
  !!v && typeof v === "object" && typeof (v as { presetId?: unknown }).presetId === "string";

export type Fetched = { doc: EditDoc; rev: number; read_only: boolean; captions: DocCaptions; renderStyle: EditDoc["style"] | null };

export async function fetchDoc(jobId: string): Promise<Fetched | null> {
  const r = await apiFetch(`/jobs/${jobId}/doc`);
  if (!r.ok) return null;
  const j = await r.json();
  if (!j || !j.doc || !Array.isArray(j.doc.words)) return null;
  const captions = docCaptions(j);
  // Only a live style: the first save sends it, and PATCH refuses others.
  const renderStyle =
    isStyle(j.render_style) && (!captions.presetsLive || captions.presetsLive.includes(j.render_style.presetId))
      ? j.render_style
      : null;
  return {
    doc: j.doc as EditDoc,
    rev: typeof j.rev === "number" ? j.rev : 0,
    read_only: !!j.read_only,
    captions,
    renderStyle,
  };
}

/**
 * The doc as the editor shows it (UT5): with the style an export draws now
 * — before the first editor save that can be a v1 caption preset's look,
 * not yet the doc's own style. Saved with the next edit.
 */
export function withRenderStyle(doc: EditDoc, style: EditDoc["style"] | null): EditDoc {
  return style && JSON.stringify(style) !== JSON.stringify(doc.style) ? { ...doc, style } : doc;
}
