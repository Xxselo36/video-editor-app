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
  // Replaces the badge once paid plans are live (NEXT_PUBLIC_BILLING_ENABLED).
  "site.hero.badgePricing": "See plans & pricing",
  "site.hero.titleLead": "Edit while you",
  "site.hero.titleAccent": "record.",
  "site.hero.sub":
    "Say {cut} when you mess up. Say {finish} when you're done. Ready to post in minutes, with captions and cuts included.",
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
  "site.features.cleanup.body": "Fixes misheard words and brand names in your captions.",
  "site.features.captions.title": "Animated captions",
  "site.features.captions.body": "Several styles, from Clean to Clipper.",
  "site.features.vertical.title": "Auto vertical",
  "site.features.vertical.body": "Landscape → 9:16 with face tracking.",
  "site.features.hooks.title": "Best moments as clips",
  "site.features.hooks.body":
    "For videos of 90 seconds or more, CleoCuts finds up to {count} of the best moments and cuts each into its own short clip.",

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
  "site.steps.post.body": "Download your finished video, ready for TikTok, Instagram and YouTube.",
  "site.steps.post.hint": "Download when it's ready",

  /* ── Landing: footer ── */
  "site.footer.editor": "Editor",
  "site.footer.library": "Library",
  "site.footer.imprint": "Imprint",
  "site.footer.privacy": "Privacy",
  "site.footer.terms": "Terms",
  "site.footer.pricing": "Pricing",

  /* ── Pricing page ── */
  "site.pricing.title": "Simple pricing",
  "site.pricing.subtitle": "Pay monthly for the minutes of video you upload. Cancel any time.",
  "site.pricing.perMonth": "/ month",
  "site.pricing.perYear": "/ year",
  "site.pricing.priceAtCheckout": "Price shown at checkout",
  "site.pricing.popular": "Most popular",
  "site.pricing.minutes": "{minutes} min of video per month",
  "site.pricing.retention": "Projects kept for {days} days",
  "site.pricing.featureWorkflows": "All workflows and caption styles",
  "site.pricing.featureVoice": "Voice commands and AI cleanup",
  "site.pricing.choose": "Choose {plan}",
  "site.pricing.current": "Your current plan",
  "site.pricing.manage": "Manage subscription",
  "site.pricing.switch": "Switch to {plan}",
  "site.pricing.unavailable": "Not available yet",
  "site.pricing.redirecting": "Opening checkout…",
  "site.pricing.checkoutFailed": "Couldn't open the checkout. Please try again in a moment.",
  "site.pricing.loadFailed": "Couldn't load the plans. Please try again in a moment.",
  "site.pricing.minutesHint":
    "Minutes count the length of the videos you upload. Unused minutes don't roll over to the next month.",
  "site.pricing.vatNote":
    "Prices include VAT. Payments are handled by Lemon Squeezy, our Merchant of Record — they charge you and send your invoices.",
  "site.pricing.testMode": "Test mode — no real payments",
  "site.pricing.testersOnly": "Plans can't be bought yet — checkout is in test mode for invited testers only.",
  "site.pricing.betaTitle": "Free during the open beta",
  "site.pricing.betaBody": "CleoCuts is free while we're in beta. Paid plans with more minutes are coming soon.",

  /* ── Library: header ── */
  "library.header.homeAria": "CleoCuts editor",
  "library.header.title": "Library",
  "library.header.newProject": "New project",

  /* ── Library: list ── */
  "library.count.one": "{count} project",
  "library.count.other": "{count} projects",
  "library.confirmDelete": "Delete this project permanently? The video and all edits are removed from our servers.",
  "library.deleteFailed": "Couldn't delete right now — if the video is still processing, try again in a moment.",

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
  "library.card.expiresDays": "Auto-deletes in {n} days",
  "library.card.expiresSoon": "Auto-deletes within 24 hours",
  "library.card.expired": "Expired — files were deleted",
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
  "common.videoModal.dialogLabel": "Video preview",

  /* ── Accounts (header, all pages) ── */
  "common.auth.signIn": "Sign in",
  "common.auth.account": "Account",
  "common.auth.pricing": "Pricing",
  "common.language": "Language",
  "common.footer.legalAria": "Legal",
  "legal.onlyDeEn":
    "This page is available in German and English only. You are reading the English version.",
  "common.backHome": "Back to home",
  "common.notFound.title": "Page not found",
  "common.notFound.body": "This page doesn't exist or has moved.",
  "common.error.title": "Something went wrong",
  "common.error.body": "This page couldn't be shown. Please try again.",
  "common.error.retry": "Try again",
  "common.error.ref": "Error reference: {id}",
};
