/**
 * Per-caption position / size keys of the doc style (UT5:
 * overrides.captions, keyed by the id of a caption's first word). No
 * engine import: the Text tab, the doc store and the autosave use these.
 */

type Captions = Record<string, unknown>;
type StyleLike = { presetId: string; overrides: Record<string, unknown> };
type WordLike = { id: string; text: string; start: number; end: number; hidden?: boolean };

function captionsOf(overrides: Record<string, unknown> | null | undefined): Captions | null {
  const c = overrides?.captions;
  return c && typeof c === "object" && !Array.isArray(c) ? (c as Captions) : null;
}

function withCaptions<S extends StyleLike>(style: S, captions: Captions): S {
  const overrides = { ...style.overrides };
  if (Object.keys(captions).length) overrides.captions = captions;
  else delete overrides.captions;
  return { ...style, overrides };
}

/** Ids of the words whose caption has its own position or size. */
export function adjustedWordIds(overrides: Record<string, unknown> | null | undefined): ReadonlySet<string> {
  return new Set(Object.keys(captionsOf(overrides) ?? {}));
}

/**
 * The keys follow a word's new id (the autosave's serverIds renames
 * unsaved words, review 2). The same style object when nothing moved.
 */
export function renameCaptionKeys<S extends StyleLike>(style: S, map: ReadonlyMap<string, string>): S {
  const caps = captionsOf(style.overrides);
  if (!caps || !Object.keys(caps).some((k) => map.has(k))) return style;
  const out: Captions = {};
  for (const [k, v] of Object.entries(caps)) out[map.get(k) ?? k] = v;
  return withCaptions(style, out);
}

const SENTENCE_END = /[.!?…。！？]["'»”)\]]*$/;
const shown = (w: WordLike) => !w.hidden && w.text.trim() !== "";

/**
 * After a doc change (review 3/10): a caption's own position / size stays
 * with the caption when its first word is hidden, deleted or merged away —
 * the key moves to the next shown word, the caption's new first word. A
 * key whose caption is gone with it (the word ended a sentence, or the
 * next word already starts another adjusted caption) is dropped, so no
 * key is left on a word that isn't drawn, and none can come back later
 * to win over a newer adjustment. `next` itself when nothing changed.
 */
export function followCaptionKeys<D extends { words: readonly WordLike[]; style: StyleLike }>(prev: D, next: D): D {
  const caps = captionsOf(next.style.overrides);
  if (!caps) return next;
  const index = new Map(next.words.map((w, i) => [w.id, i]));
  const out: Captions = {};
  let changed = false;
  const moved: [string, unknown][] = [];
  for (const [k, v] of Object.entries(caps)) {
    const i = index.get(k);
    if (i !== undefined && shown(next.words[i])) {
      out[k] = v;
      continue;
    }
    changed = true;
    const old = (i !== undefined ? next.words[i] : undefined) ?? prev.words.find((w) => w.id === k);
    if (!old || SENTENCE_END.test(old.text.trim())) continue;
    let j = i !== undefined ? i + 1 : next.words.findIndex((w) => w.start >= old.start - 1e-3);
    if (j < 0) continue;
    while (j < next.words.length && !shown(next.words[j])) j++;
    const target = next.words[j];
    if (target) moved.push([target.id, v]);
  }
  if (!changed) return next;
  for (const [id, v] of moved) if (!(id in out) && !(id in caps)) out[id] = v;
  return { ...next, style: withCaptions(next.style, out) };
}
