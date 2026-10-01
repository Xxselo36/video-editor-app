"""The two-pass (auto + English) Groq merge: a word spoken across a
5 s bucket boundary must not come out twice when the two buckets pick
different passes (owner report: "…ob es gleich funktioniert.
funktioniert.")."""
from backend import whisper_groq as wg


def _pass(lang, words):
    return {"language": lang,
            "segments": [{"words": [
                {"word": w, "start": s, "end": e, "probability": p}
                for (w, s, e, p) in words]}]}


def _run(monkeypatch, auto_words, en_words):
    passes = {None: _pass("de", auto_words), "en": _pass("en", en_words)}
    monkeypatch.setattr(wg, "transcribe_via_groq",
                        lambda path, initial_prompt=None, language=None:
                        passes[language])
    res = wg.transcribe_via_groq_multilang("x.wav", initial_prompt="p")
    return [w["word"].strip() for s in res["segments"] for w in s["words"]]


def test_word_across_a_bucket_boundary_is_kept_once(monkeypatch):
    # Bucket 1 (5-10 s): auto is surer. Bucket 2 (10-15 s): English is
    # surer. "funktioniert" starts at 9.98 in the auto pass and at 10.02
    # in the English one, so each bucket brings its own copy.
    auto = [("ob", 8.6, 8.8, 0.9), ("es", 8.8, 9.0, 0.9),
            ("gleich", 9.0, 9.4, 0.9), ("funktioniert.", 9.98, 10.6, 0.9),
            ("Cleo", 11.0, 11.3, 0.3), ("kat", 11.3, 11.6, 0.3)]
    en = [("ob", 8.6, 8.8, 0.2), ("es", 8.8, 9.0, 0.2),
          ("gleich", 9.0, 9.4, 0.2), ("funktioniert.", 10.02, 10.58, 0.6),
          ("Cleo", 11.0, 11.3, 0.95), ("cut.", 11.3, 11.6, 0.95)]
    words = _run(monkeypatch, auto, en)
    assert words == ["ob", "es", "gleich", "funktioniert.", "Cleo", "cut."]


def test_same_word_twice_in_a_row_from_one_pass_stays(monkeypatch):
    # Really said twice ("nein nein") inside one bucket: not a merge
    # artefact, nothing is dropped.
    auto = [("nein", 1.0, 1.3, 0.9), ("nein", 1.35, 1.7, 0.9)]
    en = [("nine", 1.0, 1.3, 0.1), ("nine", 1.35, 1.7, 0.1)]
    assert _run(monkeypatch, auto, en) == ["nein", "nein"]


def test_different_words_that_overlap_across_a_switch_keep_the_first(monkeypatch):
    # The passes heard the same sound differently at the boundary
    # ("Okay" vs "OK"): one word of speech, kept once (the earlier one).
    auto = [("Also", 8.0, 8.5, 0.9), ("Okay", 9.9, 10.4, 0.9),
            ("ja", 12.0, 12.2, 0.2)]
    en = [("So", 8.0, 8.5, 0.1), ("OK", 10.01, 10.4, 0.5),
          ("yes", 12.0, 12.2, 0.9)]
    assert _run(monkeypatch, auto, en) == ["Also", "Okay", "yes"]


def test_drop_boundary_duplicates_counts():
    picked = [("auto", {"word": "a", "start": 0.0, "end": 0.5}),
              ("en", {"word": "a", "start": 0.05, "end": 0.5}),
              ("en", {"word": "b", "start": 0.6, "end": 0.9})]
    words, dropped = wg._drop_boundary_duplicates(picked)
    assert [w["word"] for w in words] == ["a", "b"] and dropped == 1
