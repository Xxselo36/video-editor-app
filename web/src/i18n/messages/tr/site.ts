import type { SiteKey } from "../en";

export const trSite: Partial<Record<SiteKey, string>> = {
  // ── site.* (Landing) ─────────────────────────────────────────────────
  "site.header.homeAria": "CleoCuts ana sayfa",
  "site.header.openEditor": "Editörü aç",

  "site.hero.badge": "Açık beta · ücretsiz",
  "site.hero.badgePricing": "Planları ve fiyatları gör",
  "site.hero.titleLead": "Kayıt yaparken",
  "site.hero.titleAccent": "düzenle.",
  "site.hero.sub":
    "Hata yaptığında {cut} de. Bittiğinde {finish} de. Altyazı ve kesimler dahil, dakikalar içinde paylaşıma hazır.",
  "site.hero.cta": "CleoCuts'ı dene",

  "site.showcase.listening": "CleoCuts dinliyor",
  "site.showcase.captionStyle": "altyazı stili",
  "site.showcase.clipper": "KONUŞMA EDİTÖRDÜR",
  "site.showcase.highlight": "PAYLAŞIMA HAZIR",
  "site.showcase.flash": "CUT DE",
  "site.showcase.punch": "MÜKEMMEL",
  "site.showcase.elegant": "Sadece dinler.",

  "site.features.title": "CleoCuts ne yapar.",
  "site.features.voice.title": "Sesli komutlar",
  "site.features.voice.body": "Çekim ortasında {cut} de. CleoCuts başarısız denemeyi kaldırır.",
  "site.features.cleanup.title": "AI temizliği",
  "site.features.cleanup.body":
    "Altyazılarındaki yanlış anlaşılan kelimeleri ve marka adlarını düzeltir.",
  "site.features.captions.title": "Animasyonlu altyazılar",
  "site.features.captions.body": "Clean'den Clipper'a birçok stil.",
  "site.features.vertical.title": "Otomatik dikey",
  "site.features.vertical.body": "Yatay → yüz takibiyle 9:16.",
  "site.features.hooks.title": "En iyi anlar, ayrı klipler olarak",
  "site.features.hooks.body":
    "90 saniye veya daha uzun videolarda CleoCuts en iyi anlardan {count} taneye kadarını bulur ve her birini ayrı bir kısa klip yapar.",

  "site.steps.title": "Üç adım.",
  "site.steps.sub": "Kaydet. CleoCuts'la konuş. Paylaş.",
  "site.steps.record.title": "Kaydet",
  "site.steps.record.body": "Hata yaptığında {cut} de. Yeniden çekim yok.",
  "site.steps.record.hint": "Her uzunlukta çekim",
  "site.steps.upload.title": "Yükle",
  "site.steps.upload.body": "Videonu bırak. Bir iş akışı seç. Gerisini AI yapar.",
  "site.steps.upload.hint": "Uzunluğa göre birkaç dakika",
  "site.steps.post.title": "Paylaş",
  "site.steps.post.body": "Bitmiş videonu indir; TikTok, Instagram ve YouTube için hazır.",
  "site.steps.post.hint": "Hazır olduğunda indir",

  "site.footer.editor": "Editör",
  "site.footer.library": "Kütüphane",
  "site.footer.imprint": "Yasal bilgiler",
  "site.footer.privacy": "Gizlilik",
  "site.footer.terms": "Koşullar",
  "site.footer.pricing": "Fiyatlandırma",

  /* ── Pricing page ── */
  "site.pricing.title": "Basit fiyatlandırma",
  "site.pricing.subtitle": "Yüklediğin video dakikaları için aylık öde. İstediğin zaman iptal et.",
  "site.pricing.perMonth": "/ ay",
  "site.pricing.perYear": "/ yıl",
  "site.pricing.priceAtCheckout": "Fiyat ödeme sırasında gösterilir",
  "site.pricing.popular": "En popüler",
  "site.pricing.minutes": "Ayda {minutes} dk video",
  "site.pricing.retention": "Projeler {days} gün saklanır",
  "site.pricing.featureWorkflows": "Tüm iş akışları ve altyazı stilleri",
  "site.pricing.featureVoice": "Sesli komutlar ve AI temizliği",
  "site.pricing.choose": "{plan} seç",
  "site.pricing.current": "Mevcut planın",
  "site.pricing.manage": "Aboneliği yönet",
  "site.pricing.switch": "{plan} planına geç",
  "site.pricing.unavailable": "Henüz mevcut değil",
  "site.pricing.redirecting": "Ödeme sayfası açılıyor…",
  "site.pricing.checkoutFailed": "Ödeme sayfası açılamadı. Lütfen birazdan tekrar dene.",
  "site.pricing.loadFailed": "Planlar yüklenemedi. Lütfen birazdan tekrar dene.",
  "site.pricing.minutesHint":
    "Dakikalar, yüklediğin videoların uzunluğuna göre sayılır. Kullanılmayan dakikalar sonraki aya devretmez.",
  "site.pricing.vatNote":
    "Fiyatlara KDV dahildir. Ödemeler, satıcı kaydımız (Merchant of Record) Lemon Squeezy üzerinden yapılır — ücreti onlar tahsil eder ve faturalarını onlar gönderir.",
  "site.pricing.testMode": "Test modu — gerçek ödeme yok",
  "site.pricing.testersOnly": "Planlar henüz satın alınamıyor — ödeme test modunda, yalnızca davetli test kullanıcıları için.",
  "site.pricing.betaTitle": "Açık beta boyunca ücretsiz",
  "site.pricing.betaBody":
    "CleoCuts beta sürecinde ücretsiz. Daha fazla dakika sunan ücretli planlar yakında geliyor.",

  "library.header.homeAria": "CleoCuts editörü",
  "library.header.title": "Kütüphane",
  "library.header.newProject": "Yeni proje",

  "library.count.one": "{count} proje",
  "library.count.other": "{count} proje",
  "library.confirmDelete": "Bu proje kalıcı olarak silinsin mi? Video ve tüm düzenlemeler sunucularımızdan kaldırılır.",
  "library.deleteFailed": "Şu anda silinemedi — video hâlâ işleniyorsa birazdan tekrar dene.",

  "library.empty.title": "Kütüphanen boş",
  "library.empty.body":
    "Bitirdiğin her video burada görünür. İstediğin zaman yeniden indirebilir, altyazılarını alabilir ve hook kliplerini paylaşabilirsin.",
  "library.empty.cta": "İlk projeni başlat",

  "library.card.playAria": "{name} önizlemesini oynat",
  "library.card.noPreview": "önizleme yok",
  "library.card.customPreset": "Özel",
  "library.card.deleteAria": "Projeyi sil",
  "library.card.expiresDays": "{n} gün içinde otomatik silinecek",
  "library.card.expiresSoon": "24 saat içinde silinecek",
  "library.card.expired": "Süresi doldu — dosyalar silindi",
  "library.card.hooks.one": "{count} hook",
  "library.card.hooks.other": "{count} hook",
  "library.card.hookSeconds": "{seconds}sn",
  "library.card.caption": "Açıklama",
  "library.card.copy": "kopyala",
  "library.card.copied": "kopyalandı",

  "library.format.primary": "Ana kurgu",
  "library.format.hook": "Hook klip {n}",

  "library.time.justNow": "az önce",
  "library.time.minutesAgo": "{n}dk önce",
  "library.time.hoursAgo": "{n}sa önce",
  "library.time.daysAgo": "{n}g önce",

  "common.videoModal.closeAria": "Önizlemeyi kapat",
  "common.videoModal.close": "Kapat",
  "common.videoModal.dialogLabel": "Video önizlemesi",
  "common.auth.signIn": "Giriş yap",
  "common.auth.account": "Hesap",
  "common.auth.pricing": "Fiyatlandırma",
  "common.language": "Dil",
  "common.footer.legalAria": "Yasal bilgiler",
  "legal.onlyDeEn":
    "Bu sayfa yalnızca Almanca ve İngilizce olarak mevcut. İngilizce sürümünü okuyorsun.",
  "common.backHome": "Ana sayfaya dön",
  "common.notFound.title": "Sayfa bulunamadı",
  "common.notFound.body": "Bu sayfa yok ya da taşındı.",
  "common.error.title": "Bir şeyler ters gitti",
  "common.error.body": "Bu sayfa gösterilemedi. Lütfen tekrar dene.",
  "common.error.retry": "Tekrar dene",
  "common.error.ref": "Hata referansı: {id}",
};
