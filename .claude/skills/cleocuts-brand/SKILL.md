---
name: cleocuts-brand
description: CleoCuts brand guidelines — colors, logo, typography, voice-command colors, motion, and copy voice. Use for any CleoCuts UI, landing page, marketing asset, social graphic, email, deck, or plugin panel, and whenever brand, style guide, colors, logo, or "on-brand" comes up in this project. Takes precedence over generic style presets from other design skills.
---

# CleoCuts Brand

Source of truth in code: `web/src/app/globals.css` (tokens) and `web/src/components/Logo.tsx` (logo). If they change, they win over this file — update this file to match.

## Product in one line

"The world's first voice-controlled AI video editor." Creators say "Cleo cut" when they mess up; AI cleans the rest — cuts, captions, ready-to-post clips.

## Look

Dark, cool near-black with a slight violet undertone. Deep violet is the brand; magenta adds energy in gradients. Soft ambient violet/magenta glow behind the page. No cold zinc/gray, no pure black, no light theme by default.

## Color tokens

Always use the CSS variables, never raw hex in components.

| Role | Token | Value |
|---|---|---|
| Page bg | `--surface-0` | `#0b0a10` |
| Card bg | `--surface-1` | `#131217` |
| Elevated | `--surface-2` | `#1b1a22` |
| Subtle wash | `--surface-tint` | `#24222d` |
| Heading text | `--text-strong` | `#f5f3fa` |
| Body text | `--text-body` | `#c4c0d0` |
| Muted text | `--text-muted` | `#8b869a` |
| Faint (hints, timestamps) | `--text-faint` | `#85809a` |
| Border | `--border` / `--border-hover` / `--border-strong` | `#23222b` / `#3a3849` / `#545267` |
| Brand (violet-500) | `--brand` | `#8b5cf6` |
| Filled button bg (violet-600) | `--brand-solid` | `#7c3aed` |
| Filled button hover (violet-700) | `--brand-solid-hover` | `#6d28d9` |
| Brand hover (violet-400) | `--brand-hover` | `#a78bfa` |
| Brand tint bg | `--brand-tint` | `rgba(139,92,246,0.12)` |
| Text on brand tint | `--brand-strong` | `#ddd6fe` |
| Brand glow | `--brand-glow` | `rgba(139,92,246,0.4)` |
| Accent (magenta) | `--accent` | `#ec4899` |
| Accent tint | `--accent-tint` | `rgba(236,72,153,0.14)` |
| Danger | `--danger` | `#ef6b57` |
| Warning | `--warn` | `#f59e0b` |
| Success | `--success` | `#10b981` |

Shadows: `--shadow-sm`, `--shadow-md`, `--shadow-glow` (violet ring + glow — for primary CTAs and focused hero elements only).

Rules:
- Violet = primary actions, links, focus, active states. One primary CTA per view.
- Filled buttons with white text use `--brand-solid` (AA 5.7:1), never `--brand` (only 4.23:1). `--brand` is for accents and brand-colored text.
- Every text token is WCAG AA on all surfaces — keep it that way; don't introduce dimmer text colors.
- Dark UI only (`color-scheme: dark` is set).
- Magenta only as gradient partner to violet (violet → magenta), never as a standalone button color.
- Text on dark surfaces: `--text-strong` for headings, `--text-body` for paragraphs. Check WCAG AA contrast for anything muted.

## Voice-command colors

Each "Cleo …" command has a fixed color — tokens `--cmd-start`, `--cmd-cut`, `--cmd-keep`, `--cmd-finish`, `--cmd-stopgo` in `globals.css` (also hardcoded in `web/src/features/voice-test/VoiceTestDialog.tsx`). Job states reuse the same hues (uploading blue, analyzing amber, reviewing green, rendering purple, error red — `features/jobs/ActiveJobCard.tsx`). Use them wherever commands appear (UI chips, tutorials, marketing, video overlays) — never swap them.

| Command | Meaning | Color |
|---|---|---|
| Cleo start | Begin take | `#5A9FFF` blue |
| Cleo cut | Discard current take | `#F26E6E` red |
| Cleo keep | Confirm take, next scene | `#4ECC77` green |
| Cleo finish | End video | `#B979FF` purple |
| Cleo stop / Cleo go | Skip a sentence / resume | `#F5B54D` amber |

Write commands with curly quotes in UI copy: “Cleo cut”.

## Logo

- Mark: `LogoMark` — rounded "C" stroke with violet gradient (`#e9d5ff` → `#a78bfa` → `#6d28d9`) and a glowing spark inside (the "listening" moment). Default 28px.
- Wordmark: `LogoWord` — mark + "CleoCuts" in bold, tight tracking (`-0.02em`), `--text-strong`.
- Spelling: always **CleoCuts** (capital C twice, one word). Never "Cleocuts", "Cleo Cuts", "CLEOCUTS".
- Use the components, never redraw. Only on dark backgrounds. Don't recolor, stretch, or add effects.
- Raster files: `web/src/app/icon.svg`, `web/src/app/apple-icon.png`, `web/public/icons/`. (`docs/logo.png` and `logo.png` are old SmartCut branding, not CleoCuts.)

## Typography

- Site pages (landing, legal, account): system UI font stack (Tailwind default sans). No web font on the site — keep it fast.
- Editor v2: **Geist** + **Geist Mono**, loaded only in the editor chunk (`features/editor/v2/fonts.ts`, `--ed-font` / `--ed-mono`).
- Headings: `font-bold` / `font-semibold`, `tracking-tight`. Small uppercase labels: `tracking-wider`.
- **Bangers** (`assets/fonts/Bangers-Regular.ttf`) = font of the "Clipper" caption style; also used as headline font in share images (`lib/shareImage.tsx`). Never for UI text.
- Caption-style showcases may use their own fonts (e.g. Georgia for "Elegant") — they demo video captions, not UI.

## Components & icons

- Use the UI kit in `web/src/components/ui/` (`Button`, `Card`, `Dialog`, `IconButton`, `Tabs`, `Toast`, `Switch`, `Slider`, `Progress`) before writing new styled elements.
- `Button` variants: `primary` (brand-solid fill, main action) and `tint` (secondary). Sizes `lg` / `md` / `sm` / `pill`.
- One `Dialog` for every modal (portal, focus trap, Escape).
- Icons: **lucide-react** via `ui/Icon` (sits on the text baseline, 0.84em, decorative). No emoji as UI icons.

## Shape & spacing

- Radius: header actions/chips `rounded-full`; buttons and cards `rounded-xl`; inline/small controls `rounded-lg`; large panels `rounded-2xl`.
- Cards: `--surface-1` + 1px `--border`, hover → `--border-hover`. Elevation by lighter surface, not heavy shadows.

## Motion

- Entry: `phase-fade` — 280ms, `cubic-bezier(0.16, 1, 0.3, 1)`, 8px rise.
- Live/listening indicators: `pulse-dot` (2s soft pulse). Loading: `skeleton` shimmer.
- Always respect `prefers-reduced-motion` (already wired in `globals.css` — extend it for new animations).
- Motion is quick and calm; no bouncy or long hero animations.
- One vocabulary of curves (the landing defines them as custom properties on `.page`, mirrored in `features/landing/shared.tsx` for Web Animations):
  - `--ease-out` `cubic-bezier(0.16, 1, 0.3, 1)`: the brand curve. Entrances, rises of 12px or less, fades in.
  - `--ease-move` `cubic-bezier(0.77, 0, 0.175, 1)`: something already on screen travels (a lift, a close, a chip moving on).
  - `--ease-drawer` `cubic-bezier(0.32, 0.72, 0, 1)`: something rises into place (a phone video, the phone CTA bar).
  - `--spring-hinge`: a critically damped spring (no overshoot, about 600ms) for hinged 3D folds and tiles standing up, as CSS `linear()`; `--ease-move` where `linear()` is not supported.
  - `ease` for opacity out and state changes; linear only for playheads, scrub heads and the voice ink.
- Rule: one thing starts at a time. A demo waits for its section's entrance to finish; rows cascade top to bottom; an exit takes at most 70% of its entrance's duration.
- Owner-approved exceptions (Oct 2026):
  - The landing hero's take-strip loop runs continuously. It has a pause button, stops off screen and in hidden tabs, and shows one still under reduced motion.
  - Inside a video frame, motion is video content, not UI. That covers caption animations drawn by the caption engine (its pop and bounce included) and the creator's movements in the footage.
  - Playheads and scrub heads move linearly, at the speed of time.

## Voice & copy

- Short, direct, creator-to-creator. Confident, a little playful. Sentences like "Three steps." and "What CleoCuts does."
- Lead with the voice magic: say it, Cleo handles it. Concrete outcomes over AI buzzwords (no "revolutionary", "leverage", "seamless").
- Honest copy: claim only what the product does today. Error and status messages say what actually happened.
- Source copy is English; all UI strings go through i18n keys (`web/src/i18n/messages/<lang>`, 14 languages). Never hardcode user-facing text — add the key in English and the other languages.
