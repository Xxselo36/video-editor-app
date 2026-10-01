import type { SiteKey } from "../en";

export const idSite: Partial<Record<SiteKey, string>> = {
  // ── site.* (Landing) ─────────────────────────────────────────────────
  "site.header.homeAria": "Beranda CleoCuts",
  "site.header.openEditor": "Buka editor",

  "site.hero.badge": "Beta terbuka · gratis",
  "site.hero.badgePricing": "Lihat paket & harga",
  "site.hero.titleLead": "Edit sambil kamu",
  "site.hero.titleAccent": "merekam.",
  "site.hero.sub":
    "Bilang {cut} kalau kamu salah ngomong. Bilang {finish} kalau sudah selesai. Siap diposting dalam hitungan menit, lengkap dengan teks dan potongan.",
  "site.hero.cta": "Coba CleoCuts",

  "site.showcase.listening": "CleoCuts mendengarkan",
  "site.showcase.captionStyle": "gaya teks",
  "site.showcase.clipper": "SUARAMU JADI EDITOR",
  "site.showcase.highlight": "SIAP POSTING",
  "site.showcase.flash": "BILANG CUT",
  "site.showcase.punch": "SEMPURNA",
  "site.showcase.elegant": "Cuma mendengarkan.",

  "site.features.title": "Apa yang CleoCuts bisa lakukan.",
  "site.features.voice.title": "Pemicu suara",
  "site.features.voice.body": "Bilang {cut} di tengah take. CleoCuts menghapus percobaan yang gagal.",
  "site.features.cleanup.title": "Pembersihan AI",
  "site.features.cleanup.body": "Memperbaiki kata yang salah dengar dan nama brand di teksmu.",
  "site.features.captions.title": "Teks animasi",
  "site.features.captions.body": "Beberapa gaya, dari Clean sampai Clipper.",
  "site.features.vertical.title": "Otomatis vertikal",
  "site.features.vertical.body": "Lanskap → 9:16 dengan pelacakan wajah.",
  "site.features.hooks.title": "Momen terbaik jadi klip",
  "site.features.hooks.body":
    "Untuk video 90 detik atau lebih, CleoCuts menemukan hingga {count} momen terbaik dan memotong masing-masing jadi klip pendek tersendiri.",

  "site.steps.title": "Tiga langkah.",
  "site.steps.sub": "Rekam. Ngobrol sama CleoCuts. Posting.",
  "site.steps.record.title": "Rekam",
  "site.steps.record.body": "Bilang {cut} kalau kamu salah ngomong. Tanpa perlu ulang rekam.",
  "site.steps.record.hint": "Take berapa lama pun boleh",
  "site.steps.upload.title": "Unggah",
  "site.steps.upload.body": "Masukkan videomu. Pilih workflow. Sisanya biar AI yang urus.",
  "site.steps.upload.hint": "Beberapa menit, tergantung durasinya",
  "site.steps.post.title": "Posting",
  "site.steps.post.body": "Unduh video jadimu, siap untuk TikTok, Instagram, dan YouTube.",
  "site.steps.post.hint": "Unduh kalau sudah siap",

  "site.footer.editor": "Editor",
  "site.footer.library": "Perpustakaan",
  "site.footer.imprint": "Imprint",
  "site.footer.privacy": "Privasi",
  "site.footer.terms": "Ketentuan",
  "site.footer.pricing": "Harga",

  /* ── Pricing page ── */
  "site.pricing.title": "Harga yang simpel",
  "site.pricing.subtitle": "Bayar bulanan sesuai menit video yang kamu unggah. Bisa berhenti kapan saja.",
  "site.pricing.perMonth": "/ bulan",
  "site.pricing.perYear": "/ tahun",
  "site.pricing.priceAtCheckout": "Harga ditampilkan saat checkout",
  "site.pricing.popular": "Paling populer",
  "site.pricing.minutes": "{minutes} menit video per bulan",
  "site.pricing.retention": "Proyek disimpan selama {days} hari",
  "site.pricing.featureWorkflows": "Semua workflow dan gaya teks",
  "site.pricing.featureVoice": "Perintah suara dan pembersihan AI",
  "site.pricing.choose": "Pilih {plan}",
  "site.pricing.current": "Paketmu saat ini",
  "site.pricing.manage": "Kelola langganan",
  "site.pricing.switch": "Ganti ke {plan}",
  "site.pricing.unavailable": "Belum tersedia",
  "site.pricing.redirecting": "Membuka checkout…",
  "site.pricing.checkoutFailed": "Checkout tidak bisa dibuka. Coba lagi sebentar lagi.",
  "site.pricing.loadFailed": "Paket tidak bisa dimuat. Coba lagi sebentar lagi.",
  "site.pricing.minutesHint":
    "Menit dihitung dari durasi video yang kamu unggah. Menit yang tidak terpakai tidak terbawa ke bulan berikutnya.",
  "site.pricing.vatNote":
    "Harga sudah termasuk PPN. Pembayaran diurus oleh Lemon Squeezy, Merchant of Record kami — mereka yang menagihmu dan mengirim fakturmu.",
  "site.pricing.testMode": "Mode tes — tanpa pembayaran sungguhan",
  "site.pricing.testersOnly": "Paket belum bisa dibeli — checkout masih dalam mode tes, khusus penguji undangan.",
  "site.pricing.betaTitle": "Gratis selama beta terbuka",
  "site.pricing.betaBody": "CleoCuts gratis selama masih beta. Paket berbayar dengan lebih banyak menit segera hadir.",

  "library.header.homeAria": "Editor CleoCuts",
  "library.header.title": "Perpustakaan",
  "library.header.newProject": "Proyek baru",

  "library.count.one": "{count} proyek",
  "library.count.other": "{count} proyek",
  "library.confirmDelete": "Hapus proyek ini secara permanen? Video dan semua editan akan dihapus dari server kami.",
  "library.deleteFailed": "Belum bisa dihapus — kalau video masih diproses, coba lagi sebentar lagi.",

  "library.empty.title": "Perpustakaanmu masih kosong",
  "library.empty.body":
    "Setiap video yang kamu selesaikan akan muncul di sini. Kamu bisa unduh lagi, ambil teksnya, dan bagikan klip hook kapan pun.",
  "library.empty.cta": "Mulai proyek pertamamu",

  "library.card.playAria": "Putar pratinjau {name}",
  "library.card.noPreview": "tidak ada pratinjau",
  "library.card.customPreset": "Kustom",
  "library.card.deleteAria": "Hapus proyek",
  "library.card.expiresDays": "Terhapus otomatis dalam {n} hari",
  "library.card.expiresSoon": "Terhapus dalam 24 jam",
  "library.card.expired": "Kedaluwarsa — file sudah dihapus",
  "library.card.hooks.one": "{count} hook",
  "library.card.hooks.other": "{count} hook",
  "library.card.hookSeconds": "{seconds}dtk",
  "library.card.caption": "Caption",
  "library.card.copy": "salin",
  "library.card.copied": "disalin",

  "library.format.primary": "Edit utama",
  "library.format.hook": "Klip hook {n}",

  "library.time.justNow": "baru saja",
  "library.time.minutesAgo": "{n}m lalu",
  "library.time.hoursAgo": "{n}j lalu",
  "library.time.daysAgo": "{n}h lalu",

  "common.videoModal.closeAria": "Tutup pratinjau",
  "common.videoModal.close": "Tutup",
  "common.videoModal.dialogLabel": "Pratinjau video",

  /* ── Accounts (header, all pages) ── */
  "common.auth.signIn": "Masuk",
  "common.auth.account": "Akun",
  "common.auth.pricing": "Harga",
  "common.language": "Bahasa",
  "common.footer.legalAria": "Informasi hukum",
  "legal.onlyDeEn":
    "Halaman ini hanya tersedia dalam bahasa Jerman dan Inggris. Kamu sedang membaca versi bahasa Inggris.",
  "common.backHome": "Kembali ke beranda",
  "common.notFound.title": "Halaman tidak ditemukan",
  "common.notFound.body": "Halaman ini tidak ada atau sudah dipindahkan.",
  "common.error.title": "Terjadi kesalahan",
  "common.error.body": "Halaman ini tidak bisa ditampilkan. Coba lagi.",
  "common.error.retry": "Coba lagi",
  "common.error.ref": "Referensi error: {id}",
};
