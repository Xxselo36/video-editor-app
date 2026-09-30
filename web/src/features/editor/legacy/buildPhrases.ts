/**
 * The editor's transcript sentences (moved from app/app/page.tsx
 * in UX4): Whisper's fragments grouped into readable phrases, or the
 * user's saved edits from GET /subtitles.
 */

export type Subtitle = {
  start: number;
  end: number;
  text: string;
  original_start?: number;
  original_end?: number;
  confidence?: number;
};

export type Phrase = {
  start: number;
  end: number;
  original_start: number;
  original_end: number;
  text: string;
  confidence: number;
};

// Transcript as returned by GET /subtitles: the user's saved edits when
// present, otherwise sentences grouped from Whisper's fragments.
export function phrasesFromSubtitlesResponse(data: {
  subtitles?: Subtitle[];
  phrases?: Phrase[] | null;
}): Phrase[] {
  if (Array.isArray(data.phrases)) return data.phrases;
  return buildPhrases(data.subtitles ?? []);
}

// Group Whisper's short fragments (1-3 words each) into readable
// sentences. Mirrors plugins/premiere/panel/index.html:buildPhrases.
const SENTENCE_END = /[.!?…]["'»)\]]*\s*$/;
const MAX_WORDS_PER_PHRASE = 10;
const MAX_GAP_SECONDS = 1.5;

export function buildPhrases(subs: Subtitle[]): Phrase[] {
  const phrases: Phrase[] = [];
  let curIndices: number[] = [];

  const wordCount = (text: string) =>
    (text || "").trim().split(/\s+/).filter(Boolean).length;

  const flush = () => {
    if (curIndices.length === 0) return;
    const first = subs[curIndices[0]];
    const last = subs[curIndices[curIndices.length - 1]];
    const confSum = curIndices.reduce(
      (acc, i) => acc + (subs[i].confidence ?? 1),
      0,
    );
    phrases.push({
      start: first.start,
      end: last.end,
      original_start: first.original_start ?? first.start,
      original_end: last.original_end ?? last.end,
      confidence: confSum / curIndices.length,
      text: curIndices
        .map((i) => (subs[i].text || "").trim())
        .join(" "),
    });
    curIndices = [];
  };

  for (let i = 0; i < subs.length; i++) {
    const s = subs[i];
    if (!s.text || !s.text.trim()) continue;
    if (curIndices.length === 0) {
      curIndices.push(i);
      continue;
    }
    const prev = subs[curIndices[curIndices.length - 1]];
    const gap = s.start - prev.end;
    const endsSentence = SENTENCE_END.test((prev.text || "").trim());
    const wordsSoFar = curIndices.reduce(
      (n, idx) => n + wordCount(subs[idx].text),
      0,
    );
    if (
      endsSentence ||
      gap > MAX_GAP_SECONDS ||
      wordsSoFar + wordCount(s.text) > MAX_WORDS_PER_PHRASE
    ) {
      flush();
    }
    curIndices.push(i);
  }
  flush();
  return phrases;
}
