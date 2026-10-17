# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Short-video creators who film themselves talking to their phone for TikTok, Instagram Reels and YouTube Shorts (confirmed by the owner). They record alone, usually in several attempts, and lose most of their time cutting out botched takes, pauses and filler words and adding captions. They visit the site on their phone more often than on a desktop. Their job: get a talking-head take from "recorded" to "ready to post" without sitting in an editing app.

## Product Purpose

CleoCuts (cleocuts.com) turns a raw phone recording into a cut, captioned, vertical video. The creator records, says “Cleo cut” when a take goes wrong, uploads, and gets the video back with the failed takes, pauses and filler words removed and animated captions burned in, ready to download and post. Success: the creator posts the result without opening another editor.

## Positioning

Voice commands spoken during the recording steer the edit. “Cleo start” opens a take, “Cleo cut” throws it away, “Cleo keep” keeps it, “Cleo finish” ends the video, “Cleo stop” and “Cleo go” skip a sentence. No neighbouring caption tool can claim that the creator edits by talking while filming. Everything else (captions, pause removal, 9:16 reframing) is table stakes that support this mechanism.

## Operating Context

- Recording happens in the phone's camera app, not in CleoCuts. The commands are recognised afterwards, on the server (Whisper), not live.
- The web app at `/app`: upload (resumable, up to 30 min and 4 GB by default), one start screen (aspect 9:16 / 16:9 / original, pace Tight / Natural / No cuts, remove fillers, voice commands on or off, spoken language), processing, then a browser editor (fix caption text, restore any cut, caption style and size) and a done view (download, share on phones, AI post text with hashtags, SRT/VTT, edit again without re-uploading).
- Accounts (Clerk) and paid plans (Lemon Squeezy) exist in code behind switches. The site is in an open beta with no users yet.

## Capabilities and Constraints

- Voice commands: scene commands need “Cleo start” first; “Cleo cut” and “Cleo finish” do nothing without it. “Cleo stop … Cleo go” works on its own.
- Automatic removal of pauses and filler words (pace setting).
- 12 animated caption styles (Power, Mega, Clipper, Karaoke, Highlight Box, One Word, Word by Word, Neon, Sunset, Elegant, Subtitle Bar, Minimal) plus Off. Style availability depends on the script; right-to-left scripts get none yet.
- Landscape to 9:16 with face tracking; 1080p export.
- AI caption cleanup fixes misheard words and brand names; it decides no cuts.
- Bonus clips: when the recording and the finished (edited) video both run 90 s or more, up to 3 clips of 20 to 60 s; they are offered while the timeline is untouched since analysis.
- 14 interface languages; 97 spoken languages plus auto-detect.
- Plans (when billing is on): Starter / Pro / Studio with monthly minutes; prices come only from Lemon Squeezy at runtime and are never hardcoded.
- Undecided or unmeasured: processing time (never measured), any comparison with other editors.

## Brand Commitments

- The `cleocuts-brand` skill (`.claude/skills/cleocuts-brand/SKILL.md`) and the tokens in `web/src/app/globals.css` are binding: dark violet world, violet primary, magenta only as a gradient partner, system font on site pages, fixed voice-command colours, `LogoMark` / `LogoWord` only, spelling "CleoCuts".
- Voice: short, creator-to-creator, leads with the voice magic, honest, no buzzwords. Source copy is English; every string ships in all 14 languages.

## Evidence on Hand

- Real product surfaces that can be shown: the caption engine (`web/src/lib/captions`, all 12 styles with their real fonts), the command colours, the editor and done view.
- No testimonials, user counts, press, ratings, measured speeds or benchmarks exist. Do not invent any.
- No marketing video or before/after clip exists. `docs/raw.mp4` and `docs/edited.mp4` are old SmartCut material of a real person and are not usable without consent and a re-render.
- Old SmartCut branding (`docs/banner.png`, `docs/logo.png`, `logo.png`, `docs/index.html`) is not CleoCuts material.

## Product Principles

1. The voice mechanism is the product; every surface should make “say it, it's gone” obvious.
2. Claim only what ships today. Demonstrations may be synthetic if labelled; facts, prices and numbers may not.
3. Phone first: the creator records, uploads and often edits on a phone.
4. The creator stays in control: every automatic cut can be seen and restored.

## Accessibility & Inclusion

WCAG 2.2 AA. All text tokens are AA on every surface. Motion respects `prefers-reduced-motion` (every landing demo becomes a still and nothing loops). One known exception to that target: the landing's looping demos have no pause buttons (owner decision, Oct 2026), so they knowingly miss WCAG 2.2.2 Pause, Stop, Hide (Level A); they stop off screen and in hidden tabs and go on from where they were. 14 languages, including long German words and CJK; right-to-left captions are not supported yet.
