import type { SiteKey } from "../en";

export const hiSite: Partial<Record<SiteKey, string>> = {
  // ── site.* (Landing) ─────────────────────────────────────────────────
  "site.header.homeAria": "CleoCuts होम",
  "site.header.openEditor": "एडिटर खोलें",

  "site.footer.editor": "एडिटर",
  "site.footer.library": "लाइब्रेरी",
  "site.footer.imprint": "इम्प्रिंट",
  "site.footer.privacy": "प्राइवेसी",
  "site.footer.terms": "शर्तें",
  "site.footer.pricing": "प्राइसिंग",

  "site.pricing.title": "आसान प्राइसिंग",
  "site.pricing.subtitle": "आप जितने मिनट का वीडियो अपलोड करते हैं, उसके लिए हर महीने पेमेंट करें। कभी भी कैंसिल करें।",
  "site.pricing.perMonth": "/ महीना",
  "site.pricing.perYear": "/ साल",
  "site.pricing.priceAtCheckout": "कीमत चेकआउट पर दिखेगी",
  "site.pricing.popular": "सबसे लोकप्रिय",
  "site.pricing.minutes": "हर महीने {minutes} मिनट का वीडियो",
  "site.pricing.retention": "प्रोजेक्ट्स {days} दिनों तक सेव रहते हैं",
  "site.pricing.featureWorkflows": "सभी वर्कफ़्लो और कैप्शन स्टाइल",
  "site.pricing.featureVoice": "वॉइस कमांड्स और AI क्लीनअप",
  "site.pricing.choose": "{plan} चुनें",
  "site.pricing.current": "आपका मौजूदा प्लान",
  "site.pricing.manage": "सब्सक्रिप्शन मैनेज करें",
  "site.pricing.switch": "{plan} पर स्विच करें",
  "site.pricing.unavailable": "अभी उपलब्ध नहीं",
  "site.pricing.redirecting": "चेकआउट खुल रहा है…",
  "site.pricing.checkoutFailed": "चेकआउट नहीं खुल पाया। कृपया थोड़ी देर में फिर कोशिश करें।",
  "site.pricing.loadFailed": "प्लान लोड नहीं हो पाए। कृपया थोड़ी देर में फिर कोशिश करें।",
  "site.pricing.minutesHint":
    "मिनट आपके अपलोड किए गए वीडियो की लंबाई के हिसाब से गिने जाते हैं। बचे हुए मिनट अगले महीने में नहीं जुड़ते।",
  "site.pricing.vatNote":
    "कीमतों में VAT शामिल है। पेमेंट Lemon Squeezy संभालता है, जो हमारा Merchant of Record है — वही आपसे पेमेंट लेता है और आपको इनवॉइस भेजता है।",
  "site.pricing.testMode": "टेस्ट मोड — कोई असली पेमेंट नहीं",
  "site.pricing.testersOnly": "प्लान अभी खरीदे नहीं जा सकते — चेकआउट टेस्ट मोड में है, सिर्फ़ आमंत्रित टेस्टर्स के लिए।",
  "site.pricing.betaTitle": "ओपन बीटा के दौरान फ़्री",
  "site.pricing.betaBody": "बीटा के दौरान CleoCuts फ़्री है। ज़्यादा मिनटों वाले पेड प्लान जल्द आ रहे हैं।",

  "library.header.homeAria": "CleoCuts एडिटर",
  "library.header.title": "लाइब्रेरी",
  "library.header.newProject": "नया प्रोजेक्ट",

  "library.count.one": "{count} प्रोजेक्ट",
  "library.count.other": "{count} प्रोजेक्ट्स",
  "library.confirmDelete": "क्या इस प्रोजेक्ट को हमेशा के लिए डिलीट करें? वीडियो और सभी एडिट्स हमारे सर्वर से हटा दिए जाएंगे।",
  "library.deleteFailed": "अभी डिलीट नहीं हो सका — अगर वीडियो अभी प्रोसेस हो रहा है, तो थोड़ी देर में फिर कोशिश करें।",

  "library.empty.title": "आपकी लाइब्रेरी खाली है",
  "library.empty.body":
    "आपका हर पूरा हुआ वीडियो यहां दिखेगा। आप इसे कभी भी फिर से डाउनलोड कर सकते हैं, अपने कैप्शन ले सकते हैं और हुक क्लिप्स शेयर कर सकते हैं।",
  "library.empty.cta": "अपना पहला प्रोजेक्ट शुरू करें",

  "library.card.playAria": "{name} का प्रीव्यू चलाएं",
  "library.card.noPreview": "कोई प्रीव्यू नहीं",
  "library.card.customPreset": "कस्टम",
  "library.card.deleteAria": "प्रोजेक्ट डिलीट करें",
  "library.card.expiresDays": "{n} दिनों में अपने-आप डिलीट होगा",
  "library.card.expiresSoon": "24 घंटों के अंदर डिलीट होगा",
  "library.card.expired": "समय समाप्त — फ़ाइलें डिलीट हो गईं",
  "library.card.hooks.one": "{count} हुक",
  "library.card.hooks.other": "{count} हुक्स",
  "library.card.hookSeconds": "{seconds}सेकंड",
  "library.card.caption": "कैप्शन",
  "library.card.copy": "कॉपी करें",
  "library.card.copied": "कॉपी हो गया",

  "library.format.primary": "मेन एडिट",
  "library.format.hook": "हुक क्लिप {n}",

  "library.time.justNow": "अभी",
  "library.time.minutesAgo": "{n} मिनट पहले",
  "library.time.hoursAgo": "{n} घंटे पहले",
  "library.time.daysAgo": "{n} दिन पहले",

  "common.videoModal.closeAria": "प्रीव्यू बंद करें",
  "common.videoModal.close": "बंद करें",
  "common.videoModal.dialogLabel": "वीडियो प्रीव्यू",

  "common.auth.signIn": "साइन इन करें",
  "common.auth.account": "अकाउंट",
  "common.auth.pricing": "प्राइसिंग",
  "common.language": "भाषा",
  "common.footer.legalAria": "कानूनी जानकारी",
  "legal.onlyDeEn":
    "यह पेज सिर्फ़ जर्मन और अंग्रेज़ी में उपलब्ध है। आप अंग्रेज़ी संस्करण पढ़ रहे हैं।",
  "common.backHome": "होम पर वापस जाएं",
  "common.notFound.title": "पेज नहीं मिला",
  "common.notFound.body": "यह पेज मौजूद नहीं है या कहीं और चला गया है।",
  "common.error.title": "कुछ गड़बड़ हो गई",
  "common.error.body": "यह पेज दिखाया नहीं जा सका। कृपया फिर से कोशिश करें।",
  "common.error.retry": "फिर कोशिश करें",
  "common.error.ref": "एरर रेफ़रेंस: {id}",
};
