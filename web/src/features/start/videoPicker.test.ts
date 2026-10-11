// The upload inputs' formats (iOS: the original formats, else video/*),
// what a pick from the unfiltered "Pick anyway" input is, and when the
// start screen says iOS gave up on the video (pickWatch).
import { describe, expect, it } from "vitest";
import { BACK_GRACE_MS, BACK_MIN_OPEN_MS, GAVE_UP_CANCEL_MS, PickWatch, type PickClock } from "./pickWatch";
import { IOS_VIDEO_ACCEPT, pickedKind, VIDEO_ACCEPT, videoAccept } from "./videoPicker";

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
  const changes: boolean[] = [];
  const w = new PickWatch((m) => changes.push(m), clock);
  return { w, advance, changes };
}

describe("PickWatch (iOS gave up on the video)", () => {
  it("a cancel long after the picker opened is iOS giving up: the hint shows", () => {
    const { w, advance, changes } = watchWith();
    w.opened();
    advance(GAVE_UP_CANCEL_MS + 500);
    w.cancelled();
    expect(w.missed).toBe(true);
    expect(changes).toEqual([true]);
  });

  it("a quick cancel is the user closing the picker: no hint", () => {
    const { w, advance } = watchWith();
    w.opened();
    advance(3000);
    w.cancelled();
    expect(w.missed).toBe(false);
  });

  it("the page back without a file: the hint after the grace period", () => {
    const { w, advance } = watchWith();
    w.opened();
    advance(BACK_MIN_OPEN_MS + 1);
    w.back();
    advance(BACK_GRACE_MS - 10);
    expect(w.missed).toBe(false);
    advance(20);
    expect(w.missed).toBe(true);
  });

  it("a file within the grace period (the export was slow): no hint", () => {
    const { w, advance, changes } = watchWith();
    w.opened();
    advance(5000);
    w.back();
    advance(BACK_GRACE_MS / 2);
    w.arrived();
    advance(BACK_GRACE_MS * 2);
    expect(changes).toEqual([]);
  });

  it("a file after the hint showed (a very slow export): the hint goes", () => {
    const { w, advance, changes } = watchWith();
    w.opened();
    advance(5000);
    w.back();
    advance(BACK_GRACE_MS + 1);
    expect(w.missed).toBe(true);
    w.arrived();
    expect(w.missed).toBe(false);
    expect(changes).toEqual([true, false]);
  });

  it("ignores back signals right after opening (the tap that opened it) and while nothing is open", () => {
    const { w, advance } = watchWith();
    w.back();
    advance(BACK_GRACE_MS * 2);
    expect(w.missed).toBe(false);
    w.opened();
    advance(BACK_MIN_OPEN_MS - 100);
    w.back();
    advance(BACK_GRACE_MS * 2);
    expect(w.missed).toBe(false);
    // Still open: a later signal counts.
    w.back();
    advance(BACK_GRACE_MS + 1);
    expect(w.missed).toBe(true);
  });

  it("a cancel after the page came back stops the grace timer and decides by the time open", () => {
    const { w, advance } = watchWith();
    w.opened();
    advance(2000);
    w.back();
    advance(1000);
    w.cancelled(); // 3 s: the user closed it
    advance(BACK_GRACE_MS * 2);
    expect(w.missed).toBe(false);
  });

  it("a new try hides the hint; 'Pick anyway' keeps it, also through a quick cancel", () => {
    const { w, advance } = watchWith();
    w.opened();
    advance(GAVE_UP_CANCEL_MS + 1);
    w.cancelled();
    expect(w.missed).toBe(true);
    w.opened({ fromHint: true });
    advance(2000);
    w.cancelled();
    expect(w.missed).toBe(true);
    // A photo picked there: the hint stays (the caller shows why).
    w.opened({ fromHint: true });
    w.closed();
    expect(w.missed).toBe(true);
    w.opened();
    expect(w.missed).toBe(false);
  });

  it("dispose stops a pending grace timer", () => {
    const { w, advance } = watchWith();
    w.opened();
    advance(2000);
    w.back();
    w.dispose();
    advance(BACK_GRACE_MS * 2);
    expect(w.missed).toBe(false);
  });
});
