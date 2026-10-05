# CleoCuts Betrieb: Überwachung & Alarme

Drei GitHub-Actions-Workflows überwachen die Produktion. Sie kosten
praktisch nichts: kein bezahlter Dienst, und GitHub Actions ist für
öffentliche Repos gratis. Wenn etwas kaputt ist, **schlägt der Workflow
fehl und GitHub schickt dir eine E-Mail**. Das ist der ganze
Alarm-Mechanismus.

Die Logs sind öffentlich (das Repo ist public). Die Checks schreiben
deshalb nur Statuscodes, Latenzen und OK/Fehler ins Log, nie
Dollarbeträge, Job-IDs oder Secrets. Aus demselben Grund ist die
Kostenschwelle ein **Secret**: GitHub schreibt jede Umgebungsvariable
eines Schritts im Klartext ins Log, maskiert werden nur Secrets.

| Workflow | Wann | Prüft | Rot, wenn … |
|---|---|---|---|
| **Uptime** (`.github/workflows/uptime.yml`) | alle 10 Min | `GET https://api.cleocuts.com/ready` (Backend **und** Datenbank) und die Startseite `https://cleocuts.com/` | eine der beiden URLs zweimal im Abstand von 30 s keinen 2xx liefert (Timeout 20 s pro Versuch) |
| **Ops watch** → Job *Modal can render* (`.github/workflows/ops-watch.yml`, `.github/scripts/modal_probe.py`) | alle 6 h (00:17, 06:17, 12:17, 18:17 UTC) | ob Modal einen Render-Aufruf überhaupt noch ausführt | Spend-Limit erreicht, Token ungültig, App nicht deployt, keine Antwort in 180 s |
| **Ops watch** → Job *Spend in the last 24 h* (`.github/scripts/cost_guard.py`) | alle 6 h | Verarbeitungskosten der letzten 24 h laut `/admin/costs` | Summe > Repo-Secret `COST_ALERT_USD_PER_DAY` (Standard **10 USD**), oder der Check kann nicht laufen |
| **Deploy Modal render**, *diagnose* angehakt (`.github/workflows/modal-deploy.yml`) | nur manuell | App-Status, Fehlerzeilen aus den Modal-Logs, dann derselbe Probe wie oben | Probe schlägt fehl |

Alle drei kannst du jederzeit von Hand starten: **Actions → Workflow
wählen → Run workflow**.

## Wie funktionieren die Checks?

**Uptime** ruft `/ready` auf. Das antwortet nur mit 200, wenn die
Job-Datenbank innerhalb von 2 s antwortet. `/health` (reine
Lebendigkeit) wird nur bei einem Fehler zusätzlich abgefragt, damit du
im Log siehst, ob das Backend ganz weg ist oder nur die Datenbank
hängt. Die Web-Startseite wird mit Redirects (`-L`) geladen.

**Modal-Probe**: Startet `render_burn_concat` für den Job
`diag-probe`, zu dem es keine Eingabedatei gibt. Funktioniert Modal,
startet ein Container und bricht sofort mit `FileNotFoundError` ab. Das
ist die **gesunde** Antwort. Alles andere ist ein Alarm:

| Ergebnis | Annotation im Run |
|---|---|
| `ResourceExhaustedError` „workspace billing cycle spend limit reached“ | **Modal spend limit reached** |
| anderer `ResourceExhaustedError` (Rate-Limit o. ä.) | Modal refused the call (resource exhausted) |
| `AuthError` / `PermissionDeniedError` | Modal rejected the token |
| `NotFoundError` | Modal app cleocuts-render not found |
| keine Antwort in 180 s / Aufruf abgelaufen | Modal did not run the probe |
| Client hängt komplett (Lookup/Spawn kommt nicht zurück, 270 s Watchdog) | Modal probe hung |
| Netzwerkfehler zu Modal | Could not reach Modal |
| Container stürzt ab oder der Aufruf scheitert in Modal mit einem anderen Fehler (z. B. nach einem kaputten Deploy) | **Modal probe failed** |
| `modal` ist im Runner nicht installiert (Setup-Fehler, nicht Modal) | Modal client missing |
| Secrets fehlen | Modal probe not configured |

Endet der Probe anders als mit der gesunden Antwort (Timeout,
Netzwerkfehler, Watchdog, Abbruch), bricht er seinen Aufruf ab, damit
kein wartender Aufruf später noch einen Container startet.

**Kosten-Check**: Holt `GET /admin/costs` (Header `X-Admin-Token` aus
dem Secret `CLEO_ADMIN_TOKEN`) und summiert `usd_all_in` aller Jobs,
die in den letzten 24 h **angelegt oder geändert** wurden. Die
Zeitstempel kommen aus `GET /jobs` (mit Admin-Token: alle Jobs), denn
`/admin/costs` hat keine Zeitfilter. Das Ergebnis ist bewusst eine
**Obergrenze**:
- Ein alter Job, der heute neu gerendert oder bearbeitet wurde, zählt
  mit seinen *gesamten* Kosten.
- `usd_all_in` enthält auch den Speicher für die volle
  Aufbewahrungszeit und geschätzten Egress, liegt also über dem, was an
  dem Tag tatsächlich bezahlt wurde.
- Test-Jobs (cost-test) zählen mit, es ist echtes Geld.
- Nicht gezählt werden Jobs, die innerhalb der 24 h angelegt **und
  wieder gelöscht** wurden (sie tauchen in `/admin/costs` nicht mehr
  auf).

Ist `GET /jobs` nicht verfügbar (Accounts aus → 404, der
Standard, solange `CLERK_ISSUER` nicht gesetzt ist), nimmt der Check
erst die Gesamtsumme aller Jobs: Liegt sogar die unter dem Limit, ist
alles OK. Sonst holt er `updated_at` der Jobs aus `GET /jobs/status`
(mit ausgeschalteten Accounts ohne Login erreichbar, 50 Jobs pro
Request; `updated_at` wird beim Anlegen und bei jeder Änderung gesetzt).
Nur wenn auch das nicht antwortet, meldet er „Cost guard could not
run“, statt zu raten.

## Wie Alarme ankommen

GitHub schickt bei jedem **fehlgeschlagenen** Run eine E-Mail:

- **Geplante Runs** (die `schedule`-Trigger): an die Person, die die
  `cron`-Zeile im Workflow zuletzt geändert hat. Wurde der Workflow
  deaktiviert und wieder aktiviert, geht die Mail an die Person, die ihn
  **wieder aktiviert** hat.
- **Manuelle Runs**: an die Person, die sie gestartet hat.

### Einmalig nach dem Merge einrichten (wichtig)

Die Workflow-Dateien werden nicht von deinem GitHub-Account angelegt.
Damit die Mails sicher **bei dir** landen:

1. **Actions → Uptime → „···“ (oben rechts) → Disable workflow**, dann
   **Enable workflow**. Ab jetzt bist du der Empfänger.
2. Dasselbe für **Actions → Ops watch**.
3. **GitHub → Settings → Notifications** (github.com/settings/notifications)
   → Abschnitt **System → Actions**: „Email“ einschalten und
   **„Only notify for failed workflows“** anhaken. Optional „GitHub
   Mobile“ für Push aufs Handy.
4. Prüfen, dass die Mail-Adresse unter **Settings → Notifications →
   Default notifications email** eine ist, die du liest.

### Alarm-Test (2 Minuten)

1. **Settings → Secrets and variables → Actions → Variables → New
   repository variable**: `CLEO_WEB_URL` = `https://cleocuts.com/gibt-es-nicht`
2. **Actions → Uptime → Run workflow**. Nach ca. 1 Min ist der Run rot
   und die Mail kommt.
3. Variable `CLEO_WEB_URL` **sofort wieder löschen**, sonst schlägt
   auch jeder geplante Run fehl.

### Gut zu wissen

- Während eines Ausfalls kommt **alle 10 Min eine Mail** (jeder
  fehlgeschlagene Uptime-Run). Bei einem bekannten, längeren Ausfall:
  Workflow deaktivieren und danach wieder aktivieren (macht dich
  nebenbei wieder zum Empfänger).
- GitHub startet geplante Runs bei hoher Last **verspätet** (oft einige
  Minuten, manchmal länger). „Alle 10 Min“ ist Best-Effort, kein
  exakter SLA-Monitor.
- In öffentlichen Repos **deaktiviert GitHub geplante Workflows nach
  60 Tagen ohne Aktivität im Repo** (vorher kommt eine Warn-Mail).
  Dann unter Actions wieder aktivieren.
- Andere URLs, z. B. für Staging: Repo-Variablen `CLEO_API_URL` und
  `CLEO_WEB_URL` (gelten für Uptime; `CLEO_API_URL` auch für den
  Kosten-Check).

## Was tun bei welchem Alarm?

Den Titel des Alarms siehst du im fehlgeschlagenen Run ganz oben unter
„Annotations“.

### Modal spend limit reached

Renders schlagen fehl, bis das Limit erhöht ist (genau das hat am
28.09.2026 die Produktion lahmgelegt).

1. **Modal Dashboard → Settings → Usage** → Spend-Limit des Workspace
   erhöhen.
2. **Actions → Ops watch → Run workflow**. Der Job *Modal can render*
   muss grün werden.
3. Danach schauen, *warum* das Limit erreicht war: Modal Dashboard →
   Usage (welche App, welcher Tag) und `/admin/costs` (siehe
   Kosten-Alarm). Renders, die in der Zeit fehlgeschlagen sind, stehen
   auf Fehler und müssen neu gestartet werden.

### Modal refused the call (resource exhausted)

Meist ebenfalls das Spend-Limit, sonst ein Rate-Limit. Erst Settings →
Usage prüfen, dann in ein paar Minuten den Workflow erneut starten.

### Modal rejected the token

Token widerrufen oder abgelaufen. **Modal Dashboard → Settings → API
Tokens** → neues Token anlegen und `MODAL_TOKEN_ID` /
`MODAL_TOKEN_SECRET` an **beiden** Stellen ersetzen: GitHub (Settings →
Secrets and variables → Actions) **und** Railway (Backend-Service →
Variables, danach neu deployen).

### Modal app cleocuts-render not found

Die Render-App ist nicht deployt (oder wurde gestoppt). **Actions →
Deploy Modal render → Run workflow** (diagnose *nicht* anhaken) oder
lokal `modal deploy backend/modal_render.py`.

### Modal did not run the probe / Modal probe hung / Could not reach Modal

1. status.modal.com prüfen.
2. Modal Dashboard → Apps → `cleocuts-render`: hängende Aufrufe,
   abstürzende Container? Und Settings → Usage (Spend-Limit).
3. **Actions → Deploy Modal render → Run workflow mit diagnose
   angehakt**: Das zeigt App-Status und die letzten Fehlerzeilen.
4. Ein einzelner Netzwerkfehler kann Zufall sein. Run wiederholen.

### Modal probe failed

Modal hat den Aufruf angenommen und einen Container gestartet, aber der
ist abgestürzt oder der Aufruf ist mit einem unerwarteten Fehler
gescheitert (der Fehlertext steht in Klammern hinter der Annotation).
Meist ein kaputter Deploy der Render-App, z. B. ein fehlendes Paket im
Image oder eine geänderte Signatur von `render_burn_concat`. Renders
schlagen dann ebenfalls fehl.

1. **Actions → Deploy Modal render → Run workflow mit diagnose
   angehakt**: Die Fehlerzeilen aus den Modal-Logs zeigen, woran der
   Container scheitert. Modal Dashboard → Apps → `cleocuts-render`
   zeigt dasselbe.
2. Kam der Alarm nach einem Deploy: den letzten funktionierenden Stand
   wieder deployen. Entweder den kaputten Commit auf `main` per
   `git revert` rückgängig machen (der Push deployt automatisch) oder
   lokal den guten Commit auschecken und `modal deploy
   backend/modal_render.py`.
3. **Actions → Ops watch → Run workflow**. Der Job *Modal can render*
   muss grün werden.
4. Kein Deploy vorher: status.modal.com prüfen und den Run wiederholen.

### Modal client missing

Nur ein Setup-Fehler im Workflow: `pip install modal` ist im Runner
fehlgeschlagen oder fehlt. Modal selbst ist nicht betroffen. Den
fehlgeschlagenen Schritt *Install the Modal client* im Log ansehen und
den Run wiederholen.

### API not ready

Im Log steht direkt darunter `/health`:
- **`/health` = 200, `/ready` nicht**: Das Backend läuft, aber die
  **Datenbank** antwortet nicht (Postgres/Volume auf Railway).
  `curl -s https://api.cleocuts.com/ready` zeigt `db_timeout` oder
  `db_error`. Railway → Datenbank-Service: läuft er, ist der Speicher
  voll? Siehe DEPLOY.md §8.
- **beides down**: Das Backend ist weg. Railway → Backend-Service →
  Deployments/Logs: abgestürzt, Deploy fehlgeschlagen,
  Speicher/Volume voll? Notfalls den letzten funktionierenden Deploy
  erneut ausrollen (Redeploy). Railway-Status: status.railway.com.

### Web app down

Railway ist hier nicht beteiligt. **Vercel → Projekt → Deployments**:
Ist der letzte Deploy kaputt, den vorherigen per **Instant Rollback /
Promote to Production** zurückholen. Sonst DNS/Domain in Cloudflare und
vercel-status.com prüfen.

### Spend above COST_ALERT_USD_PER_DAY

Die Verarbeitung der letzten 24 h hat mehr gekostet als das Limit
(Obergrenze, siehe oben). Die Zahlen stehen absichtlich **nicht** im
öffentlichen Log. Schau sie dir **lokal** an (nie in einem Workflow):

```bash
export CLEO_ADMIN_TOKEN=…   # derselbe Wert wie auf Railway
curl -s -H "X-Admin-Token: $CLEO_ADMIN_TOKEN" \
  https://api.cleocuts.com/admin/costs | python3 -m json.tool | less
```

Die `rows` sind nach `usd_all_in` absteigend sortiert. `owner_id` zeigt,
ob ein einzelner Account (Missbrauch? Endlosschleife?) dahintersteckt,
`usd` die Aufteilung (Modal, Groq, Claude, Speicher, Egress).
- Missbrauch oder Fehler: Nutzer sperren bzw. Bug fixen. Die harte
  Kostengrenze für Modal bleibt das Modal-Spend-Limit.
- Erwartetes Wachstum: Limit anheben unter **Settings → Secrets and
  variables → Actions → Secrets → New repository secret** (bzw. das
  vorhandene aktualisieren): `COST_ALERT_USD_PER_DAY`, Zahl in USD,
  z. B. `25`. Ohne Secret gilt 10. **Keine Repo-Variable** nehmen: deren
  Wert stünde bei jedem Run im öffentlichen Log. Nebenwirkung des
  Secrets: GitHub zeigt dieselbe Zahl überall im Log dieses Jobs als
  `***`. Das ist harmlos.

### Cost guard could not run

Der Text der Annotation sagt, was fehlt:
- **401**: Das GitHub-Secret `CLEO_ADMIN_TOKEN` stimmt nicht mit dem auf
  Railway überein. Beide auf denselben Wert setzen.
- **404** auf `/admin/costs`: `CLEO_ADMIN_TOKEN` ist auf Railway nicht
  gesetzt (dann ist der Endpoint aus).
- **failed twice (HTTP 5xx / Netzwerk)**: API down, siehe Uptime-Alarm.
- **Can't tell the last 24 h apart**: Weder `GET /jobs` noch
  `GET /jobs/status` hat geantwortet (siehe „Kosten-Check“ oben). Meist
  ist die API gerade gestört; sonst die Zeitstempel in `/admin/costs`
  aufnehmen (siehe unten).
- **not configured / misconfigured**: Secret `CLEO_ADMIN_TOKEN` fehlt,
  oder das Secret `COST_ALERT_USD_PER_DAY` ist keine positive Zahl.

## Uploads abgelehnt? ("Ops inspect")

Jede Ablehnung der Upload-Routen (multipart init / sign / complete,
presign, POST /jobs) wird als `upload_refused`-Event gespeichert: Code,
Größe, Länge, freier Platz, Reservierungen, laufende Uploads/Analysen —
ohne Nutzerdaten (nur ein Hash). Ansehen: GitHub → Actions → **Ops
inspect (live backend)** → *Run workflow* (liest `GET /admin/capacity`
mit dem Secret `CLEO_ADMIN_TOKEN`; das Log zeigt nur Zahlen und Codes).

| Ausgabe | Bedeutung | Tun |
|---|---|---|
| `DISK: … server_storage_full`, `ROOM: … does not fit` | das Volume (`CLEO_TMP_ROOT`) ist für das Video zu klein | Railway-Volume vergrößern, oder `CLEO_TMP_ROOT` auf die Container-Platte legen (DEPLOY.md 10.6) |
| `RATE: … too_many_uploads` | `CLEO_UPLOAD_INITS_PER_HOUR` erreicht | Limit anheben |
| `QUEUE: … server_busy` | mehr als `CLEO_MAX_QUEUE` Analysen warten | `CLEO_MAX_ANALYZE` / Queue prüfen |
| `LEAK?: …` | Upload-Plätze ohne Worker, älter als 10 min | verfallen nach `CLEO_UPLOAD_ENTRY_TTL_S` (2 h) von selbst |

## Task-Warteschlange (WP4, nur mit `CLEO_TASK_QUEUE=1`)

Die Warteschlange (DEPLOY.md Abschnitt 11) hat noch keinen eigenen
GitHub-Check; beobachtet wird über das Railway-Log und
`GET /admin/queue` (Header `X-Admin-Token`: Zähler pro Art, Alter des
ältesten wartenden Tasks, Breaker, führender Prozess). Für den späteren
Alarm-Ausbau (WP6) sind das die Signale:

| Log-Zeile / Wert | Bedeutung | Tun |
|---|---|---|
| `[queue] ingest: queued N (oldest S s), running R/L; render: …` (alle 5 min) | Lage der Warteschlange | `oldest` über ~10 min bei `running` < Limit → Dispatcher hängt: Log nach `[leader]` durchsuchen, notfalls Backend neu starten (nichts geht verloren) |
| `[leader] … leads …` | dieser Prozess führt (nach jedem Start genau einmal) | — |
| `[leader] LEADERSHIP LOST` | die Leader-Verbindung zu Postgres ist weg | kommt sie nicht binnen einer Minute wieder (`leads`), Postgres prüfen |
| `[leader] took over: N job(s) …` | beim Start liegengebliebene Jobs neu eingereiht oder abgeschlossen | nur nach Umschalten/Restore erwartet |
| `[reaper] task … lease expired … → queued` | ein Worker ist verschwunden (Deploy, Absturz, Hänger); der Task läuft erneut | gelegentlich normal; häufig → Worker hängen |
| `… → dead` (ERROR) | ein Task hat alle Versuche verbraucht: Analyse → Fehler + Erstattung, Render → zurück in den Editor | Job-ID ansehen (Kosten-Test-Workflow, `inspect_jobs`) |
| `[finalizer] task … not settled yet` | Abschluss eines Tasks scheiterte (meist DB), wird alle 2 s wiederholt | wiederholt über Minuten → Datenbank prüfen |
| `[groq] BREAKER OPEN until …` (ERROR) | Groq lehnt ab (Stundenkontingent / 429-Serie); Analysen warten, nach 30 min Fehler + Erstattung | Groq-Konsole: Kontingent/Tier; `CLEO_GROQ_ASH_BUDGET` senken |
| `[groq] audio budget: … analyses wait` | das eigene Stundenbudget ist voll, Analysen warten | nur Stoßzeiten; dauerhaft → Tier erhöhen, dann Budget anheben |
| `[llm] SPEND LIMIT hit in …` / `[llm] SPEND LIMIT REACHED — breaker open` (ERROR) | Anthropic-Ausgabenlimit erreicht; Analysen warten (danach ohne LLM-Schritte, `processing_warnings`), Renders ohne Hooks/Caption | Anthropic Console → Limits/Billing erhöhen; der Breaker prüft stündlich selbst |
| `[worker] PROTOCOL MISMATCH` / `SCHEMA BEHIND` (ERROR) | Deploy-Versatz zwischen API und Worker; wird wiederholt | nur kurz nach Deploys erwartet |
| `[queue] NOT STARTING` | `CLEO_EXECUTOR_*=modal` in einer Version ohne Modal-Executor | Variable löschen |

## Was kosten die Checks?

**GitHub Actions**: Für öffentliche Repos sind Standard-Runner
kostenlos und unbegrenzt. Zur Einordnung: Uptime sind 144 Runs/Tag à
unter 1 Min, Ops watch 4 Runs/Tag mit 2 Jobs à 1 bis 4 Min. **Falls das
Repo je privat wird**: Uptime allein wären ca. 4.300 abgerechnete
Minuten/Monat, mehr als die 2.000 Freiminuten von GitHub Free. Dann den
Cron auf `*/30` stellen oder Uptime deaktivieren.

**Modal-Probe** (Modal-Listenpreise, keine Region, nicht
„non-preemptible“, beides nutzt `modal_render.py` nicht): Der Aufruf
belegt einen Container mit der Reservierung der Funktion, also 8 Cores
und 8 GiB:

- 8 × 0,0000131 $/Core·s + 8 × 0,00000222 $/GiB·s = **0,000123 $/s**
  (≈ 0,44 $/h)
- Start + Abbruch dauern ca. 5 bis 15 s → **0,001 bis 0,002 $**
- Modal rechnet danach noch das Idle-Fenster bis zum Herunterfahren ab
  (Standard 60 s, `modal_render.py` setzt kein `scaledown_window`) →
  im ungünstigsten Fall ≈ 75 s ≈ **0,009 $ pro Probe**
- 4 Probes/Tag ≈ 120/Monat → **höchstens ≈ 1,10 $/Monat**, meist
  weniger (läuft gerade ein warmer Container, wird der wiederverwendet).
  Das zählt gegen das Modal-Spend-Limit. Jeder manuelle Diagnose-Run
  kostet dasselbe.

**Kosten-Check und Uptime**: Nur ein paar HTTP-Requests (288 pro Tag
gegen API und Vercel, 2 Admin-Requests alle 6 h, mit ausgeschalteten
Accounts und Gesamtsumme über dem Limit zusätzlich 1 Request je 50 Jobs
an `/jobs/status`). Das ist vernachlässigbar.

## Optional: Zeitstempel in `/admin/costs`

Mit `created_at`/`updated_at` in jeder Zeile von `/admin/costs` braucht
der Kosten-Check weder `GET /jobs` noch `GET /jobs/status` (ein Request
statt mehrerer). In `backend/main.py`, `admin_costs()`, im
`rows.append({...})`:

```python
            "created_at": job.created_at or None,
            "updated_at": job.updated_at or None,
```
