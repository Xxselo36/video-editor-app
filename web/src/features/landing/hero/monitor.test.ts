import { describe, expect, it } from "vitest";
import { LANGS, type Lang } from "@/i18n/langs";
import { deLanding } from "@/i18n/messages/de/landing";
import { enLanding } from "@/i18n/messages/en/landing";
import { esLanding } from "@/i18n/messages/es/landing";
import { frLanding } from "@/i18n/messages/fr/landing";
import { hiLanding } from "@/i18n/messages/hi/landing";
import { idLanding } from "@/i18n/messages/id/landing";
import { itLanding } from "@/i18n/messages/it/landing";
import { jaLanding } from "@/i18n/messages/ja/landing";
import { koLanding } from "@/i18n/messages/ko/landing";
import { nlLanding } from "@/i18n/messages/nl/landing";
import { plLanding } from "@/i18n/messages/pl/landing";
import { ptLanding } from "@/i18n/messages/pt/landing";
import { ruLanding } from "@/i18n/messages/ru/landing";
import { trLanding } from "@/i18n/messages/tr/landing";
import { captionWords, spokenUntil } from "../captions/words";
import { HERO_S, RAW_S, SEAM_MS, SHARED, drains, steer as steerAt, timecode, timingOf, type Cue } from "./monitor";
import * as score from "./score";
import { AT, FINISHED, HEAD_FROM, HEAD_MS, LOOP_FROM, MARKED, PIECES, RENDER_MS, STEPS, headAt, type PieceId } from "./score";

const { cuts: CUTS, firstKept: FIRST_KEPT, jumpMs: JUMP_MS, rate: RAW_RATE, cuesAt, rawAt, rawAtHead } = timingOf(score);
const steer = (target: number, at: number, rate: number) => steerAt(target, at, rate, RAW_RATE);

const piece = (id: PieceId) => PIECES.find((p) => p.id === id)!;
/** A piece's stretch of the raw take (s). */
const span = (id: PieceId) => [rawAt(AT[id]), rawAt(AT[id] + piece(id).g)] as const;
const kinds = (cues: Cue[]) => cues.map((c) => (c.kind === "cut" ? `cut ${c.cut.id}` : c.kind));
/** The cues of one pass of the loop, from the hold after the captions to the captions. */
function loopCues(): string[][] {
  const out: string[][] = [];
  let prev = STEPS[STEPS.length - 1];
  for (const s of STEPS.slice(LOOP_FROM)) {
    out.push(kinds(cuesAt(prev, s)));
    prev = s;
  }
  return out;
}

describe("hero monitor: the raw take on the tape", () => {
  it("the playhead's run is the whole take", () => {
    expect(rawAt(HEAD_FROM)).toBe(0);
    expect(rawAt(AT.post)).toBe(RAW_S);
    // it waits on its first frame before “Cleo start” and its last after “Cleo finish”
    expect(rawAt(0)).toBe(0);
    expect(rawAt(100)).toBe(RAW_S);
    for (let x = 1; x <= 100; x++) expect(rawAt(x)).toBeGreaterThanOrEqual(rawAt(x - 1));
  });

  it("follows the playhead's clock, and reads as fast-forward", () => {
    expect(rawAtHead(0)).toBe(0);
    expect(rawAtHead(HEAD_MS)).toBe(RAW_S);
    expect(rawAtHead(HEAD_MS + 500)).toBe(RAW_S);
    // the clock and the tape agree on every post (headAt rounds to 1 ms)
    for (const id of ["a", "um", "b", "pause", "c", "skip", "d"] as PieceId[]) {
      expect(Math.abs(rawAtHead(headAt(AT[id])) - rawAt(AT[id]))).toBeLessThan(0.005);
    }
    expect(RAW_RATE).toBeCloseTo(RAW_S / (HEAD_MS / 1000), 10);
    expect(RAW_RATE).toBeGreaterThan(3);
    expect(RAW_RATE).toBeLessThan(4.5);
  });

  it("the finished video starts at its first kept take, inside what it shares with the raw take", () => {
    expect(FIRST_KEPT).toBe(rawAt(AT.a));
    expect(FIRST_KEPT).toBeCloseTo(3.17, 2);
    // the render wipes the grade across one frame both takes have
    expect(FIRST_KEPT).toBeGreaterThanOrEqual(SHARED[0]);
    expect(FIRST_KEPT).toBeLessThan(SHARED[1]);
    // short of the finished video's own loop crossfade (its last 0.4 s)
    expect(SHARED[1]).toBeCloseTo(HERO_S - 0.4, 10);
    expect(HERO_S).toBeLessThan(RAW_S);
  });
});

/** Each language's caption, as the hero plays it. */
const LANDING: Record<Lang, Partial<Record<keyof typeof enLanding, string>>> = {
  en: enLanding,
  de: deLanding,
  es: esLanding,
  fr: frLanding,
  pt: ptLanding,
  it: itLanding,
  tr: trLanding,
  pl: plLanding,
  nl: nlLanding,
  ru: ruLanding,
  ja: jaLanding,
  ko: koLanding,
  id: idLanding,
  hi: hiLanding,
};
/** TakeStrip's hold after the caption's last word (s). */
const CAPTION_HOLD = 0.4;
const SEAM_S = SEAM_MS / 1000;

describe("hero monitor: the seam", () => {
  it("drains over the seam step, the length of the monitor's fade", () => {
    const seams = STEPS.filter((s) => s.fade === "out");
    expect(seams).toHaveLength(1);
    expect(seams[0].ms).toBe(SEAM_MS);
  });

  it("drains only where both files show the same frame, even if it starts a little late", () => {
    for (let t = 0; t < HERO_S; t += 0.01) {
      if (!drains(t)) continue;
      expect(t).toBeGreaterThanOrEqual(SHARED[0]);
      expect(t + SEAM_S + 0.1).toBeLessThanOrEqual(SHARED[1] + 1e-9);
    }
    // the middle drains; the finished video's loop crossfade and its wrap do not
    expect(drains(1)).toBe(true);
    expect(drains(4.5)).toBe(true);
    for (const t of [5.3, 5.6, 5.77, 5.95]) expect(drains(t)).toBe(false);
  });

  it("every language: the steady seam drains inside the shared frames, or the snap takes over", () => {
    // From the second loop on, the Scene starts at the first kept take on
    // the reveal, plays the caption and the hold after it, then the seam.
    const hold = STEPS[LOOP_FROM].ms / 1000;
    for (const lang of Object.keys(LANGS) as Lang[]) {
      const caption = LANDING[lang]["site.demo.caption"] ?? enLanding["site.demo.caption"];
      const capS = Math.round((spokenUntil(captionWords(caption, lang)) + CAPTION_HOLD) * 1000) / 1000;
      const t = (FIRST_KEPT + capS + hold) % HERO_S;
      const clean = t >= SHARED[0] && t + SEAM_S <= SHARED[1];
      // a drain across the finished video's loop would blend two poses
      if (drains(t)) expect(clean, lang).toBe(true);
      if (!clean) expect(drains(t), lang).toBe(false);
    }
  });
});

describe("hero monitor: the cuts", () => {
  it("every marked removal and the head trim flash; the tail trim does not", () => {
    const ids = CUTS.map((c) => c.id);
    for (const m of MARKED) expect(ids).toContain(m.id);
    expect(ids).toContain("pre");
    expect(ids).not.toContain("post");
    // in tape order, and only what the edit removes
    expect(ids).toEqual(PIECES.map((p) => p.id).filter((id) => ids.includes(id)));
    for (const id of ids) expect(FINISHED.gone).toContain(id);
  });

  it("each flashes a frame inside its own piece", () => {
    for (const c of CUTS) {
      const [from, to] = span(c.id);
      expect(c.at).toBeGreaterThanOrEqual(from);
      expect(c.at).toBeLessThanOrEqual(to);
      // never a frame of a kept take
      for (const p of PIECES.filter((q) => !FINISHED.gone.includes(q.id) && piece(q.id).g > 0)) {
        const [a, b] = span(p.id);
        expect(c.at > a && c.at < b).toBe(false);
      }
    }
  });

  it("each jump lands on the first frame of the next kept take", () => {
    for (const c of CUTS) {
      const n = PIECES.findIndex((p) => p.id === c.id);
      const next = PIECES.slice(n + 1).find((p) => !FINISHED.gone.includes(p.id))!;
      expect(next.kind).toBe("take");
      expect(c.to).toBe(rawAt(AT[next.id]));
      // forward through the take, past the removed moment
      expect(c.to).toBeGreaterThan(c.at);
    }
  });

  it("the head trim lands on the finished video's first frame and holds it for the render", () => {
    const head = CUTS.filter((c) => c.hold);
    expect(head.map((c) => c.id)).toEqual(["pre"]);
    expect(head[0].to).toBe(FIRST_KEPT);
  });

  it("the jump comes as the tape starts closing, well before the next lift", () => {
    expect(JUMP_MS).toBeGreaterThan(0);
    // the lanes are still closing behind it
    expect(JUMP_MS).toBeGreaterThan(score.CLOSE_DELAY_MS);
    expect(JUMP_MS).toBeLessThan(score.CLOSE_DELAY_MS + score.CLOSE_MS);
    const lifts = STEPS.filter((s, n) => n > 0 && s.phase === "edit" && cuesAt(STEPS[n - 1], s).some((c) => c.kind === "cut"));
    for (const s of lifts) expect(s.ms).toBeGreaterThan(JUMP_MS + 150);
  });
});

describe("hero monitor: following the playhead", () => {
  it("leaves the speed alone when in step", () => {
    expect(steer(5, 5, RAW_RATE)).toEqual({});
    expect(steer(5.01, 5, RAW_RATE)).toEqual({});
  });

  it("never flutters on the clocks' jitter: in step, ±0.03 s around the playhead changes nothing", () => {
    for (let n = 0; n < 200; n++) {
      const jitter = 0.03 * Math.sin(n * 2.399);
      expect(steer(5 + jitter, 5, RAW_RATE)).toEqual({});
    }
  });

  it("corrects a drift with a few speed changes, then holds the base speed", () => {
    // one display frame at a time, the take lagging 0.4 s at first and
    // its clock read with ±0.03 s of jitter
    const dt = 1 / 60;
    let target = 2;
    let at = 1.6;
    let rate = RAW_RATE;
    let changes = 0;
    for (let n = 0; n < 4.5 * 60; n++) {
      target += RAW_RATE * dt;
      at += rate * dt;
      const next = steer(target, at + 0.03 * Math.sin(n * 2.399), rate);
      expect(next.seek).toBeUndefined();
      if (next.rate !== undefined && next.rate !== rate) {
        rate = next.rate;
        changes++;
      }
    }
    expect(changes).toBeGreaterThan(0);
    expect(changes).toBeLessThanOrEqual(4);
    expect(rate).toBe(RAW_RATE);
    expect(Math.abs(target - at)).toBeLessThan(0.12);
  });

  it("a take that keeps lagging (a slow decoder) is corrected a few times a second at most", () => {
    const dt = 1 / 60;
    let target = 0;
    let at = 0;
    let rate = RAW_RATE;
    let changes = 0;
    for (let n = 0; n < 4.5 * 60; n++) {
      target += RAW_RATE * dt;
      // it delivers only 85 % of the speed it is set to
      at += 0.85 * rate * dt;
      const next = steer(target, at + 0.03 * Math.sin(n * 2.399), rate);
      if (next.seek !== undefined) at = next.seek;
      if (next.rate !== undefined && next.rate !== rate) {
        rate = next.rate;
        changes++;
      }
      expect(Math.abs(target - at)).toBeLessThan(1.3);
    }
    expect(changes / 4.5).toBeLessThanOrEqual(3);
  });

  it("steers only the speed when a little off, within limits", () => {
    const behind = steer(5.3, 5, RAW_RATE);
    expect(behind.seek).toBeUndefined();
    expect(behind.rate).toBeGreaterThan(RAW_RATE);
    const ahead = steer(5, 5.3, RAW_RATE);
    expect(ahead.seek).toBeUndefined();
    expect(ahead.rate).toBeLessThan(RAW_RATE);
    for (const err of [-1.1, -0.6, 0.6, 1.1]) {
      const r = steer(8 + err, 8, RAW_RATE).rate!;
      expect(r).toBeGreaterThanOrEqual(RAW_RATE * 0.5);
      expect(r).toBeLessThanOrEqual(RAW_RATE * 1.5);
    }
    // back to the base speed once in step again
    expect(steer(5, 5, RAW_RATE * 1.3).rate).toBe(RAW_RATE);
  });

  it("jumps only when far off, ahead of the playhead and inside the take", () => {
    const far = steer(10, 6, RAW_RATE * 1.4);
    expect(far.seek).toBeGreaterThan(10);
    expect(far.seek).toBeLessThan(10.5);
    expect(far.rate).toBe(RAW_RATE);
    expect(steer(10, 6, RAW_RATE).rate).toBeUndefined();
    expect(steer(RAW_S, 2, RAW_RATE).seek).toBeLessThan(RAW_S);
  });

  it("the timecode runs 0:00 to 0:16 over the take", () => {
    expect(timecode(0)).toBe("0:00");
    expect(timecode(9.99)).toBe("0:09");
    expect(timecode(RAW_S)).toBe("0:16");
    expect(timecode(65)).toBe("1:05");
    expect(timecode(-1)).toBe("0:00");
  });
});

describe("hero monitor: the cues of the loop", () => {
  it("one pass: cue, seam, the dissolve, follow, read, the five cuts, render, reveal", () => {
    const cues = loopCues();
    expect(cues.flat()).toEqual([
      "prime",
      "seam",
      "snap",
      "follow",
      "read",
      "cut bad",
      "cut um",
      "cut pause",
      "cut skip",
      "cut pre",
      "render",
      "reveal",
    ]);
    // at most one cue a step
    for (const c of cues) expect(c.length).toBeLessThanOrEqual(1);
  });

  it("each cue lands on the step it belongs to", () => {
    let prev = STEPS[STEPS.length - 1];
    for (const s of STEPS.slice(LOOP_FROM)) {
      for (const c of cuesAt(prev, s)) {
        if (c.kind === "prime") {
          // the hold right before the seam, cued for its length
          expect(STEPS[STEPS.indexOf(s) + 1].fade).toBe("out");
          expect(c.ms).toBe(s.ms);
        }
        if (c.kind === "seam") expect(s).toMatchObject({ fade: "out", frame: "lit" });
        if (c.kind === "snap") expect(s).toMatchObject({ fade: "snap", frame: "raw" });
        if (c.kind === "follow") expect(s.head).toBe("run");
        if (c.kind === "read") expect(s.sweep).toBe("read");
        if (c.kind === "cut") {
          // as its piece lifts off the tape
          expect(s.gone).toContain(c.cut.id);
          expect(prev.gone).not.toContain(c.cut.id);
        }
        if (c.kind === "render") expect(s).toMatchObject({ sweep: "render", frame: "raw", ms: RENDER_MS });
        if (c.kind === "reveal") expect(s).toMatchObject({ frame: "lit", reveal: true });
      }
      prev = s;
    }
  });

  it("the first load only cues the seam; a monitor that mounts mid-loop waits for one", () => {
    const first: string[] = [];
    let prev: (typeof STEPS)[number] | undefined;
    for (const s of STEPS.slice(0, LOOP_FROM + 1)) {
      first.push(...kinds(cuesAt(prev, s)));
      prev = s;
    }
    expect(first).toEqual(["prime"]);
    // mounted on any step: no cut, reveal or seam it did not see begin
    for (const s of STEPS) {
      for (const c of kinds(cuesAt(undefined, s))) expect(["prime", "seam", "snap", "follow", "read", "render"]).toContain(c);
    }
  });
});
