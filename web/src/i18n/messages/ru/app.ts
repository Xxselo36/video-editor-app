import type { AppKey } from "../en";

export const ruApp: Partial<Record<AppKey, string>> = {
  // ── Header ──────────────────────────────────────────────────────────
  "app.header.homeAria": "CleoCuts — на главную",
  "app.header.library": "Библиотека",
  "app.header.beta": "Бета",
  "app.header.opening": "Открываем…",

  // ── Browser notifications ───────────────────────────────────────────
  "app.notify.readyTitle": "CleoCuts — твоё видео готово",

  // ── Toasts / notices ────────────────────────────────────────────────
  "app.notice.loadFailed": "Не удалось загрузить проект. Попробуй ещё раз через минуту.",
  "app.notice.alreadyExporting": "Это видео уже экспортируется. Прогресс видно на его карточке.",
  "app.notice.offline": "Не получается связаться с сервером. Проверь интернет и попробуй снова.",

  // ── Errors ──────────────────────────────────────────────────────────
  "app.errors.expired":
    "Этого проекта больше нет на сервере (истёк срок или было обновление). Загрузи видео заново.",
  "app.errors.generic": "Что-то пошло не так. Попробуй ещё раз.",
  "app.errors.connection": "Связь прервалась. Проверь интернет и попробуй снова.",
  "app.errors.interrupted":
    "Загрузка была прервана (страница перезагрузилась или приложение переключилось). Загрузи видео заново.",
  "app.errors.tooLarge": "Файл слишком большой. Обрежь видео или экспортируй его в меньшем размере.",
  "app.errors.noSpeech": "Мы не нашли в этом видео речи. CleoCuts режет и субтитрует видео, где кто-то говорит, — попробуй клип с голосом.",
  "app.errors.noSpeechRefunded": "Мы не нашли в этом видео речи. CleoCuts режет и субтитрует видео, где кто-то говорит, — попробуй клип с голосом. Минуты возвращены на твой счёт.",
  "app.errors.noAudioTrack": "В этом видео нет звуковой дорожки — резать и субтитровать нечего. Ничего не списано.",
  "app.errors.renderFailed":
    "Рендер не удался. Твои изменения сохранены — открой проект и запусти рендер снова.",
  "app.errors.serverNoResponse": "Сервер не отвечает. Попробуй ещё раз.",
  "app.errors.serverBusy": "Наши серверы сейчас перегружены. Попробуй снова через несколько минут.",
  "app.errors.saveEditsFailed": "Не удалось сохранить изменения — проверь подключение и попробуй снова.",
  "app.errors.title": "Что-то пошло не так",
  "app.errors.tryAgain": "Попробовать снова",
  // Accounts + billing (only reachable when they are switched on)
  "app.errors.signInRequired": "Твоя сессия завершилась. Войди снова и повтори попытку.",
  "app.errors.subscriptionRequired": "Для загрузки нужен тариф. Выбери его на странице с ценами.",
  "app.errors.quotaExceeded":
    "В этом периоде не хватает минут для этого видео. Повысь тариф или дождись сброса.",
  "app.errors.unreadableVideo":
    "Не удалось прочитать этот видеофайл. Экспортируй его заново в MP4 или MOV и загрузи снова.",
  // Upload limits (413 / 429 from the backend, also checked before uploading)
  "app.errors.fileTooLarge":
    "Этот файл больше {max} ГБ. Обрежь видео или экспортируй его в меньшем размере.",
  "app.errors.videoTooLong": "Это видео длиннее {max} мин. Обрежь его или раздели на части.",
  "app.errors.tooManyJobs":
    "У тебя уже обрабатывается максимальное количество видео. Дождись, пока одно из них будет готово, и попробуй снова.",

  // ── Accounts ────────────────────────────────────────────────────────
  "app.auth.signInToContinue": "Войди, чтобы открыть свои проекты.",
  "app.auth.loadFailed":
    "Не удалось загрузить вход. Проверь подключение (или разреши этот сайт в блокировщике контента) и попробуй снова.",

  // ── Billing: upload blocked (402) + minutes left ────────────────────
  "app.paywall.subscriptionTitle": "Выбери тариф, чтобы загружать видео",
  "app.paywall.subscriptionBody":
    "Для загрузки нужен активный тариф. Выбери подходящий — это займёт минуту, а отменить можно в любой момент.",
  "app.paywall.quotaTitle": "Не хватает минут",
  "app.paywall.quotaBody": "В этом периоде у тебя осталось {left} мин, а этому видео нужно {needed} мин.",
  "app.paywall.quotaBodyUnknown": "Это видео длиннее, чем минуты, оставшиеся у тебя в этом периоде.",
  "app.paywall.seePlans": "Посмотреть тарифы",
  "app.paywall.upgrade": "Повысить тариф",
  "app.paywall.close": "Не сейчас",
  "app.billing.minutesLeft": "Осталось {n} мин в этом периоде",
  "app.billing.choosePlan": "Выбери тариф, чтобы загружать видео",

  // ── Account page (/app/account) ─────────────────────────────────────
  "app.account.title": "Аккаунт",
  "app.account.signedInAs": "Вход выполнен: {email}",
  "app.account.plan": "Тариф",
  "app.account.noPlan": "Тарифа пока нет",
  "app.account.freeBeta": "CleoCuts бесплатен во время открытой беты — тариф не нужен.",
  "app.account.status.active": "Активен · продление {date}",
  "app.account.status.activeNoDate": "Активен",
  "app.account.status.trial": "Пробный период · первый платёж {date}",
  "app.account.status.cancelled": "Будет отменён {date}",
  "app.account.status.pastDue": "Платёж просрочен — обнови способ оплаты.",
  "app.account.status.paused": "Приостановлен",
  "app.account.status.expired": "Истёк",
  "app.account.status.comp": "Бесплатный доступ",
  "app.account.usage": "Минуты в этом периоде",
  "app.account.usageOf": "Использовано {used} из {limit} мин",
  "app.account.resetsOn": "Сброс {date}",
  "app.account.manage": "Управление подпиской",
  "app.account.manageHint": "Счета, способ оплаты и отмена подписки — в клиентском портале Lemon Squeezy.",
  "app.account.changePlan": "Сменить тариф",
  "app.account.choosePlan": "Выбрать тариф",
  "app.account.portalFailed": "Не удалось открыть портал оплаты. Попробуй ещё раз через минуту.",
  "app.account.loadFailed": "Не удалось загрузить аккаунт. Попробуй ещё раз через минуту.",
  "app.account.testMode": "Тестовый режим",
  "app.account.successPending": "Спасибо! Оплата прошла — активируем твой тариф…",
  "app.account.successDone": "Тариф {plan} активен. Приятного монтажа!",
  "app.account.successSlow":
    "Это занимает больше времени, чем обычно. Тариф появится здесь в течение нескольких минут — обнови страницу, чтобы проверить.",

  // ── Library fallbacks ───────────────────────────────────────────────
  "app.library.untitled": "Без названия",

  // ── Workflow presets ────────────────────────────────────────────────
  "app.preset.tiktok.label": "TikTok / Reels",
  "app.preset.tiktok.tagline": "Вертикальный короткий формат",
  "app.preset.tiktok.desc": "Голосовые команды, субтитры Clipper, автовертикальный кадр",
  "app.preset.tiktok.bullet1": "Голосовые команды включены: скажи «Cleo cut», чтобы переснять",
  "app.preset.tiktok.bullet2": "Жирные субтитры в стиле Clipper",
  "app.preset.tiktok.bullet3": "Автовертикаль 9:16 с трекингом лица",
  "app.preset.podcast.label": "Подкаст (длинный формат)",
  "app.preset.podcast.tagline": "Полный эпизод + клипы",
  "app.preset.podcast.desc": "ИИ-чистка, поиск хуков, экспорт в нескольких форматах",
  "app.preset.podcast.bullet1": "ИИ-чистка твоего транскрипта",
  "app.preset.podcast.bullet2": "3 хук-клипа выбираются автоматически",
  "app.preset.podcast.bullet3": "Экспорт полного эпизода + клипов 9:16",
  "app.preset.vlog.label": "Чистка влога",
  "app.preset.vlog.tagline": "Один спикер в кадре",
  "app.preset.vlog.desc": "Убирает слова-паразиты, сдержанные субтитры, формат сохраняется",
  "app.preset.vlog.bullet1": "Убирает «эээ», «ну», длинные паузы",
  "app.preset.vlog.bullet2": "Сдержанные субтитры, которые не отвлекают",
  "app.preset.vlog.bullet3": "Сохраняет твой исходный формат кадра",
  "app.preset.captions.label": "Только субтитры",
  "app.preset.captions.tagline": "Добавить только субтитры",
  "app.preset.captions.desc": "Вшивает субтитры в видео — без монтажа, без чистки",
  "app.preset.captions.bullet1": "Вшивает субтитры в выбранном стиле",
  "app.preset.captions.bullet2": "Без монтажа, без чистки",
  "app.preset.captions.bullet3": "Самый быстрый вариант — только субтитры",
  "app.preset.custom.label": "Свой вариант",
  "app.preset.custom.tagline": "Настроить всё самому",
  "app.preset.custom.desc": "Все настройки — выбираешь каждый параметр сам",
  "app.preset.custom.bullet1": "Доступны все настройки",
  "app.preset.custom.bullet2": "Сам выбираешь субтитры, монтаж, формат",
  "app.preset.custom.bullet3": "Для тех, кто точно знает, что хочет",

  // ── Caption styles ──────────────────────────────────────────────────
  "app.captions.clean": "Clean",
  "app.captions.classic": "Classic",
  "app.captions.clipper": "Clipper",
  "app.captions.highlight": "Highlight",
  "app.captions.flash": "Flash",
  "app.captions.punch": "Punch",
  "app.captions.elegant": "Elegant",
  "app.captions.subtle": "Subtle",
  "app.captions.none": "Без субтитров",

  // ── Cut styles ──────────────────────────────────────────────────────
  "app.cutStyle.tight.label": "Жёсткий",
  "app.cutStyle.tight.desc": "Агрессивный",
  "app.cutStyle.balanced.label": "Сбалансированный",
  "app.cutStyle.balanced.desc": "По умолчанию",
  "app.cutStyle.smooth.label": "Плавный",
  "app.cutStyle.smooth.desc": "Сохранять паузы",

  // ── Export formats ──────────────────────────────────────────────────
  "app.format.9x16.desc": "TikTok / Reels / Shorts",
  "app.format.1x1.desc": "Лента Instagram",
  "app.format.16x9.desc": "YouTube / компьютер",

  // ── Dashboard ───────────────────────────────────────────────────────
  "app.dashboard.workspace": "Твоё рабочее пространство",
  "app.dashboard.inProgressCountOne": "{count} видео в обработке",
  "app.dashboard.inProgressCountOther": "{count} видео в обработке",
  "app.dashboard.readyCountOne": "{count} видео готово к проверке",
  "app.dashboard.readyCountOther": "Готово к проверке: {count} видео",
  "app.dashboard.failedCountOne": "{count} видео с ошибкой",
  "app.dashboard.failedCountOther": "Видео с ошибкой: {count}",
  "app.dashboard.readyWhenYouAre": "Готовы, когда скажешь",
  "app.dashboard.newVideo": "Новое видео",
  "app.dashboard.inProgress": "В обработке",
  "app.dashboard.recentProjects": "Недавние проекты",
  "app.dashboard.viewAll": "Смотреть все",
  "app.dashboard.startFirst": "Начни своё первое видео",
  "app.dashboard.startFirstSub": "Выбери workflow — CleoCuts сам разберётся с субтитрами, форматом и чисткой",
  "app.dashboard.voiceTeaser": "Скажи «Cleo» во время записи — сэкономишь часы на монтаже",

  // ── Workflow picker ─────────────────────────────────────────────────
  "app.picker.backToDashboard": "Назад на главную",
  "app.picker.freeDuringBeta": "Бесплатно во время беты",
  "app.picker.title": "Что ты выпускаешь?",
  "app.picker.subtitle":
    "Выбери workflow — CleoCuts заранее настроит субтитры, формат и чистку под платформу.",
  "app.picker.chipCaptions": "Субтитры {style}",
  "app.picker.chipVoice": "«Cleo cut» включено",
  "app.picker.customTitle": "Своя настройка",
  "app.picker.customSub": "Выбираешь каждый параметр сам — субтитры, монтаж, форматы",

  // ── Upload (choose a file) ──────────────────────────────────────────
  "app.upload.back": "Назад",
  "app.upload.title": "Выбери видео",
  "app.upload.hint":
    "MP4 или MOV с телефона или компьютера. Держи эту страницу открытой, пока загрузка не завершится.",
  "app.upload.tapToChoose": "Нажми, чтобы выбрать",
  "app.upload.orDrag": "или перетащи файл",
  "app.upload.privacyLink": "Как мы обращаемся с твоими видео",
  "app.upload.resuming":
    "Продолжаем загрузку с того места, где она прервалась — держи эту страницу открытой.",

  // ── Configure (custom settings) ─────────────────────────────────────
  "app.configure.back": "назад",
  "app.configure.fileInfo": "{name} · {size} МБ",
  "app.configure.captionStyle": "Стиль субтитров",
  "app.configure.captionPreviewAlt": "Пример субтитров {style}",
  "app.configure.cutStyle": "Стиль монтажа",
  "app.configure.cleanup": "Чистка",
  "app.configure.voiceTriggers": "Слушать «Cleo cut» / «Cleo go»",
  "app.configure.voiceTriggersDesc": "Автоматически убирает неудачные дубли",
  "app.configure.removeFillers": "Убрать слова-паразиты",
  "app.configure.removeFillersDesc": "Вырезает «эээ», «ну», «типа»…",
  "app.configure.smartReframe": "Умный кадр",
  "app.configure.smartcam": "SmartCam — трекинг лица",
  "app.configure.smartcamDesc": "Автоматический кадр для вертикального/горизонтального видео",
  "app.configure.portrait": "портрет",
  "app.configure.landscape": "ландшафт",
  "app.configure.portraitDesc": "Вертикальный 9:16",
  "app.configure.landscapeDesc": "Горизонтальный 16:9",
  "app.configure.extraFormats": "Дополнительные форматы",
  "app.configure.extraFormatsHint":
    "Основной экспорт идёт в формате SmartCam (или в исходном соотношении сторон). Выбери дополнительные версии с рамками для других платформ.",
  "app.configure.process": "Обработать видео",

  // ── Done screen ─────────────────────────────────────────────────────
  "app.done.readyToPost": "Готово к публикации",
  "app.done.captionSuggestion": "Вариант описания",
  "app.done.copy": "копировать",
  "app.done.downloadPrimary": "Скачать основную версию",
  "app.done.downloadFormat": "Скачать {format}",
  "app.done.mainEdit": "Основной монтаж",
  "app.done.bonusClips": "Бонус-клипы",
  "app.done.aiPicked": "выбрано ИИ",
  "app.done.processAnother": "Обработать ещё одно",

  // ── Dashboard job cards ─────────────────────────────────────────────
  "app.card.noPreview": "нет превью",
  "app.card.uploading.title": "Загрузка",
  "app.card.uploading.sub": "Идёт загрузка — держи эту страницу открытой и не блокируй телефон.",
  "app.card.analyzing.title": "Анализ",
  "app.card.analyzing.sub": "Транскрибируем и вырезаем паузы и слова-паразиты.",
  "app.card.reviewing.title": "Готово к редактированию",
  "app.card.reviewing.sub": "Нажми, чтобы открыть редактор и доработать монтаж.",
  "app.card.rendering.title": "Рендер",
  "app.card.rendering.sub": "Собираем твоё финальное видео.",
  // Waiting for a free server slot (status "processing", message "queued")
  "app.card.queued.title": "В очереди (#{n})",
  "app.card.queued.titleNoPos": "В очереди",
  "app.card.queued.sub":
    "Сейчас много видео — твоё запустится автоматически. Можешь уйти с этой страницы.",
  "app.card.open": "Открыть",
  "app.card.remove": "Удалить",
  "app.card.renderFailedNote": "Рендер не удался — твои изменения сохранены. Открой и запусти рендер снова.",

  // ── Captions tab ────────────────────────────────────────────────────
  "app.captions.styleHeading": "Стиль субтитров · {style}",
  "app.captions.appliedToOutput": "Применено к результату",
  "app.captions.disabled": "Субтитры отключены для этого рендера.",

  // ── Voice test (dialog) ─────────────────────────────────────────────
  "app.voice.title": "Проверь свой голос",
  "app.voice.subtitle": "Произнеси команды — посмотрим, слышит ли тебя Cleo.",
  "app.voice.close": "Закрыть",
  "app.voice.heardYou": "Услышали тебя!",
  "app.voice.listening": "Слушаем…",
  "app.voice.heardPrefix": "слышно: ",
  "app.voice.permissionHint": "Используется микрофон. Браузер превращает речь в текст: Chrome отправляет её для этого в Google, Safari — в Apple. В CleoCuts ничего не уходит.",
  "app.voice.requesting": "Запрашиваем…",
  "app.voice.start": "Начать",
  "app.voice.denied": "Доступ запрещён. Включи его в настройках браузера и перезагрузи страницу.",
  "app.voice.unsupported": "Не поддерживается в этом браузере. Попробуй Safari или Chrome.",
  "app.voice.done": "Готово",
  "app.voice.cmd.start": "Начать дубль",
  "app.voice.cmd.cut": "Переснять, отбросить текущий дубль",
  "app.voice.cmd.keep": "Подтвердить дубль, следующая сцена",
  "app.voice.cmd.finish": "Закончить видео, вырезать всё после",
  "app.voice.cmd.stop": "Пропустить одно неудачное предложение (используется с «go»)",
  "app.voice.cmd.go": "Продолжить после «stop»",
  "app.crash.saving": "Сохраняем твои последние изменения…",
  "app.crash.saved": "Твои последние изменения сохранены.",
  "app.crash.unsaved": "Последние изменения могли не сохраниться.",
  "app.crash.body": "Перезагрузи страницу, чтобы продолжить с того же места.",
  "app.crash.reload": "Перезагрузить страницу",

  // ── Error codes, warnings, stages (UX5, lib/errorKeys.ts) ────────
  "app.errors.noVideoTrack": "Это аудиофайл. CleoCuts нужно видео со звуком — выбери видеофайл. Ничего не списано.",
  "app.errors.videoTooShort": "Это видео короче {min} секунд — слишком короткое для монтажа. Ничего не списано.",
  "app.errors.processingInterrupted": "Обработка была прервана. Загрузи видео ещё раз.",
  "app.errors.mediaUnavailable": "Исходное видео больше недоступно, поэтому этот проект нельзя снова редактировать.",
  "app.errors.tooManyRenders": "Выполняется слишком много экспортов. Подожди, пока один из них завершится.",
  "app.errors.renderLimit": "Для этого видео достигнут лимит экспортов на сегодня. Попробуй завтра.",
  "app.errors.staleRev": "Этот проект изменили в другой вкладке. Перезагрузи страницу, чтобы увидеть последнюю версию.",
  "app.errors.docNotReady": "Этот проект ещё не готов. Попробуй через минуту.",
  "app.errors.refunded": "Минуты вернули на твой счёт.",
  "app.errors.tryAnotherVideo": "Попробовать другое видео",
  "app.warnings.scriptUnsupported": "Субтитры для письменности этого языка пока недоступны.",
  "app.warnings.smartcamFailed": "Отслеживание говорящего не сработало для этого видео, поэтому оно обрезано по центру.",
  "app.audio.silent": "Похоже, звука нет — проверь, что микрофон включён и не отключён.",
  "app.audio.quiet": "Звук очень тихий — в следующий раз говори ближе к микрофону.",
  "app.audio.clipping": "Звук перегружен на пиках — запись слишком громкая, возможны искажения.",
  "app.stage.queued": "Ожидание свободного места",
  "app.stage.analyze.normalize": "Подготовка видео",
  "app.stage.analyze.smartcam": "Отслеживание говорящего",
  "app.stage.analyze.transcribe": "Расшифровка",
  "app.stage.analyze.cleanup": "Доработка расшифровки",
  "app.stage.analyze.cuts": "Поиск склеек",
  "app.stage.analyze.captions": "Подготовка субтитров",
  "app.stage.analyze.done": "Готово к проверке",
  "app.stage.render.prepare": "Подготовка экспорта",
  "app.stage.render.captions": "Добавление субтитров ({i}/{n})",
  "app.stage.render.encode": "Экспорт",
  "app.stage.render.hooks": "Нарезка лучших моментов",
  "app.stage.render.finish": "Завершение",
};
