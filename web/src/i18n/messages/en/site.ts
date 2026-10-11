/**
 * English strings for the site's header and footer, the pricing page
 * (site.*), the library (library.*) and shared components (common.*).
 * The landing page's own strings are in landing.ts.
 *
 * "{name}" placeholders are filled at render time.
 */
export const enSite = {
  /* ── Landing: header ── */
  "site.header.homeAria": "CleoCuts home",
  "site.header.openEditor": "Open editor",

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
