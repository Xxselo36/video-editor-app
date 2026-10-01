import type { AppKey } from "../en";

export const idApp: Partial<Record<AppKey, string>> = {
  // ── Header ──────────────────────────────────────────────────────────
  "app.header.homeAria": "Beranda CleoCuts",
  "app.header.library": "Perpustakaan",
  "app.header.beta": "Beta",
  "app.header.opening": "Membuka…",

  // ── Browser notifications ───────────────────────────────────────────
  "app.notify.readyTitle": "CleoCuts — videomu sudah siap",

  // ── Toasts / notices ────────────────────────────────────────────────
  "app.notice.loadFailed": "Proyek tidak bisa dimuat sekarang. Coba lagi sebentar lagi.",
  "app.notice.alreadyExporting": "Video ini sudah sedang diekspor. Kartunya menampilkan progresnya.",
  "app.notice.offline": "Tidak bisa terhubung ke server. Cek internetmu dan coba lagi.",

  // ── Errors ──────────────────────────────────────────────────────────
  "app.errors.expired":
    "Proyek ini sudah tidak ada di server (kedaluwarsa atau ada update server). Silakan unggah videonya lagi.",
  "app.errors.generic": "Ada yang salah. Coba lagi.",
  "app.errors.connection": "Koneksi terputus. Cek internetmu dan coba lagi.",
  "app.errors.interrupted":
    "Unggahan terputus (halaman dimuat ulang atau ganti aplikasi). Silakan unggah videonya lagi.",
  "app.errors.tooLarge": "Filenya terlalu besar. Potong videonya atau ekspor dengan ukuran lebih kecil.",
  "app.errors.noSpeech": "Kami tidak menemukan ucapan di video ini. CleoCuts memotong dan memberi teks video yang berisi orang berbicara — coba klip yang ada suaranya.",
  "app.errors.noSpeechRefunded": "Kami tidak menemukan ucapan di video ini. CleoCuts memotong dan memberi teks video yang berisi orang berbicara — coba klip yang ada suaranya. Menitnya sudah dikembalikan.",
  "app.errors.noAudioTrack": "Video ini tidak punya trek audio, jadi tidak ada yang bisa dipotong atau diberi teks. Tidak ada biaya yang dikenakan.",
  "app.errors.renderFailed":
    "Rendering gagal. Editanmu sudah tersimpan — buka proyeknya dan render lagi.",
  "app.errors.serverNoResponse": "Server tidak merespons. Coba lagi.",
  "app.errors.serverBusy": "Server kami sedang sibuk. Coba lagi dalam beberapa menit.",
  "app.errors.saveEditsFailed": "Editanmu tidak bisa disimpan — cek koneksimu dan coba lagi.",
  "app.errors.title": "Ada yang salah",
  "app.errors.tryAgain": "Coba lagi",
  // Accounts + billing (only reachable when they are switched on)
  "app.errors.signInRequired": "Sesimu sudah berakhir. Silakan masuk lagi dan coba ulang.",
  "app.errors.subscriptionRequired": "Untuk mengunggah, kamu perlu paket. Pilih salah satu di halaman harga.",
  "app.errors.quotaExceeded":
    "Sisa menitmu di periode ini tidak cukup untuk video ini. Upgrade paketmu atau tunggu sampai kuotanya direset.",
  "app.errors.unreadableVideo":
    "Kami tidak bisa membaca file video ini. Ekspor ulang sebagai MP4 atau MOV, lalu unggah lagi.",
  // Upload limits (413 / 429 from the backend, also checked before uploading)
  "app.errors.fileTooLarge":
    "File ini lebih dari {max} GB. Potong videonya atau ekspor dengan ukuran lebih kecil.",
  "app.errors.videoTooLong":
    "Video ini lebih dari {max} menit. Potong videonya atau bagi menjadi beberapa bagian.",
  "app.errors.tooManyJobs":
    "Kamu sudah mencapai batas maksimum video yang sedang diproses. Tunggu sampai salah satunya selesai, lalu coba lagi.",

  // ── Accounts ────────────────────────────────────────────────────────
  "app.auth.signInToContinue": "Masuk untuk membuka proyekmu.",
  "app.auth.loadFailed":
    "Halaman masuk tidak bisa dimuat. Cek koneksimu (atau izinkan situs ini di pemblokir kontenmu) dan coba lagi.",

  // ── Billing: upload blocked (402) + minutes left ────────────────────
  "app.paywall.subscriptionTitle": "Pilih paket untuk mengunggah",
  "app.paywall.subscriptionBody":
    "Unggahan butuh paket aktif. Pilih salah satu — cuma butuh semenit, dan bisa dibatalkan kapan saja.",
  "app.paywall.quotaTitle": "Sisa menit tidak cukup",
  "app.paywall.quotaBody": "Sisa menitmu di periode ini tinggal {left} menit — video ini butuh {needed} menit.",
  "app.paywall.quotaBodyUnknown": "Video ini lebih panjang dari sisa menitmu di periode ini.",
  "app.paywall.seePlans": "Lihat paket",
  "app.paywall.upgrade": "Upgrade paket",
  "app.paywall.close": "Nanti saja",
  "app.billing.minutesLeft": "Sisa {n} menit di periode ini",
  "app.billing.choosePlan": "Pilih paket untuk mengunggah",

  // ── Account page (/app/account) ─────────────────────────────────────
  "app.account.title": "Akun",
  "app.account.signedInAs": "Masuk sebagai {email}",
  "app.account.plan": "Paket",
  "app.account.noPlan": "Belum ada paket",
  "app.account.freeBeta": "CleoCuts gratis selama beta terbuka — tidak perlu paket.",
  "app.account.status.active": "Aktif · diperpanjang pada {date}",
  "app.account.status.activeNoDate": "Aktif",
  "app.account.status.trial": "Uji coba · pembayaran pertama pada {date}",
  "app.account.status.cancelled": "Berakhir pada {date}",
  "app.account.status.pastDue": "Pembayaran terlambat — perbarui metode pembayaranmu.",
  "app.account.status.paused": "Dijeda",
  "app.account.status.expired": "Kedaluwarsa",
  "app.account.status.comp": "Gratis",
  "app.account.usage": "Menit di periode ini",
  "app.account.usageOf": "{used} dari {limit} menit terpakai",
  "app.account.resetsOn": "Direset pada {date}",
  "app.account.manage": "Kelola langganan",
  "app.account.manageHint": "Faktur, metode pembayaran, dan pembatalan diurus di portal pelanggan Lemon Squeezy.",
  "app.account.changePlan": "Ganti paket",
  "app.account.choosePlan": "Pilih paket",
  "app.account.portalFailed": "Portal tagihan tidak bisa dibuka. Coba lagi sebentar lagi.",
  "app.account.loadFailed": "Akunmu tidak bisa dimuat sekarang. Coba lagi sebentar lagi.",
  "app.account.testMode": "Mode tes",
  "app.account.successPending": "Terima kasih! Pembayaranmu berhasil — paketmu sedang diaktifkan…",
  "app.account.successDone": "Paket {plan} kamu sudah aktif. Selamat mengedit!",
  "app.account.successSlow":
    "Prosesnya lebih lama dari biasanya. Paketmu akan muncul di sini dalam beberapa menit — muat ulang halaman untuk mengecek.",

  // ── Library fallbacks ───────────────────────────────────────────────
  "app.library.untitled": "Tanpa judul",

  // ── Workflow presets ────────────────────────────────────────────────
  "app.preset.tiktok.label": "TikTok / Reels",
  "app.preset.tiktok.tagline": "Vertikal, format pendek",
  "app.preset.tiktok.desc": "Pemicu suara, teks Clipper, auto-crop vertikal",
  "app.preset.tiktok.bullet1": "Pemicu suara aktif: bilang “Cleo cut” untuk ulang",
  "app.preset.tiktok.bullet2": "Teks tebal gaya Clipper",
  "app.preset.tiktok.bullet3": "Otomatis vertikal 9:16 dengan pelacakan wajah",
  "app.preset.podcast.label": "Podcast Durasi Panjang",
  "app.preset.podcast.tagline": "Episode penuh + klip",
  "app.preset.podcast.desc": "Pembersihan AI, deteksi hook, ekspor multi-format",
  "app.preset.podcast.bullet1": "Pembersihan AI pada transkripmu",
  "app.preset.podcast.bullet2": "3 klip hook dipilih otomatis",
  "app.preset.podcast.bullet3": "Episode penuh + klip 9:16 diekspor",
  "app.preset.vlog.label": "Pembersihan Vlog",
  "app.preset.vlog.tagline": "Solo talking-head",
  "app.preset.vlog.desc": "Hapus kata pengisi, teks halus, aspek tetap sama",
  "app.preset.vlog.bullet1": "Menghapus “eh”, “anu”, jeda panjang",
  "app.preset.vlog.bullet2": "Teks halus yang tidak mengganggu",
  "app.preset.vlog.bullet3": "Aspek rasio asli tetap dipakai",
  "app.preset.captions.label": "Cuma Teks",
  "app.preset.captions.tagline": "Tambah teks saja",
  "app.preset.captions.desc": "Bakar teks ke videomu — tanpa potongan, tanpa pembersihan",
  "app.preset.captions.bullet1": "Membakar teks dengan gaya pilihanmu",
  "app.preset.captions.bullet2": "Tanpa potongan, tanpa pembersihan",
  "app.preset.captions.bullet3": "Paling cepat — cuma teks",
  "app.preset.custom.label": "Kustom",
  "app.preset.custom.tagline": "Atur semuanya",
  "app.preset.custom.desc": "Semua pengaturan — pilih tiap detail sendiri",
  "app.preset.custom.bullet1": "Semua pengaturan terbuka",
  "app.preset.custom.bullet2": "Pilih teks, potongan, format sendiri",
  "app.preset.custom.bullet3": "Buat yang sudah tahu apa yang diinginkan",

  // ── Caption styles ──────────────────────────────────────────────────
  "app.captions.clean": "Clean",
  "app.captions.classic": "Classic",
  "app.captions.clipper": "Clipper",
  "app.captions.highlight": "Highlight",
  "app.captions.flash": "Flash",
  "app.captions.punch": "Punch",
  "app.captions.elegant": "Elegant",
  "app.captions.subtle": "Subtle",
  "app.captions.none": "Tanpa teks",

  // ── Cut styles ──────────────────────────────────────────────────────
  "app.cutStyle.tight.label": "Ketat",
  "app.cutStyle.tight.desc": "Agresif",
  "app.cutStyle.balanced.label": "Seimbang",
  "app.cutStyle.balanced.desc": "Default",
  "app.cutStyle.smooth.label": "Halus",
  "app.cutStyle.smooth.desc": "Simpan jeda",

  // ── Export formats ──────────────────────────────────────────────────
  "app.format.9x16.desc": "TikTok / Reels / Shorts",
  "app.format.1x1.desc": "Feed Instagram",
  "app.format.16x9.desc": "YouTube / desktop",

  // ── Dashboard ───────────────────────────────────────────────────────
  "app.dashboard.workspace": "Ruang kerjamu",
  "app.dashboard.inProgressCountOne": "{count} video sedang diproses",
  "app.dashboard.inProgressCountOther": "{count} video sedang diproses",
  "app.dashboard.readyCountOne": "{count} video siap ditinjau",
  "app.dashboard.readyCountOther": "{count} video siap ditinjau",
  "app.dashboard.failedCountOne": "{count} video gagal",
  "app.dashboard.failedCountOther": "{count} video gagal",
  "app.dashboard.readyWhenYouAre": "Siap kapan pun kamu siap",
  "app.dashboard.newVideo": "Video baru",
  "app.dashboard.inProgress": "Sedang diproses",
  "app.dashboard.recentProjects": "Proyek terbaru",
  "app.dashboard.viewAll": "Lihat semua",
  "app.dashboard.startFirst": "Mulai video pertamamu",
  "app.dashboard.startFirstSub": "Pilih workflow — CleoCuts yang urus teks, format, dan pembersihan",
  "app.dashboard.voiceTeaser": "Bilang “Cleo” saat merekam — hemat berjam-jam waktu edit",

  // ── Workflow picker ─────────────────────────────────────────────────
  "app.picker.backToDashboard": "Kembali ke dashboard",
  "app.picker.freeDuringBeta": "Gratis selama beta",
  "app.picker.title": "Kamu mau posting apa?",
  "app.picker.subtitle":
    "Pilih workflow — CleoCuts mengatur teks, format, dan pembersihan sesuai platformnya.",
  "app.picker.chipCaptions": "Teks {style}",
  "app.picker.chipVoice": "\"Cleo cut\" aktif",
  "app.picker.customTitle": "Setup kustom",
  "app.picker.customSub": "Pilih tiap detail sendiri — teks, potongan, format",

  // ── Upload (choose a file) ──────────────────────────────────────────
  "app.upload.back": "Kembali",
  "app.upload.title": "Pilih video",
  "app.upload.hint":
    "MP4 atau MOV dari HP atau komputermu. Biarkan halaman ini terbuka sampai unggahan selesai.",
  "app.upload.tapToChoose": "Ketuk untuk memilih",
  "app.upload.orDrag": "atau seret satu ke sini",
  "app.upload.privacyLink": "Cara kami menangani videomu",
  "app.upload.resuming":
    "Melanjutkan unggahan dari titik terakhirnya — biarkan halaman ini terbuka.",

  // ── Configure (custom settings) ─────────────────────────────────────
  "app.configure.back": "kembali",
  "app.configure.fileInfo": "{name} · {size} MB",
  "app.configure.captionStyle": "Gaya teks",
  "app.configure.captionPreviewAlt": "Pratinjau teks {style}",
  "app.configure.cutStyle": "Gaya potongan",
  "app.configure.cleanup": "Pembersihan",
  "app.configure.voiceTriggers": "Dengarkan \"Cleo cut\" / \"Cleo go\"",
  "app.configure.voiceTriggersDesc": "Otomatis menghapus take yang gagal",
  "app.configure.removeFillers": "Hapus kata pengisi",
  "app.configure.removeFillersDesc": "Memotong \"eh\", \"anu\", \"kayak\"…",
  "app.configure.smartReframe": "Smart reframe",
  "app.configure.smartcam": "SmartCam pelacakan wajah",
  "app.configure.smartcamDesc": "Auto-reframe untuk output vertikal/horizontal",
  "app.configure.portrait": "potret",
  "app.configure.landscape": "lanskap",
  "app.configure.portraitDesc": "Vertikal 9:16",
  "app.configure.landscapeDesc": "Horizontal 16:9",
  "app.configure.extraFormats": "Format output tambahan",
  "app.configure.extraFormatsHint":
    "Ekspor utama memakai format SmartCam-mu (atau aspek aslinya). Pilih versi letterbox tambahan untuk platform lain.",
  "app.configure.process": "Proses video",

  // ── Done screen ─────────────────────────────────────────────────────
  "app.done.readyToPost": "Siap diposting",
  "app.done.captionSuggestion": "Saran caption",
  "app.done.copy": "salin",
  "app.done.downloadPrimary": "Unduh versi utama",
  "app.done.downloadFormat": "Unduh {format}",
  "app.done.mainEdit": "Edit utama",
  "app.done.bonusClips": "Klip bonus",
  "app.done.aiPicked": "Dipilih AI",
  "app.done.processAnother": "Proses video lain",

  // ── Dashboard job cards ─────────────────────────────────────────────
  "app.card.noPreview": "tidak ada pratinjau",
  "app.card.uploading.title": "Mengunggah",
  "app.card.uploading.sub": "Sedang mengunggah — biarkan halaman ini terbuka dan jangan kunci HP-mu.",
  "app.card.analyzing.title": "Menganalisis",
  "app.card.analyzing.sub": "Mentranskrip dan memotong jeda serta kata pengisi.",
  "app.card.reviewing.title": "Siap diedit",
  "app.card.reviewing.sub": "Ketuk untuk membuka editor dan menyempurnakan potongannya.",
  "app.card.rendering.title": "Merender",
  "app.card.rendering.sub": "Menyatukan video akhirmu.",
  // Waiting for a free server slot (status "processing", message "queued")
  "app.card.queued.title": "Dalam antrean (#{n})",
  "app.card.queued.titleNoPos": "Dalam antrean",
  "app.card.queued.sub":
    "Sedang banyak video — videomu akan mulai otomatis. Kamu bisa meninggalkan halaman ini.",
  "app.card.open": "Buka",
  "app.card.remove": "Hapus",
  "app.card.renderFailedNote": "Rendering gagal — editanmu sudah tersimpan. Buka dan render lagi.",

  // ── Captions tab ────────────────────────────────────────────────────
  "app.captions.styleHeading": "Gaya teks · {style}",
  "app.captions.appliedToOutput": "Diterapkan ke output",
  "app.captions.disabled": "Teks dinonaktifkan untuk render ini.",

  // ── Voice test (dialog) ─────────────────────────────────────────────
  "app.voice.title": "Tes suaramu",
  "app.voice.subtitle": "Ucapkan perintahnya — lihat apakah Cleo mendengarmu.",
  "app.voice.close": "Tutup",
  "app.voice.heardYou": "Kedengaran!",
  "app.voice.listening": "Mendengarkan…",
  "app.voice.heardPrefix": "terdengar: ",
  "app.voice.permissionHint": "Memakai mikrofonmu. Browser-mu mengubah suaramu jadi teks: Chrome mengirimnya ke Google untuk itu, Safari ke Apple. Tidak ada yang dikirim ke CleoCuts.",
  "app.voice.requesting": "Meminta izin…",
  "app.voice.start": "Mulai",
  "app.voice.denied": "Izin ditolak. Aktifkan di pengaturan browser + muat ulang.",
  "app.voice.unsupported": "Tidak didukung di browser ini. Coba Safari atau Chrome.",
  "app.voice.done": "Selesai",
  "app.voice.cmd.start": "Mulai take-mu",
  "app.voice.cmd.cut": "Ulang, buang take saat ini",
  "app.voice.cmd.keep": "Konfirmasi take, lanjut ke scene berikutnya",
  "app.voice.cmd.finish": "Akhiri video, potong semua setelah ini",
  "app.voice.cmd.stop": "Lewati satu kalimat yang salah (dipasangkan dengan 'go')",
  "app.voice.cmd.go": "Lanjutkan setelah 'stop'",
  "app.crash.saving": "Menyimpan perubahan terakhirmu…",
  "app.crash.saved": "Perubahan terakhirmu sudah tersimpan.",
  "app.crash.unsaved": "Perubahan terakhirmu mungkin belum tersimpan.",
  "app.crash.body": "Muat ulang halaman untuk melanjutkan dari posisi terakhirmu.",
  "app.crash.reload": "Muat ulang halaman",

  // ── Error codes, warnings, stages (UX5, lib/errorKeys.ts) ────────
  "app.errors.noVideoTrack": "Ini file audio. CleoCuts memerlukan video bersuara — pilih file video. Tidak ada yang ditagih.",
  "app.errors.videoTooShort": "Video ini lebih pendek dari {min} detik — terlalu pendek untuk dipotong. Tidak ada yang ditagih.",
  "app.errors.processingInterrupted": "Pemrosesan terputus. Unggah video lagi.",
  "app.errors.mediaUnavailable": "Video asli sudah tidak tersedia, jadi proyek ini tidak bisa diedit lagi.",
  "app.errors.tooManyRenders": "Terlalu banyak ekspor yang berjalan. Tunggu sampai salah satunya selesai.",
  "app.errors.renderLimit": "Video ini sudah mencapai batas ekspor hari ini. Coba lagi besok.",
  "app.errors.staleRev": "Proyek ini diubah di tab lain. Muat ulang untuk melihat versi terbaru.",
  "app.errors.docNotReady": "Proyek ini belum siap. Coba lagi sebentar lagi.",
  "app.errors.refunded": "Menitnya sudah dikembalikan.",
  "app.errors.tryAnotherVideo": "Coba video lain",
  "app.errors.appUpdated": "CleoCuts baru saja diperbarui. Muat ulang halaman dan unggah videonya lagi.",
  "app.warnings.scriptUnsupported": "Teks untuk aksara bahasa ini belum tersedia.",
  "app.warnings.smartcamFailed": "Pelacakan pembicara tidak berhasil untuk video ini, jadi video dipotong di bagian tengah.",
  "app.audio.silent": "Audio tampak senyap — periksa apakah mikrofon menyala dan tidak dibisukan.",
  "app.audio.quiet": "Audio sangat pelan — lain kali bicaralah lebih dekat ke mikrofon.",
  "app.audio.clipping": "Audio pecah di puncaknya — rekaman terlalu keras, kemungkinan ada distorsi.",
  "app.stage.queued": "Menunggu slot kosong",
  "app.stage.analyze.normalize": "Menyiapkan videomu",
  "app.stage.analyze.smartcam": "Melacak pembicara",
  "app.stage.analyze.transcribe": "Mentranskripsi",
  "app.stage.analyze.cleanup": "Merapikan transkrip",
  "app.stage.analyze.cuts": "Mencari potongan",
  "app.stage.analyze.captions": "Menyiapkan teks",
  "app.stage.analyze.done": "Siap ditinjau",
  "app.stage.render.prepare": "Menyiapkan ekspor",
  "app.stage.render.captions": "Menambahkan teks ({i}/{n})",
  "app.stage.render.encode": "Mengekspor",
  "app.stage.render.hooks": "Memotong sorotan",
  "app.stage.render.finish": "Menyelesaikan",
};
