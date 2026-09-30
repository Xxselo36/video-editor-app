# Labelling word boundaries for the word-timing measurement (UX2)

Two real clips, hand-labelled word by word, answer two launch questions
(PLAN_TECH, UX2 "Word-timing measurement on real speech"):

1. **How far off are Groq's word times?** Median error above 80 ms (word
   start or end) means forced alignment (package UT6) is scheduled before
   launch.
2. **Do the v1 captions follow real speech?** At least 95 % of the words
   must be the highlighted word at their labelled midpoint, and no caption
   may be burned twice (`test_caption_sync_real.py`, nightly).

The espeak clip in `testdata/captions/audit_clip.json` speaks at a very even
pace, which flatters any timing. Real speech has variable pace, short pauses
inside sentences and fillers. So these labels come from real recordings.

## 1. The clips

- Two clips of about 60 s each from the owner's test videos: one German, one
  English. Pick natural talking-head speech with at least a few pauses, a
  filler or two ("äh", "uh"), and fast and slow passages. Avoid music under
  the voice.
- The clips stay **out of git**. Put them in the R2 test bucket as
  `real_words/de.mp4` and `real_words/en.mp4`; the nightly job fetches them
  into `$CLEO_REAL_CLIPS_DIR`.
- Record each clip's SHA-256 in its labels file (below), so the labels
  can't silently drift from the clip.

## 2. The audio to label

Label the audio exactly as the pipeline decodes it, so both share one time
base (an MP4 edit list or an audio start offset is applied the same way):

```bash
ffmpeg -i de.mp4 -vn -ac 1 -ar 48000 de.wav
sha256sum de.mp4
```

## 3. Labelling in Audacity

1. **File → Open** `de.wav`. Switch the track to **Multi-view** (track menu →
   Multi-view) to see the waveform and spectrogram together. Word onsets and
   offsets are much easier to see in the spectrogram.
2. **Tracks → Add New → Label Track.**
3. For every spoken word, in order:
   - Select the word's span on the audio track. Zoom in so that about 1–2 s
     fill the screen (Ctrl+1 / Ctrl+3). Play the selection with Space and
     nudge its edges until it holds just that word.
   - **Start** = the onset of the word's first sound (a plosive's burst, a
     fricative's noise, a vowel's first cycle). **End** = the offset of its
     last sound, without the following silence or breath.
   - Press **Ctrl+B** and type the word as spoken, e.g. `Mistake`, `two`,
     `Grüße`. Case and punctuation don't matter; they are ignored.
   - Numbers: write them the way you'd expect them in a caption (`10`, not
     `zehn`) when that is natural. A word that Groq writes differently is
     left out of the timing statistics and reported as "not matched". It
     doesn't count as a timing error.
   - Label fillers too (`äh`, `ähm`, `uh`, `hm`). They are aligned for the
     timing error, but not scored for captions (captions never show them).
   - Words that run together ("gonna"): one label as heard.
4. Aim for ±10 ms per boundary. When two words touch without a pause, put
   the boundary where the spectrogram changes (e.g. the start of the next
   consonant), and use the same point as the end of one label and the start
   of the next.
5. **File → Export → Export Labels…** → `de_labels.txt` (tab-separated
   `start end word`).

Expect roughly 45–60 minutes per minute of speech. Save the Audacity project
(`.aup3`) next to the clip in the test bucket, so the labels can be
corrected later.

**Quality check.** A second person opens the project, plays 20 random labels
and checks their edges. If more than 2 are off by more than 30 ms, re-label
those passages.

## 4. Into the repo

```bash
python backend/scripts/measure_word_timing.py \
    --convert-labels de_labels.txt --language de --clip-name de_60s.mp4 \
    --out testdata/real_words/de.json
```

Then add `"sha256": "<sha256sum of de.mp4>"` and `"labeller": "<name>"` to
the JSON by hand, and commit it. The labels are small text. The clip stays
out of git.

## 5. The measurement

```bash
GROQ_API_KEY=... python backend/scripts/measure_word_timing.py \
    --clip de.mp4 --labels testdata/real_words/de.json \
    --cache de.analysis.json --json de_report.json --markdown
```

- It runs the production analysis once (Groq, the production prompts and
  both passes, the production cuts and units) and caches it in `--cache`, so
  re-runs don't pay Groq again. Upload the cache next to the clip as
  `real_words/de.analysis.json`: the nightly test uses it and needs no
  Groq key.
- It prints the start/end error (median, p90, bias), the UT6 verdict, and
  the caption sync on the clip with the gate verdict. `--markdown` prints a
  table row.
- It also runs with `CLEO_GROQ_DEBUG=1`. The log line `[groq] debug: raw
  verbose_json word = …; per-word probability: yes|NO` answers whether Groq
  sends per-word confidence (captions.md C21). If it says NO, open the
  follow-up: drop the second (en) transcription pass or merge the two passes
  by segment `avg_logprob`, and hide the low-confidence UI.

Record both clips' rows, the Groq probability answer and the UT6 decision in
`docs/qa/word-timing.md`, the done-when of UX2.
