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


def test_a_word_spoken_across_a_switch_is_in_one_pass_or_the_other(monkeypatch):
    # Bucket 5-10 s picks English, 10-15 s the auto (German) pass.
    # "Cleo" starts at 9.98 in the German pass and at 10.02 in the
    # English one: by start time it was in neither winning bucket, and
    # the "Cleo keep" after it was lost (commands-10).
    auto = [("ganz", 8.0, 8.4, 0.4), ("klar.", 8.4, 9.0, 0.4),
            ("Cleo", 9.98, 10.3, 0.9), ("keep.", 10.3, 10.6, 0.9),
            ("Weiter", 11.0, 11.4, 0.9), ("geht's.", 11.4, 11.8, 0.9)]
    en = [("it's", 8.0, 8.4, 0.9), ("obvious.", 8.4, 9.0, 0.9),
          ("Cleo", 10.02, 10.3, 0.5), ("keep.", 10.3, 10.6, 0.5),
          ("Whiter", 11.0, 11.4, 0.3), ("gates.", 11.4, 11.8, 0.3)]
    assert _run(monkeypatch, auto, en) == [
        "it's", "obvious.", "Cleo", "keep.", "Weiter", "geht's."]


def test_a_word_straddling_a_switch_in_both_passes_is_kept_once(monkeypatch):
    # Both copies have their middle on the side the OTHER pass won.
    auto = [("eins", 7.0, 7.4, 0.3), ("Cleo", 9.8, 10.1, 0.9),
            ("cut.", 10.1, 10.5, 0.9), ("neu", 11.0, 11.3, 0.9)]
    en = [("one", 7.0, 7.4, 0.9), ("Cleo", 9.9, 10.3, 0.5),
          ("cut.", 10.3, 10.5, 0.2), ("new", 11.0, 11.3, 0.2)]
    words = _run(monkeypatch, auto, en)
    assert words.count("Cleo") == 1 and words[-2:] == ["cut.", "neu"]


def test_chunks_do_not_double_the_word_across_their_edge(monkeypatch):
    # 300 s chunks with a 2 s overlap: chunk 1 keeps a word starting
    # before 300 s that runs past it, chunk 2 hears it again from 0.0
    # (the owner's doc had such a pair at 300 s and at 600 s).
    chunks = [
        {"language": "de", "segments": [{"words": [
            {"word": "vorher", "start": 298.5, "end": 299.8},
            {"word": "Wort", "start": 299.888, "end": 300.788}]}]},
        {"language": "de", "segments": [{"words": [
            {"word": "Wort", "start": 0.0, "end": 0.74},
            {"word": "danach", "start": 1.0, "end": 1.5}]}]},
    ]
    calls = iter(chunks)
    monkeypatch.setattr(wg, "_extract_chunk", lambda path, start, length: "c.wav")
    monkeypatch.setattr(wg, "_transcribe_single",
                        lambda path, initial_prompt=None, language=None: next(calls))
    res = wg._transcribe_chunked("x.wav", 302.0, None, None)
    words = [(w["word"], w["start"]) for s in res["segments"] for w in s["words"]]
    assert words == [("vorher", 298.5), ("Wort", 299.888), ("danach", 301.0)]
