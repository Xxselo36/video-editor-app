---
name: CleoCuts
description: The voice-controlled AI video editor. Dark violet studio, system type, fixed voice-command colours.
colors:
  surface-0: "#0b0a10"
  surface-1: "#131217"
  surface-2: "#1b1a22"
  surface-tint: "#24222d"
  text-strong: "#f5f3fa"
  text-body: "#c4c0d0"
  text-muted: "#8b869a"
  text-faint: "#85809a"
  border: "#23222b"
  border-hover: "#3a3849"
  border-strong: "#545267"
  brand: "#8b5cf6"
  brand-solid: "#7c3aed"
  brand-solid-hover: "#6d28d9"
  brand-hover: "#a78bfa"
  brand-tint: "rgba(139, 92, 246, 0.12)"
  brand-strong: "#ddd6fe"
  brand-glow: "rgba(139, 92, 246, 0.4)"
  on-brand-solid: "#ffffff"
  accent: "#ec4899"
  accent-tint: "rgba(236, 72, 153, 0.14)"
  danger: "#ef6b57"
  warn: "#f59e0b"
  success: "#10b981"
  cmd-start: "#5a9fff"
  cmd-cut: "#f26e6e"
  cmd-keep: "#4ecc77"
  cmd-finish: "#b979ff"
  cmd-stopgo: "#f5b54d"
typography:
  display:
    fontFamily: "ui-sans-serif, system-ui, sans-serif"
    fontSize: "clamp(2.25rem, 1.55rem + 3.4vw, 4.5rem)"
    fontWeight: 800
    lineHeight: 1.03
    letterSpacing: "-0.035em"
  headline:
    fontFamily: "ui-sans-serif, system-ui, sans-serif"
    fontSize: "clamp(1.875rem, 1.4rem + 2.1vw, 3.25rem)"
    fontWeight: 800
    lineHeight: 1.08
    letterSpacing: "-0.03em"
  command-word:
    fontFamily: "ui-sans-serif, system-ui, sans-serif"
    fontSize: "clamp(1.625rem, 1.3rem + 1.3vw, 2.25rem)"
    fontWeight: 800
    lineHeight: 1.1
    letterSpacing: "-0.03em"
  title:
    fontFamily: "ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.25rem"
    fontWeight: 700
    lineHeight: 1.3
    letterSpacing: "-0.015em"
  lead:
    fontFamily: "ui-sans-serif, system-ui, sans-serif"
    fontSize: "clamp(1.0625rem, 1rem + 0.3vw, 1.25rem)"
    fontWeight: 400
    lineHeight: 1.55
  body:
    fontFamily: "ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.0625rem"
    fontWeight: 400
    lineHeight: 1.6
  label:
    fontFamily: "ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 600
    lineHeight: 1.3
  group-label:
    fontFamily: "ui-sans-serif, system-ui, sans-serif"
    fontSize: "11px"
    fontWeight: 600
    letterSpacing: "0.15em"
  editor-ui:
    fontFamily: "Geist, ui-sans-serif, system-ui, sans-serif"
  editor-mono:
    fontFamily: "Geist Mono, ui-monospace, monospace"
rounded:
  sm: "4px"
  lg: "8px"
  xl: "12px"
  2xl: "16px"
  full: "9999px"
spacing:
  gutter: "1rem"
  gutter-sm: "1.5rem"
  gutter-lg: "2rem"
  section: "4.5rem"
  section-md: "6rem"
components:
  button-primary:
    backgroundColor: "{colors.brand-solid}"
    textColor: "{colors.on-brand-solid}"
    typography: "{typography.label}"
    rounded: "{rounded.xl}"
    padding: "10px 24px"
  button-primary-hover:
    backgroundColor: "{colors.brand-solid-hover}"
  button-primary-lg:
    backgroundColor: "{colors.brand-solid}"
    textColor: "{colors.on-brand-solid}"
    rounded: "{rounded.xl}"
    padding: "16px 24px"
  button-primary-pill:
    backgroundColor: "{colors.brand-solid}"
    textColor: "{colors.on-brand-solid}"
    rounded: "{rounded.full}"
    padding: "8px 16px"
  button-tint:
    backgroundColor: "{colors.brand-tint}"
    textColor: "{colors.brand-strong}"
    rounded: "{rounded.xl}"
    padding: "10px 24px"
  button-sm:
    rounded: "{rounded.lg}"
    padding: "6px 12px"
  card:
    backgroundColor: "{colors.surface-1}"
    rounded: "{rounded.2xl}"
  command-chip:
    backgroundColor: "{colors.surface-1}"
    textColor: "{colors.cmd-cut}"
    rounded: "{rounded.full}"
    padding: "5px 12px"
  legend-chip:
    backgroundColor: "{colors.surface-1}"
    textColor: "{colors.text-body}"
    rounded: "{rounded.full}"
    padding: "6px 12px"
  icon-tile:
    backgroundColor: "{colors.surface-2}"
    textColor: "{colors.text-strong}"
    rounded: "{rounded.lg}"
    size: "36px"
---

# Design System: CleoCuts

Source of truth in code: `web/src/app/globals.css` (tokens), `web/src/components/Logo.tsx` (logo), `web/src/components/ui/` (kit). The `cleocuts-brand` skill is binding; if this file and either of those disagree, they win and this file is updated.

## Overview

**Creative North Star: "The Listening Studio"**

A dark, quiet edit bay at night. Surfaces are near-black with a slight violet undertone, layered from page to card to elevated by lightness, with a soft ambient violet and magenta glow fixed behind the page. Into that calm, colour enters for exactly two reasons: violet marks the one thing to do (the action, focus, the link), and five fixed hues name the spoken commands. Everything else is neutral, so a coloured word always means something.

Type is the system font, set heavy and tight for headlines and plain for reading; the site ships no web font. The editor alone loads Geist and Geist Mono. Caption fonts (Bangers, Montserrat, Poppins, Playfair, Inter) belong to the video, never to the interface. Motion is quick and calm: one ease-out curve, short steps, no bounce, and every animation has a reduced-motion answer.

**Key Characteristics:**
- Dark UI only (`color-scheme: dark`); no light theme, no pure black, no cold zinc.
- Depth by lighter surface and hairline border, not heavy shadow.
- Violet for action and focus; magenta only as violet's gradient partner.
- Fixed command colours wherever a "Cleo …" command appears.
- System font on the site; Geist only in the editor; Bangers only in captions and share images.
- One ease-out curve, UI steps of 150 to 600 ms, reduced motion respected everywhere. The one exception is a playhead (the take strip's recording sweep, the clip's scrub): it moves at the speed of time, linear.

## Colors

A cool near-black studio with one violet voice and five fixed signal hues.

### Primary
- **Deep Violet** (`brand`): accents, brand-coloured text, the source of the ambient glow and the CTA glow ring.
- **Solid Violet** (`brand-solid`): the fill of every filled brand button, with white text (AA 5.7:1); `brand-solid-hover` on hover. Also the page's text-selection colour.
- **Lilac** (`brand-hover`): links, inline links, and the 2px focus outline.
- **Violet Wash** (`brand-tint` with `brand-strong` text): the secondary (tint) button and selected states.

### Secondary
- **Magenta** (`accent`, `accent-tint`): only as the gradient partner to violet (the ambient page glow, violet to magenta gradients). Never a button, never alone.

### Tertiary: voice commands
Fixed per command and reused for job states (uploading blue, analyzing amber, reviewing green, rendering purple). All reach AA as text on surface-0/1.
- **Start Blue** (`cmd-start`): "Cleo start".
- **Cut Red** (`cmd-cut`): "Cleo cut"; also a removed bad take.
- **Keep Green** (`cmd-keep`): "Cleo keep".
- **Finish Purple** (`cmd-finish`): "Cleo finish".
- **Stop/Go Amber** (`cmd-stopgo`): "Cleo stop" and "Cleo go"; also a skipped sentence.

### Neutral
- **Studio Black** (`surface-0`): page, sticky header, phone bottom bar.
- **Panel** (`surface-1`): cards, chips, sentence panels.
- **Raised** (`surface-2`): elevated blocks, strip segments, icon tiles, skip link.
- **Wash** (`surface-tint`): subtle fills, hatch stripes, pause blocks.
- **Text** (`text-strong` headings, `text-body` paragraphs, `text-muted` and `text-faint` hints): every text token is AA on surface-0/1/2.
- **Hairlines** (`border`, `border-hover`, `border-strong`): dividers and card edges at rest, on hover, and for emphasis (marked pieces, caption frames).
- **Feedback** (`danger`, `warn`, `success`): status and error messages only.

### Named Rules
**The One Violet Rule.** Violet is spent on actions, links, focus and active states. One primary (brand-solid) action per view; on the landing the header and phone bar carry it only while the hero and closing buttons are off screen.

**The Fixed Command Rule.** Each "Cleo …" command always wears its own `--cmd-*` colour, as text, chip border, marker post or tint, and nothing else uses those hues as decoration. Never swap them. Commands are written in the language's quotation marks and never translated.

**The Caption Data Rule.** Caption preset colours (yellow, neon green, cyan and so on from `web/src/lib/captions/presets.ts`) and their black strokes and drop shadows are video data rendered inside caption frames, not UI colours or UI shadows.

## Typography

**Display Font:** system UI stack (Tailwind default sans)
**Body Font:** the same system stack
**Editor Font:** Geist and Geist Mono (editor chunk only, `--ed-font` / `--ed-mono`)

**Character:** One family, contrast by weight: 800 with tight negative tracking for headlines, regular at 1.55 to 1.6 line height for reading. Fast and native on every phone.

### Hierarchy
- **Display** (800, fitted 2 to 6rem per language, 0.98, -0.04em): the page headline, centred, one line per sentence; the word that does the cutting (`site.hero.cutWord`) is inked in the violet-to-magenta brand gradient with a soft violet glow, the only gradient text on the site. The closing headline uses the same voice at up to 4rem.
- **Headline** (800, fluid 1.875 to 3.25rem, 1.08, -0.03em): section titles, max 22 to 28ch.
- **Command Word** (800, fluid 1.625 to 2.25rem, 1.1, -0.03em): a command set in its command colour.
- **Title** (700, 1.25rem, 1.3, -0.015em): feature titles inside a section.
- **Lead / Body** (400, 1.0625 to 1.25rem, 1.55 to 1.6): paragraphs in `text-body`, 34 to 40rem wide.
- **Label** (600 to 650, 0.8125 to 0.875rem): buttons, chips, legend items, FAQ questions (1.125rem, 650).
- **Group Label** (600, 11px, uppercase, 0.15em, `text-muted`): `SectionLabel`, naming a group of items inside the app (a list, a timeline panel).

### Named Rules
**The No Web Font Rule.** Site pages load no UI web font. Geist lives only in the editor; Bangers only in the Clipper caption style and share images; caption fonts load only inside caption frames.

**The Language Rule.** Headlines break by phrase in Japanese (`word-break: auto-phrase`) and keep words whole in Korean (`keep-all`); every string ships in all 14 languages.

## Layout

A single centred column (`max-width: 76rem`) with a gutter of 1rem, 1.5rem from 640px and 2rem from 1024px. Sections breathe at 4.5rem block padding, 6rem from 768px; the closing section takes 6 to 9rem. Reading widths are capped (lead 34rem, body 38rem, FAQ 46rem). Lists are separated by `border` hairlines rather than boxed. Grids collapse to one column on phones and open at 768px (commands, caption styles 2 to 4 columns, control list) or 900 to 1024px (paired features, the cleanup panel).

Phone first: the sticky header is 4rem high; below 768px a fixed bottom bar carries the primary action with safe-area padding, and scroll padding keeps focused elements clear of both bars (5rem top, 6rem bottom).

## Elevation & Depth

Flat and tonal. Depth comes from stepping surface-0 to surface-1 to surface-2 and from 1px borders; a fixed ambient glow (violet at top centre, magenta top right) sits behind the page. Shadows are rare and purposeful.

### Shadow Vocabulary
- **Hairline lift** (`--shadow-sm`): small controls.
- **Ambient** (`--shadow-md`): caption frames and floating panels.
- **Violet glow** (`--shadow-glow`): primary calls to action and focused hero elements only.
- **Dialog backdrop**: `rgba(0,0,0,0.7)` with a 6px blur.

### Named Rules
**The Lighter-Surface Rule.** To raise something, make its surface lighter and give it a hairline; do not reach for a bigger shadow.

## Shapes

Soft, consistent corners on a five-step scale: inline pieces and swatches `sm`; small controls, icon tiles and segments `lg`; buttons `xl`; cards, panels and caption frames `2xl`; header actions, chips and the play toggle `full`. Hatching (135deg stripes of `border-strong` or `surface-tint`) is the shared mark for "removed" (pauses, gone takes) across the landing demos. Vertical video always appears at 9:16, landscape at 16:9.

## Components

### Buttons
Confident, filled, one per view.
- **Shape:** `xl` (12px) by default; `lg` for the inline `sm` size; `full` for the header `pill`.
- **Primary:** `brand-solid` fill, white semibold text; sizes `lg` (16px 24px, base), `md` (10px 24px), `sm` (6px 12px), `pill` (8px 16px). The hero's own button is a compact centred pill with an arrow (44px tall on phones, 48px from tablets); the phone bar keeps its full-width button.
- **Hover / Press:** fill to `brand-solid-hover`; press scales down (0.97 on landing CTAs). Landing CTAs add `--shadow-glow`.
- **Tint (secondary):** `brand-tint` fill, `brand-strong` text.
- **Links styled as buttons** use `buttonClass(variant, size)`; never restyle a button's variant or size through `className`.
- **Disabled:** 60% opacity.

### Chips
- **Command chip:** pill, 1px border and text in the command colour, background the command colour mixed 14% into `surface-1`.
- **Legend chip:** pill, `surface-1`, `border`, `text-body`; the active one takes the relevant colour as border and `text-strong` text.

### Cards / Containers
- **Corner Style:** `2xl` (16px), contents clipped.
- **Background:** `surface-1` with a 1px `border`; hover to `border-hover`.
- **Shadow Strategy:** none at rest (see Elevation).

### Dialog
One `Dialog` for every modal: portal into `body`, focus moves in and returns, Tab is trapped, Escape and backdrop click close, page scroll is locked.

### Icons
lucide-react through `ui/Icon`: on the text baseline, 0.84em by default, decorative (the control carries the name). `IconButton` requires a label. In feature lists an icon sits on a 36px `surface-2` tile with `lg` corners.

### Navigation
Sticky header on `surface-0` with a bottom hairline: `LogoWord` left; pricing link, language switcher, account and (desktop, once the hero button has gone) the pill CTA right. Phones narrower than 360px show the mark only. Footer links in `text-muted`, `text-strong` on hover.

### Take Strip (signature)
The hero's endless loop, in two acts. A recording drawn as a tape lying in 3D: a plate (surface-1 to surface-2, lit far edge, a thickness edge in front) carrying surface-2 segments with a waveform texture. Act 1, "You talk": a white playhead records across the tape, linear, and each command post (in its command colour) appears with a short flare as the playhead reaches it, under a narration chip ("Cleo start", "Cleo cut", ...). Act 2, "Cleo cuts": the bad take, a filler word, a pause and the skipped sentence are each marked (hatched toward their colour, 620 ms), lift off the tape and the tape closes behind them (420 ms), leaving a thin cut marker; then the bits before "Cleo start" and after "Cleo finish" go. The freed end of the tape shows a faint hatch, so the result reads visibly shorter. "Cleo keep" leaves its post on the tape and seals the first scene with a green "kept" mark. One narration chip per act travels from flag to flag on the move curve; Act 1 ends with the playhead landing on "Cleo finish", and in Act 2 the pieces lift on the same curve, a little faster each time. A render head then sweeps over the kept tape into the video, which lights up as it lands, and its captions play once, timed to the sentence. The loop's seam is one event in one direction: everything on the tape leaves together, the tape swaps back to raw while unseen, and the raw pieces slide in left to right. The 9:16 frame is the tape's monitor and is visible the whole loop: on desktop in the right column, on phones and tablets centred under the button (its width follows the screen height, 152 px on a 390x844 phone), above the chips and the tape, so the picture and the playhead read top to bottom. While the footage is raw it shows the ungraded take the clip was cut from (the raw take, `hero-raw`, played by a monitor loaded as a lazy chunk after hydration, under a lighter 0.36 scrim). At the seam the grade drains from the frame on screen (the raw take, cued to the same frame, fades in over 320 ms), then while the tape is unseen the frame dissolves to the take's first frame and waits there at "Cleo start". Where the seam falls on the finished clip's own loop crossfade (its last 0.4 s, which the raw take does not have; it depends on the caption's length, e.g. Japanese and Korean), the clip plays the seam out under the scrim and the monitor takes over at that dissolve instead, from a still of the frame on screen. In Act 1 the take plays in lockstep with the playhead, the whole take in one run (about 3.7x, only the playback rate steered): a small fast-forward pill (the frame tag's style, top right) shows the take's running timecode, and a thin bar at the frame's foot runs with the playhead. It lands and holds on the take's calm last frame. In Act 2 each removal lifting off the tape flashes its removed moment in the frame, hatched and ringed in its command colour as on the tape (the bad take's big gesture in cut red, the skipped sentence's glance away in stop/go amber, the filler and the pause neutral, the bit before "Cleo start" in start blue), then cuts hard to the next kept take's first frame as the tape starts closing (never a black frame: the cut waits behind the still until the take has its frame). The ends' trim lands and holds on the finished video's first frame; the render head's violet line then wipes the grade across that frame from left to right, in step with the head on the tape, and fades where it lands as the finished video plays at 1x with its captions. Without the raw take (still loading, refused, data saver, or failing or refused mid-loop, when the monitor takes its pill and bar with it) the frame shows the finished clip dimmed under the scrim (on phones and tablets now for the whole loop). A step machine drives it (transitions only between steps); it stops off screen and in hidden tabs; the pause button (44 px) freezes every moving part in place and resume continues where it stopped; reduced motion shows the finished still. Desktop shows a legend of the five results, phones a status line with ticks.

### Spoken Cut (command words)
One row per voice command, in its command colour, with a strip of the recording under the word that shows what the command does. Each row is said, then edited: the word inks from a tint into its colour behind a small voice caret while its post rises in the strip like a level meter; a hatch marks the span; the piece folds away on a hinge (the hinge spring) while the rest of the strip rides its edge shut, leaving one marker in the command colour and a dashed rail where the video got shorter. "Cleo keep" brings in the next scene instead; "Cleo stop … go" grows its hatch at the speed of speech and lands the go post on the stop post. Each row plays with the scroll: it starts when its strip reaches the middle of the screen, finishes before the next one arrives (one row at a time, top to bottom), and plays backwards when scrolling up; rows above stay edited, rows below wait unsaid, and nothing moves while the page stands still, so there is no pause control and no replay button. Where the browser can, a scroll timeline drives it off the main thread; elsewhere one light script follows the scroll. Reduced motion shows every strip marked, at rest. The automatic cuts (pauses, filler words) use the same grammar in the sentence beside them: hatched markers where something was cut, tap one to bring it back.

### Section Entrances
Everything between the demos enters once per load as it scrolls up: headings and the lines under them rise 12px on the brand curve, demo figures rise 16px from 98%, list rows draw their rule in from the start edge with the icon and text after it, in reading order (60 to 70ms apart, at most 360ms in total). Only what was below the fold when the page loaded takes part; what is still parked when scrolling rests goes in then, and anything scrolled past unseen is simply shown. The bonus-clip tiles wait for their figure's entrance, then stand up one by one. The closing call ends like a render finishing: the reprise video tips up from its bottom edge, a playhead sweeps the title in, the note follows and the button glows once. Reduced motion: fades only.

### Creator Footage (Scene)
Every video frame on the landing shows one real creator talking to the camera: muted, looping stock clips of one man (MART PRODUCTION on Pexels, free to use) on three sets (a cafe, an office, a room). Cut, graded and encoded in `web/public/landing/video/` (H.264, 25 fps, no audio, 6 to 7 s; the last 0.4 s fades into the moments before the first frame, so the loop has no seam): the hero's 9:16 clip (also the closing frame), three 9:16 clips for the caption carousel, three smaller ones for the bonus tiles, and the 16:9 take SmartCam reframes, with his face track from the product's own face model for the 9:16 crop that follows him; plus the hero's ungraded 16.8 s raw take (`hero-raw`, a keyframe every second), which only the hero's monitor plays, once per loop and never looped. Each clip has a first-frame webp poster and an inline 12 px preview, so a frame is never empty; a soft vignette sits over every frame. His movement is video content, not UI motion. A clip loads only near the viewport (the hero's right away) and plays only on screen in a visible tab, pausing on its frame otherwise; under reduced motion, data saver or a 2G-class connection it never loads and the poster stays as a meaningful still, as it does when a browser refuses to autoplay. Every section that loops clips has a 44 px pause control (WCAG 2.2.2). Every frame carries the "Example" tag: he is shown as an example, never as a customer or testimonial.

### Caption Frame
`2xl` corners, `border-strong` edge, `--shadow-md`, the creator footage behind; caption text drawn by the real caption engine on a canvas (the export's own pages, entrances and highlights), with a CSS poster of the settled caption until the engine and font are ready. Small frames enlarge Karaoke (Hindi) to stay legible.

### Caption Player
The 12 styles as a radio group of chips beside one phone frame. A short tour plays four styles once (a progress line under the playing chip), then the visitor picks; a pause button stops it. The tour starts only once the caption itself is on screen.

### Reframe (16:9 to 9:16)
The 16:9 take with a 9:16 window on it, beside (desktop) or above (phones) the 9:16 result. The pass: the window starts where a plain centre crop sits, cutting his face in half; a face box (violet corner brackets) closes on his face, the window glides over to it on the filmed curve and the outside settles darker; the result frame moves by exactly as much. Once per entry, with a Replay button.

### Bonus Clips
The finished 3-minute video as a flat tape with a time ruler. A playhead scans it; each picked span outlines, a connector draws down and its 9:16 tile stands up. Each tile then loops its clip with its caption: three short spoken phrases, one caption page each ("My best tip" / "for more views" / "hook them fast"), so the subtitles change twice per loop like a real short, with a breath between phrases and the last phrase held until the clip starts over. Every phrase fits on one page in every language, and every still (poster, reduced motion, pause before the first word) shows the first phrase whole.

### Logo
`LogoMark` (violet-gradient rounded C with a glowing spark, default 28px) and `LogoWord` (mark plus bold "CleoCuts", -0.02em). Use the components only, only on dark surfaces, never recoloured or redrawn.

## Do's and Don'ts

### Do:
- **Do** use the CSS variables from `globals.css`, never raw hex, in UI components.
- **Do** fill every filled brand button with `brand-solid` and white text, `brand-solid-hover` on hover.
- **Do** colour every spoken command with its `--cmd-*` token, in quotation marks.
- **Do** raise surfaces by lightness (surface-0 to 1 to 2) plus a 1px border.
- **Do** enter screens with `phase-fade` (280ms, `cubic-bezier(0.16, 1, 0.3, 1)`, 8px rise) and use the same curve for every transition.
- **Do** give every new animation a `prefers-reduced-motion` rule; looping demos pause off screen, in hidden tabs, on a pause control, and show one still frame under reduced motion.
- **Do** focus with a 2px `brand-hover` outline at 3px offset.

### Don't:
- **Don't** use `brand` (#8b5cf6) as a fill behind white text (4.23:1).
- **Don't** use magenta as a standalone button, text or fill colour.
- **Don't** swap, reuse or decorate with the command colours.
- **Don't** load a web font on site pages, or use Geist outside the editor or Bangers outside captions and share images.
- **Don't** add a light theme, pure black, cold zinc greys, or a text colour dimmer than `text-faint`.
- **Don't** use emoji or unicode glyphs as UI icons; use lucide through `ui/Icon`.
- **Don't** carry caption styling (black text stroke, hard drop shadows, preset colours) into UI elements.
- **Don't** use bouncy easing or long hero animations.
