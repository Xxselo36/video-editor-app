# Cleo Deploy Guide — Phase 4

Target stack:
- **Backend** → Railway (Docker, persistent volume, ~$5-10/Mo)
- **Frontend** → Vercel (Next.js, free hobby tier)
- **Domain** → Cloudflare Registrar (~$10/Jahr)
- **DNS** → Cloudflare

You do the clicking, I help when you hit issues. Stop at any step and ask.

---

## 0. Vorbereitung: Code auf GitHub pushen

Aktuell sind `web/`, `backend/`, `.dockerignore` und ~20 modifizierte
Files **uncommitted**. Railway zieht direkt aus GitHub — also erst pushen.

In deinem Terminal:

```bash
cd /Users/selimalcibuga/video-editor-app

# 1) nuitka-crash-report.xml ist kein Repo-Inhalt — gitignoren
echo "nuitka-crash-report.xml" >> .gitignore
git rm --cached nuitka-crash-report.xml 2>/dev/null || true

# 2) Alles inszenieren (web/, backend/, modifizierte src/, plugins/, etc.)
git add -A

# 3) Commit
git commit -m "Web app phase 2-4: Next.js frontend + FastAPI backend + LLM layer"

# 4) Pushen
git push origin main
```

→ **Sag mir Bescheid wenn `git push` durch ist** oder Errors kommen.

---

## 1. Domain registrieren (Cloudflare Registrar)

**Empfehlung**: `cleo.video` (~$25/Jahr) ist on-brand. Alternativen falls
vergeben:

| Domain | Cost/Jahr | Vibe |
|---|---|---|
| **cleo.video** | ~$25 | Direkt, beschreibt das Tool |
| **cleo.app** | ~$15 | Premium, modern |
| **usecleo.com** | ~$10 | Safe fallback, sprechfreundlich |
| **trycleo.com** | ~$10 | Marketing-ready ("Try Cleo") |
| **hellocleo.com** | ~$10 | Friendly vibe |

**Schritte:**
1. Account auf https://dash.cloudflare.com/ — wenn nicht schon vorhanden
2. Im Dashboard links: **Registrar** → **Register Domain**
3. Such-Feld: dein Wunschname (z.B. `cleo`) → Cloudflare zeigt verfügbare
   TLDs an mit Preisen
4. Pick deinen → **Add to cart** → Checkout (Kreditkarte/PayPal)
5. Nach Kauf: Domain steht unter "Websites" im Dashboard

→ **Sag mir welche Domain du gekauft hast** — ich konfiguriere DNS + CORS.

---

## 2. Backend auf Railway deployen

### 2.1 Account + Projekt anlegen

1. https://railway.com/ → **Login with GitHub** (gleicher Account wie Repo)
2. Im Dashboard: **+ New Project** → **Deploy from GitHub repo**
3. Repo wählen: `Xxselo36/video-editor-app`
4. Railway detected den Dockerfile in `backend/Dockerfile` →
   bestätigt das Service-Setup

### 2.2 Service-Settings

In Railway → dein Projekt → Service "video-editor-app":

**Tab "Settings":**

- **Watch Paths**: `backend/**`, `src/**`, `plugins/**`
  (Re-Deploy nur wenn diese Files sich ändern, spart Bandwidth)
- **Root Directory**: `/` (Repo root — Dockerfile baut von dort)
- **Dockerfile Path**: `backend/Dockerfile`
- **Start Command**: leer lassen (Dockerfile's CMD reicht)
- **Healthcheck Path**: `/health`
- **Healthcheck Timeout**: 300 (Whisper-Modell-Download dauert beim Boot)
- **Restart Policy**: `Always` (Railway-Default ist "On Failure" mit
  max. 10 Versuchen — danach bleibt der Service tot, bis jemand von Hand
  neu deployt; mit Postgres siehe 8.2 "Sicherung gegen Split-Brain")

**Tab "Variables"** (Env-Vars):

```
ANTHROPIC_API_KEY = <dein neuer Anthropic-Key>
CLEO_CACHE_DIR    = /data/cache
CLEO_ALLOWED_ORIGINS = https://cleocuts.com,https://www.cleocuts.com
PYTHONUNBUFFERED  = 1
```

> **Wichtig:** der Anthropic-Key im Chat ist geleakt — auf
> https://console.anthropic.com/settings/keys den alten löschen, neuen
> erstellen, hier eintragen.

**Tab "Volumes":**

- **+ New Volume**
- Mount Path: `/data`
- Size: 10 GB (skaliert später)

### 2.3 Deploy starten

- Settings → **Deploy** → grüner Button
- Erster Build dauert **8-15 min** (torch + opencv runterladen)
- Logs unter "Deployments" beobachten — bei "Application startup
  complete" ist's online

### 2.4 Public Domain holen

- Service → **Settings → Networking → Generate Domain**
- Du kriegst eine URL wie `cleo-production-xxxx.up.railway.app`
- Test: `curl https://<railway-url>/health` → sollte `{"status":"ok"}`
  zurückgeben

→ **Sag mir die Railway-URL** — ich passe Frontend-Config an.

---

## 3. Frontend auf Vercel deployen

### 3.1 Account + Projekt

1. https://vercel.com/ → **Login with GitHub**
2. **Add New → Project** → Repo `Xxselo36/video-editor-app`
3. **Configure Project:**
   - **Framework Preset**: Next.js (auto-detected)
   - **Root Directory**: `web`  ← wichtig! das Repo hat Multi-Apps
   - **Build Command**: leer lassen (Vercel detected)
   - **Output Directory**: leer lassen

### 3.2 Environment Variable

Bei "Environment Variables":

```
NEXT_PUBLIC_BACKEND_URL = https://<deine-railway-url>
```

(z.B. `https://cleo-production-xxxx.up.railway.app` — die URL aus
Schritt 2.4)

### 3.3 Deploy

- **Deploy**-Button
- Dauert ~1-2 min
- Test: `https://<projekt>.vercel.app` öffnen → siehst Cleo-Landing
- Probier mal: kleiner Upload → Backend muss antworten

→ Wenn der Test funktioniert, weiter zu DNS.

---

## 4. Domain auf Vercel + Railway zeigen lassen

### 4.1 Vercel-Custom-Domain (Frontend)

1. Vercel → Projekt → **Settings → Domains**
2. **Add** → `cleo.video` (oder dein Domain-Name) → **Add**
3. Vercel zeigt dir DNS-Records die du eintragen musst (typisch
   ein A-Record auf 76.76.21.21 + AAAA auf 2606:4700::6810:1521 oder
   ein CNAME bei Subdomain).

### 4.2 Railway-Custom-Domain (Backend)

1. Railway → Service → **Settings → Networking → Custom Domain**
2. **+ Custom Domain** → `api.cleo.video` (Subdomain für Backend)
3. Railway zeigt dir den CNAME-Wert (z.B.
   `cleo-production-xxxx.up.railway.app`)

### 4.3 DNS-Records in Cloudflare setzen

1. Cloudflare Dashboard → deine Domain → **DNS → Records**
2. Records hinzufügen:

```
Type  | Name | Target                          | Proxy
------|------|---------------------------------|-------
CNAME | @    | cname.vercel-dns.com            | OFF
CNAME | www  | cname.vercel-dns.com            | OFF
CNAME | api  | <railway-target-aus-4.2>        | OFF
```

> **Proxy OFF** wichtig: sonst zickt's bei TLS-Cert-Ausstellung. Kannst
> du später (nach grünem Cert) auf "Proxied" stellen für Caching/DDoS.

### 4.4 Auf Cert + Propagation warten

- Vercel-Domain: ~5 min, dann grüner Haken
- Railway-Domain: ~5 min, dann grüner Haken
- Test: `curl https://api.cleo.video/health` → `{"status":"ok"}`
- Test: `https://cleo.video` → Cleo-Landing

→ **Sag mir wenn beide grün sind**, ich update die Frontend-Env-Var
auf die finale Domain.

---

## 5. Frontend-Env auf Custom-Domain umstellen

1. Vercel → Projekt → **Settings → Environment Variables**
2. `NEXT_PUBLIC_BACKEND_URL` → bearbeiten → `https://api.cleo.video`
3. **Redeployments → Redeploy** (Latest Deployment → 3-dot-menu)

---

## 6. End-to-End-Test

iPhone Safari → `https://cleo.video` → fertig:
- Sicheres HTTPS (Schloss-Symbol)
- Upload-Flow durchspielen
- Download-Outputs

---

## Häufige Probleme

| Symptom | Lösung |
|---|---|
| Railway Build OOM (Out-of-memory) | Service → Settings → Resources → RAM auf 4 GB |
| Whisper lädt ewig beim ersten Job | Normal — Modell wird gecacht, danach schnell |
| CORS-Error im Browser | `CLEO_ALLOWED_ORIGINS` enthält deine Vercel-Domain? |
| Vercel-Build "next.js not found" | Root-Directory war nicht `web/` |
| `cleo.video` lädt nicht | DNS-Propagation kann bis 30 min dauern |

---

## Kosten-Schätzung

| Posten | Cost/Monat |
|---|---|
| Railway Backend (1 GB RAM, 1 vCPU, 10 GB volume) | ~$8-12 |
| Vercel Hobby | $0 |
| Cloudflare Domain | ~$1 (jährlich abgerechnet) |
| Cloudflare DNS | $0 |
| Anthropic API (~100 Videos) | ~$0.40 |
| **Total** | **~$10-15** |

Für **Test-Phase mit <50 Usern** völlig safe.

---

## 7. Accounts (Clerk) + Abos (Lemon Squeezy) — Backend-Env-Vars

Alles ist **aus**, solange die Variablen fehlen — dann läuft das Backend
exakt wie bisher (anonym, Job-ID reicht). Vier Schalter, jeder setzt den
vorherigen voraus:

| Schalter | Backend (Railway) | Wirkung |
|---|---|---|
| **AUTH** | `CLERK_ISSUER` | Clerk-Login Pflicht, Jobs gehören einem Account |
| **BILLING** | AUTH + `LEMONSQUEEZY_API_KEY`, `_STORE_ID`, `_WEBHOOK_SECRET`, mind. eine `LEMONSQUEEZY_VARIANT_<PLAN>` | Checkout, Portal, Minuten-Anzeige — niemand wird blockiert |
| **ENFORCE** | `CLEO_BILLING_ENFORCE=1` | Upload nur mit aktivem Abo + genug Minuten (402) |
| **Comp** | `CLEO_COMP_USERS` | diese Accounts bekommen Studio gratis |

### 7.1 Reihenfolge beim Einschalten

0. **Clerk-Production-Instanz fertig:** Domain in Clerk angelegt, die
   DNS-Records (siehe 7.2) in Cloudflare gesetzt und in Clerk als
   verifiziert angezeigt. Sonst lädt Clerk ab Schritt 1 nicht, und
   `/app` zeigt allen nach ~15 s nur "Couldn't load sign-in" / "Die
   Anmeldung konnte nicht geladen werden" — der Editor ist dann für
   alle weg.
1. **Frontend** mit Clerk-Keys deployen (`NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`
   **und** `CLERK_SECRET_KEY` auf Vercel — immer beide zusammen), dann
   **Redeploy** (`NEXT_PUBLIC_*` wird beim Build eingebacken). **Ab jetzt
   ist Login für `/app` Pflicht** — das entscheidet das Frontend allein,
   egal was das Backend macht. Das Backend ignoriert die Tokens noch.
2. **Backend** `CLERK_ISSUER` setzen → das Backend verlangt Login und
   ordnet Jobs Accounts zu. Beta-Projekte (ohne Besitzer) übernimmt der
   erste eingeloggte User, der sie öffnet. `/app?job=…`-Links
   funktionieren danach nur noch für den Besitzer.
3. **Backend** Lemon-Squeezy-Variablen setzen → Billing an. Die
   Billing-UI (Preise, Konto-Seite, Minuten) ist seit Schritt 1 im
   Frontend und folgt `GET /billing/config` von selbst — dafür muss im
   Frontend nichts neu deployt werden.
4. Erst wenn Checkout + Webhook getestet sind: `CLEO_BILLING_ENFORCE=1`.
5. Optional, erst nach 3: `NEXT_PUBLIC_BILLING_ENABLED=1` auf Vercel +
   Redeploy. Ändert nur die Landing-Page (Badge "Open beta · free" →
   Link zu den Preisen).

Umgekehrte Reihenfolge = User bekommen 401/402 ohne UI dafür.

### 7.1b Ausschalten / Rollback

Genau andersherum, damit niemand 401 ohne Login-UI bekommt:

1. `CLEO_BILLING_ENFORCE` entfernen (niemand wird mehr blockiert).
2. **Backend** `CLERK_ISSUER` entfernen → Backend wieder anonym (Job-ID
   reicht, wie in der Beta).
3. **Frontend** `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` + `CLERK_SECRET_KEY`
   (und ggf. `NEXT_PUBLIC_BILLING_ENABLED`) auf Vercel entfernen →
   Redeploy.

Was dabei mit den Projektlisten passiert: Mit Accounts liegen die
Listen im Browser pro User (`cleo-library-v1:<user-id>` usw.). Nach dem
Ausschalten führt die Web-App sie beim ersten Laden wieder in die
anonyme Liste des Geräts zusammen — auf einem geteilten Gerät sieht
man dann (wie in der Beta) alle Projekte, die dort je angelegt wurden.
Die Server-Liste (`GET /jobs`) gibt es ohne Accounts nicht; Projekte,
die nur auf einem anderen Gerät angelegt wurden, tauchen also nicht
auf. Abos und Minuten bleiben in der DB und gelten wieder, sobald
Accounts wieder an sind.

### 7.2 Variablen

**Clerk (Backend)**

```
CLERK_ISSUER             = https://clerk.cleocuts.com
                           (Clerk Dashboard → API Keys → "Frontend API URL";
                            Dev-Instanz: https://<slug>.clerk.accounts.dev)
CLERK_AUTHORIZED_PARTIES = https://cleocuts.com,https://www.cleocuts.com
                           (Origins der Web-App; Default zusätzlich
                            http://localhost:3000. LAN-Handy-Test:
                            http://192.168.x.y:3000 ergänzen)
CLERK_JWT_KEY            = empfohlen für Production: PEM-Public-Key
                           (Dashboard → API Keys → "JWT public key"). Dann
                           prüft das Backend Tokens ohne Netz. Ohne: Keys
                           per JWKS von Clerk (5 min gecacht) — ist Clerk
                           beim Start nicht erreichbar, schlägt Login fehl.
CLERK_SECRET_KEY         = sk_live_… — die E-Mail-Adresse der User (Clerk
                           Backend API; Session-Tokens enthalten keine).
                           Nötig für E-Mail-Einträge in CLEO_COMP_USERS /
                           CLEO_BILLING_TESTERS (ohne passen nur Clerk-IDs;
                           Log-Warnung beim Start) und vorbelegt im Checkout.
CLEO_MEDIA_SECRET        = empfohlen: langer Zufallswert (openssl rand -hex 32)
                           für die ?t=-Tokens der Video-/Bild-URLs. Ohne:
                           wird einmal erzeugt und in der DB gespeichert.
CLEO_ADMIN_TOKEN         = wie bisher; mit AUTH an zusätzlich der
                           Service-Zugang (Header X-Admin-Token: sieht alle
                           Jobs, kein Minutenlimit, darf _cost_test setzen)
```

> **Cost-Test:** `.github/scripts/cost_test.py` schickt `X-Admin-Token`
> bisher nur an `/admin/costs`. Mit AUTH an muss er ihn an **alle**
> Requests hängen, sonst 401.

Production-Clerk braucht DNS-Records in Cloudflare (**DNS only**, graue
Wolke): `clerk` + `accounts` (CNAME) und die Mail-CNAMEs `clkmail`,
`clk._domainkey`, `clk2._domainkey` — Werte zeigt Clerk an.

**Lemon Squeezy (Backend)**

```
LEMONSQUEEZY_API_KEY         = API-Key (Test- und Live-Keys sind getrennt!)
LEMONSQUEEZY_STORE_ID        = numerische Store-ID
LEMONSQUEEZY_WEBHOOK_SECRET  = Signing Secret des Webhooks
LEMONSQUEEZY_VARIANT_STARTER = Variant-ID (nicht die "pending"-Default-Variante)
LEMONSQUEEZY_VARIANT_PRO     = …
LEMONSQUEEZY_VARIANT_STUDIO  = …
                               Neue Variante (z.B. Preisänderung): die neue
                               VORNE anhängen, die alte dahinter lassen:
                               `900001,795658` — verkauft wird die erste,
                               Bestandskunden der alten behalten ihren Plan.
                               Eine Variante mit Abonnenten nie einfach
                               entfernen: deren Abos gewähren dann keinen
                               Plan mehr.
LEMONSQUEEZY_TEST_MODE       = 1 → nur Test-Abos zählen, Checkouts im Test-
                               Modus (zum Durchspielen auf Production mit
                               Testkarte). Checkout dann NUR für
                               CLEO_BILLING_TESTERS / CLEO_COMP_USERS (alle
                               anderen: 403) — sonst bekäme jeder mit der
                               öffentlichen Testkarte 4242… einen Plan.
                               Nicht dauerhaft auf einer öffentlichen
                               Seite lassen. Sonst zählen nur Live-Abos.
CLEO_BILLING_TESTERS         = user_2abc…,ich@example.com — dürfen im
                               Test-Modus kaufen (wie CLEO_COMP_USERS:
                               Clerk-IDs oder E-Mails)
CLEO_APP_URL                 = https://cleocuts.com (Redirect nach dem Kauf:
                               /app/account?billing=success)
CLEO_BILLING_ENFORCE         = 1 → Uploads brauchen Abo + Minuten
CLEO_COMP_USERS              = user_2abc…,freund@example.com (Clerk-IDs
                               oder E-Mails → Studio gratis; E-Mails nur
                               mit CLERK_SECRET_KEY)
CLEO_PLAN_MINUTES_STARTER    = optional, Default 90 (Pro 300, Studio 900)
```

In Lemon Squeezy:
- Starter/Pro/Studio als **Varianten eines Produkts** (monatlich), damit
  Kunden im Customer Portal den Plan wechseln können.
- **Keine License Keys** für diese Varianten aktivieren: `src/license.py`
  (SmartCut Desktop) akzeptiert jeden gültigen Key aus dem Store, ohne
  Produkt zu prüfen — ein CleoCuts-Key würde SmartCut freischalten.
- Webhook: URL `https://api.cleocuts.com/billing/webhook`, Events
  `subscription_created`, `_updated`, `_cancelled`, `_resumed`,
  `_expired`, `_paused`, `_unpaused`, `subscription_payment_success`,
  `_payment_failed`, `_payment_recovered`. Test- und Live-Modus brauchen
  je einen eigenen Webhook (+ Secret), Variant-IDs unterscheiden sich
  zwischen den Modi.

### 7.3 Betrieb

- **Billing braucht eine persistente DB.** Liegt die SQLite-DB auf `/tmp`
  (kein `/data`, kein `CLEO_JOB_DB`, kein Postgres), bleibt Billing aus —
  Log beim Start: `[billing] !!! BILLING DISABLED: the job DB is on /tmp …`,
  `GET /billing/config` meldet `"reason": "db_not_persistent"`. Mit
  Postgres (Abschnitt 8) ist das erfüllt.
- **Backup:** Abos lassen sich aus der LS-API neu aufbauen, das
  Minuten-Ledger (`usage`-Tabelle) nicht → mit Postgres: nächtliches
  Backup nach R2 + Railway-Backups (Abschnitt 8.4); ohne:
  Railway-Volume-Backups für `/data/cleo_jobs.db` einschalten.
- **Verlorene Webhooks** (z.B. während eines Deploys): das Backend
  gleicht stündlich alle Abos mit der LS-API ab und beim Aufruf von
  `/me`, wenn ein Abo veraltet aussieht. Notfalls im LS-Dashboard
  → Webhooks → "Resend".
- **R2:** Lifecycle-Regel auf `uploads/` (z.B. 2 Tage) für hochgeladene,
  aber nie gestartete Dateien. Keys sind jetzt `uploads/<user-id>/…`.
- Minuten werden **einmal beim Upload** abgebucht (Länge per ffprobe,
  sekundengenau), nach der Analyse nachberechnet, wenn das Video länger
  war (auch wenn die Analyse danach scheitert, z.B. "No speech
  detected"), und nur bei Serverfehlern (voller Speicher, Neustart,
  ffmpeg) erstattet. Mit `CLEO_BILLING_ENFORCE` wird nie mehr analysiert
  als abgebucht (+5 s): die Länge im Datei-Header kann gefälscht sein.
  Rendern kostet nichts extra. Ein Downgrade ändert die Aufbewahrung
  bestehender Projekte nicht.
- **Käufe ohne unseren Checkout** (gehostete Buy-Links, Dashboard)
  werden keinem Account zugeordnet: die User-ID in den Custom Data muss
  vom Backend signiert sein. Kauft jemand trotzdem so, im LS-Dashboard
  erstatten.

### 7.4 Neue Endpoints (Kurzüberblick)

| Endpoint | Zweck |
|---|---|
| `GET /me` | User, Plan, Abo, Minuten, `media_token` (AUTH aus: `{"auth_enabled": false}`) |
| `GET /jobs` | alle Projekte des Users, neueste zuerst (intern in Seiten à 200 gelesen; AUTH aus: 404 `not_available`) |
| `GET /billing/config` | öffentlich: Billing an?, Pläne + Preise |
| `POST /billing/checkout` | `{plan}` → `{url}`; 409 `already_subscribed` → Portal |
| `GET /billing/portal` | frische Customer-Portal-URL |
| `POST /billing/webhook` | Lemon Squeezy (HMAC-signiert) |

Entfernt: `/uploads/multipart/*` und `/jobs/{id}/source-video` (vom
Frontend nie benutzt).

---

## 8. Postgres (`DATABASE_URL`)

Sobald `DATABASE_URL` gesetzt ist, ist **Postgres die Quelle der
Wahrheit** für Jobs, User, Abos, Minuten-Ledger (`usage`),
Webhook-Events und `meta` (Media-/Checkout-Secret). Ohne bleibt alles
wie bisher auf SQLite (`/data/cleo_jobs.db`) — das bleibt für lokale
Entwicklung, Tests und als Fallback. Code: `backend/db.py` (Auswahl +
Umstieg), `backend/pg.py` (Pool, Schema, Stores), `backend/pg_cutover.py`
(Kopie SQLite → Postgres), `backend/pg_backup.py` (Backups).

### 8.1 Variablen (Railway → Backend-Service)

```
DATABASE_URL           = ${{Postgres.DATABASE_URL}}
                         (Railway-Referenz auf den Postgres-Service, privates
                          Netz, direkte Verbindung — so lassen. Neon & Co.:
                          die DIREKTE URL nehmen, nicht die "pooled"; siehe
                          unten)
CLEO_DB_BACKEND        = leer lassen (= Postgres, wenn DATABASE_URL gesetzt).
                         sqlite   → SQLite erzwingen (Rollback, siehe 8.3)
                         postgres → Postgres Pflicht: ohne DATABASE_URL
                                    startet das Backend nicht
CLEO_DB_POOL_MAX       = optional, Default 10 Verbindungen pro Prozess
CLEO_DB_BOOT_WAIT_S    = optional, Default 180: so lange wartet ein Boot
                         nach dem Umzug auf ein nicht erreichbares Postgres
                         (Retry mit Backoff), bevor er abbricht (8.2)
CLEO_PG_BACKUP_KEEP_DAYS = optional, Default 14 (Backups in R2, 8.4)
```

Verbindung: Pool (1–`CLEO_DB_POOL_MAX`), 5 s Connect-Timeout,
`statement_timeout` 15 s, jede Schreiboperation in einer eigenen
Transaktion. `GET /ready` prüft die DB über den Pool.

**Kurzer Postgres-Ausfall** (Restart/Redeploy des Postgres-Service):
Requests scheitern, solange Postgres weg ist (`/ready` → 503). Der Pool
baut danach binnen Sekunden neu auf (Reconnect-Zyklen à 20 s statt
wachsender Pausen bis 2 min). Analyse-/Render-Worker wiederholen ihre
Status-Schreibvorgänge bis zu 3 min; hält der Ausfall länger, wird eine
fertige Analyse als unser Fehler gewertet (Fehler + Minuten zurück), ein
Render geht zurück in den Review. Ein Job, dessen Worker dabei ganz
ausgestiegen ist, wird vom stündlichen Retention-Loop nach 10 min ohne
Änderung aufgeräumt wie bei einem Neustart (`[jobs] settled … running
job(s) whose worker is gone`) — nicht erst beim nächsten Deploy.

**Pooled URL / PgBouncer (Transaction-Pooling):** `statement_timeout`
15 s und die Zeitzone UTC setzt das Backend per `SET` einmal pro
Verbindung (Session-Ebene). Hinter einem Transaction-Pooler landet jede
Transaktion auf irgendeiner Server-Verbindung — die Einstellungen gelten
dort **nicht** (der 15-s-Timeout fehlt still), und sie können auf fremde
Verbindungen durchschlagen. Deshalb die direkte URL nehmen. Geht es nur
über den Pooler, die Werte auf der Rolle setzen (einmal, in der
Postgres-Konsole; `<user>` = der User aus der URL):

```sql
ALTER ROLE <user> SET statement_timeout = '15s';
ALTER ROLE <user> SET timezone = 'UTC';
```

**Weiterhin `--workers 1`** (Dockerfile) und **ein** Replica: die DB ist
jetzt mehrprozess-sicher (Row-Locks, Compare-and-set, Advisory-Locks für
das Minutenkonto, UNIQUE auf dem Upload-Key), aber Warteschlange,
Admission-Control und die Reihenfolge der Editor-Speicherungen sind noch
Prozess-Speicher, und der Boot-Check würde die laufenden Jobs eines
zweiten Workers als "interrupted" markieren. Das ändert erst die
DB-Task-Queue (WP4).

### 8.2 Automatischer Umzug (erster Boot mit `DATABASE_URL`)

Nichts manuell kopieren. Ablauf:

1. Railway: **+ New → Database → PostgreSQL** im selben Projekt.
2. Backend-Service → Variables: `DATABASE_URL = ${{Postgres.DATABASE_URL}}`
   → Deploy. **Das Volume `/data` bleibt gemountet** — daraus wird kopiert.
3. Beim Start (vor allem anderen): Schema anlegen, dann — nur wenn in
   Postgres `meta.migrated_from_sqlite` fehlt — unter einem globalen Lock
   **alle Tabellen in EINER Transaktion kopieren**, prüfen (Zeilen pro
   Tabelle; pro User die Summe der nicht erstatteten `seconds_billed`),
   Marker setzen, committen. Dauert Sekunden bis ~1 min (5k Jobs ≈
   250 MB); der Healthcheck-Timeout (300 s) reicht.
4. Die SQLite-Datei wird **nicht** umbenannt oder gelöscht (read-only
   Backup). Daneben entsteht `/data/cleo_jobs.db.migrated-to-postgres`.

**Im Log prüfen** (Deployments → Logs):

```
[db] applied schema migration(s) [1]
[db] migrated SQLite → Postgres (postgres.railway.internal:5432/railway):
     meta=3, users=…, subscriptions=…, usage=…, billing_events=…, jobs=…,
     job_keys=… The SQLite file stays as a read-only backup: /data/cleo_jobs.db
[db] backend: postgres (postgres.railway.internal:5432/railway, pool max 10, schema v1)
```

Bei jedem späteren Boot nur noch die letzte Zeile. Gegenprobe in der
Postgres-Konsole (Railway → Postgres → Data/Query):

```sql
SELECT value FROM meta WHERE key = 'migrated_from_sqlite';  -- Zeit + Zählungen
SELECT count(*) FROM jobs;  SELECT count(*) FROM usage;
```

**Wenn der Umzug scheitert**, läuft das Backend normal weiter — auf
SQLite, für diese Prozess-Laufzeit. In Postgres ist dann nichts
geschrieben (Rollback); der nächste Boot versucht es erneut. Drei Arten:

1. **Eine Zeile ist kaputt** — nur dann nennt die Meldung eine Zeile und
   endet auf `fix or delete it in SQLite`:

   ```
   [db] MIGRATION FAILED — staying on SQLite: jobs row 'abc123def456' can't be read (…) — fix or delete it in SQLite
   ```

   Das gibt es nur bei Datenfehlern: die Zeile ist kein JSON / kein Job
   (`can't be read`), ein Wert passt nicht (`usage row '…': usage.created_at:
   … is not a Unix time`), wir konnten sie nicht schreiben (Python-Fehler
   beim Umwandeln, `DataError`), oder Postgres lehnt sie als Daten ab
   (SQLSTATE-Klasse 22 "data exception", z.B. `InvalidTextRepresentation`,
   oder 23 "integrity constraint", z.B. `UniqueViolation`). Dann diese
   Zeile in SQLite reparieren oder löschen — über die Railway-Shell:
   `python -c "import sqlite3; c = sqlite3.connect('/data/cleo_jobs.db'); c.execute(\"DELETE FROM jobs WHERE id = 'abc123def456'\"); c.commit()"`
   (löscht das Projekt eines echten Users: vorher `SELECT data …` ansehen)
   und neu deployen/restarten.
2. **Postgres oder die Verbindung ist ausgefallen** (Verbindung weg,
   `QueryCanceled`, `AdminShutdown`, `DiskFull`, `PoolTimeout`, …) —
   dann nennt die Meldung **keine** Zeile:

   ```
   [db] MIGRATION FAILED — staying on SQLite: copying jobs to Postgres failed (OperationalError: …) — the database or the connection failed, not a row: nothing was committed and nothing needs fixing in SQLite; the next boot tries again
   ```

   **Nichts in SQLite löschen** — an den Daten liegt es nicht. Postgres
   wieder zum Laufen bringen (bei `DiskFull`: Postgres-Volume
   vergrößern; der Umzug schreibt etwa das Doppelte der SQLite-Größe,
   WAL eingerechnet) und neu starten.
3. **Die SQLite-Datei selbst ist nicht lesbar** (beschädigte Seite auf
   dem Volume) — keine Zeile, und Postgres ist nicht schuld:

   ```
   [db] MIGRATION FAILED — staying on SQLite: reading jobs from SQLite failed (DatabaseError: database disk image is malformed) — the SQLite file can't be read, not Postgres: nothing was committed. A damaged file fails every boot like this until it is checked (PRAGMA integrity_check) and repaired or restored (DEPLOY.md 8.2)
   ```

   Ein Neustart hilft hier **nicht** — jeder Boot scheitert gleich, und
   das Backend läuft solange auf der beschädigten Datei weiter (soweit
   sie lesbar ist). Über die Railway-Shell prüfen:
   `python -c "import sqlite3; print(sqlite3.connect('/data/cleo_jobs.db').execute('PRAGMA integrity_check').fetchall())"`.
   Dann die Datei reparieren — Kopie ziehen, lokal
   `sqlite3 kopie.db .recover | sqlite3 gerettet.db`, Zählungen
   vergleichen (was auf der kaputten Seite stand, fehlt danach), die
   gerettete Datei bei gestopptem Backend nach `/data/cleo_jobs.db`
   legen (alte `cleo_jobs.db-wal` / `-shm` daneben entfernen) — oder ein
   Volume-Backup zurückspielen — und neu deployen.

`Postgres table … already has rows but meta.migrated_from_sqlite is
missing` heißt: `DATABASE_URL` zeigt auf eine benutzte Datenbank — eine
leere nehmen.

Ohne SQLite-Datei (frisches Deployment ohne Volume) wird nur das Schema
angelegt (`[db] fresh Postgres database …`). **Achtung:** fehlt beim
ersten Boot versehentlich das Volume, gilt die Datenbank danach als
"fresh" und es wird später nichts mehr kopiert — dann den Postgres-Inhalt
leeren (neue Datenbank) und mit Volume neu starten.

**Sicherung gegen Split-Brain:** Die `.migrated-to-postgres`-Datei wird
**vor** dem Commit des Umzugs geschrieben (fsync, zuerst als "pending");
scheitert das (z.B. Volume voll), wird nichts committet und der Boot
bleibt auf SQLite. Solange die Datei existiert:

- Ist Postgres beim Boot nicht erreichbar, versucht es der Boot
  `CLEO_DB_BOOT_WAIT_S` lang (Default 180 s, Backoff bis 30 s) weiter und
  bricht dann ab (`[db] NOT STARTING: [db] Postgres (…) failed and this
  deployment was already cut over …`) — statt still auf der veralteten
  SQLite-Kopie zu laufen. Railway startet den Container danach **nur
  gemäß Restart Policy** neu: mit dem Default ("On Failure", max. 10
  Versuche) ist nach ~10 × 3 min Schluss und der Service bleibt aus, bis
  jemand neu deployt. Deshalb Restart Policy `Always` (2.2) — dann läuft
  das Backend von selbst wieder an, sobald Postgres zurück ist.
- Zeigt `DATABASE_URL` auf eine Datenbank **ohne** Umzugs-Marker (neu
  angelegt, geleert, falsche Referenz), startet der Boot **nicht** — egal
  ob die SQLite-Datei noch da ist: die alte SQLite-Kopie wird nicht
  erneut importiert (sie hätte gelöschte Projekte, verbrauchte Minuten
  und alte Abos zurückgebracht), und ohne SQLite-Datei wird die leere
  Datenbank nicht als "fresh" übernommen (alle Projekte, Minuten und
  Abos wären scheinbar weg, alle signierten Media-Links kaputt). Log:
  `[db] NOT STARTING: [db] refusing to start: Postgres (…) has no cutover
  marker but … says this SQLite file was already migrated …`. Abhilfe:
  `DATABASE_URL` auf die richtige Datenbank zeigen lassen oder ein Backup
  einspielen (8.4) — bei einem Restore erst `DATABASE_URL` umstellen,
  wenn der Restore durch ist. Nur wer den alten Stand bewusst importieren
  (bzw. ohne SQLite-Datei bewusst leer anfangen) will, löscht die Datei
  (8.3).

Nicht die `.migrated-to-postgres`-Datei löschen, um einen Boot-Abbruch
zu "reparieren".

Scheitert der Umzug in einem Prozess, prüft er vor dem Rückfall auf
SQLite noch einmal Postgres (wartet dabei auf einen gerade kopierenden
anderen Prozess): hat inzwischen jemand umgezogen, läuft er auf
Postgres. Ist er doch auf SQLite gelandet und zieht später ein anderer
Prozess um, beendet er sich (`[db] !!! another process cut over to
Postgres …`, Exit 1); der Neustart läuft auf Postgres.

### 8.3 Rollback

`CLEO_DB_BACKEND=sqlite` setzen → Deploy: das Backend läuft wieder auf
`/data/cleo_jobs.db` (Log: `[db] !!! WARNING: running on SQLite …`).
**Nur direkt nach dem Umzug sinnvoll:** alles, was seit dem Umzug in
Postgres geschrieben wurde (neue Jobs, Abos, Minuten), ist in SQLite
**nicht** enthalten und wird nicht zurückkopiert. Umgekehrt landet, was
während des Rollbacks in SQLite geschrieben wird, beim Zurückschalten
nicht in Postgres (der Marker ist gesetzt). Für einen zweiten, sauberen
Umzug: neue leere Postgres-Datenbank, `.migrated-to-postgres`-Datei
löschen, `CLEO_DB_BACKEND` entfernen, deployen.

### 8.4 Backups + Restore

- **Automatisch:** mit Postgres **und** R2 (`R2_*`-Variablen) lädt das
  Backend einmal pro 24 h (stündliche Prüfung im Retention-Loop, genau
  ein Prozess) einen logischen Dump nach
  `backups/pg/<YYYY-MM-DD>.sql.gz` in den R2-Bucket (alle Tabellen, eine
  konsistente Momentaufnahme) und löscht Dumps älter als 14 Tage. Log:
  `[backup] backups/pg/2026-09-28.sql.gz: 12.3 MB, rows {…}`; Fehler:
  `[backup] Postgres backup FAILED: …` (nächste Stunde neuer Versuch).
  Der Dump enthält auch das Media-/Checkout-Secret → Bucket privat halten.
- **Zweite Ebene:** Railway → Postgres-Service → **Backups** aktivieren
  (Volume-Snapshots, Zeitplan täglich/wöchentlich).
- **Sofort ein Backup:** Railway-Shell des Backends:
  `python -m backend.pg_backup run` (nach R2) oder
  `python -m backend.pg_backup export /tmp/now.sql.gz` (Datei).

**Restore** (in eine **leere** Datenbank — nie über die laufende):

1. Dump holen: `python -m backend.pg_backup list`, dann
   `python -m backend.pg_backup download backups/pg/2026-09-28.sql.gz /tmp/b.sql.gz`
   (oder im Cloudflare-Dashboard herunterladen).
2. Leere Datenbank anlegen (Railway: neuer Postgres-Service, oder
   `CREATE DATABASE restore_0928;` auf dem bestehenden Server).
3. Einspielen — eins von beiden:
   `gunzip -c /tmp/b.sql.gz | psql "<NEUE_URL>" -v ON_ERROR_STOP=1`
   oder `DATABASE_URL="<NEUE_URL>" python -m backend.pg_backup restore /tmp/b.sql.gz`
   (legt das Schema selbst an; bricht ab, wenn die Ziel-DB nicht leer ist).
4. Backend-`DATABASE_URL` auf die neue Datenbank zeigen lassen, deployen.
   Der Dump enthält den Umzugs-Marker → es wird nichts erneut aus SQLite
   kopiert. Log: `[db] backend: postgres (…)`.


## 9. Fehlerberichte (Sentry), Sicherheits-Header, Modal-Grenzen

### 9.1 Sentry (aus, bis ein DSN gesetzt ist)

- **Backend (Railway):** `SENTRY_DSN` = DSN eines Sentry-*Python*-Projekts.
  Optional `SENTRY_ENVIRONMENT` (sonst `RAILWAY_ENVIRONMENT_NAME`) und
  `SENTRY_TRACES_SAMPLE_RATE` (leer/0 = kein Tracing, bleibt im Gratis-Kontingent).
  Log beim Start ohne DSN: nichts; mit DSN und fehlendem Paket: eine Warnung.
- **Website (Vercel):** `NEXT_PUBLIC_SENTRY_DSN` (eigenes *Browser*-Projekt),
  danach neu deployen (`NEXT_PUBLIC_*` wird beim Build eingebacken).
- **Beide zusammen ein- oder ausschalten:** die Datenschutzseite nennt die
  Fehlerberichte, sobald `NEXT_PUBLIC_SENTRY_DSN` gesetzt ist.
- In Sentry je Projekt: *Settings → Security & Privacy* → "Prevent Storing
  of IP Addresses" und den serverseitigen "Data Scrubber" einschalten.
- Gemeldet werden: unerwartete Fehler in Requests, fehlgeschlagene Analysen
  und Renders (Tag `phase`, `job_id`) und fehlgeschlagene LS-Webhooks.
  Tokens, E-Mails, Query-Strings und Request-Bodies werden vorher entfernt
  (`backend/observability.py`).

### 9.2 Sicherheits-Header

Kommen immer, ohne Variable: Backend über `backend/security_headers.py`
(nosniff, no-referrer, DENY, HSTS, `Cross-Origin-Resource-Policy:
cross-origin`), Website über `web/next.config.ts` (CSP, HSTS, …). Wer der
Website eine neue externe Quelle hinzufügt (Skript, Bild, API), muss sie in
der CSP in `web/next.config.ts` erlauben.

### 9.3 Modal-Render: Zeitgrenzen (Defaults passen, nur bei Bedarf setzen)

| Variable | Default | Wirkung |
|---|---|---|
| `CLEO_MODAL_POLL_S` | 10 | so oft wird auf das Ergebnis gewartet/geprüft |
| `CLEO_MODAL_DEADLINE_S_BASE` / `_PER_S` / `_MAX` | 240 / 6 / 3720 | Render-Frist: 240 s + 6 × Videolänge, höchstens 62 min (Modal-Timeout von `render_r2`: 60 min) → `render_timeout` |
| `CLEO_MODAL_START_TIMEOUT_S` | 120 | Aufruf nach 120 s nicht gestartet → `render_unavailable` (0 = aus) |
| `CLEO_MODAL_HEARTBEAT_S` | 300 | Lebenszeichen am Job während langer Renders (0 = aus) |
| `CLEO_MODAL_TRANSFER_S_MAX` | 3600 | Obergrenze für Upload/Download zu Modal |
| `CLEO_MODAL_TRANSFER_IDLE_S` | 300 | Download bricht ab, wenn so lange keine Daten kommen |
| `MODAL_MAX_THROTTLE_WAIT` | 60 | wie lange der Modal-Client bei Drosselung wartet |

Ist das Modal-Budget erschöpft (Spend Limit), schlagen Renders sofort mit
`render_unavailable` fehl, der Job geht zurück in den Editor, der Nutzer
kann später erneut rendern. Überwachung und Alarme: `OPERATIONS.md`.


## 10. Media storage (R2)

Mit R2 liegt **jedes Byte eines Jobs in R2** — Upload, Mezzanine
(`mezz.mp4`, die Render-Quelle), Editor-Proxy, Vorschauen, Renders,
Thumbnail — und nichts mehr auf dem Railway-Volume. Media-Routen
(`/jobs/{id}/proxy-video|preview-video|watch|download|thumbnail`) prüfen
Login + Besitz und antworten mit **307 auf eine presigned R2-URL**
(Range geht, kein Byte läuft über Railway). Uploads gehen direkt vom
Browser nach R2, **fortsetzbar** (Multipart, Stand im IndexedDB des
Browsers). `POST /jobs` antwortet in ~1 s, egal wie groß die Datei ist
(HEAD + Längen-Probe über den Header); die Analyse lädt die Datei selbst.
Der Modal-Render (`render_r2`) liest und schreibt R2 direkt.

**Aus, bis konfiguriert:** ohne `R2_*`-Variablen läuft alles wie bisher
auf der lokalen Platte (Media-Backend `local`: gleiche Keys unter
`<CLEO_WORK_ROOT>/media`). Code: `backend/storage.py` (R2-Client),
`backend/media.py` (die Media-API des Backends), `backend/uploads.py`
(Upload-Tickets), `backend/r2_backfill.py`, `backend/r2_setup.py`,
`web/src/lib/chunkedUpload.ts`.

### 10.1 Variablen und Schalter (Railway → Backend-Service)

```
R2_ACCOUNT_ID          = Cloudflare Account-ID
R2_ACCESS_KEY_ID       = API-Token "cleocuts-api" (Object Read & Write, nur
R2_SECRET_ACCESS_KEY     dieser Bucket) — siehe 10.2
R2_BUCKET              = cleocuts-media  (Staging: cleocuts-media-staging)

CLEO_MEDIA_BACKEND     = leer lassen (= r2, wenn R2_* gesetzt; sonst local).
                         local → Medien auf der lokalen Platte (Rollback, 10.5)
                         r2    → R2 Pflicht: ohne R2_* startet das Backend
                                 nicht ("[media] NOT STARTING")
CLEO_UPLOAD_MODE       = multipart (Default) | single
                         single → /uploads/multipart/init antwortet 409
                         use_single_put, die Website lädt per einfachem
                         presigned PUT hoch (Kill-Switch, sofort, ohne Deploy)
CLEO_TMP_ROOT          = /tmp/cleo (Default; Container-Platte, NICHT das
                         Volume): Analyse-Arbeitsordner, Proxy-Cache,
                         Legacy-Uploads (≤ 100 MB) auf dem Weg nach R2
CLEO_PROXY_CACHE_GB    = 5: lokaler LRU-Cache der Editor-Proxies für die
                         Vorschau-Neubauten (/edit-segments)
CLEO_PROBE_WORKERS     = 4: parallele Längen-Proben (ffprobe über presigned
                         URL) in POST /jobs, eigener Thread-Pool
CLEO_BACKFILL          = 1 → der stündliche Loop verschiebt alte lokale Jobs
                         nach R2 (je CLEO_BACKFILL_BATCH=5 Jobs, höchstens
                         CLEO_BACKFILL_MBPS=40 MB/s; fehlende Proxies werden
                         erzeugt, außer CLEO_BACKFILL_MAKE_PROXY=0) — 10.4
CLEO_MODAL_RENDER_FN   = leer (= render_r2). render_burn_concat → der alte
                         Volume-Weg (Rollback, 10.5)
CLEO_MEDIA_ROOT        = nur Media-Backend local: Ordner der Keys
                         (Default <CLEO_WORK_ROOT>/media)
R2_ENDPOINT_URL        = nur Tests / lokaler S3-Ersatz (Default
                         https://<R2_ACCOUNT_ID>.r2.cloudflarestorage.com)
```

`boto3`/`botocore` sind auf eine Minor-Version gepinnt
(`backend/requirements.txt`): die tagesgenauen presigned URLs (gleiche URL
den ganzen UTC-Tag, 48 h gültig ab 00:00Z → Browser-Cache trifft) nutzen
botocore-Interna. Beim Anheben beide zusammen, dann
`pytest backend/tests/test_wp3_storage.py`.

### 10.2 Einrichtung (in dieser Reihenfolge)

**Achtung:** Sind `R2_*` auf Railway schon gesetzt (der bisherige
Direkt-Upload per `/uploads/presign` nutzt sie), schaltet schon der
Deploy dieses Codes die Medien auf R2 und die Renders auf `render_r2`.
Dann die Schritte 1–6 **vor** dem Deploy erledigen — oder vorher
`CLEO_MEDIA_BACKEND=local` setzen und es nach Schritt 6 wieder löschen.

1. **Bucket** je Umgebung: `cleocuts-media`, `cleocuts-media-staging`
   (Cloudflare → R2 → Create bucket). Privat lassen, **r2.dev-Zugriff
   aus**, keine Custom Domain (presigned URLs gehen nur über
   `<account>.r2.cloudflarestorage.com`). Den bestehenden `R2_BUCKET`
   weiter zu nutzen geht auch — dann dort die Regeln unten setzen. Die
   Postgres-Backups (8.4) liegen im selben Bucket unter `backups/` und
   sind von keiner Regel unten betroffen.
2. **Tokens** (R2 → Manage API tokens):
   - "cleocuts-api": *Object Read & Write*, nur dieser Bucket →
     Railway: `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`,
     `R2_BUCKET` (**noch nicht deployen**, erst Schritt 3–6).
   - Gleiche Rechte für Modal (eigener Token oder derselbe):
     ```
     modal secret create cleocuts-r2 R2_ACCOUNT_ID=… R2_ACCESS_KEY_ID=… \
         R2_SECRET_ACCESS_KEY=… R2_BUCKET=…
     ```
   - Ein Bucket-Admin-Token ("Workers R2 Storage Write" / Admin Read &
     Write) **nur auf dem eigenen Rechner** für CORS und Lifecycle — nie
     deployen.
3. **CORS** (Bucket → Settings → CORS policy, oder mit dem Admin-Token
   `aws s3api put-bucket-cors --bucket cleocuts-media --endpoint-url
   https://<account>.r2.cloudflarestorage.com --cors-configuration
   file://cors.json`). `python -m backend.r2_setup --print-config`
   druckt beide JSONs (im Dashboard nur die Liste in `CORSRules`
   einfügen):
   ```json
   {"CORSRules":[{"AllowedOrigins":["https://cleocuts.com","https://www.cleocuts.com"],
     "AllowedMethods":["GET","HEAD","PUT"],"AllowedHeaders":["content-type","range"],
     "ExposeHeaders":["ETag","Content-Length","Content-Range","Accept-Ranges"],"MaxAgeSeconds":7200}]}
   ```
   Staging zusätzlich: die Vercel-Preview-Origin(s),
   `http://localhost:3000`, `http://localhost:3123`
   (`--print-config --origins https://…,http://localhost:3000,…`).
   `<video>`, `<img>` und Download-Links brauchen kein CORS — nur die
   Upload-PUTs.
4. **Lifecycle** (`aws s3api put-bucket-lifecycle-configuration … 
   --lifecycle-configuration file://lifecycle.json`):
   ```json
   {"Rules":[
    {"ID":"uploads-expire-2d","Status":"Enabled","Filter":{"Prefix":"uploads/"},"Expiration":{"Days":2}},
    {"ID":"uploads-abort-mpu-1d","Status":"Enabled","Filter":{"Prefix":"uploads/"},"AbortIncompleteMultipartUpload":{"DaysAfterInitiation":1}},
    {"ID":"jobs-abort-mpu-2d","Status":"Enabled","Filter":{"Prefix":"jobs/"},"AbortIncompleteMultipartUpload":{"DaysAfterInitiation":2}}]}
   ```
   **Keine** Alters-Regel auf `jobs/`: R2 zählt das Objektalter, die
   Aufbewahrung zählt die Untätigkeit — ein Studio-Projekt, das vor 120
   Tagen angelegt und letzten Monat bearbeitet wurde, verlöre sonst seine
   Medien. Gelöscht wird über `media_gc` (10.6).
5. **Prüfen** (mit dem API-Token, lokal mit den Railway-Werten als
   Env-Vars): `python -m backend.r2_setup --check --origin
   https://cleocuts.com` — HeadBucket, put/get/Range/delete, ein
   2-Teile-Multipart über presigned Part-URLs (plus ein PUT mit falscher
   Länge, der **abgelehnt** werden muss), presigned GET von heute und
   gestern 00:00Z (→ 206), CORS-Preflight. Muss "all checks passed"
   melden.
6. **Modal deployen** (neue Funktion `render_r2`, Image mit boto3):
   `modal deploy backend/modal_render.py` — mit dem Secret aus Schritt 2,
   sonst schlägt der Deploy fehl. `render_burn_concat` und das Volume
   bleiben (Rollback).
7. **Railway deployen** mit den Variablen aus Schritt 2 und — beim ersten
   Mal — `CLEO_UPLOAD_MODE=single` (10.3). Im Log: `[media] backend: r2
   (bucket …)`.

### 10.3 Rollout

1. **Staging:** Bucket + 10.2 komplett, `r2_setup --check`, dann ein
   Burst (20 Uploads in 60 s mit mehreren GB: POST /jobs p95 < 1,5 s,
   kein ENOSPC) und die Geräte-Checkliste (iOS Safari 17/18, Android
   Chrome: 2-GB-4K-HEVC aus Fotos mit Flugmodus bei ~50 % → setzt fort;
   Tab beendet + Datei neu gewählt → setzt fort; Proxy-Wiedergabe und
   Springen im Editor über 307; Download öffnet).
2. **Produktion mit `CLEO_UPLOAD_MODE=single`:** alles andere von WP3 ist
   aktiv — Medien und Renders laufen über R2, der Backfill läuft (10.4),
   Uploads noch per einfachem PUT.
3. **Nach 2 Tagen ohne Auffälligkeiten:** `CLEO_UPLOAD_MODE=multipart`
   (oder die Variable löschen). 48 h lang die `[upload] …`-Zeilen im Log
   beobachten (Retries / Fehlschläge einzelner Parts mit User-Agent).

### 10.4 Backfill (alte Jobs vom Volume nach R2)

Nach dem Deploy liegen neue Jobs in R2; alte werden weiter von der Platte
ausgeliefert. Umziehen (Railway → Service → Shell, oder
`railway run`):

```
python -m backend.r2_backfill --dry-run          # was, wie viel, ~Egress
python -m backend.r2_backfill                    # für echt (--limit N, --job ID,
                                                 #  --max-mbps 40)
```

Pro Job (neueste zuerst, laufende übersprungen): Quelle, `mezz.mp4`,
Proxy (fehlt er, wird er erzeugt: ~27 CPU-s pro Videominute, einmalig),
Vorschau, Renders unter `r1/` (hart verlinkte Formate nur **einmal**
hochgeladen), Thumbnail, Hook-Clips; dann HEAD jedes Keys gegen die
lokale Größe und erst dann die Keys am Job setzen. Idempotent: ein
zweiter Lauf tut nichts. Am Ende eine Zusammenfassung mit
`local_only_left` — **Ziel: 0**. Alternativ `CLEO_BACKFILL=1` setzen:
der stündliche Loop erledigt es in kleinen Portionen (danach wieder
entfernen). Grob 5 GB insgesamt ≈ $0,25 Railway-Egress.

Frühestens **7 Tage später** die lokalen Dateien löschen:

```
python -m backend.r2_backfill --delete-local --dry-run
python -m backend.r2_backfill --delete-local
```

Löscht nur bei Jobs, deren Keys per HEAD mit der gespeicherten Größe
bestätigt sind. Das Volume selbst fällt erst in WP6 weg (zusammen mit
dem SQLite-Backup).

### 10.5 Rollback

- **Uploads:** `CLEO_UPLOAD_MODE=single` — sofort, ohne Deploy.
- **Render:** `CLEO_MODAL_RENDER_FN=render_burn_concat` → der alte
  Volume-Weg (Mezzanine rüber zum Modal-Volume, Ergebnisse zurück, dann
  nach R2). Geht, solange `render_burn_concat` deployed ist (bis WP4).
- **Medien:** `CLEO_MEDIA_BACKEND=local` ist **nur sicher, bevor neue
  Jobs Medien ausschließlich in R2 haben** (also direkt nach dem ersten
  Deploy). Danach gilt: ein Code-Rollback liefert die alten lokalen Jobs
  weiter aus, aber Jobs mit R2-Medien brauchen diesen Code — also nicht
  auf eine Version vor WP3 zurückrollen, sondern vorwärts reparieren.

### 10.6 Betrieb

- **Löschen ist eine Warteschlange** (Tabelle `media_gc`): Projekt
  löschen / Aufbewahrung abgelaufen → Zeile + Objekte `jobs/{id}/` und
  der Upload werden sofort versucht, sonst alle 5 min erneut.
  Überholte Renders (`r{g}/`) und Vorschau-Versionen erst nach 24 h
  (jemand streamt sie evtl. noch). Log `[media] deleted …`; schlägt
  es 10× fehl: **`[media] GC STUCK — …`** (Fehler-Level, geht an Sentry).
- **Wöchentlicher Waisen-Check:** `jobs/{id}/`-Präfixe ohne Job, deren
  neuestes Objekt > 2 Tage alt ist, kommen in `media_gc`. `uploads/`
  räumt die Lifecycle-Regel ab.
- `GET /admin/costs`: Speicher aus `media_bytes` der Jobs (R2-Preis),
  plus alte lokale Dateien.
- `media_gc` ist nicht Teil der Postgres-Backups; nach einem Restore
  findet der Waisen-Check die Präfixe gelöschter Jobs.

### 10.7 Kosten (R2: $0,015/GB-Monat, Class A $4,50/M, Class B $0,36/M, Egress frei; gratis: 10 GB, 1 M A, 10 M B pro Monat)

Pro 2-Minuten-SmartCam-Job ≈ 0,51 GB gespeichert (Mezzanine 318 MB,
Renders 90, Proxy ≈ 20, Vorschau 19, Hooks ≤ 83) ≈ $0,0077/Monat;
≈ 40 Class-A- und 300–600 Class-B-Operationen < $0,0005. Der Railway-Egress
für Wiedergabe und Downloads (≈ 0,35 GB pro Videominute) entfällt; die
Analyse läuft in WP3 noch auf Railway (≈ 0,6 GB Egress pro 2-min-Job
beim Hochladen der Ergebnisse, ≈ $0,03).

| Videominuten / Monat | Speicher (schlank, §13) | Class A | Class B | gesamt |
|---|---|---|---|---|
| 1.000 | $3,7 ($2,1) | gratis | gratis | ≈ $4 |
| 10.000 | $38 ($22) | gratis (≈ 0,2 M) | gratis (≈ 2,5 M) | ≈ $38 |
| 100.000 | $383 ($225) | ≈ $5 | ≈ $5 | ≈ $390 |

### 10.8 Key-Layout

```
uploads/{user}/{uuid32}{ext}   Browser-Upload (ohne Accounts: uploads/{uuid32}{ext})
jobs/{id}/source{ext}          Quelle, die nicht über uploads/ kam (Legacy-Upload ≤ 100 MB, Backfill)
jobs/{id}/mezz.mp4             Render-Quelle (normalisiert bzw. SmartCam; 1-s-GOP, +faststart)
jobs/{id}/proxy.mp4            ≤ 720p-Proxy der Mezzanine, gleiche Zeitachse (Editor)
jobs/{id}/preview/v{n}.mp4     serverseitige Schnitt-Vorschau, Version n
jobs/{id}/r{g}/primary.mp4     Render-Generation g = 1, 2, … (nie wiederverwendet)
jobs/{id}/r{g}/{fmt}.mp4       weitere Formate (":"→"x", z. B. 16x9.mp4); gleiche Größe wie
                               primary → derselbe Key
jobs/{id}/r{g}/hook_{k}.mp4    Hook-Clips
jobs/{id}/r{g}/thumb.jpg       Thumbnail
backups/pg/…                   Postgres-Backups (8.4), von nichts hier berührt
```

Keys sind unveränderlich: ein Key, auf den ein Job zeigt, wird nie
überschrieben; eine neue Version bekommt einen neuen Key (daher
`Cache-Control: private, max-age=31536000, immutable` auf allen Objekten
unter `jobs/`).
