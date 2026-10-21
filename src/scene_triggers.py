"""Scene-based voice commands: Cleo start / restart / keep / finish.

Enables a record-once-and-refine workflow. Every take has an anchor,
where it began: the end of the scene command before it, or the start of
the video when there was none — "Cleo start" is not needed (owner
decision), it marks where a take begins. Until a clear "Cleo start" the
"Cleo go" that closes a "Cleo stop … go" pair is an anchor too (a cut
never reaches back past the pair).

    'Cleo start'   — anchors a new take. What came since the anchor is
                     dropped: everything before it when it is the first
                     command (setup/warmup), else e.g. the chatter after
                     a keep. Said clearly (a strong, non-phonetic form)
                     it opens a started session: from there on every
                     command acts in full, whatever it removes (as
                     before the start became optional).
    'Cleo restart' — ('Cleo cut') discards the current provisional take
                     (from the anchor to this restart, inclusive). New
                     anchor set here.
    'Cleo keep'    — commits the current take. Content up to this
                     keep is preserved (the keep phrase itself is
                     removed). New anchor set here for the next scene.
    'Cleo finish'  — commits the final take. Everything after 'Cleo
                     finish' is dropped (cool-down / off-camera).

Until a clear 'Cleo start' was said (no started session yet) a command
removes at most IMPLICIT_CUT_MAX_S on its own: a cut, a finish (what
follows it) or a misheard start that would remove more cuts only its
phrase and becomes a suggestion the creator confirms in the editor
(job.cut_suggestions). A phonetic guess there never moves the anchor:
it cuts its phrase only, and a guess at 'cut' is a suggestion whatever
its length.

If the user doesn't say 'Cleo finish', the tail (from last anchor to
audio end) is kept forgivingly — user may have just stopped recording.
Parallel to voice_triggers.py which handles the 'Cleo stop … go' pairs.
"""
from __future__ import annotations

from functools import lru_cache
from typing import NamedTuple

from src import command_gate as gate


# Wake-word variants — Whisper regularly mishears "Cleo" as "Clio"
# (Renault-car), "Cleyo", "Klio", "Kleo". Plus common mishearings of
# the English command word in German audio (e.g. "restart" → "is what").
# Only the first five are strong (src/command_gate.py PRIMARY_WAKE); the
# others need a break before and after the phrase.
_CLEO_VARIANTS = [
    "cleo", "clio", "cleyo", "klio", "kleo",
    # Whisper mishearings observed in real recordings:
    "clear", "cleer", "clara", "claro", "clean",
    "kilo", "keo", "kejo", "clea",
    "chloe", "leo", "cleos",
]


def _combos(command_variants: list[str]) -> list[str]:
    """Build 'cleo <cmd>' for every Cleo-variant × command-variant."""
    return [f"{c} {cmd}" for c in _CLEO_VARIANTS for cmd in command_variants]


# Bilingual command set — English and German phrases both accepted so
# the user can say whatever comes naturally. Every phrase paired with
# every Cleo-mishearing (Clio, Cleyo, Klio, Kleo) plus phonetic collapse
# variants Whisper produces in mixed-language audio.

DEFAULT_START_KEYWORDS = _combos([
    # EN
    "start", "starts", "starte", "started", "starting",
    "star", "startet",
    # DE-mishearings of English 'start' in DE-audio
    "ist ab", "istab", "is ab", "isab",
    "hat ab", "hatab",
    "is tough", "istough", "is tuff", "is auf",
    "ist auf", "is doof",
])

DEFAULT_RESTART_KEYWORDS = _combos([
    # Primary — 'Cleo cut' is now the RESTART command (was voice-trigger).
    "cut", "cuts", "cutted", "cutting",
    # DE variants for 'cut'
    "schnitt", "schneiden", "schneide",
    # Whisper mishears of 'cut' in mixed audio
    "kutt", "kurt", "gut", "kot",
    # Legacy: 'restart' + its mishears kept as fallback so users who
    # already learned the old primary don't get broken.
    "restart", "restarts", "restarte", "restartet", "restarted",
    "is what", "is that", "is left", "is what's", "is that's",
    "rest art", "rest hart", "rest hard", "restard",
    "restat", "restate",
    # DE proper — semantic siblings
    "neu", "nue", "noi",
    "nochmal", "noch mal", "nochmals",
    "zurück", "zurueck", "zuruck",
])

DEFAULT_KEEP_KEYWORDS = _combos([
    # EN
    "keep", "keeps", "keep it", "keep it up",
    "kip", "kiep", "kef", "kefir",
    "kib", "keeb", "geeb",
    # DE proper
    "behalten", "behalte", "behält", "behaelt",
    "speichern", "speichere",
    "check",
])

DEFAULT_FINISH_KEYWORDS = _combos([
    # EN
    "finish", "finished", "finishes", "finishing",
    "finnisch", "finito", "finnish", "fenish",
    "fin", "finish it",
    # DE proper
    "ende", "enden", "endet",
    "fertig", "fertisch",
    "schluss", "schlus",
])


# The command words as taught. With a strong wake word they need only a
# break after them (src/command_gate.py); every other variant above (a
# mishearing, a German sibling, a stand-in like "gut" or "noch mal")
# needs breaks on both sides.
STRONG_COMMANDS = {
    "start": frozenset({"start", "starts", "starte", "started", "starting"}),
    "restart": frozenset({"cut", "restart", "restarts", "restarte",
                          "restartet", "restarted"}),
    "keep": frozenset({"keep", "keeps"}),
    "finish": frozenset({"finish", "finished", "finishes", "finishing"}),
}

# Same-type commands closer than this are one command said (or
# hallucinated) twice; the repeat's phrase is cut with the first one, at
# most REPEAT_REACH_S past the repeat's start (a hallucinated copy's
# times drift far into the following audio).
HALLUCINATION_GAP = 1.0
REPEAT_REACH_S = 1.2

# Until a clear "Cleo start" was said, a command removes at most this
# much on its own; a "Cleo cut" (its take), a "Cleo finish" (the rest of
# the video) or a misheard start (what came before it) that would remove
# more is only suggested — one tap in the editor confirms it (owner
# decision). Its phrase is cut anyway.
IMPLICIT_CUT_MAX_S = 60.0


class ScenePlan(NamedTuple):
    """What the scene commands of a recording do (plan_scene_cuts)."""
    # (start, end) ranges to cut, Whisper times (the analysis snaps them
    # to the audio, src/edge_snap.py)
    cuts: list[tuple[float, float]]
    # (start, end) ranges a command would remove but doesn't, because no
    # clear "Cleo start" came before it (module doc): not cut (the
    # phrase itself is in `cuts`), offered in the editor
    suggestions: list[tuple[float, float]]
    # (command_type, phrase_start, phrase_end) for logging / debugging
    events: list[tuple[str, float, float]]


def _normalize(text: str) -> str:
    return gate.normalize(text)


def _table(start_keywords=None, restart_keywords=None, keep_keywords=None,
           finish_keywords=None) -> gate.CommandTable:
    return gate.CommandTable([
        ("start", start_keywords or DEFAULT_START_KEYWORDS, STRONG_COMMANDS["start"]),
        ("restart", restart_keywords or DEFAULT_RESTART_KEYWORDS, STRONG_COMMANDS["restart"]),
        ("keep", keep_keywords or DEFAULT_KEEP_KEYWORDS, STRONG_COMMANDS["keep"]),
        ("finish", finish_keywords or DEFAULT_FINISH_KEYWORDS, STRONG_COMMANDS["finish"]),
    ])


@lru_cache(maxsize=1)
def scene_table() -> gate.CommandTable:
    """The default scene commands (also the bounds of a stop … go pair,
    src/voice_triggers.py)."""
    return _table()


def find_scene_cut_ranges(
    whisper_words: list[dict],
    clip_duration: float | None = None,
    start_keywords: list[str] | None = None,
    restart_keywords: list[str] | None = None,
    keep_keywords: list[str] | None = None,
    finish_keywords: list[str] | None = None,
) -> tuple[list[tuple[float, float]], list[tuple[str, float, float]]]:
    """plan_scene_cuts as (cut_ranges, events): a suggested take is not
    cut (its "Cleo cut" phrase is)."""
    plan = plan_scene_cuts(whisper_words, clip_duration, start_keywords,
                           restart_keywords, keep_keywords, finish_keywords)
    return plan.cuts, plan.events


def stop_go_resumes(whisper_words: list[dict]) -> list[float]:
    """Where the take after each "Cleo stop … Cleo go" pair begins: the
    end of its go (src/voice_triggers.py; owner decision: before a clear
    "Cleo start" a go starts a take, so a later "Cleo cut" never reaches
    back past the pair). A pair closed by a phonetic guess at the go is
    no anchor."""
    from src.voice_triggers import detect_voice_triggers
    return [p.continue_end
            for p in detect_voice_triggers(whisper_words, quiet=True)
            if p.kind == "pair" and not p.guessed_go]


def plan_scene_cuts(
    whisper_words: list[dict],
    clip_duration: float | None = None,
    start_keywords: list[str] | None = None,
    restart_keywords: list[str] | None = None,
    keep_keywords: list[str] | None = None,
    finish_keywords: list[str] | None = None,
    implicit_cut_max_s: float | None = None,
    resumes: list[float] | None = None,
) -> ScenePlan:
    """Scan words for scene commands: what they cut, what they suggest.

    Args:
        whisper_words: list of {"word": str, "start": float, "end": float}
        clip_duration: audio duration in seconds. Used to cap the
            'everything after Cleo finish' cut range.
        *_keywords: overrideable phrase lists per command type.
        implicit_cut_max_s: the most a command removes on its own before
            a clear "Cleo start" (None: IMPLICIT_CUT_MAX_S; inf: no limit).
        resumes: where a take begins after each "Cleo stop … go" pair
            (None: stop_go_resumes of the words).

    Only phrases said as commands count (src/command_gate.py). No 'Cleo
    start' is needed: a take begins after the command before it, or at
    the start of the video (module doc). Until a clear 'Cleo start' a
    command removes at most `implicit_cut_max_s` on its own, and a
    phonetic guess only its phrase (a guess at 'cut': and a suggestion);
    after one, every command acts in full, as before the start became
    optional.
    """
    if implicit_cut_max_s is None:
        implicit_cut_max_s = IMPLICIT_CUT_MAX_S
    if start_keywords or restart_keywords or keep_keywords or finish_keywords:
        table = _table(start_keywords, restart_keywords, keep_keywords,
                       finish_keywords)
    else:
        table = scene_table()

    words = gate.split_tokens(whisper_words)
    if not words:
        return ScenePlan([], [], [])
    norm = gate.normalized(words)

    # [type, start, end, phonetic, index of the word after the phrase,
    #  weak (src/command_gate.py: a misheard wake or command word)]
    events: list[list] = []
    i = 0
    while i < len(words):
        m = table.match(words, norm, i)
        if m is None:
            i += 1
            continue
        cmd_type, _kw, next_idx, phrase_start, phrase_end, weak = m
        events.append([cmd_type, phrase_start, phrase_end, False, next_idx,
                       weak])
        i = next_idx

    # Phonetic-fuzzy pass — catches Whisper mishears the exact-match
    # scan missed (e.g. 'Klio Kip', 'Kleo Kat.'). Only adds events,
    # never overrides — dedupe_window prevents collisions with the
    # primary detection.
    try:
        from src.phonetic_wake_detection import find_phonetic_candidates
        primary_events = [(t, s, e) for (t, s, e, *_r) in events]
        candidates = find_phonetic_candidates(
            words, already_detected=primary_events,
        )
        for (cmd_type, ph_s, ph_e, raw) in candidates:
            print(f"[phonetic] added {cmd_type} @ {ph_s:.2f}s — raw="
                  f"{raw!r}", flush=True)
            events.append([cmd_type, ph_s, ph_e, True,
                           gate.index_at(words, ph_s) + 2, True])
        # Re-sort chronologically since phonetic events are appended.
        events.sort(key=lambda e: e[1])
    except Exception as _phe:
        print(f"[phonetic] skipped: {_phe}", flush=True)

    # Dedupe consecutive same-type events within 1s — Whisper
    # sometimes hallucinates a command 2-3 times as a hedge when
    # decoding gets uncertain ('Cleo keep. Cleo keep. Cleo keep.' when
    # the user said it once), and a creator unsure the first was heard
    # says it twice. Keep the first occurrence of each cluster and cut
    # the repeat's phrase with it — capped, since the extra copies'
    # word.end timestamps can drift far into the following audio.
    deduped: list[list] = []
    for evt in events:
        if deduped and evt[0] == deduped[-1][0]:
            gap = evt[1] - deduped[-1][2]
            if gap < HALLUCINATION_GAP:
                reach = min(evt[2], evt[1] + REPEAT_REACH_S)
                if evt[4] < len(words):  # the word after the repeat
                    reach = min(reach, max(evt[1],
                                           float(words[evt[4]].get("start", 0))))
                deduped[-1][2] = max(deduped[-1][2], reach)
                # a guess (or a misheard form) only when both copies are
                deduped[-1][3] = deduped[-1][3] and evt[3]
                deduped[-1][5] = deduped[-1][5] and evt[5]
                continue
        deduped.append(evt)
    events = deduped
    out_events = [(t, s, e) for (t, s, e, *_r) in events]

    # The go of each "Cleo stop … go" pair starts a take too before a
    # clear start (an anchor, not a scene command: not in the events).
    if resumes is None:
        try:
            resumes = stop_go_resumes(whisper_words)
        except Exception as _vte:
            print(f"[scene-triggers] stop/go anchors skipped: {_vte}",
                  flush=True)
            resumes = []
    steps = sorted([*events, *(["go", t, t, False, 0, False] for t in resumes)],
                   key=lambda e: e[1])

    cut_ranges: list[tuple[float, float]] = []
    suggestions: list[tuple[float, float]] = []

    def suggest(a: float, b: float, what: str, at: float) -> None:
        # one a later suggestion holds (a guess at "cut", then a cut from
        # the same anchor) is offered as that one
        suggestions[:] = [s for s in suggestions if not (a <= s[0] and s[1] <= b)]
        suggestions.append((a, b))
        print(f"[scene-triggers] '{what}' at {at:.2f}s would remove "
              f"{b - a:.1f}s before any 'Cleo start' — suggested, not cut",
              flush=True)

    # The take in progress began at `anchor`: the end of the command
    # before it, or the start of the video. `started`: a clear 'Cleo
    # start' was said (a started session, module doc).
    anchor, started = 0.0, False

    for evt in steps:
        cmd_type, phrase_start, phrase_end, phonetic, _next, weak = evt
        tail_cap = clip_duration if clip_duration else (
            float(words[-1].get("end", phrase_end)) + 60.0
        )
        if cmd_type == "go":
            # before a clear start only: a started session stays as
            # before (a cut there reaches back to the scene command)
            if not started:
                anchor = max(anchor, phrase_end)
        elif started:
            # A started session: every command as before the start
            # became optional (phonetic guesses included).
            if cmd_type in ("start", "restart"):
                # Discard the current provisional take. (Another 'Cleo
                # start' effectively means the user forgot to say
                # restart and just started over.)
                if phrase_end > anchor:
                    cut_ranges.append((anchor, phrase_end))
                anchor = phrase_end
            elif cmd_type == "finish" and not phonetic:
                # Cut the 'Cleo finish' phrase, then all following audio.
                cut_ranges.append((phrase_start, tail_cap))
                break
            else:
                # 'Cleo keep' (or a phonetic guess at 'finish'): keep the
                # take, cut only the phrase itself.
                cut_ranges.append((phrase_start, phrase_end))
                anchor = phrase_end
        elif phonetic:
            # Before a clear start a guess never anchors a take (nor
            # shields one from the real command after it): its phrase
            # goes; a guess at 'cut' offers its take.
            cut_ranges.append((phrase_start, phrase_end))
            if cmd_type == "restart" and phrase_end > anchor:
                suggest(anchor, phrase_end, "cut (guess)", phrase_start)
        elif cmd_type == "start" and not weak:
            # The first clear 'Cleo start': drop what came since the
            # anchor (everything before it as the first command, also
            # when Whisper puts its first word at 0.0) and open the
            # session.
            if phrase_end > anchor:
                cut_ranges.append((anchor, phrase_end))
            anchor, started = phrase_end, True
        elif cmd_type in ("start", "restart"):
            # 'Cleo cut' (or a misheard start): discard the take since
            # the anchor, a long one only as a suggestion.
            if phrase_end - anchor <= implicit_cut_max_s:
                if phrase_end > anchor:
                    cut_ranges.append((anchor, phrase_end))
            else:
                cut_ranges.append((phrase_start, phrase_end))
                suggest(anchor, phrase_end, cmd_type, phrase_start)
            anchor = phrase_end
        elif cmd_type == "finish":
            # Everything after it goes — more than the limit only as a
            # suggestion (a false 'Leo, fertig?' early in a long video).
            if tail_cap - phrase_start <= implicit_cut_max_s:
                cut_ranges.append((phrase_start, tail_cap))
                break
            cut_ranges.append((phrase_start, phrase_end))
            suggest(phrase_start, tail_cap, "finish", phrase_start)
            anchor = phrase_end
        else:
            # 'Cleo keep': keep the take, cut only the phrase itself.
            cut_ranges.append((phrase_start, phrase_end))
            anchor = phrase_end

    # a suggestion a later command cut after all (a guess at "cut", then
    # the real one within the limit) is no suggestion
    suggestions = [s for s in suggestions if not _covered(cut_ranges, *s)]
    return ScenePlan(cut_ranges, suggestions, out_events)


def _covered(ranges: list[tuple[float, float]], a: float, b: float) -> bool:
    """Is [a, b] inside the union of `ranges`?"""
    t = a
    for x, y in sorted(ranges):
        if x <= t + 1e-6 and y > t:
            t = y
    return t >= b - 1e-6
