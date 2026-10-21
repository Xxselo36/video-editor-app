import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { LANGS, loadLang, translate, type Lang, type TFn } from "@/i18n";
import { cutRange, splitSuggestions } from "@/features/editor/state/cuts";
import { EMPTY_TL_HISTORY, tlCommit, tlUndo } from "@/features/editor/timeline/history";
import type { EditorSeg } from "@/features/editor/timeline/mechanics";
import { removedRanges } from "../../model";
import { CutSuggestionNote } from "./CutSuggestionNote";

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
    expect(en).toContain('title="No “Cleo start” before it, so Cleo asks first."');
    expect(await loadLang("de")).toBe(true);
    const de = renderToStaticMarkup(createElement(CutSuggestionNote, { r, t: tOf("de"), onShow: () => {}, onTake: () => {} }));
    expect(de).toContain(">Vorschlag: 1:12 entfernen?</span>");
    expect(de).toContain('aria-label="Vorschlag zeigen: 1:12 entfernen"');
    expect(de).toContain('aria-label="Übernehmen: 1:12 entfernen"');
    expect(de).toContain(">Zeigen</button>");
    expect(de).toContain(">Übernehmen</button>");
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
