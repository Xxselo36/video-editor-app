/**
 * English strings for the landing page (site.*), the library (library.*)
 * and shared components (common.*).
 *
 * "{name}" placeholders are filled at render time. The voice commands
 * ({start} {cut} {keep} {finish} {stop} {go}, “Cleo start” …) are passed
 * in as placeholders because they stay literal in every language.
 */
export const enSite = {
  /* ── Landing: header ── */
  "site.header.homeAria": "CleoCuts home",
  "site.header.openEditor": "Open editor",

  /* ── Landing: shared ── */
  "site.quote": "“{text}”",
  "site.skipToContent": "Skip to content",

  /* ── Landing: call to action (create an account, or the editor) ── */
  "site.cta.signupFree": "Create free account",
  "site.cta.signup": "Create account",
  "site.cta.start": "Start free",
  "site.cta.openEditor": "Open editor",

  /* ── Landing: hero ── */
  "site.hero.title": "You talk. Cleo edits.",
  "site.hero.sub": "Say {start}, then {cut} after any bad take. CleoCuts also removes pauses and filler words and adds captions.",

  /* ── Landing: take-strip demo ("[word]" marks the highlighted caption word) ── */
  "site.demo.example": "Example",
  "site.demo.pause": "Pause animation",
  "site.demo.play": "Play animation",
  "site.demo.listAria": "What CleoCuts removes and adds",
  "site.demo.take": "Bad take removed",
  "site.demo.pauses": "Pauses removed",
  "site.demo.fillers": "Filler words removed",
  "site.demo.skip": "Sentence skipped",
  "site.demo.captions": "Captions added",
  "site.demo.filler": "um",
  "site.demo.caption": "3 tips for better [hooks]",

  /* ── Landing: voice commands ── */
  "site.commands.title": "Talk to Cleo while you film.",
  "site.commands.sub": "Say {start} first, then use the others while you record. After the upload, CleoCuts finds them and edits for you.",
  "site.commands.start": "Starts your video. Everything before it is dropped.",
  "site.commands.cut": "Throws away the take you're in. Then say the line again.",
  "site.commands.keep": "Keeps the take and starts the next scene.",
  "site.commands.stopgo": "Skips everything you say in between.",
  "site.commands.finish": "Ends your video. Everything after it is dropped.",

  /* ── Landing: automatic cleanup ── */
  "site.auto.title": "Pauses and filler words are cut for you.",
  "site.auto.body": "No command needed. CleoCuts removes pauses and filler words like {um} from the whole video. You choose the pace: {tight}, {natural} or {none}.",
  "site.auto.sample": "So {um} three tips {pause} for better {um} hooks.",
  "site.auto.pause": "pause",
  "site.auto.cleanup": "CleoCuts also fixes misheard words in your captions.",

  /* ── Landing: caption styles ── */
  "site.captions.title": "Captions that follow every word.",
  "site.captions.body": "Up to 12 styles, from loud to calm. In the editor, switch the style, fix any word, and resize or move each caption.",

  /* ── Landing: format and bonus clips ── */
  "site.format.title": "Vertical, even if you filmed wide.",
  "site.format.body": "Landscape videos are reframed to 9:16 around your face. Already vertical? It stays as you filmed it.",
  "site.clips.title": "Bonus clips from longer videos.",
  "site.clips.body": "When your finished video runs 90 seconds or more, CleoCuts picks up to {count} short clips worth posting on their own.",

  /* ── Landing: the creator's control ── */
  "site.control.title": "You have the last word.",
  "site.control.restore": "Every cut stays visible. Tap one to bring it back.",
  "site.control.text": "Fix any word, and resize or move each caption.",
  "site.control.post": "Download or share, with the text for your post and hashtags ready to copy.",
  "site.control.files": "Caption files as SRT and VTT.",
  "site.control.reedit": "Edit again without a new upload.",

  /* ── Landing: questions ── */
  "site.faq.title": "Questions",
  "site.faq.record.q": "Do I film inside CleoCuts?",
  "site.faq.record.a": "No. Film with your phone's camera like always, then upload the video here.",
  "site.faq.commands.q": "Do I have to use the commands?",
  "site.faq.commands.a": "No. Without commands, CleoCuts still removes pauses and filler words and adds captions. The commands help when you film several takes. They are made for English and German videos; in other languages they may not be recognized yet.",
  "site.faq.languages.q": "Which languages work?",
  "site.faq.languages.a": "CleoCuts understands 97 spoken languages and detects yours by itself. Captions work in most languages that use Latin or Cyrillic letters, and in Hindi, Chinese, Japanese and Korean. Arabic, Hebrew, Thai, Greek and some other scripts aren't supported yet.",
  "site.faq.price.q": "What does it cost?",
  "site.faq.price.beta": "Nothing during the open beta.",
  "site.faq.price.plans": "Monthly plans, each with a set number of video minutes. All details are on the pricing page.",
  "site.faq.price.link": "See pricing",
  "site.faq.delete.q": "Can I delete my videos?",
  "site.faq.delete.a": "Yes. Delete a project any time, and the video and all edits are removed from our servers.",

  /* ── Landing: closing call ── */
  "site.final.title": "Film your next video with Cleo.",
  "site.final.beta": "Free during the open beta.",
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
