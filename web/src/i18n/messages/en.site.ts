/**
 * English strings for the landing page (site.*), the library (library.*)
 * and shared components (common.*).
 *
 * "{name}" placeholders are filled at render time. The voice commands
 * ("Cleo cut" / "Cleo finish") and aspect ratios are passed in as
 * placeholders because they must stay literal in every language.
 */
export const enSite = {
  /* ── Landing: header ── */
  "site.header.homeAria": "CleoCuts home",
  "site.header.openEditor": "Open editor",

  /* ── Landing: hero ── */
  "site.hero.badge": "Open beta · free",
  "site.hero.titleLead": "Edit while you",
  "site.hero.titleAccent": "record.",
  "site.hero.sub":
    "Say {cut} when you mess up. Say {finish} when you're done. Ready to post in minutes, with captions, cuts and multiple formats included.",
  "site.hero.cta": "Try CleoCuts",

  /* ── Landing: caption showcase ── */
  "site.showcase.listening": "CleoCuts listening",
  "site.showcase.captionStyle": "caption style",
  "site.showcase.clipper": "TALK IS THE EDITOR",
  "site.showcase.highlight": "READY TO POST",
  "site.showcase.flash": "SAY CUT",
  "site.showcase.punch": "NAILED IT",
  "site.showcase.elegant": "It just listens.",

  /* ── Landing: features ── */
  "site.features.title": "What CleoCuts does.",
  "site.features.voice.title": "Voice triggers",
  "site.features.voice.body": "Say {cut} mid-take. CleoCuts removes the failed attempt.",
  "site.features.cleanup.title": "AI cleanup",
  "site.features.cleanup.body": "Fixes typos, brand names and homophones.",
  "site.features.captions.title": "{count} caption styles",
  "site.features.captions.body": "From Clean to Clipper. Real fonts.",
  "site.features.captions.decoration": "REAL FONTS",
  "site.features.vertical.title": "Auto vertical",
  "site.features.vertical.body": "Landscape → 9:16 with face tracking.",
  "site.features.multiformat.title": "Multi-format",
  "site.features.multiformat.body": "{formats} in one render.",
  "site.features.hooks.title": "Hook clip picker",
  "site.features.hooks.body":
    "CleoCuts finds the {count} best moments in your long-form video and cuts them into standalone reels.",

  /* ── Landing: how it works ── */
  "site.steps.title": "Three steps.",
  "site.steps.sub": "Record. Talk to CleoCuts. Post.",
  "site.steps.record.title": "Record",
  "site.steps.record.body": "Say {cut} when you mess up. No retakes.",
  "site.steps.record.hint": "Takes of any length",
  "site.steps.upload.title": "Upload",
  "site.steps.upload.body": "Drop in your video. Pick a workflow. AI does the rest.",
  "site.steps.upload.hint": "A few minutes, depending on length",
  "site.steps.post.title": "Post",
  "site.steps.post.body": "Get {formats} ready for TikTok, Instagram and YouTube.",
  "site.steps.post.hint": "Download when it's ready",

  /* ── Landing: footer ── */
  "site.footer.editor": "Editor",
  "site.footer.library": "Library",
  "site.footer.imprint": "Imprint",
  "site.footer.privacy": "Privacy",

  /* ── Library: header ── */
  "library.header.homeAria": "CleoCuts editor",
  "library.header.title": "Library",
  "library.header.newProject": "New project",

  /* ── Library: list ── */
  "library.count.one": "{count} project",
  "library.count.other": "{count} projects",
  "library.confirmDelete": "Delete this project from your library?",

  /* ── Library: empty state ── */
  "library.empty.title": "Your library is empty",
  "library.empty.body":
    "Every video you finish shows up here. You can re-download it, grab your captions and share hook clips any time.",
  "library.empty.cta": "Start your first project",

  /* ── Library: project card ── */
  "library.card.playAria": "Play preview of {name}",
  "library.card.noPreview": "no preview",
  "library.card.customPreset": "Custom",
  "library.card.deleteAria": "Delete project",
  "library.card.hooks.one": "{count} hook",
  "library.card.hooks.other": "{count} hooks",
  "library.card.hookSeconds": "{seconds}s",
  "library.card.caption": "Caption",
  "library.card.copy": "copy",
  "library.card.copied": "copied",

  /* ── Library: download labels ── */
  "library.format.primary": "Main edit",
  "library.format.hook": "Hook clip {n}",

  /* ── Library: relative time ── */
  "library.time.justNow": "just now",
  "library.time.minutesAgo": "{n}m ago",
  "library.time.hoursAgo": "{n}h ago",
  "library.time.daysAgo": "{n}d ago",

  /* ── Shared components ── */
  "common.videoModal.closeAria": "Close preview",
  "common.videoModal.close": "Close",
};
