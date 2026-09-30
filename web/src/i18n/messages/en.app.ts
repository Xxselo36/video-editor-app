/**
 * English strings for the /app editor flow (web/src/app/app/page.tsx).
 * Flat keys, grouped by screen. "{name}" = placeholder filled at runtime.
 * Plurals use separate …One / …Other keys.
 */
export const enApp = {
  // ── Header ──────────────────────────────────────────────────────────
  "app.header.homeAria": "CleoCuts home",
  "app.header.library": "Library",
  "app.header.beta": "Beta",
  "app.header.opening": "Opening…",

  // ── Browser notifications ───────────────────────────────────────────
  "app.notify.readyTitle": "CleoCuts — your video is ready",
  "app.notify.clickToView": "Click to view",
  "app.notify.reviewTitle": "CleoCuts — ready for your review",
  "app.notify.reviewBody": "Cuts + transcript are done. Tap to review.",

  // ── Toasts / notices ────────────────────────────────────────────────
  "app.notice.loadFailed": "Couldn't load the project right now. Please try again in a moment.",
  "app.notice.done": "This video is done — find it under Recent and in your Library.",
  "app.notice.processing": "This video is still processing. The card shows its progress.",
  "app.notice.alreadyExporting": "This video is already being exported. Its card shows the progress.",
  "app.notice.offline": "Can't reach the server. Check your internet and try again.",

  // ── Errors ──────────────────────────────────────────────────────────
  "app.errors.expired":
    "This project no longer exists on the server (expired or server update). Please upload the video again.",
  "app.errors.generic": "Something went wrong. Please try again.",
  "app.errors.connection": "The connection dropped. Check your internet and try again.",
  "app.errors.interrupted":
    "The upload was interrupted (page reloaded or app switched). Please upload the video again.",
  "app.errors.tooLarge": "The file is too large. Please trim the video or export it smaller.",
  "app.errors.noAudio": "No usable audio was found in the video.",
  "app.errors.noSpeech": "We couldn't find any speech in this video. CleoCuts cuts and captions videos where someone talks — try a clip with a voice.",
  "app.errors.noSpeechRefunded": "We couldn't find any speech in this video. CleoCuts cuts and captions videos where someone talks — try a clip with a voice. The minutes were credited back.",
  "app.errors.noAudioTrack": "This video has no sound track, so there's nothing to cut or caption. Nothing was charged.",
  "app.errors.renderFailed":
    "Rendering failed. Your edits are saved — open the project and render again.",
  "app.errors.serverNoResponse": "Server did not respond. Please try again.",
  "app.errors.serverBusy": "Our servers are busy right now. Please try again in a few minutes.",
  "app.errors.saveEditsFailed": "Couldn't save your edits — check your connection and try again.",
  "app.errors.title": "Something went wrong",
  "app.errors.tryAgain": "Try again",
  // Accounts + billing (only reachable when they are switched on)
  "app.errors.signInRequired": "Your session has ended. Please sign in again and retry.",
  "app.errors.subscriptionRequired": "Uploading needs a plan. Please choose one on the pricing page.",
  "app.errors.quotaExceeded":
    "Not enough minutes left this period for this video. Please upgrade your plan or wait for the reset.",
  "app.errors.unreadableVideo":
    "We couldn't read this video file. Please export it again as MP4 or MOV and upload it.",
  // Upload limits (413 / 429 from the backend, also checked before uploading)
  "app.errors.fileTooLarge":
    "This file is larger than {max} GB. Please trim the video or export it smaller.",
  "app.errors.videoTooLong":
    "This video is longer than {max} minutes. Please trim it or split it into parts.",
  "app.errors.tooManyJobs":
    "You already have the maximum number of videos processing. Please wait until one is ready, then try again.",

  // ── Accounts ────────────────────────────────────────────────────────
  "app.auth.signInToContinue": "Sign in to open your projects.",
  "app.auth.loadFailed":
    "Couldn't load sign-in. Check your connection (or allow this site in your content blocker) and try again.",

  // ── Billing: upload blocked (402) + minutes left ────────────────────
  "app.paywall.subscriptionTitle": "Choose a plan to upload",
  "app.paywall.subscriptionBody":
    "Uploads need an active plan. Pick one — it only takes a minute, and you can cancel any time.",
  "app.paywall.quotaTitle": "Not enough minutes left",
  "app.paywall.quotaBody": "You have {left} min left this period — this video needs {needed} min.",
  "app.paywall.quotaBodyUnknown": "This video is longer than the minutes you have left this period.",
  "app.paywall.seePlans": "See plans",
  "app.paywall.upgrade": "Upgrade plan",
  "app.paywall.close": "Not now",
  "app.billing.minutesLeft": "{n} min left this period",
  "app.billing.choosePlan": "Choose a plan to upload",

  // ── Account page (/app/account) ─────────────────────────────────────
  "app.account.title": "Account",
  "app.account.signedInAs": "Signed in as {email}",
  "app.account.plan": "Plan",
  "app.account.noPlan": "No plan yet",
  "app.account.freeBeta": "CleoCuts is free during the open beta — no plan needed.",
  "app.account.status.active": "Active · renews on {date}",
  "app.account.status.activeNoDate": "Active",
  "app.account.status.trial": "Trial · first payment on {date}",
  "app.account.status.cancelled": "Cancels on {date}",
  "app.account.status.pastDue": "Payment past due — please update your payment method.",
  "app.account.status.paused": "Paused",
  "app.account.status.expired": "Expired",
  "app.account.status.comp": "Complimentary",
  "app.account.usage": "Minutes this period",
  "app.account.usageOf": "{used} of {limit} min used",
  "app.account.resetsOn": "Resets on {date}",
  "app.account.manage": "Manage subscription",
  "app.account.manageHint": "Invoices, payment method and cancellation are handled in the Lemon Squeezy customer portal.",
  "app.account.changePlan": "Change plan",
  "app.account.choosePlan": "Choose a plan",
  "app.account.portalFailed": "Couldn't open the billing portal. Please try again in a moment.",
  "app.account.loadFailed": "Couldn't load your account right now. Please try again in a moment.",
  "app.account.testMode": "Test mode",
  "app.account.successPending": "Thanks! Your payment went through — activating your plan…",
  "app.account.successDone": "Your {plan} plan is active. Happy editing!",
  "app.account.successSlow":
    "This is taking longer than usual. Your plan will show up here within a few minutes — reload the page to check.",

  // ── Library fallbacks ───────────────────────────────────────────────
  "app.library.untitled": "Untitled",

  // ── Workflow presets ────────────────────────────────────────────────
  "app.preset.tiktok.label": "TikTok / Reels",
  "app.preset.tiktok.tagline": "Vertical short-form",
  "app.preset.tiktok.desc": "Voice-triggers, Clipper captions, auto-vertical crop",
  "app.preset.tiktok.bullet1": "Voice-triggers on: say “Cleo cut” to redo",
  "app.preset.tiktok.bullet2": "Bold Clipper-style captions",
  "app.preset.tiktok.bullet3": "Auto vertical 9:16 with face tracking",
  "app.preset.podcast.label": "Podcast Long-Form",
  "app.preset.podcast.tagline": "Full episode + clips",
  "app.preset.podcast.desc": "AI cleanup, hook detection, multi-format export",
  "app.preset.podcast.bullet1": "AI cleanup on your transcript",
  "app.preset.podcast.bullet2": "3 hook clips picked automatically",
  "app.preset.podcast.bullet3": "Full episode + 9:16 clips exported",
  "app.preset.vlog.label": "Vlog Cleanup",
  "app.preset.vlog.tagline": "Solo talking-head",
  "app.preset.vlog.desc": "Remove fillers, subtle captions, keep aspect",
  "app.preset.vlog.bullet1": "Removes “ähm”, “uh”, long pauses",
  "app.preset.vlog.bullet2": "Subtle captions that don't distract",
  "app.preset.vlog.bullet3": "Keeps your original aspect",
  "app.preset.captions.label": "Just Captions",
  "app.preset.captions.tagline": "Add captions only",
  "app.preset.captions.desc": "Burn captions on your video — no cuts, no cleanup",
  "app.preset.captions.bullet1": "Burns captions in your picked style",
  "app.preset.captions.bullet2": "No cuts, no cleanup",
  "app.preset.captions.bullet3": "Fastest — just captions",
  "app.preset.custom.label": "Custom",
  "app.preset.custom.tagline": "Configure everything",
  "app.preset.custom.desc": "Full settings — pick every knob yourself",
  "app.preset.custom.bullet1": "Every setting exposed",
  "app.preset.custom.bullet2": "Pick captions, cuts, format yourself",
  "app.preset.custom.bullet3": "For when you know what you want",

  // ── Caption styles ──────────────────────────────────────────────────
  "app.captions.clean": "Clean",
  "app.captions.classic": "Classic",
  "app.captions.clipper": "Clipper",
  "app.captions.highlight": "Highlight",
  "app.captions.flash": "Flash",
  "app.captions.punch": "Punch",
  "app.captions.elegant": "Elegant",
  "app.captions.subtle": "Subtle",
  "app.captions.none": "No captions",

  // ── Cut styles ──────────────────────────────────────────────────────
  "app.cutStyle.tight.label": "Tight",
  "app.cutStyle.tight.desc": "Aggressive",
  "app.cutStyle.balanced.label": "Balanced",
  "app.cutStyle.balanced.desc": "Default",
  "app.cutStyle.smooth.label": "Smooth",
  "app.cutStyle.smooth.desc": "Keep pauses",

  // ── Export formats ──────────────────────────────────────────────────
  "app.format.9x16.desc": "TikTok / Reels / Shorts",
  "app.format.1x1.desc": "Instagram feed",
  "app.format.16x9.desc": "YouTube / desktop",

  // ── Dashboard ───────────────────────────────────────────────────────
  "app.dashboard.workspace": "Your workspace",
  "app.dashboard.inProgressCountOne": "{count} video in progress",
  "app.dashboard.inProgressCountOther": "{count} videos in progress",
  "app.dashboard.readyCountOne": "{count} video ready to review",
  "app.dashboard.readyCountOther": "{count} videos ready to review",
  "app.dashboard.failedCountOne": "{count} video failed",
  "app.dashboard.failedCountOther": "{count} videos failed",
  "app.dashboard.readyWhenYouAre": "Ready when you are",
  "app.dashboard.newVideo": "New video",
  "app.dashboard.inProgress": "In progress",
  "app.dashboard.recentProjects": "Recent projects",
  "app.dashboard.viewAll": "View all →",
  "app.dashboard.startFirst": "Start your first video",
  "app.dashboard.startFirstSub": "Pick a workflow — CleoCuts handles captions, format, cleanup",
  "app.dashboard.voiceTeaser": "Say “Cleo” while recording — save hours of editing",

  // ── Workflow picker ─────────────────────────────────────────────────
  "app.picker.backToDashboard": "Back to dashboard",
  "app.picker.freeDuringBeta": "Free during beta",
  "app.picker.title": "What are you shipping?",
  "app.picker.subtitle":
    "Pick a workflow — CleoCuts pre-configures captions, format, and cleanup for the platform.",
  "app.picker.chipCaptions": "{style} captions",
  "app.picker.chipVoice": "\"Cleo cut\" on",
  "app.picker.customTitle": "Custom setup",
  "app.picker.customSub": "Pick every knob yourself — captions, cuts, formats",

  // ── Upload (choose a file) ──────────────────────────────────────────
  "app.upload.back": "← Back",
  "app.upload.title": "Choose a video",
  "app.upload.hint":
    "MP4 or MOV from your phone or computer. Keep this page open until the upload has finished.",
  "app.upload.tapToChoose": "Tap to choose",
  "app.upload.orDrag": "or drag one in",
  "app.upload.privacyLink": "How we handle your videos",
  "app.upload.keepTabOpen":
    "Keep this tab open until the upload finishes. Switching apps or locking your phone will cancel the upload.",
  "app.upload.resuming":
    "Resuming the upload where it stopped — keep this page open.",

  // ── Configure (custom settings) ─────────────────────────────────────
  "app.configure.back": "← back",
  "app.configure.fileInfo": "{name} · {size} MB",
  "app.configure.captionStyle": "Caption style",
  "app.configure.captionPreviewAlt": "{style} caption preview",
  "app.configure.cutStyle": "Cut style",
  "app.configure.cleanup": "Cleanup",
  "app.configure.voiceTriggers": "Listen for \"Cleo cut\" / \"Cleo go\"",
  "app.configure.voiceTriggersDesc": "Auto-removes failed takes",
  "app.configure.removeFillers": "Remove filler words",
  "app.configure.removeFillersDesc": "Cuts out \"ähm\", \"uh\", \"like\"…",
  "app.configure.smartReframe": "Smart reframe",
  "app.configure.smartcam": "SmartCam face-tracking",
  "app.configure.smartcamDesc": "Auto-reframe for vertical/horizontal output",
  "app.configure.portrait": "portrait",
  "app.configure.landscape": "landscape",
  "app.configure.portraitDesc": "Vertical 9:16",
  "app.configure.landscapeDesc": "Horizontal 16:9",
  "app.configure.extraFormats": "Extra output formats",
  "app.configure.extraFormatsHint":
    "Primary export is your SmartCam format (or original aspect). Pick extra letterbox-padded versions for other platforms.",
  "app.configure.process": "Process video",

  // ── Progress screen ─────────────────────────────────────────────────
  "app.progress.uploading": "Uploading",
  "app.progress.rendering": "Rendering",
  "app.progress.processing": "Processing",
  "app.progress.stage.prep": "Preparing your video",
  "app.progress.stage.listen": "Listening to your voice",
  "app.progress.stage.polish": "Finding the good takes",
  "app.progress.stage.preview": "Almost ready",
  "app.progress.stage.burn": "Applying your edits",
  "app.progress.stage.stitch": "Stitching it together",
  "app.progress.stage.finish": "Final touches",

  // ── Done screen ─────────────────────────────────────────────────────
  "app.done.readyToPost": "Ready to post",
  "app.done.captionSuggestion": "Caption suggestion",
  "app.done.copy": "copy",
  "app.done.downloadPrimary": "Download primary",
  "app.done.downloadFormat": "Download {format}",
  "app.done.mainEdit": "Main edit",
  "app.done.bonusClips": "Bonus clips",
  "app.done.aiPicked": "AI-picked",
  "app.done.processAnother": "Process another",

  // ── Dashboard job cards ─────────────────────────────────────────────
  "app.card.noPreview": "no preview",
  "app.card.uploading.title": "Uploading",
  "app.card.uploading.sub": "Uploading — keep this page open and don't lock your phone.",
  "app.card.analyzing.title": "Analyzing",
  "app.card.analyzing.sub": "Transcribing and cutting pauses and filler words.",
  "app.card.reviewing.title": "Ready to edit",
  "app.card.reviewing.sub": "Tap to open the editor and fine-tune the cut.",
  "app.card.rendering.title": "Rendering",
  "app.card.rendering.sub": "Putting your final video together.",
  // Waiting for a free server slot (status "processing", message "queued")
  "app.card.queued.title": "Waiting in line (#{n})",
  "app.card.queued.titleNoPos": "Waiting in line",
  "app.card.queued.sub": "Lots of videos right now — yours starts automatically. You can leave this page.",
  "app.card.open": "Open →",
  "app.card.remove": "✕ Remove",
  "app.card.renderFailedNote": "Render failed — your edits are saved. Open it and render again.",

  // ── Review (editor) ─────────────────────────────────────────────────
  "app.review.backToDashboard": "← Dashboard",
  "app.review.audioHeadsUp": "Audio heads-up",
  "app.review.updatingPreview": "Updating preview…",
  "app.review.tabTimeline": "Timeline",
  "app.review.tabTranscript": "Transcript",
  "app.review.tabCaptions": "Captions",
  "app.review.preparing": "Preparing…",
  "app.review.applyRender": "Apply & render",

  // ── Transcript tab ──────────────────────────────────────────────────
  "app.transcript.lineDeleted": "Line deleted",
  "app.transcript.undo": "↶ Undo",
  "app.transcript.headingOne": "Transcript · {count} line",
  "app.transcript.headingOther": "Transcript · {count} lines",
  "app.transcript.hint": "Fix typos, drop a line with ✕, tap a card to jump to that moment.",
  "app.transcript.empty": "No captions. Output will be video only.",
  "app.transcript.verify": "verify",
  "app.transcript.deleteSentence": "Delete sentence",

  // ── Captions tab ────────────────────────────────────────────────────
  "app.captions.styleHeading": "Caption style · {style}",
  "app.captions.appliedToOutput": "Applied to output",
  "app.captions.disabled": "Captions disabled for this render.",

  // ── Timeline editor ─────────────────────────────────────────────────
  "app.timeline.title": "Timeline",
  "app.timeline.clipsOne": "{count} clip · {dur}",
  "app.timeline.clipsOther": "{count} clips · {dur}",
  "app.timeline.saving": "saving",
  "app.timeline.saveFailedTitle":
    "The server no longer accepts changes for this video (it may be rendering or expired).",
  "app.timeline.saveRetryingTitle": "Your last change hasn't reached the server yet. Retrying…",
  "app.timeline.notSaved": "not saved",
  "app.timeline.notSavedRetrying": "not saved · retrying",
  "app.timeline.undoTitle": "Undo (⌘Z)",
  "app.timeline.undoAria": "Undo",
  "app.timeline.redoTitle": "Redo (⌘⇧Z)",
  "app.timeline.redoAria": "Redo",
  "app.timeline.splitTitle": "Split the clip under the playhead",
  "app.timeline.split": "⧉ Split",
  "app.timeline.splitUnavailable": "Move the playhead into a clip to split it (not right at its start or end).",
  "app.timeline.zoomOutTitle": "Zoom out (show more of the video)",
  "app.timeline.zoomOutAria": "Zoom out",
  "app.timeline.fitTitle": "Fit the whole video",
  "app.timeline.fit": "Fit",
  "app.timeline.zoomInTitle": "Zoom in (more detail, finer trimming)",
  "app.timeline.zoomInAria": "Zoom in",
  "app.timeline.clipLabel": "Clip {n}",
  "app.timeline.moveLeft": "Move clip left",
  "app.timeline.moveRight": "Move clip right",
  "app.timeline.deleteTitle": "Delete clip (⌫)",
  "app.timeline.delete": "✕ Delete",
  "app.timeline.speed": "Speed",
  "app.timeline.speedNormal": "1× (normal)",
  "app.timeline.volume": "Volume",
  "app.timeline.muteBadge": "M",
  "app.timeline.fadeIn": "Fade in",
  "app.timeline.fadeOut": "Fade out",
  "app.timeline.resetEffects": "Reset effects",
  // Legacy cut strip
  "app.timeline.cuts": "Cuts",
  "app.timeline.cutsRemoved": "{sec}s removed",
  "app.timeline.cutsRestored": " · {count} restored",
  "app.timeline.cutTitleRestore": "Cut {from}–{to} (tap to restore)",
  "app.timeline.cutTitleRemoveAgain": "Cut {from}–{to} (tap to remove again)",
  "app.timeline.cutsLegend": "Red = removed · tap to restore. Green dashes = kept.",

  // ── Voice commands (test modal + scene panel) ───────────────────────
  "app.voice.title": "Test your voice",
  "app.voice.subtitle": "Say the commands — see if Cleo hears you.",
  "app.voice.close": "Close",
  "app.voice.heardYou": "Heard you!",
  "app.voice.listening": "Listening…",
  "app.voice.heardPrefix": "heard: ",
  "app.voice.permissionHint": "Uses your microphone. Your browser turns your speech into text: Chrome sends it to Google for that, Safari to Apple. Nothing goes to CleoCuts.",
  "app.voice.requesting": "Requesting…",
  "app.voice.start": "Start",
  "app.voice.denied": "Permission denied. Enable in browser settings + reload.",
  "app.voice.unsupported": "Not supported in this browser. Try Safari or Chrome.",
  "app.voice.done": "Done",
  "app.voice.cmd.start": "Begin your take",
  "app.voice.cmd.cut": "Redo, discard current take",
  "app.voice.cmd.keep": "Confirm take, next scene",
  "app.voice.cmd.finish": "End video, cut everything after",
  "app.voice.cmd.stop": "Skip one bad sentence (pair with 'go')",
  "app.voice.cmd.go": "Resume after 'stop'",
  "app.voice.scene.heading": "Voice commands · {count} active",
  "app.voice.scene.hint": "Uncheck false detections, add missing ones. Cuts update automatically.",
  "app.voice.scene.add": "+ Add",
  "app.voice.scene.addAt": "Add command at current video time",
  "app.voice.scene.none": "No voice commands detected.",
  "app.voice.scene.disable": "Disable",
  "app.voice.scene.enable": "Enable",
  "app.voice.scene.heard": "heard: “{text}”",
  "app.voice.scene.type.start": "Start",
  "app.voice.scene.type.keep": "Keep",
  "app.voice.scene.type.restart": "Cut / Restart",
  "app.voice.scene.type.finish": "Finish",
  "app.crash.saving": "Saving your latest changes…",
  "app.crash.saved": "Your latest changes are saved.",
  "app.crash.unsaved": "Your latest changes may not have been saved.",
  "app.crash.body": "Reload the page to continue where you left off.",
  "app.crash.reload": "Reload page",
};
