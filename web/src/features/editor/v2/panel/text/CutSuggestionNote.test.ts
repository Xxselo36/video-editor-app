import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { LANGS, loadLang, translate, type Lang, type TFn } from "@/i18n";
import { cutRange, splitSuggestions, type OpenSuggestion } from "@/features/editor/state/cuts";
import type { DocWord } from "@/features/editor/state/doc";
import { EMPTY_TL_HISTORY, tlCommit, tlUndo } from "@/features/editor/timeline/history";
import type { EditorSeg } from "@/features/editor/timeline/mechanics";
import { removedRanges } from "../../model";
import { bulkRestoreOp, cutsModel, removedOf, takeSuggestionOp } from "../../useCuts";
import { CutSuggestionNote, SuggestionNotes } from "./CutSuggestionNote";

const tOf =
  (lang: Lang): TFn =>
  (key, vars) =>
    translate(lang, key, vars);
const seg = (id: string, start: number, end: number): EditorSeg => ({ id, start, end });

/** The buttons of a rendered note (the component has no hooks: call it). */
function buttons(el: ReactNode): ReactElement<{ "data-testid": string; onClick: () => void; "aria-label": string }>[] {
  const out: ReactElement<{ "data-testid": string; onClick: () => void; "aria-label": string }>[] = [];
  const walk = (n: ReactNode) => {
    if (Array.isArray(n)) return n.forEach(walk);
    if (!isValidElement<{ children?: ReactNode }>(n)) return;
    if (n.type === "button") out.push(n as (typeof out)[number]);
    walk(n.props.children);
  };
  walk(el);
  return out;
}

describe("the suggestion note (“Suggestion: remove 1:12? · Show · Apply”)", () => {
  // 80 s suggested, 7.5 s of it cut already (a pause): 1:12 still plays
  const r = { start: 10, end: 90, plays: 72.5 };

  it("says what still plays, names Show and Apply after it, and why it waits (en, de)", async () => {
    const en = renderToStaticMarkup(createElement(CutSuggestionNote, { r, t: tOf("en"), onShow: () => {}, onTake: () => {} }));
    expect(en).toContain(">Suggestion: remove 1:12?</span>");
    expect(en).toContain('aria-label="Show suggestion: remove 1:12"');
    expect(en).toContain('aria-label="Apply: remove 1:12"');
    expect(en).toContain(">Show</button>");
    expect(en).toContain(">Apply</button>");
    // why: a visible line under the row (review F6: phones have no hover), describing Apply
    expect(en).toContain('aria-describedby="ed-sugg-why-10000-90000"');
    expect(en).toContain('id="ed-sugg-why-10000-90000"');
    expect(en).toContain('data-testid="ed-suggestion-why">No “Cleo start” before it, so Cleo asks first.</div>');
    expect(en).not.toContain("title=");
    expect(await loadLang("de")).toBe(true);
    const de = renderToStaticMarkup(createElement(CutSuggestionNote, { r, t: tOf("de"), onShow: () => {}, onTake: () => {} }));
    expect(de).toContain(">Vorschlag: 1:12 entfernen?</span>");
    expect(de).toContain('aria-label="Vorschlag zeigen: 1:12 entfernen"');
    expect(de).toContain('aria-label="Übernehmen: 1:12 entfernen"');
    expect(de).toContain(">Zeigen</button>");
    expect(de).toContain(">Übernehmen</button>");
    expect(de).toContain('data-testid="ed-suggestion-why">Davor kam kein „Cleo start“, darum fragt Cleo erst.</div>');
  });

  it("Show and Apply call their own action", () => {
    const onShow = vi.fn();
    const onTake = vi.fn();
    const [show, take] = buttons(CutSuggestionNote({ r, t: tOf("en"), onShow, onTake }));
    expect([show.props["data-testid"], take.props["data-testid"]]).toEqual(["ed-suggestion-show", "ed-suggestion-take"]);
    show.props.onClick();
    expect([onShow.mock.calls.length, onTake.mock.calls.length]).toEqual([1, 0]);
    take.props.onClick();
    expect([onShow.mock.calls.length, onTake.mock.calls.length]).toEqual([1, 1]);
  });

  it("every language's button name holds the visible label (WCAG 2.5.3 label in name)", async () => {
    for (const lang of Object.keys(LANGS) as Lang[]) {
      expect(await loadLang(lang)).toBe(true);
      const t = tOf(lang);
      const [show, take] = buttons(CutSuggestionNote({ r, t, onShow: () => {}, onTake: () => {} }));
      const low = (x: string) => x.toLocaleLowerCase(lang);
      expect(low(show.props["aria-label"]), lang).toContain(low(t("editor.cuts.showTake")));
      expect(low(take.props["aria-label"]), lang).toContain(low(t("editor.cuts.takeSuggestion")));
      expect(show.props["aria-label"], lang).toContain("1:12");
      expect(take.props["aria-label"], lang).toContain("1:12");
    }
  });

  it("Apply is one undo step; the undo offers the suggestion again", () => {
    // useCuts takeSuggestion: cutRange of the suggestion, one history commit
    const D = 100;
    const sugg = [{ id: 0, start: 10, end: 80, kind: "voice_cmd" }];
    const before = [seg("a", 0, 30), seg("b", 31, D)];
    const [open] = splitSuggestions(sugg, removedRanges(before, D)).open;
    expect(open).toEqual({ start: 10, end: 80, plays: 69 });
    const after = cutRange(before, open.start, open.end, D);
    const c = tlCommit(EMPTY_TL_HISTORY, before, after, undefined, 0);
    expect(c.apply && c.added).toBe(true);
    expect(c.st.history).toHaveLength(1);
    expect(splitSuggestions(sugg, removedRanges(after, D)).open).toEqual([]);
    const u = tlUndo(c.st, after)!;
    expect(u.to).toBe(before);
    expect(u.st.history).toHaveLength(0);
    expect(splitSuggestions(sugg, removedRanges(u.to, D)).open).toEqual([open]);
  });
});

describe("the Text tab's suggestion row, from the job to Apply (useCuts cutsModel → SuggestionNotes)", () => {
  // 100 s, no "Cleo start": the analysis cut only the "Cleo cut." phrase
  // (79.4-80) and suggests its 80 s take (job.cut_suggestions)
  const D = 100;
  const words: DocWord[] = [];
  for (let k = 0, at = 0.5; at + 0.4 <= 79; k++, at += 0.5) words.push({ id: `w${k}`, text: "Wort", start: at, end: at + 0.4 });
  words.push({ id: "c1", text: "Cleo", start: 79.4, end: 79.7 }, { id: "c2", text: "cut.", start: 79.7, end: 80 });
  words.push({ id: "n1", text: "Weiter.", start: 81, end: 81.5 });
  const job = {
    cutRanges: [{ id: 0, start: 79.4, end: 80, kind: "voice_cmd" }],
    cutSuggestions: [{ id: 0, start: 0, end: 80, kind: "voice_cmd" }],
    sceneEvents: [{ type: "restart", start: 79.4, end: 80, source: "analysis", heard: "clear" }],
    words,
  };
  // as useCuts gets it: removed from the clips (none while they aren't known)
  const model = (segs: EditorSeg[]) => cutsModel({ ...job, segs, removed: removedOf(segs, D) });
  const clips = [seg("a", 0, 79.4), seg("b", 80, D)];

  it("offers the suggestion (none before the clips are known); the lone phrase is no take", async () => {
    expect(model([]).suggestions).toEqual([]);
    const m = model(clips);
    expect(m.suggestions).toEqual([{ start: 0, end: 80, plays: 79.4 }]);
    expect(m.takes).toEqual([]);
    // the cuts menu: no "Restore Cleo-cut takes" for the lone phrase (review F4)
    expect(m.counts).toMatchObject({ voice_cmd: 0, ai: 1 });
    expect(bulkRestoreOp(clips, m, "voice_cmd", D)).toBe(clips);
    const html = renderToStaticMarkup(
      createElement(SuggestionNotes, { suggestions: m.suggestions, t: tOf("en"), onShow: () => {}, onTake: () => {} }),
    );
    expect(html.match(/data-testid="ed-cut-suggestion"/g)).toHaveLength(1);
    expect(html).toContain(">Suggestion: remove 1:19?</span>");
    expect(html).toContain(">No “Cleo start” before it, so Cleo asks first.</div>");
  });

  it("Show and Apply act on their own row; Apply is one undo step, then a counted take; restore or undo offer it again", () => {
    const shown: OpenSuggestion[] = [];
    const taken: OpenSuggestion[] = [];
    const two = [{ start: 0, end: 80, plays: 79.4 }, { start: 85, end: 99, plays: 14 }];
    const notes = SuggestionNotes({ suggestions: two, t: tOf("en"), onShow: (x) => shown.push(x), onTake: (x) => taken.push(x) });
    const rows = (notes as ReactElement<{ children: ReactElement<{ onShow: () => void; onTake: () => void }>[] }>).props.children;
    expect(rows).toHaveLength(2);
    rows[1].props.onShow();
    rows[0].props.onTake();
    expect([shown, taken]).toEqual([[two[1]], [two[0]]]);
    // Apply (TranscriptEditor takeSuggestion → useCuts → takeSuggestionOp): one history commit
    const [open] = model(clips).suggestions;
    const after = takeSuggestionOp(clips, open, D);
    expect(removedRanges(after, D)).toEqual([{ start: 0, end: 80 }]);
    // its whole span, also when a part in it is cut already (plays < its length)
    const holed = cutRange(clips, 10, 20, D);
    const [part] = model(holed).suggestions;
    expect(part).toEqual({ start: 0, end: 80, plays: 69.4 });
    expect(removedRanges(takeSuggestionOp(holed, part, D), D)).toEqual([{ start: 0, end: 80 }]);
    const c = tlCommit(EMPTY_TL_HISTORY, clips, after, undefined, 0);
    expect(c.apply && c.added).toBe(true);
    expect(c.st.history).toHaveLength(1);
    const m = model(after);
    expect(m.suggestions).toEqual([]);
    // the note's "Cleo cut: 1 botched take" and the menu's "Restore Cleo-cut takes 1"
    expect(m.takes).toEqual([{ start: 0, end: 80, kind: "voice_cmd" }]);
    expect(m.counts).toMatchObject({ voice_cmd: 1, ai: 1 });
    // "Restore Cleo-cut takes" brings it back: offered again
    const restored = bulkRestoreOp(after, m, "voice_cmd", D);
    expect(model(restored).suggestions).toEqual([{ start: 0, end: 80, plays: 80 }]);
    // so does the undo
    const u = tlUndo(c.st, after)!;
    expect(model(u.to).suggestions).toEqual([open]);
  });
});
