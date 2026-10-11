// The upload inputs' formats (iOS: the original formats, else video/*),
// what a pick from the unfiltered "Pick anyway" input is, and when the
// start screen says iOS gave up on the video (pickWatch).
import { describe, expect, it } from "vitest";
import {
  BACK_MIN_OPEN_MS,
  CANCEL_AFTER_BACK_MS,
  GAVE_UP_CANCEL_MS,
  PickWatch,
  STALL_MS,
  type PickClock,
  type PickState,
} from "./pickWatch";
import {
  IOS_VIDEO_ACCEPT,
  originalTooBig,
  overLimitGb,
  pickedKind,
  resumeWithAny,
  VIDEO_ACCEPT,
  videoAccept,
} from "./videoPicker";

const IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1";
const MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15";
const ANDROID = "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36";

describe("videoAccept", () => {
  it("offers the original formats on an iPhone and an iPad (also in desktop mode)", () => {
    expect(videoAccept({ userAgent: IPHONE, platform: "iPhone", maxTouchPoints: 5 })).toBe(IOS_VIDEO_ACCEPT);
    expect(videoAccept({ userAgent: MAC, platform: "MacIntel", maxTouchPoints: 5 })).toBe(IOS_VIDEO_ACCEPT);
    // Chrome on iOS uses the same picker.
    expect(videoAccept({ userAgent: IPHONE.replace("Version/26.0", "CriOS/141.0"), platform: "iPhone", maxTouchPoints: 5 })).toBe(
      IOS_VIDEO_ACCEPT,
    );
  });

  it("keeps video/* everywhere else", () => {
    expect(videoAccept({ userAgent: MAC, platform: "MacIntel", maxTouchPoints: 0 })).toBe(VIDEO_ACCEPT);
    expect(videoAccept({ userAgent: ANDROID, platform: "Linux armv8l", maxTouchPoints: 5 })).toBe(VIDEO_ACCEPT);
    expect(videoAccept(undefined)).toBe("video/*");
  });

  it("lists exactly the formats of the owner's test C (MOV, MP4, HEVC; no wildcard)", () => {
    expect(IOS_VIDEO_ACCEPT.split(",")).toEqual(["video/quicktime", "video/mp4", "video/hevc", ".mov", ".mp4", ".m4v", ".hevc"]);
  });
});

describe("pickedKind", () => {
  it("takes videos by type, and by extension when the browser gives no type", () => {
    expect(pickedKind({ type: "video/quicktime", name: "IMG_0042.MOV" })).toBe("video");
    expect(pickedKind({ type: "video/mp4", name: "x" })).toBe("video");
    expect(pickedKind({ type: "", name: "clip.MOV" })).toBe("video");
    expect(pickedKind({ type: "application/octet-stream", name: "clip.mkv" })).toBe("video");
  });

  it("refuses photos and other files; says audio apart (the app's no_video message)", () => {
    expect(pickedKind({ type: "image/heic", name: "IMG_0043.HEIC" })).toBe("other");
    expect(pickedKind({ type: "image/jpeg", name: "IMG_0044.JPG" })).toBe("other");
    expect(pickedKind({ type: "", name: "notes.txt" })).toBe("other");
    expect(pickedKind({ type: "application/pdf", name: "a.mov.pdf" })).toBe("other");
    expect(pickedKind({ type: "audio/x-m4a", name: "memo.m4a" })).toBe("audio");
  });
});

/** A clock the test moves by hand. */
function fakeClock() {
  let now = 1_000_000;
  let timers: { at: number; fn: () => void; id: number }[] = [];
  let seq = 0;
  const clock: PickClock = {
    now: () => now,
    setTimeout: (fn, ms) => {
      const id = ++seq;
      timers.push({ at: now + ms, fn, id });
      return id;
    },
    clearTimeout: (id) => {
      timers = timers.filter((t) => t.id !== id);
    },
  };
  const advance = (ms: number) => {
    now += ms;
    const due = timers.filter((t) => t.at <= now);
    timers = timers.filter((t) => t.at > now);
    due.forEach((t) => t.fn());
  };
  return { clock, advance };
}

function watchWith() {
  const { clock, advance } = fakeClock();
  const changes: PickState[] = [];
  const w = new PickWatch((m) => changes.push(m), clock);
  return { w, advance, changes };
}

describe("PickWatch (iOS gave up on the video)", () => {
  it("a late cancel with no back signal around it is iOS giving up: the hint", () => {
    const { w, advance, changes } = watchWith();
    w.opened();
    advance(GAVE_UP_CANCEL_MS + 500);
    w.cancelled();
    // (A moment for a back signal that would make it the user's cancel.)
    expect(w.missed).toBe(false);
    advance(CANCEL_AFTER_BACK_MS);
    expect(w.missed).toBe(true);
    expect(changes).toEqual(["missed"]);
  });

  it("a quick cancel is the user closing the picker: no hint", () => {
    const { w, advance } = watchWith();
    w.opened();
    advance(3000);
    w.cancelled();
    advance(STALL_MS * 2);
    expect(w.state).toBe("none");
  });

  it("the picker closed with a selection, iOS gave up seconds later: the hint, however soon after opening", () => {
    // The review's case (a): selected at 4 s, cancelled at 7 s.
    const { w, advance } = watchWith();
    w.opened();
    advance(4000);
    w.back();
    advance(3000);
    w.cancelled();
    expect(w.missed).toBe(true);
  });

  it("a user who browsed for a while and then closed the picker: no hint (back and cancel together, in either order)", () => {
    // The review's case (b): 20 s in Photos, then Cancel.
    let { w, advance } = watchWith();
    w.opened();
    advance(20_000);
    w.back();
    advance(CANCEL_AFTER_BACK_MS - 300);
    w.cancelled();
    advance(STALL_MS * 2);
    expect(w.state).toBe("none");
    // The cancel first, the page's focus right after it.
    ({ w, advance } = watchWith());
    w.opened();
    advance(20_000);
    w.cancelled();
    advance(200);
    w.back();
    advance(STALL_MS * 2);
    expect(w.state).toBe("none");
    // The same after "Take Video" (recording for a minute, then Cancel).
    ({ w, advance } = watchWith());
    w.opened();
    advance(60_000);
    w.back();
    w.cancelled();
    expect(w.state).toBe("none");
  });

  it("back without a file and no cancel: the preparing status stays, 'Still nothing?' only after STALL_MS", () => {
    const { w, advance, changes } = watchWith();
    w.opened();
    advance(5000);
    w.back();
    // Way past the 15 s of before: iOS may still be at it (43 s for a
    // 140 MB clip in the owner's test C).
    advance(40_000);
    expect(w.state).toBe("none");
    advance(STALL_MS - 40_000);
    expect(w.state).toBe("stalled");
    expect(w.missed).toBe(false);
    // A cancel after all: iOS gave up (long after the page came back).
    w.cancelled();
    expect(w.state).toBe("missed");
    expect(changes).toEqual(["stalled", "missed"]);
  });

  it("a file that arrives (a slow export) hides everything", () => {
    const { w, advance, changes } = watchWith();
    w.opened();
    advance(5000);
    w.back();
    advance(STALL_MS + 1);
    expect(w.stalled).toBe(true);
    w.arrived();
    expect(w.state).toBe("none");
    expect(changes).toEqual(["stalled", "none"]);
    // … also one that arrives while a late cancel waits for a back signal.
    w.opened();
    advance(GAVE_UP_CANCEL_MS + 1);
    w.cancelled();
    w.arrived();
    advance(CANCEL_AFTER_BACK_MS * 2);
    expect(w.state).toBe("none");
  });

  it("ignores back signals right after opening (the tap that opened it) and while nothing is open", () => {
    const { w, advance } = watchWith();
    w.back();
    advance(STALL_MS * 2);
    expect(w.state).toBe("none");
    w.opened();
    advance(BACK_MIN_OPEN_MS - 100);
    w.back();
    advance(STALL_MS * 2);
    expect(w.state).toBe("none");
    // Still open: a later signal counts.
    w.back();
    advance(STALL_MS + 1);
    expect(w.state).toBe("stalled");
  });

  it("Pick anyway (from the hint): the hint goes once the picker closes, comes back on a cancel, never stalls", () => {
    const { w, advance } = watchWith();
    w.opened();
    advance(4000);
    w.back();
    advance(3000);
    w.cancelled();
    expect(w.missed).toBe(true);
    // The converting picker: closed with a selection, iOS converts (minutes).
    w.opened({ any: true, fromHint: true });
    expect(w.missed).toBe(true);
    advance(2000);
    w.back();
    expect(w.state).toBe("none");
    advance(7 * 60_000);
    expect(w.state).toBe("none");
    // It gave up on that one too: the hint again.
    w.cancelled();
    expect(w.missed).toBe(true);
    // Closed at once (the user changed their mind): the hint stays.
    w.opened({ any: true, fromHint: true });
    advance(1500);
    w.back();
    w.cancelled();
    expect(w.missed).toBe(true);
    // A photo picked there: the hint stays (the caller shows why).
    w.opened({ any: true, fromHint: true });
    w.closed();
    expect(w.missed).toBe(true);
    // A fresh try with the original-formats picker: it goes.
    w.opened();
    expect(w.missed).toBe(false);
  });

  it("the unfiltered picker on its own (Other video formats): a quick cancel says nothing", () => {
    const { w, advance } = watchWith();
    w.opened({ any: true });
    advance(1500);
    w.back();
    w.cancelled();
    advance(STALL_MS * 2);
    expect(w.state).toBe("none");
  });

  it("dispose stops a pending timer", () => {
    const { w, advance } = watchWith();
    w.opened();
    advance(2000);
    w.back();
    w.dispose();
    advance(STALL_MS * 2);
    expect(w.state).toBe("none");
  });
});

describe("originalTooBig (iOS: an original over the cap isn't uploaded)", () => {
  const cap = 10e9;
  it("holds back a pick from the original-formats input over the cap on iOS", () => {
    expect(originalTooBig(10e9 + 1, cap, { ios: true, original: true })).toBe(true);
    expect(originalTooBig(10e9, cap, { ios: true, original: true })).toBe(false);
  });

  it("lets everything else through to the upload (its own 413 file_too_large)", () => {
    // "Pick anyway" (converted), and every other platform.
    expect(originalTooBig(10e9 + 1, cap, { ios: true, original: false })).toBe(false);
    expect(originalTooBig(10e9 + 1, cap, { ios: false, original: true })).toBe(false);
    expect(originalTooBig(10e9 + 1, 0, { ios: true, original: true })).toBe(false);
  });

  it("says the size rounded up, never as the limit itself", () => {
    expect(overLimitGb(10e9 + 1)).toBe(10.1);
    expect(overLimitGb(12.34e9)).toBe(12.4);
    expect(overLimitGb(16.2e9)).toBe(16.2);
  });
});

describe("resumeWithAny (resuming an upload picked with Pick anyway)", () => {
  it("opens the unfiltered input again on iOS for a 'Pick anyway' upload only", () => {
    expect(resumeWithAny(true, "any")).toBe(true);
    expect(resumeWithAny(true, undefined)).toBe(false);
    expect(resumeWithAny(true, null)).toBe(false);
    expect(resumeWithAny(false, "any")).toBe(false);
  });
});
