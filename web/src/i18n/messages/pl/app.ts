import type { AppKey } from "../en";

export const plApp: Partial<Record<AppKey, string>> = {
  // ── Header ──────────────────────────────────────────────────────────
  "app.header.homeAria": "Strona główna CleoCuts",
  "app.header.library": "Biblioteka",
  "app.header.beta": "Beta",
  "app.header.opening": "Otwieranie…",

  // ── Browser notifications ───────────────────────────────────────────
  "app.notify.readyTitle": "CleoCuts — twój film jest gotowy",

  // ── Toasts / notices ────────────────────────────────────────────────
  "app.notice.loadFailed": "Nie udało się teraz wczytać projektu. Spróbuj ponownie za chwilę.",
  "app.notice.alreadyExporting": "Ten film jest już eksportowany. Postęp widać na jego karcie.",
  "app.notice.offline": "Nie można połączyć się z serwerem. Sprawdź internet i spróbuj ponownie.",

  // ── Errors ──────────────────────────────────────────────────────────
  "app.errors.expired":
    "Ten projekt nie istnieje już na serwerze (wygasł albo serwer został zaktualizowany). Wgraj film ponownie.",
  "app.errors.generic": "Coś poszło nie tak. Spróbuj ponownie.",
  "app.errors.connection": "Połączenie zostało przerwane. Sprawdź internet i spróbuj ponownie.",
  "app.errors.interrupted":
    "Przesyłanie zostało przerwane (strona się odświeżyła albo zmieniono aplikację). Wgraj film ponownie.",
  "app.errors.tooLarge": "Plik jest za duży. Przytnij film albo wyeksportuj mniejszą wersję.",
  "app.errors.noSpeech": "W tym filmie nie znaleźliśmy mowy. CleoCuts tnie i napisuje filmy, w których ktoś mówi — spróbuj z klipem, w którym słychać głos.",
  "app.errors.noSpeechRefunded": "W tym filmie nie znaleźliśmy mowy. CleoCuts tnie i napisuje filmy, w których ktoś mówi — spróbuj z klipem, w którym słychać głos. Minuty zostały ci zwrócone.",
  "app.errors.noAudioTrack": "Ten film nie ma ścieżki dźwiękowej, więc nie ma czego ciąć ani napisywać. Nic nie zostało pobrane.",
  "app.errors.renderFailed":
    "Renderowanie nie powiodło się. Twoje zmiany są zapisane — otwórz projekt i wyrenderuj ponownie.",
  "app.errors.serverNoResponse": "Serwer nie odpowiedział. Spróbuj ponownie.",
  "app.errors.serverBusy": "Nasze serwery są teraz przeciążone. Spróbuj ponownie za kilka minut.",
  "app.errors.saveEditsFailed": "Nie udało się zapisać zmian — sprawdź połączenie i spróbuj ponownie.",
  "app.errors.title": "Coś poszło nie tak",
  "app.errors.tryAgain": "Spróbuj ponownie",
  // Accounts + billing (only reachable when they are switched on)
  "app.errors.signInRequired": "Twoja sesja wygasła. Zaloguj się ponownie i spróbuj jeszcze raz.",
  "app.errors.subscriptionRequired": "Do przesyłania potrzebujesz planu. Wybierz go na stronie z cennikiem.",
  "app.errors.quotaExceeded":
    "Za mało minut w tym okresie na ten film. Ulepsz plan albo poczekaj na odnowienie limitu.",
  "app.errors.unreadableVideo":
    "Nie udało się odczytać tego pliku wideo. Wyeksportuj go ponownie jako MP4 lub MOV i wgraj jeszcze raz.",
  // Upload limits (413 / 429 from the backend, also checked before uploading)
  "app.errors.fileTooLarge":
    "Ten plik jest większy niż {max} GB. Przytnij film albo wyeksportuj mniejszą wersję.",
  "app.errors.videoTooLong":
    "Ten film jest dłuższy niż {max} min. Przytnij go albo podziel na części.",
  "app.errors.tooManyJobs":
    "Masz już maksymalną liczbę przetwarzanych filmów. Poczekaj, aż któryś będzie gotowy, i spróbuj ponownie.",

  // ── Accounts ────────────────────────────────────────────────────────
  "app.auth.signInToContinue": "Zaloguj się, aby otworzyć swoje projekty.",
  "app.auth.loadFailed":
    "Nie udało się wczytać logowania. Sprawdź połączenie (albo odblokuj tę stronę w blokerze treści) i spróbuj ponownie.",

  // ── Billing: upload blocked (402) + minutes left ────────────────────
  "app.paywall.subscriptionTitle": "Wybierz plan, aby przesyłać",
  "app.paywall.subscriptionBody":
    "Przesyłanie wymaga aktywnego planu. Wybierz jeden — zajmie to tylko minutę, a zrezygnować możesz w każdej chwili.",
  "app.paywall.quotaTitle": "Za mało minut",
  "app.paywall.quotaBody": "W tym okresie zostało ci {left} min — ten film potrzebuje {needed} min.",
  "app.paywall.quotaBodyUnknown": "Ten film jest dłuższy niż liczba minut, które zostały ci w tym okresie.",
  "app.paywall.seePlans": "Zobacz plany",
  "app.paywall.upgrade": "Ulepsz plan",
  "app.paywall.close": "Nie teraz",
  "app.billing.minutesLeft": "Zostało {n} min w tym okresie",
  "app.billing.choosePlan": "Wybierz plan, aby przesyłać",

  // ── Account page (/app/account) ─────────────────────────────────────
  "app.account.title": "Konto",
  "app.account.signedInAs": "Zalogowano jako {email}",
  "app.account.plan": "Plan",
  "app.account.noPlan": "Brak planu",
  "app.account.freeBeta": "W czasie otwartej bety korzystasz z CleoCuts bezpłatnie — plan nie jest potrzebny.",
  "app.account.status.active": "Aktywny · odnawia się {date}",
  "app.account.status.activeNoDate": "Aktywny",
  "app.account.status.trial": "Okres próbny · pierwsza płatność {date}",
  "app.account.status.cancelled": "Zostanie anulowany {date}",
  "app.account.status.pastDue": "Zaległa płatność — zaktualizuj metodę płatności.",
  "app.account.status.paused": "Wstrzymany",
  "app.account.status.expired": "Wygasł",
  "app.account.status.comp": "Bezpłatny",
  "app.account.usage": "Minuty w tym okresie",
  "app.account.usageOf": "Wykorzystano {used} z {limit} min",
  "app.account.resetsOn": "Limit odnawia się {date}",
  "app.account.manage": "Zarządzaj subskrypcją",
  "app.account.manageHint": "Faktury, metodę płatności i anulowanie obsłużysz w portalu klienta Lemon Squeezy.",
  "app.account.changePlan": "Zmień plan",
  "app.account.choosePlan": "Wybierz plan",
  "app.account.portalFailed": "Nie udało się otworzyć portalu płatności. Spróbuj ponownie za chwilę.",
  "app.account.loadFailed": "Nie udało się teraz wczytać twojego konta. Spróbuj ponownie za chwilę.",
  "app.account.testMode": "Tryb testowy",
  "app.account.successPending": "Dzięki! Płatność przeszła — aktywujemy twój plan…",
  "app.account.successDone": "Twój plan {plan} jest aktywny. Miłego montażu!",
  "app.account.successSlow":
    "Trwa to dłużej niż zwykle. Twój plan pojawi się tutaj w ciągu kilku minut — odśwież stronę, aby sprawdzić.",

  // ── Library fallbacks ───────────────────────────────────────────────
  "app.library.untitled": "Bez tytułu",

  // ── Workflow presets ────────────────────────────────────────────────
  "app.preset.tiktok.label": "TikTok / Reels",
  "app.preset.tiktok.tagline": "Wertykalny, krótki format",
  "app.preset.tiktok.desc": "Komendy głosowe, napisy Clipper, automatyczne kadrowanie wertykalne",
  "app.preset.tiktok.bullet1": "Komendy głosowe włączone: powiedz „Cleo cut”, by powtórzyć",
  "app.preset.tiktok.bullet2": "Pogrubione napisy w stylu Clipper",
  "app.preset.tiktok.bullet3": "Automatyczny format wertykalny 9:16 ze śledzeniem twarzy",
  "app.preset.podcast.label": "Podcast (długi format)",
  "app.preset.podcast.tagline": "Cały odcinek + klipy",
  "app.preset.podcast.desc": "Czyszczenie przez AI, wykrywanie hooków, eksport w wielu formatach",
  "app.preset.podcast.bullet1": "Czyszczenie twojego transkryptu przez AI",
  "app.preset.podcast.bullet2": "3 klipy hookowe wybrane automatycznie",
  "app.preset.podcast.bullet3": "Cały odcinek + klipy 9:16 wyeksportowane",
  "app.preset.vlog.label": "Czyszczenie vloga",
  "app.preset.vlog.tagline": "Solo, mówiąca głowa",
  "app.preset.vlog.desc": "Usuwa wypełniacze, dyskretne napisy, zachowuje format",
  "app.preset.vlog.bullet1": "Usuwa „yyy”, „eee”, długie pauzy",
  "app.preset.vlog.bullet2": "Dyskretne napisy, które nie rozpraszają",
  "app.preset.vlog.bullet3": "Zachowuje twój oryginalny format obrazu",
  "app.preset.captions.label": "Tylko napisy",
  "app.preset.captions.tagline": "Dodaj tylko napisy",
  "app.preset.captions.desc": "Wypala napisy na filmie — bez cięć, bez czyszczenia",
  "app.preset.captions.bullet1": "Wypala napisy w wybranym stylu",
  "app.preset.captions.bullet2": "Bez cięć, bez czyszczenia",
  "app.preset.captions.bullet3": "Najszybciej — tylko napisy",
  "app.preset.custom.label": "Własne",
  "app.preset.custom.tagline": "Skonfiguruj wszystko",
  "app.preset.custom.desc": "Pełne ustawienia — wybierz każdy szczegół sam",
  "app.preset.custom.bullet1": "Każde ustawienie dostępne",
  "app.preset.custom.bullet2": "Wybierz napisy, cięcia, format sam",
  "app.preset.custom.bullet3": "Dla tych, którzy wiedzą, czego chcą",

  // ── Caption styles ──────────────────────────────────────────────────
  "app.captions.clean": "Clean",
  "app.captions.classic": "Classic",
  "app.captions.clipper": "Clipper",
  "app.captions.highlight": "Highlight",
  "app.captions.flash": "Flash",
  "app.captions.punch": "Punch",
  "app.captions.elegant": "Elegant",
  "app.captions.subtle": "Subtle",
  "app.captions.none": "Brak napisów",

  // ── Cut styles ──────────────────────────────────────────────────────
  "app.cutStyle.tight.label": "Ciasny",
  "app.cutStyle.tight.desc": "Agresywny",
  "app.cutStyle.balanced.label": "Zbalansowany",
  "app.cutStyle.balanced.desc": "Domyślny",
  "app.cutStyle.smooth.label": "Płynny",
  "app.cutStyle.smooth.desc": "Zachowuje pauzy",

  // ── Export formats ──────────────────────────────────────────────────
  "app.format.9x16.desc": "TikTok / Reels / Shorts",
  "app.format.1x1.desc": "Kanał na Instagramie",
  "app.format.16x9.desc": "YouTube / komputer",

  // ── Dashboard ───────────────────────────────────────────────────────
  "app.dashboard.workspace": "Twój obszar pracy",
  "app.dashboard.inProgressCountOne": "{count} film w trakcie",
  "app.dashboard.inProgressCountOther": "{count} filmów w trakcie",
  "app.dashboard.readyCountOne": "{count} film gotowy do przejrzenia",
  "app.dashboard.readyCountOther": "Filmy gotowe do przejrzenia: {count}",
  "app.dashboard.failedCountOne": "{count} film z błędem",
  "app.dashboard.failedCountOther": "Filmy z błędem: {count}",
  "app.dashboard.readyWhenYouAre": "Gotowe, kiedy będziesz gotowy",
  "app.dashboard.newVideo": "Nowy film",
  "app.dashboard.inProgress": "W trakcie",
  "app.dashboard.recentProjects": "Ostatnie projekty",
  "app.dashboard.viewAll": "Zobacz wszystkie",
  "app.dashboard.startFirst": "Zacznij swój pierwszy film",
  "app.dashboard.startFirstSub": "Wybierz workflow — CleoCuts zajmie się napisami, formatem i czyszczeniem",
  "app.dashboard.voiceTeaser": "Powiedz „Cleo” podczas nagrywania — zaoszczędź godziny montażu",

  // ── Workflow picker ─────────────────────────────────────────────────
  "app.picker.backToDashboard": "Wróć do panelu",
  "app.picker.freeDuringBeta": "Bezpłatnie w czasie bety",
  "app.picker.title": "Co publikujesz?",
  "app.picker.subtitle":
    "Wybierz workflow — CleoCuts wstępnie ustawi napisy, format i czyszczenie dla tej platformy.",
  "app.picker.chipCaptions": "Napisy {style}",
  "app.picker.chipVoice": "„Cleo cut” włączone",
  "app.picker.customTitle": "Własna konfiguracja",
  "app.picker.customSub": "Wybierz każdy szczegół sam — napisy, cięcia, formaty",

  // ── Upload (choose a file) ──────────────────────────────────────────
  "app.upload.back": "Wstecz",
  "app.upload.title": "Wybierz film",
  "app.upload.hint":
    "MP4 lub MOV z telefonu albo komputera. Trzymaj tę stronę otwartą, aż przesyłanie się zakończy.",
  "app.upload.tapToChoose": "Dotknij, aby wybrać",
  "app.upload.orDrag": "albo przeciągnij plik tutaj",
  "app.upload.privacyLink": "Jak postępujemy z twoimi filmami",
  "app.upload.resuming":
    "Wznawiamy przesyłanie od miejsca, w którym zostało przerwane — trzymaj tę stronę otwartą.",

  // ── Configure (custom settings) ─────────────────────────────────────
  "app.configure.back": "wstecz",
  "app.configure.fileInfo": "{name} · {size} MB",
  "app.configure.captionStyle": "Styl napisów",
  "app.configure.captionPreviewAlt": "Podgląd napisów {style}",
  "app.configure.cutStyle": "Styl cięcia",
  "app.configure.cleanup": "Czyszczenie",
  "app.configure.voiceTriggers": "Słuchaj „Cleo cut” / „Cleo go”",
  "app.configure.voiceTriggersDesc": "Automatycznie usuwa nieudane ujęcia",
  "app.configure.removeFillers": "Usuń wypełniacze",
  "app.configure.removeFillersDesc": "Wycina „yyy”, „eee”, „no”…",
  "app.configure.smartReframe": "Smart Reframe",
  "app.configure.smartcam": "SmartCam — śledzenie twarzy",
  "app.configure.smartcamDesc": "Automatyczne kadrowanie do wertykalnego/horyzontalnego wyjścia",
  "app.configure.portrait": "portret",
  "app.configure.landscape": "pejzaż",
  "app.configure.portraitDesc": "Wertykalny 9:16",
  "app.configure.landscapeDesc": "Horyzontalny 16:9",
  "app.configure.extraFormats": "Dodatkowe formaty wyjściowe",
  "app.configure.extraFormatsHint":
    "Główny eksport używa twojego formatu SmartCam (albo oryginalnych proporcji). Wybierz dodatkowe wersje z paskami dla innych platform.",
  "app.configure.process": "Przetwórz film",

  // ── Done screen ─────────────────────────────────────────────────────
  "app.done.readyToPost": "Gotowe do publikacji",
  "app.done.captionSuggestion": "Propozycja opisu",
  "app.done.copy": "kopiuj",
  "app.done.downloadPrimary": "Pobierz wersję główną",
  "app.done.downloadFormat": "Pobierz {format}",
  "app.done.mainEdit": "Główny montaż",
  "app.done.bonusClips": "Klipy bonusowe",
  "app.done.aiPicked": "wybrane przez AI",
  "app.done.processAnother": "Przetwórz kolejny film",

  // ── Dashboard job cards ─────────────────────────────────────────────
  "app.card.noPreview": "brak podglądu",
  "app.card.uploading.title": "Przesyłanie",
  "app.card.uploading.sub": "Przesyłanie — trzymaj tę stronę otwartą i nie blokuj telefonu.",
  "app.card.analyzing.title": "Analizowanie",
  "app.card.analyzing.sub": "Transkrybowanie oraz wycinanie pauz i wypełniaczy.",
  "app.card.reviewing.title": "Gotowe do edycji",
  "app.card.reviewing.sub": "Dotknij, aby otworzyć edytor i dopracować montaż.",
  "app.card.rendering.title": "Renderowanie",
  "app.card.rendering.sub": "Składanie twojego finalnego filmu.",
  // Waiting for a free server slot (status "processing", message "queued")
  "app.card.queued.title": "W kolejce (#{n})",
  "app.card.queued.titleNoPos": "W kolejce",
  "app.card.queued.sub":
    "Teraz jest dużo filmów — twój ruszy automatycznie. Możesz opuścić tę stronę.",
  "app.card.open": "Otwórz",
  "app.card.remove": "Usuń",
  "app.card.renderFailedNote": "Renderowanie nie powiodło się — twoje zmiany są zapisane. Otwórz i wyrenderuj ponownie.",

  // ── Captions tab ────────────────────────────────────────────────────
  "app.captions.styleHeading": "Styl napisów · {style}",
  "app.captions.appliedToOutput": "Zastosowane w wyniku",
  "app.captions.disabled": "Napisy wyłączone dla tego renderu.",

  // ── Voice test (dialog) ─────────────────────────────────────────────
  "app.voice.title": "Przetestuj swój głos",
  "app.voice.subtitle": "Powiedz komendy — sprawdź, czy Cleo cię słyszy.",
  "app.voice.close": "Zamknij",
  "app.voice.heardYou": "Usłyszano cię!",
  "app.voice.listening": "Słuchanie…",
  "app.voice.heardPrefix": "usłyszano: ",
  "app.voice.permissionHint": "Korzysta z mikrofonu. Przeglądarka zamienia twoją mowę na tekst: Chrome wysyła ją w tym celu do Google, Safari do Apple. Nic nie trafia do CleoCuts.",
  "app.voice.requesting": "Żądanie dostępu…",
  "app.voice.start": "Start",
  "app.voice.denied": "Brak uprawnień. Włącz je w ustawieniach przeglądarki i odśwież stronę.",
  "app.voice.unsupported": "Nieobsługiwane w tej przeglądarce. Wypróbuj Safari albo Chrome.",
  "app.voice.done": "Gotowe",
  "app.voice.cmd.start": "Zacznij swoje ujęcie",
  "app.voice.cmd.cut": "Powtórz, odrzuć obecne ujęcie",
  "app.voice.cmd.keep": "Zatwierdź ujęcie, kolejna scena",
  "app.voice.cmd.finish": "Zakończ film, wytnij wszystko po tym",
  "app.voice.cmd.stop": "Pomiń jedno złe zdanie (razem z „go”)",
  "app.voice.cmd.go": "Kontynuuj po „stop”",
  "app.crash.saving": "Zapisywanie ostatnich zmian…",
  "app.crash.saved": "Ostatnie zmiany są zapisane.",
  "app.crash.unsaved": "Ostatnie zmiany mogły nie zostać zapisane.",
  "app.crash.body": "Odśwież stronę, aby kontynuować od miejsca, w którym przerwano.",
  "app.crash.reload": "Odśwież stronę",

  // ── Error codes, warnings, stages (UX5, lib/errorKeys.ts) ────────
  "app.errors.noVideoTrack": "To jest plik audio. CleoCuts potrzebuje wideo z dźwiękiem — wybierz plik wideo. Nic nie zostało pobrane.",
  "app.errors.videoTooShort": "To wideo jest krótsze niż {min} s — za krótkie, by je ciąć. Nic nie zostało pobrane.",
  "app.errors.processingInterrupted": "Przetwarzanie zostało przerwane. Prześlij wideo ponownie.",
  "app.errors.mediaUnavailable": "Oryginalne wideo nie jest już dostępne, więc tego projektu nie można ponownie edytować.",
  "app.errors.tooManyRenders": "Trwa zbyt wiele eksportów. Poczekaj, aż jeden się zakończy.",
  "app.errors.renderLimit": "To wideo osiągnęło dzisiejszy limit eksportów. Spróbuj ponownie jutro.",
  "app.errors.staleRev": "Ten projekt został zmieniony w innej karcie. Odśwież, aby zobaczyć najnowszą wersję.",
  "app.errors.docNotReady": "Ten projekt nie jest jeszcze gotowy. Spróbuj ponownie za chwilę.",
  "app.errors.refunded": "Minuty zostały zwrócone.",
  "app.errors.tryAnotherVideo": "Wypróbuj inne wideo",
  "app.warnings.scriptUnsupported": "Napisy nie są jeszcze dostępne dla pisma tego języka.",
  "app.warnings.smartcamFailed": "Śledzenie mówiącego nie zadziałało w tym wideo, więc zostało ono przycięte do środka.",
  "app.audio.silent": "Dźwięk wydaje się wyciszony — sprawdź, czy mikrofon jest włączony i niewyciszony.",
  "app.audio.quiet": "Dźwięk jest bardzo cichy — następnym razem mów bliżej mikrofonu.",
  "app.audio.clipping": "Dźwięk przesterowuje w szczytach — nagranie jest za głośne, możliwe zniekształcenia.",
  "app.stage.queued": "Czeka na wolne miejsce",
  "app.stage.analyze.normalize": "Przygotowywanie wideo",
  "app.stage.analyze.smartcam": "Śledzenie mówiącego",
  "app.stage.analyze.transcribe": "Transkrypcja",
  "app.stage.analyze.cleanup": "Dopracowywanie transkrypcji",
  "app.stage.analyze.cuts": "Wyszukiwanie cięć",
  "app.stage.analyze.captions": "Przygotowywanie napisów",
  "app.stage.analyze.done": "Gotowe do sprawdzenia",
  "app.stage.render.prepare": "Przygotowywanie eksportu",
  "app.stage.render.captions": "Dodawanie napisów ({i}/{n})",
  "app.stage.render.encode": "Eksportowanie",
  "app.stage.render.hooks": "Wycinanie najlepszych fragmentów",
  "app.stage.render.finish": "Kończenie",
};
