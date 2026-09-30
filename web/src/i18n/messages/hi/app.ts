import type { AppKey } from "../en";

export const hiApp: Partial<Record<AppKey, string>> = {
  // ── Header ──────────────────────────────────────────────────────────
  "app.header.homeAria": "CleoCuts होम",
  "app.header.library": "लाइब्रेरी",
  "app.header.beta": "बीटा",
  "app.header.opening": "खुल रहा है…",

  // ── Browser notifications ───────────────────────────────────────────
  "app.notify.readyTitle": "CleoCuts — आपका वीडियो तैयार है",

  // ── Toasts / notices ────────────────────────────────────────────────
  "app.notice.loadFailed": "प्रोजेक्ट अभी लोड नहीं हो पाया। कृपया थोड़ी देर में फिर कोशिश करें।",
  "app.notice.done": "यह वीडियो तैयार है — इसे Recent में और अपनी लाइब्रेरी में देखें।",
  "app.notice.processing": "यह वीडियो अभी प्रोसेस हो रहा है। कार्ड पर प्रोग्रेस दिख रहा है।",
  "app.notice.alreadyExporting": "यह वीडियो पहले से एक्सपोर्ट हो रहा है। प्रगति उसके कार्ड पर दिखती है।",
  "app.notice.offline": "सर्वर से कनेक्ट नहीं हो पा रहा। अपना इंटरनेट चेक करके फिर कोशिश करें।",

  // ── Errors ──────────────────────────────────────────────────────────
  "app.errors.expired":
    "यह प्रोजेक्ट सर्वर पर अब मौजूद नहीं है (एक्सपायर हो गया या सर्वर अपडेट हुआ है)। कृपया वीडियो फिर से अपलोड करें।",
  "app.errors.generic": "कुछ गलत हो गया। कृपया फिर कोशिश करें।",
  "app.errors.connection": "कनेक्शन टूट गया। अपना इंटरनेट चेक करके फिर कोशिश करें।",
  "app.errors.interrupted":
    "अपलोड बीच में रुक गया (पेज रीलोड हुआ या ऐप बदला गया)। कृपया वीडियो फिर से अपलोड करें।",
  "app.errors.tooLarge": "फ़ाइल बहुत बड़ी है। कृपया वीडियो को ट्रिम करें या छोटे साइज़ में एक्सपोर्ट करें।",
  "app.errors.noAudio": "वीडियो में कोई भी काम का ऑडियो नहीं मिला।",
  "app.errors.noSpeech": "इस वीडियो में हमें कोई बोली गई बात नहीं मिली। CleoCuts ऐसे वीडियो काटता है और उनमें कैप्शन लगाता है जिनमें कोई बोल रहा हो — किसी आवाज़ वाली क्लिप के साथ आज़माएँ।",
  "app.errors.noSpeechRefunded": "इस वीडियो में हमें कोई बोली गई बात नहीं मिली। CleoCuts ऐसे वीडियो काटता है और उनमें कैप्शन लगाता है जिनमें कोई बोल रहा हो — किसी आवाज़ वाली क्लिप के साथ आज़माएँ। मिनट वापस जोड़ दिए गए हैं।",
  "app.errors.noAudioTrack": "इस वीडियो में कोई ऑडियो ट्रैक नहीं है, इसलिए काटने या कैप्शन लगाने के लिए कुछ नहीं है। कोई शुल्क नहीं लिया गया।",
  "app.errors.renderFailed":
    "रेंडर करना नाकाम रहा। आपके एडिट्स सेव हैं — प्रोजेक्ट खोलकर फिर से रेंडर करें।",
  "app.errors.serverNoResponse": "सर्वर से जवाब नहीं मिला। कृपया फिर कोशिश करें।",
  "app.errors.serverBusy": "हमारे सर्वर अभी व्यस्त हैं। कृपया कुछ मिनट बाद फिर कोशिश करें।",
  "app.errors.saveEditsFailed": "आपके एडिट्स सेव नहीं हो पाए — अपना कनेक्शन चेक करके फिर कोशिश करें।",
  "app.errors.title": "कुछ गलत हो गया",
  "app.errors.tryAgain": "फिर कोशिश करें",
  // Accounts + billing (only reachable when they are switched on)
  "app.errors.signInRequired": "आपका सेशन खत्म हो गया है। कृपया फिर से साइन इन करें और दोबारा कोशिश करें।",
  "app.errors.subscriptionRequired": "अपलोड करने के लिए प्लान चाहिए। कृपया प्राइसिंग पेज पर कोई प्लान चुनें।",
  "app.errors.quotaExceeded":
    "इस अवधि में इस वीडियो के लिए काफ़ी मिनट नहीं बचे हैं। कृपया अपना प्लान अपग्रेड करें या रीसेट होने तक इंतज़ार करें।",
  "app.errors.unreadableVideo":
    "हम यह वीडियो फ़ाइल पढ़ नहीं पाए। कृपया इसे MP4 या MOV में फिर से एक्सपोर्ट करके अपलोड करें।",
  // Upload limits (413 / 429 from the backend, also checked before uploading)
  "app.errors.fileTooLarge":
    "यह फ़ाइल {max} GB से बड़ी है। कृपया वीडियो को ट्रिम करें या छोटे साइज़ में एक्सपोर्ट करें।",
  "app.errors.videoTooLong":
    "यह वीडियो {max} मिनट से लंबा है। कृपया इसे ट्रिम करें या कुछ हिस्सों में बांट दें।",
  "app.errors.tooManyJobs":
    "आपके पहले से ही अधिकतम संख्या में वीडियो प्रोसेस हो रहे हैं। कृपया किसी एक के तैयार होने तक इंतज़ार करें, फिर कोशिश करें।",

  // ── Accounts ────────────────────────────────────────────────────────
  "app.auth.signInToContinue": "अपने प्रोजेक्ट्स खोलने के लिए साइन इन करें।",
  "app.auth.loadFailed":
    "साइन-इन लोड नहीं हो पाया। अपना कनेक्शन चेक करें (या अपने कंटेंट ब्लॉकर में इस साइट को अनुमति दें) और फिर कोशिश करें।",

  // ── Billing: upload blocked (402) + minutes left ────────────────────
  "app.paywall.subscriptionTitle": "अपलोड करने के लिए प्लान चुनें",
  "app.paywall.subscriptionBody":
    "अपलोड के लिए एक्टिव प्लान चाहिए। कोई एक चुनें — इसमें बस एक मिनट लगता है, और आप कभी भी कैंसिल कर सकते हैं।",
  "app.paywall.quotaTitle": "काफ़ी मिनट नहीं बचे",
  "app.paywall.quotaBody": "इस अवधि में आपके पास {left} मिनट बचे हैं — इस वीडियो को {needed} मिनट चाहिए।",
  "app.paywall.quotaBodyUnknown": "यह वीडियो इस अवधि में आपके बचे हुए मिनटों से लंबा है।",
  "app.paywall.seePlans": "प्लान देखें",
  "app.paywall.upgrade": "प्लान अपग्रेड करें",
  "app.paywall.close": "अभी नहीं",
  "app.billing.minutesLeft": "इस अवधि में {n} मिनट बचे",
  "app.billing.choosePlan": "अपलोड करने के लिए प्लान चुनें",

  // ── Account page (/app/account) ─────────────────────────────────────
  "app.account.title": "अकाउंट",
  "app.account.signedInAs": "{email} से साइन इन किया है",
  "app.account.plan": "प्लान",
  "app.account.noPlan": "अभी कोई प्लान नहीं",
  "app.account.freeBeta": "ओपन बीटा के दौरान CleoCuts फ़्री है — किसी प्लान की ज़रूरत नहीं।",
  "app.account.status.active": "एक्टिव · {date} को रिन्यू होगा",
  "app.account.status.activeNoDate": "एक्टिव",
  "app.account.status.trial": "ट्रायल · पहला पेमेंट {date} को",
  "app.account.status.cancelled": "{date} को खत्म होगा",
  "app.account.status.pastDue": "पेमेंट बाकी है — कृपया अपना पेमेंट मेथड अपडेट करें।",
  "app.account.status.paused": "पॉज़ किया गया",
  "app.account.status.expired": "एक्सपायर हो गया",
  "app.account.status.comp": "कॉम्प्लिमेंट्री",
  "app.account.usage": "इस अवधि के मिनट",
  "app.account.usageOf": "{limit} में से {used} मिनट इस्तेमाल हुए",
  "app.account.resetsOn": "{date} को रीसेट होगा",
  "app.account.manage": "सब्सक्रिप्शन मैनेज करें",
  "app.account.manageHint": "इनवॉइस, पेमेंट मेथड और कैंसिलेशन Lemon Squeezy कस्टमर पोर्टल में मैनेज होते हैं।",
  "app.account.changePlan": "प्लान बदलें",
  "app.account.choosePlan": "प्लान चुनें",
  "app.account.portalFailed": "बिलिंग पोर्टल नहीं खुल पाया। कृपया थोड़ी देर में फिर कोशिश करें।",
  "app.account.loadFailed": "आपका अकाउंट अभी लोड नहीं हो पाया। कृपया थोड़ी देर में फिर कोशिश करें।",
  "app.account.testMode": "टेस्ट मोड",
  "app.account.successPending": "धन्यवाद! आपका पेमेंट हो गया — आपका प्लान एक्टिव किया जा रहा है…",
  "app.account.successDone": "आपका {plan} प्लान एक्टिव है। एडिटिंग का मज़ा लें!",
  "app.account.successSlow":
    "इसमें सामान्य से ज़्यादा समय लग रहा है। आपका प्लान कुछ ही मिनटों में यहां दिखेगा — चेक करने के लिए पेज रीलोड करें।",

  // ── Library fallbacks ───────────────────────────────────────────────
  "app.library.untitled": "बिना नाम",

  // ── Workflow presets ────────────────────────────────────────────────
  "app.preset.tiktok.label": "TikTok / Reels",
  "app.preset.tiktok.tagline": "वर्टिकल शॉर्ट-फॉर्म",
  "app.preset.tiktok.desc": "वॉइस-ट्रिगर्स, Clipper कैप्शन, ऑटो-वर्टिकल क्रॉप",
  "app.preset.tiktok.bullet1": "वॉइस-ट्रिगर्स ऑन: फिर से करने के लिए “Cleo cut” बोलें",
  "app.preset.tiktok.bullet2": "बोल्ड Clipper-स्टाइल कैप्शन",
  "app.preset.tiktok.bullet3": "फेस ट्रैकिंग के साथ ऑटो वर्टिकल 9:16",
  "app.preset.podcast.label": "पॉडकास्ट लॉन्ग-फॉर्म",
  "app.preset.podcast.tagline": "पूरा एपिसोड + क्लिप्स",
  "app.preset.podcast.desc": "AI क्लीनअप, हुक डिटेक्शन, मल्टी-फॉर्मेट एक्सपोर्ट",
  "app.preset.podcast.bullet1": "आपके ट्रांसक्रिप्ट पर AI क्लीनअप",
  "app.preset.podcast.bullet2": "3 हुक क्लिप्स अपने-आप चुने गए",
  "app.preset.podcast.bullet3": "पूरा एपिसोड + 9:16 क्लिप्स एक्सपोर्ट",
  "app.preset.vlog.label": "व्लॉग क्लीनअप",
  "app.preset.vlog.tagline": "सोलो टॉकिंग-हेड",
  "app.preset.vlog.desc": "फिलर वर्ड्स हटाएं, हल्के कैप्शन, आस्पेक्ट वही रखें",
  "app.preset.vlog.bullet1": "“अं”, “मतलब”, लंबे पॉज़ हटाता है",
  "app.preset.vlog.bullet2": "हल्के कैप्शन जो ध्यान नहीं भटकाते",
  "app.preset.vlog.bullet3": "आपका ओरिजिनल आस्पेक्ट बनाए रखता है",
  "app.preset.captions.label": "सिर्फ़ कैप्शन",
  "app.preset.captions.tagline": "सिर्फ़ कैप्शन जोड़ें",
  "app.preset.captions.desc": "वीडियो पर कैप्शन बर्न करें — कोई कट नहीं, कोई क्लीनअप नहीं",
  "app.preset.captions.bullet1": "आपके चुने स्टाइल में कैप्शन बर्न करता है",
  "app.preset.captions.bullet2": "कोई कट नहीं, कोई क्लीनअप नहीं",
  "app.preset.captions.bullet3": "सबसे तेज़ — सिर्फ़ कैप्शन",
  "app.preset.custom.label": "कस्टम",
  "app.preset.custom.tagline": "सब कुछ खुद सेट करें",
  "app.preset.custom.desc": "पूरी सेटिंग्स — हर चीज़ खुद चुनें",
  "app.preset.custom.bullet1": "हर सेटिंग उपलब्ध",
  "app.preset.custom.bullet2": "कैप्शन, कट्स, फॉर्मेट खुद चुनें",
  "app.preset.custom.bullet3": "जब आपको पता हो कि आपको क्या चाहिए",

  // ── Caption styles ──────────────────────────────────────────────────
  "app.captions.clean": "Clean",
  "app.captions.classic": "Classic",
  "app.captions.clipper": "Clipper",
  "app.captions.highlight": "Highlight",
  "app.captions.flash": "Flash",
  "app.captions.punch": "Punch",
  "app.captions.elegant": "Elegant",
  "app.captions.subtle": "Subtle",
  "app.captions.none": "कोई कैप्शन नहीं",

  // ── Cut styles ──────────────────────────────────────────────────────
  "app.cutStyle.tight.label": "टाइट",
  "app.cutStyle.tight.desc": "एग्रेसिव",
  "app.cutStyle.balanced.label": "बैलेंस्ड",
  "app.cutStyle.balanced.desc": "डिफ़ॉल्ट",
  "app.cutStyle.smooth.label": "स्मूथ",
  "app.cutStyle.smooth.desc": "पॉज़ रखें",

  // ── Export formats ──────────────────────────────────────────────────
  "app.format.9x16.desc": "TikTok / Reels / Shorts",
  "app.format.1x1.desc": "Instagram फ़ीड",
  "app.format.16x9.desc": "YouTube / डेस्कटॉप",

  // ── Dashboard ───────────────────────────────────────────────────────
  "app.dashboard.workspace": "आपका वर्कस्पेस",
  "app.dashboard.inProgressCountOne": "{count} वीडियो प्रोसेस हो रहा है",
  "app.dashboard.inProgressCountOther": "{count} वीडियो प्रोसेस हो रहे हैं",
  "app.dashboard.readyCountOne": "{count} वीडियो रिव्यू के लिए तैयार",
  "app.dashboard.readyCountOther": "{count} वीडियो रिव्यू के लिए तैयार",
  "app.dashboard.failedCountOne": "{count} वीडियो फ़ेल हुआ",
  "app.dashboard.failedCountOther": "{count} वीडियो फ़ेल हुए",
  "app.dashboard.readyWhenYouAre": "जब आप तैयार हों",
  "app.dashboard.newVideo": "नया वीडियो",
  "app.dashboard.inProgress": "प्रोसेस हो रहा है",
  "app.dashboard.recentProjects": "हाल के प्रोजेक्ट्स",
  "app.dashboard.viewAll": "सभी देखें",
  "app.dashboard.startFirst": "अपना पहला वीडियो शुरू करें",
  "app.dashboard.startFirstSub": "एक वर्कफ़्लो चुनें — CleoCuts कैप्शन, फॉर्मेट और क्लीनअप खुद संभालेगा",
  "app.dashboard.voiceTeaser": "रिकॉर्डिंग के दौरान “Cleo” बोलें — एडिटिंग के घंटों बचाएं",

  // ── Workflow picker ─────────────────────────────────────────────────
  "app.picker.backToDashboard": "डैशबोर्ड पर वापस जाएं",
  "app.picker.freeDuringBeta": "बीटा के दौरान फ़्री",
  "app.picker.title": "आप क्या पोस्ट कर रहे हैं?",
  "app.picker.subtitle":
    "एक वर्कफ़्लो चुनें — CleoCuts उस प्लेटफ़ॉर्म के लिए कैप्शन, फॉर्मेट और क्लीनअप पहले से सेट कर देता है।",
  "app.picker.chipCaptions": "{style} कैप्शन",
  "app.picker.chipVoice": "\"Cleo cut\" ऑन",
  "app.picker.customTitle": "कस्टम सेटअप",
  "app.picker.customSub": "हर चीज़ खुद चुनें — कैप्शन, कट्स, फॉर्मेट",

  // ── Upload (choose a file) ──────────────────────────────────────────
  "app.upload.back": "वापस",
  "app.upload.title": "वीडियो चुनें",
  "app.upload.hint":
    "अपने फ़ोन या कंप्यूटर से MP4 या MOV। अपलोड पूरा होने तक इस पेज को खुला रखें।",
  "app.upload.tapToChoose": "चुनने के लिए टैप करें",
  "app.upload.orDrag": "या एक को यहां खींचकर लाएं",
  "app.upload.privacyLink": "हम आपके वीडियो कैसे संभालते हैं",
  "app.upload.resuming":
    "अपलोड वहीं से फिर शुरू हो रहा है जहाँ रुका था — इस पेज को खुला रखें।",

  // ── Configure (custom settings) ─────────────────────────────────────
  "app.configure.back": "वापस",
  "app.configure.fileInfo": "{name} · {size} MB",
  "app.configure.captionStyle": "कैप्शन स्टाइल",
  "app.configure.captionPreviewAlt": "{style} कैप्शन प्रीव्यू",
  "app.configure.cutStyle": "कट स्टाइल",
  "app.configure.cleanup": "क्लीनअप",
  "app.configure.voiceTriggers": "\"Cleo cut\" / \"Cleo go\" के लिए सुनें",
  "app.configure.voiceTriggersDesc": "फेल हुए टेक्स को अपने-आप हटा देता है",
  "app.configure.removeFillers": "फिलर वर्ड्स हटाएं",
  "app.configure.removeFillersDesc": "\"अं\", \"मतलब\", \"जैसे\" जैसे शब्द काटता है…",
  "app.configure.smartReframe": "स्मार्ट रीफ़्रेम",
  "app.configure.smartcam": "SmartCam फेस-ट्रैकिंग",
  "app.configure.smartcamDesc": "वर्टिकल/होरिज़ोंटल आउटपुट के लिए ऑटो-रीफ़्रेम",
  "app.configure.portrait": "पोर्ट्रेट",
  "app.configure.landscape": "लैंडस्केप",
  "app.configure.portraitDesc": "वर्टिकल 9:16",
  "app.configure.landscapeDesc": "होरिज़ोंटल 16:9",
  "app.configure.extraFormats": "अतिरिक्त आउटपुट फॉर्मेट",
  "app.configure.extraFormatsHint":
    "प्राइमरी एक्सपोर्ट आपका SmartCam फॉर्मेट है (या ओरिजिनल आस्पेक्ट)। दूसरे प्लेटफ़ॉर्म के लिए अतिरिक्त लेटरबॉक्स-पैडेड वर्शन चुनें।",
  "app.configure.process": "वीडियो प्रोसेस करें",

  // ── Done screen ─────────────────────────────────────────────────────
  "app.done.readyToPost": "पोस्ट करने के लिए तैयार",
  "app.done.captionSuggestion": "कैप्शन सुझाव",
  "app.done.copy": "कॉपी करें",
  "app.done.downloadPrimary": "प्राइमरी डाउनलोड करें",
  "app.done.downloadFormat": "{format} डाउनलोड करें",
  "app.done.mainEdit": "मेन एडिट",
  "app.done.bonusClips": "बोनस क्लिप्स",
  "app.done.aiPicked": "AI-चुना हुआ",
  "app.done.processAnother": "दूसरा वीडियो प्रोसेस करें",

  // ── Dashboard job cards ─────────────────────────────────────────────
  "app.card.noPreview": "कोई प्रीव्यू नहीं",
  "app.card.uploading.title": "अपलोड हो रहा है",
  "app.card.uploading.sub": "अपलोड हो रहा है — इस पेज को खुला रखें और फ़ोन लॉक न करें।",
  "app.card.analyzing.title": "एनालाइज़ हो रहा है",
  "app.card.analyzing.sub": "ट्रांसक्राइब हो रहा है और पॉज़ व फिलर वर्ड्स कट हो रहे हैं।",
  "app.card.reviewing.title": "एडिट के लिए तैयार",
  "app.card.reviewing.sub": "एडिटर खोलने और कट फ़ाइन-ट्यून करने के लिए टैप करें।",
  "app.card.rendering.title": "रेंडर हो रहा है",
  "app.card.rendering.sub": "आपका फ़ाइनल वीडियो तैयार किया जा रहा है।",
  // Waiting for a free server slot (status "processing", message "queued")
  "app.card.queued.title": "कतार में (#{n})",
  "app.card.queued.titleNoPos": "कतार में",
  "app.card.queued.sub":
    "अभी बहुत सारे वीडियो हैं — आपका वीडियो अपने-आप शुरू हो जाएगा। आप यह पेज छोड़ सकते हैं।",
  "app.card.open": "खोलें",
  "app.card.remove": "हटाएं",
  "app.card.renderFailedNote": "रेंडर नाकाम रहा — आपके एडिट्स सेव हैं। इसे खोलकर फिर से रेंडर करें।",

  // ── Captions tab ────────────────────────────────────────────────────
  "app.captions.styleHeading": "कैप्शन स्टाइल · {style}",
  "app.captions.appliedToOutput": "आउटपुट पर लागू",
  "app.captions.disabled": "इस रेंडर के लिए कैप्शन बंद हैं।",

  // ── Voice test (dialog) ─────────────────────────────────────────────
  "app.voice.title": "अपनी आवाज़ टेस्ट करें",
  "app.voice.subtitle": "कमांड्स बोलें — देखें कि Cleo आपको सुन रहा है या नहीं।",
  "app.voice.close": "बंद करें",
  "app.voice.heardYou": "आपको सुन लिया!",
  "app.voice.listening": "सुन रहा है…",
  "app.voice.heardPrefix": "सुना: ",
  "app.voice.permissionHint": "आपके माइक का इस्तेमाल करता है। आपकी आवाज़ को टेक्स्ट में आपका ब्राउज़र बदलता है: इसके लिए Chrome उसे Google को भेजता है, Safari Apple को। CleoCuts को कुछ नहीं भेजा जाता।",
  "app.voice.requesting": "रिक्वेस्ट भेजी जा रही है…",
  "app.voice.start": "शुरू करें",
  "app.voice.denied": "परमिशन नहीं मिली। ब्राउज़र सेटिंग्स में इनेबल करें + पेज रीलोड करें।",
  "app.voice.unsupported": "इस ब्राउज़र में सपोर्ट नहीं है। Safari या Chrome आज़माएं।",
  "app.voice.done": "पूरा हुआ",
  "app.voice.cmd.start": "अपना टेक शुरू करें",
  "app.voice.cmd.cut": "फिर से करें, मौजूदा टेक हटाएं",
  "app.voice.cmd.keep": "टेक कन्फ़र्म करें, अगली सीन",
  "app.voice.cmd.finish": "वीडियो खत्म करें, बाद का सब कुछ काटें",
  "app.voice.cmd.stop": "एक ख़राब वाक्य स्किप करें (‘go’ के साथ इस्तेमाल करें)",
  "app.voice.cmd.go": "‘stop’ के बाद फिर से शुरू करें",
  "app.crash.saving": "आपके आख़िरी बदलाव सेव हो रहे हैं…",
  "app.crash.saved": "आपके आख़िरी बदलाव सेव हो गए हैं।",
  "app.crash.unsaved": "हो सकता है आपके आख़िरी बदलाव सेव न हुए हों।",
  "app.crash.body": "जहाँ छोड़ा था वहीं से जारी रखने के लिए पेज रीलोड करें।",
  "app.crash.reload": "पेज रीलोड करें",

  // ── Error codes, warnings, stages (UX5, lib/errorKeys.ts) ────────
  "app.errors.noVideoTrack": "यह एक ऑडियो फ़ाइल है। CleoCuts को आवाज़ वाला वीडियो चाहिए — कृपया कोई वीडियो फ़ाइल चुनें। कोई शुल्क नहीं लिया गया।",
  "app.errors.videoTooShort": "यह वीडियो {min} सेकंड से छोटा है — काटने के लिए बहुत छोटा। कोई शुल्क नहीं लिया गया।",
  "app.errors.processingInterrupted": "प्रोसेसिंग बीच में रुक गई। कृपया वीडियो फिर से अपलोड करें।",
  "app.errors.mediaUnavailable": "मूल वीडियो अब उपलब्ध नहीं है, इसलिए यह प्रोजेक्ट दोबारा एडिट नहीं हो सकता।",
  "app.errors.tooManyRenders": "बहुत सारे एक्सपोर्ट चल रहे हैं। कृपया किसी एक के पूरा होने तक रुकें।",
  "app.errors.renderLimit": "इस वीडियो की आज की एक्सपोर्ट सीमा पूरी हो गई है। कृपया कल फिर कोशिश करें।",
  "app.errors.staleRev": "यह प्रोजेक्ट किसी दूसरे टैब में बदला गया है। नया वर्शन देखने के लिए पेज रीलोड करें।",
  "app.errors.docNotReady": "यह प्रोजेक्ट अभी तैयार नहीं है। कृपया थोड़ी देर में फिर कोशिश करें।",
  "app.errors.refunded": "मिनट वापस जमा कर दिए गए हैं।",
  "app.errors.tryAnotherVideo": "कोई दूसरा वीडियो आज़माएँ",
  "app.warnings.scriptUnsupported": "इस भाषा की लिपि के लिए सबटाइटल अभी उपलब्ध नहीं हैं।",
  "app.warnings.smartcamFailed": "इस वीडियो में स्पीकर ट्रैकिंग काम नहीं कर पाई, इसलिए इसे बीच से क्रॉप किया गया।",
  "app.audio.silent": "ऑडियो खामोश लग रहा है — जाँचें कि माइक चालू है और म्यूट नहीं है।",
  "app.audio.quiet": "ऑडियो बहुत धीमा है — अगली बार माइक के पास बोलें।",
  "app.audio.clipping": "ऑडियो पीक पर फट रहा है — रिकॉर्डिंग बहुत तेज़ है, आवाज़ बिगड़ सकती है।",
  "app.stage.queued": "खाली जगह का इंतज़ार",
  "app.stage.analyze.normalize": "आपका वीडियो तैयार हो रहा है",
  "app.stage.analyze.smartcam": "स्पीकर को ट्रैक किया जा रहा है",
  "app.stage.analyze.transcribe": "ट्रांसक्राइब हो रहा है",
  "app.stage.analyze.cleanup": "ट्रांसक्रिप्ट सुधारा जा रहा है",
  "app.stage.analyze.cuts": "कट ढूँढे जा रहे हैं",
  "app.stage.analyze.captions": "सबटाइटल तैयार हो रहे हैं",
  "app.stage.analyze.done": "रिव्यू के लिए तैयार",
  "app.stage.render.prepare": "एक्सपोर्ट तैयार हो रहा है",
  "app.stage.render.captions": "सबटाइटल जोड़े जा रहे हैं ({i}/{n})",
  "app.stage.render.encode": "एक्सपोर्ट हो रहा है",
  "app.stage.render.hooks": "हाइलाइट काटे जा रहे हैं",
  "app.stage.render.finish": "पूरा हो रहा है",
};
