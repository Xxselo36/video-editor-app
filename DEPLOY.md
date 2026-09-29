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
  Empfohlen: `R2_BACKUP_BUCKET` = ein eigener Bucket nur für die Dumps
  (gleicher Account, der Railway-Token braucht Zugriff) — dann kann der
  Modal-Token (nur Media-Bucket, 10.2) die Backups nicht lesen. `list`
  und `download` unten nehmen automatisch diesen Bucket.
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
| `CLEO_MODAL_DEADLINE_S_BASE` / `_PER_S` / `_PER_GB` / `_MAX` | 240 / 6 / 60 / 3720 | Render-Frist: 240 s + 6 × Videolänge + 60 s pro GB Mezzanine, höchstens 62 min → `render_timeout`. Modal selbst bricht `render_r2` nach 60 min ab, `render_burn_concat` (der Default-Weg) schon nach **30 min** |
| `CLEO_MODAL_START_TIMEOUT_S` | 120 | Aufruf nach 120 s nicht gestartet → `render_unavailable` (0 = aus) |
| `CLEO_MODAL_HEARTBEAT_S` | 300 | Lebenszeichen am Job während langer Renders (0 = aus) |
| `CLEO_MODAL_TRANSFER_S_MAX` | 3600 | Obergrenze für Upload/Download zu Modal |
| `CLEO_MODAL_TRANSFER_IDLE_S` | 300 | Download bricht ab, wenn so lange keine Daten kommen |
| `MODAL_MAX_THROTTLE_WAIT` | 60 | wie lange der Modal-Client bei Drosselung wartet |

Ist das Modal-Budget erschöpft (Spend Limit), schlagen Renders sofort mit
`render_unavailable` fehl, der Job geht zurück in den Editor, der Nutzer
kann später erneut rendern. Überwachung und Alarme: `OPERATIONS.md`.


## 10. Media storage (R2)

**Kurz:** Dieser Code *kann* jedes Byte eines Jobs in R2 halten
(Upload, Mezzanine `mezz.mp4`, Editor-Proxy, Vorschauen, Renders,
Thumbnail) und Renders direkt aus R2 machen (`render_r2` auf Modal).
**Nach dem Merge ist aber alles aus.** Jeder Teil wird einzeln mit einer
Railway-Variable eingeschaltet — und genauso wieder aus. Solange keine
dieser Variablen gesetzt ist, verhält sich die App für Nutzer wie vorher:
Medien auf dem Railway-Volume, Render über den bisherigen Modal-Weg
(`render_burn_concat`), Upload per einfachem PUT.

**Wichtigste Regel:** Jeder Job merkt sich, *wo* seine Medien liegen
(Feld `media_store`: `local` oder `r2`). `CLEO_MEDIA_BACKEND` entscheidet
nur, wohin die Medien **neuer** Jobs kommen. Umschalten in beide
Richtungen ist deshalb jederzeit sicher: alte Jobs werden weiter von dort
ausgeliefert, wo sie liegen. Einzige Bedingung: **Solange es Jobs mit
Medien in R2 gibt, müssen die `R2_*`-Variablen gesetzt bleiben** (fehlen
sie, antworten deren Medien-Links mit 503, nichts wird gelöscht).

Code: `backend/storage.py` (R2-Client), `backend/media.py` (Medien-API,
Speicherort pro Job), `backend/uploads.py` (Upload-Tickets),
`backend/r2_backfill.py`, `backend/r2_setup.py`,
`web/src/lib/chunkedUpload.ts`.

### 10.1 Alle Schalter auf einen Blick (Railway → Backend-Service → Variables)

Achtung: **Jede Änderung einer Railway-Variable startet das Backend neu**
(= ein Deploy). Laufende Analysen brechen dabei ab (Minuten werden
erstattet, der Nutzer lädt neu hoch), laufende Renders gehen zurück in
den Editor. Darum Schalter nur umlegen, wenn gerade niemand hochlädt
oder rendert (Railway-Log: keine `[job …]`-Zeilen der letzten Minuten),
am besten nachts.

| Variable | Default (nicht gesetzt) | Eingeschaltet | Zurück |
|---|---|---|---|
| `CLEO_MEDIA_BACKEND` | `local`: neue Jobs auf dem Volume | `r2`: neue Jobs in R2 (ohne `R2_*` startet das Backend nicht: `[media] NOT STARTING`) | Variable löschen: neue Jobs wieder lokal, R2-Jobs bleiben in R2 |
| `CLEO_MODAL_RENDER_FN` | `render_burn_concat` (bisheriger Weg) | `render_r2`: Jobs mit Medien in R2 rendern direkt aus R2 (lokale Jobs immer auf dem alten Weg). Fehlt `render_r2` auf Modal, wird automatisch der alte Weg genommen | Variable löschen |
| `CLEO_PROXY_VIDEO` | aus: `/jobs/{id}/proxy-video` → 404, der Editor spielt wie bisher die Vorschau | `1`: Editor spielt den 720p-Proxy direkt | Variable löschen |
| `CLEO_UPLOAD_MODE` | `single`: einfacher presigned PUT wie bisher; `init`, `parts`, `sign` antworten 409 `use_single_put` | `multipart`: fortsetzbare Uploads | Variable löschen — auch Browser mitten in einem fortgesetzten Upload wechseln dann auf den einfachen PUT |
| `CLEO_MEDIA_PRESIGN` | `day`: R2-Links gleich für den ganzen UTC-Tag (Browser-Cache) | `standard`: normale presigned URLs (falls R2/ein Gerät die tagesgenauen ablehnt) | Variable löschen |
| `CLEO_TMP_ROOT` | `<CLEO_WORK_ROOT>/tmp`, also **auf dem Volume** (wie bisher) | z. B. `/tmp/cleo` (Container-Platte) — erst nach Prüfung, 10.6 | Variable löschen |
| `CLEO_BACKFILL` | aus | `1`: stündlich ein paar alte Jobs nach R2 verschieben (10.5) | Variable löschen |
| `CLEO_MEDIA_ORPHAN_SWEEP` | aus | `1`: wöchentlicher Waisen-Check (10.7) | Variable löschen |
| `R2_BACKUP_BUCKET` | Postgres-Backups im Media-Bucket (`backups/pg/`) | eigener Bucket für die Backups (empfohlen, 10.2 Schritt 1) | Variable löschen |

Weitere, nur bei Bedarf: `CLEO_BACKFILL_BATCH` (5 Jobs pro Stunde),
`CLEO_BACKFILL_MBPS` (40), `CLEO_BACKFILL_MAKE_PROXY` (1; 0 = fehlende
Proxies nicht erzeugen), `CLEO_MEDIA_ORPHAN_MAX` (200 Präfixe pro Lauf),
`CLEO_PROXY_CACHE_GB` (5), `CLEO_PROBE_WORKERS` (4),
`CLEO_MODAL_DEADLINE_S_PER_GB` (60, siehe 9.3), `CLEO_MEDIA_ROOT`
(Ordner der lokalen Medien, Default `<CLEO_WORK_ROOT>/media`),
`R2_ENDPOINT_URL` (nur Tests).

Außerhalb von Railway:
- **Modal-Secret `cleocuts-r2`** (10.2 Schritt 4): ohne es wird nur
  `render_burn_concat` deployt (die GitHub-Action prüft das selbst und
  warnt). Beim Deploy von Hand: `CLEO_MODAL_R2=1 modal deploy
  backend/modal_render.py` (mit Secret) bzw. ohne die Variable (ohne).
- **GitHub → Settings → Secrets and variables → Actions → Variables:**
  `CLEO_MODAL_RENDER_FN` — immer denselben Wert wie auf Railway, damit
  der Modal-Check (ops-watch, alle 6 h) die Funktion prüft, die wirklich
  benutzt wird.

`boto3`/`botocore` sind auf eine Minor-Version gepinnt
(`backend/requirements.txt`): die tagesgenauen presigned URLs nutzen
botocore-Interna. Beim Anheben beide zusammen, dann
`pytest backend/tests/test_wp3_storage.py`.

### 10.2 Reihenfolge — Schritt für Schritt

Jeden Schritt erst machen, wenn der vorige einen Tag ohne Auffälligkeiten
lief. Nach jedem Schritt im Railway-Log die Startzeile ansehen:
`[media] new jobs' media: … ; uploads … ; render … ; proxy-video … ;
orphan sweep … ; tmp …` — sie zeigt, was gerade an ist.

**Schritt 0 — WP3-prep zuerst (Rückfall-Version).** Den Branch
`wp3-prep` mergen und deployen, mindestens 2–3 Tage laufen lassen. Er
ändert für Nutzer nichts, versteht aber die neuen Job-Felder. Er ist ab
jetzt die Version, auf die man zurückrollt (10.8). **Nie auf eine
Version vor WP3-prep zurückrollen, sobald WP3 lief** — das würde die
Medien-Felder neuer Jobs löschen.

**Schritt 1 — WP3 mergen.** Das startet drei Deploys gleichzeitig:
Railway (Backend), GitHub-Action "Deploy Modal render" und Vercel
(Website). Nichts wird eingeschaltet:
- Railway-Log: `[media] new jobs' media: local … uploads single; render
  render_burn_concat; proxy-video off; orphan sweep off`.
- GitHub → Actions → "Deploy Modal render": grün, mit der Warnung
  "render_r2 not deployed" (das Secret gibt es noch nicht) — richtig so.
- Test: ein kurzes Video hochladen, im Editor schneiden, rendern,
  herunterladen. Alles wie vorher.
Laufende Analysen während des Deploys brechen ab (erstattet) — wie bei
jedem Deploy.

**Schritt 2 — R2 vorbereiten** (ändert noch nichts an der App):
1. **Bucket:** den bestehenden `R2_BUCKET` weiter nutzen (einfachste
   Variante). Einen *neuen* Bucket nur jetzt, bevor irgendein Job Medien
   in R2 hat — und dann bedenken: Uploads, die gerade laufen, und die
   Backups unter `backups/` bleiben im alten Bucket (alten Bucket nicht
   löschen). Staging bekommt **immer** einen eigenen Bucket
   (`cleocuts-media-staging`), nie den von Produktion.
   Bucket privat lassen, **r2.dev-Zugriff aus**, keine Custom Domain.
   Empfohlen zusätzlich: ein Bucket `cleocuts-backups` →
   Railway `R2_BACKUP_BUCKET=cleocuts-backups` (der Railway-Token muss
   auch diesen Bucket dürfen).
2. **Tokens** (Cloudflare → R2 → Manage API tokens):
   - Railway-Token (die vorhandenen `R2_*`): *Object Read & Write* auf
     den Media-Bucket (und den Backup-Bucket).
   - **Eigener Token für Modal**: *Object Read & Write* **nur auf den
     Media-Bucket** — so kann Modal die Datenbank-Backups nicht lesen.
   - Ein Admin-Token nur auf dem eigenen Rechner für CORS und Lifecycle
     — nie deployen.
3. **CORS** (Bucket → Settings → CORS policy). `python -m
   backend.r2_setup --print-config` druckt das JSON (im Dashboard nur
   die Liste in `CORSRules` einfügen):
   ```json
   {"CORSRules":[{"AllowedOrigins":["https://cleocuts.com","https://www.cleocuts.com"],
     "AllowedMethods":["GET","HEAD","PUT"],"AllowedHeaders":["content-type","range"],
     "ExposeHeaders":["ETag","Content-Length","Content-Range","Accept-Ranges"],"MaxAgeSeconds":7200}]}
   ```
   Staging zusätzlich die Vercel-Preview-Origin(s), `http://localhost:3000`,
   `http://localhost:3123`. `<video>`, `<img>` und Download-Links brauchen
   kein CORS — nur die Upload-PUTs.
4. **Lifecycle** (Bucket → Settings → Object lifecycle rules, oder
   `aws s3api put-bucket-lifecycle-configuration … --lifecycle-configuration
   file://lifecycle.json`):
   ```json
   {"Rules":[
    {"ID":"uploads-expire-2d","Status":"Enabled","Filter":{"Prefix":"uploads/"},"Expiration":{"Days":2}},
    {"ID":"uploads-abort-mpu-1d","Status":"Enabled","Filter":{"Prefix":"uploads/"},"AbortIncompleteMultipartUpload":{"DaysAfterInitiation":1}},
    {"ID":"jobs-abort-mpu-2d","Status":"Enabled","Filter":{"Prefix":"jobs/"},"AbortIncompleteMultipartUpload":{"DaysAfterInitiation":2}}]}
   ```
   **Keine** Alters-Regel auf `jobs/` (R2 zählt das Objektalter, die
   Aufbewahrung die Untätigkeit — aktive Projekte verlören sonst ihre
   Medien). Gelöscht wird über die Warteschlange `media_gc` (10.7).
5. **Prüfen** (auf dem eigenen Rechner mit den Railway-`R2_*`-Werten als
   Env-Vars, oder in der Railway-Shell):
   `python -m backend.r2_setup --check --origin https://cleocuts.com`.
   Muss **"all checks passed"** melden. Geprüft werden: Bucket erreichbar,
   put/get/Range/delete, ein 70-MiB-Upload und -Download (der Weg, den
   jede Mezzanine und jeder Render nimmt), Multipart über presigned
   Part-URLs (ein PUT mit falscher Länge muss abgelehnt werden),
   presigned GET von heute und gestern 00:00Z, die Lifecycle-Regeln für
   `uploads/` und der CORS-Preflight. Darf der Token die Lifecycle-Regeln
   nicht lesen: im Dashboard nachsehen und mit `--skip-lifecycle`
   wiederholen.

**Schritt 3 — Modal-Secret anlegen, `render_r2` deployen** (wird noch
nicht benutzt):
```
modal secret create cleocuts-r2 R2_ACCOUNT_ID=… R2_ACCESS_KEY_ID=<Modal-Token> \
    R2_SECRET_ACCESS_KEY=<Modal-Token> R2_BUCKET=<derselbe Bucket wie Railway>
```
Dann GitHub → Actions → "Deploy Modal render" → **Run workflow**
(diagnose nicht ankreuzen). Im Log: "Modal secret cleocuts-r2 found —
deploying render_burn_concat and render_r2". Der Bucket-Name muss exakt
dem auf Railway entsprechen (`render_r2` bricht sonst mit "bucket
mismatch" ab und der Render geht zurück in den Editor).

**Schritt 4 — neue Jobs nach R2:** Railway `CLEO_MEDIA_BACKEND=r2`.
Log: `[media] new jobs' media: r2 (bucket …)`. Test: neues Video
hochladen → Editor → Vorschau spielt, Rendern, Download öffnet (die Links
sind jetzt Weiterleitungen nach R2). Alte Projekte weiter öffnen und
herunterladen — sie kommen weiter vom Volume. Renders laufen noch über
den alten Weg (die Mezzanine geht über Railway zu Modal).

**Schritt 5 — Renders direkt aus R2:** Railway
`CLEO_MODAL_RENDER_FN=render_r2` **und** dieselbe GitHub-Variable (10.1).
Log eines Renders: `[modal] render_r2 complete for job …`. Steht dort
`render_r2 is not deployed … rendering on the volume path`, fehlt
Schritt 3 — die Renders funktionieren trotzdem.

**Schritt 6 — Editor spielt den Proxy:** Railway `CLEO_PROXY_VIDEO=1`.
Test auf iPhone (Safari) und Android (Chrome): Projekt öffnen, im Editor
springen und abspielen. Geht es auf einem Gerät nicht: Variable löschen
(der Editor spielt dann wieder die Vorschau) und ggf.
`CLEO_MEDIA_PRESIGN=standard` probieren.

**Schritt 7 — fortsetzbare Uploads:** Railway
`CLEO_UPLOAD_MODE=multipart`. 48 h lang die `[upload] …`-Zeilen im Log
beobachten. Test: großes Video hochladen, bei ~50 % WLAN aus, wieder an →
setzt fort.

**Schritt 8 — alte Jobs umziehen** (Backfill, 10.5).

**Schritt 9 (optional) — Waisen-Check:** `CLEO_MEDIA_ORPHAN_SWEEP=1`
(10.7). Erst nach dem Backfill.

**Schritt 10 (optional, später) — Arbeitsordner auf die
Container-Platte:** 10.6.

### 10.3 Staging (vor Schritt 4–7 in Produktion)

Eigener Bucket, alle Schritte oben dort zuerst. Dann ein Burst (20
Uploads in 60 s mit mehreren GB: POST /jobs p95 < 1,5 s, kein ENOSPC)
und die Geräte-Checkliste (iOS Safari 17/18, Android Chrome: 2-GB-4K-HEVC
aus Fotos mit Flugmodus bei ~50 % → setzt fort; Tab beendet + Datei neu
gewählt → setzt fort; Proxy-Wiedergabe und Springen im Editor über die
Weiterleitung; Download öffnet).

### 10.4 Was jeder Schalter im Fehlerfall tut (Kurzfassung)

- **Uploads machen Ärger:** `CLEO_UPLOAD_MODE` löschen. (Neustart →
  laufende Analysen brechen ab und werden erstattet; es gibt keinen
  Schalter "ohne Neustart".)
- **Editor-Wiedergabe macht Ärger:** `CLEO_PROXY_VIDEO` löschen; bei
  Problemen mit R2-Links allgemein zusätzlich `CLEO_MEDIA_PRESIGN=standard`.
- **Renders aus R2 machen Ärger:** `CLEO_MODAL_RENDER_FN` löschen → alter
  Weg. Achtung: der alte Weg (`render_burn_concat`) hat auf Modal ein
  hartes Limit von **30 min pro Render** (`render_r2`: 60 min) — sehr
  lange Videos, die mit `render_r2` gingen, brechen dort mit
  `render_timeout` ab.
- **R2 selbst macht Ärger:** `CLEO_MEDIA_BACKEND` löschen → neue Jobs
  wieder aufs Volume. Jobs, die schon in R2 sind, brauchen R2 weiterhin
  (`R2_*` **nicht** löschen).

### 10.5 Backfill (Jobs vom Volume nach R2)

Verschiebt **alte Jobs** (von vor WP3, nur lokale Dateien) und **Jobs,
die mit `CLEO_MEDIA_BACKEND` = local angelegt wurden**, nach R2. Braucht
nur die `R2_*`-Variablen (unabhängig von `CLEO_MEDIA_BACKEND`). In der
Railway-Shell (Service → Shell) oder mit `railway run`:

```
python -m backend.r2_backfill --dry-run          # was, wie viel, ~Egress
python -m backend.r2_backfill                    # für echt (--limit N, --job ID,
                                                 #  --max-mbps 40)
```

Pro Job (neueste zuerst, laufende übersprungen): alles hochladen, per
HEAD gegen die lokale Größe prüfen, dann **in einem Schritt** am Job
setzen — aber nur, wenn sich der Job in der Zwischenzeit nicht geändert
hat (sonst "skipped", der nächste Lauf macht ihn). Danach liefert R2 aus;
die lokale Kopie eines verschobenen Jobs wird einen Tag später gelöscht.
Idempotent: ein zweiter Lauf tut nichts. Am Ende eine Zusammenfassung
mit `local_only_left` — **Ziel: 0**. Alternativ `CLEO_BACKFILL=1`: der
stündliche Loop erledigt es in kleinen Portionen (danach wieder
entfernen). Grob 5 GB insgesamt ≈ $0,25 Railway-Egress.

Frühestens **7 Tage später** die lokalen Dateien der alten Jobs löschen:

```
python -m backend.r2_backfill --delete-local --dry-run
python -m backend.r2_backfill --delete-local
```

Löscht nur bei Jobs, deren Medien in R2 liegen und deren Keys per HEAD
mit der gespeicherten Größe bestätigt sind. Das Volume selbst fällt erst
in WP6 weg.

### 10.6 Arbeitsordner (`CLEO_TMP_ROOT`)

Analysen arbeiten in `CLEO_TMP_ROOT/jobs/{id}` (mehrere GB pro großem
Upload), dazu der Proxy-Cache und kleine Uploads auf dem Weg nach R2.
Default ist `<CLEO_WORK_ROOT>/tmp` auf dem Volume — dort, wo die Analyse
vorher auch lief, und dort misst die Platz-Prüfung (507
`server_storage_full`) richtig. Auf die Container-Platte (`/tmp/cleo`)
erst umstellen, wenn in der Railway-Shell `df -h /tmp` genug Platz für
mehrere gleichzeitige Analysen zeigt (≥ 3,5 × die größte erlaubte
Upload-Größe × `CLEO_MAX_ANALYZE` + 1 GB). Vorsicht: auf der
Container-Platte meldet `df` evtl. den Platz des Hosts, nicht das Limit
des Plans.

### 10.7 Betrieb

- **Löschen ist eine Warteschlange** (Tabelle `media_gc`, mit Speicherort
  pro Zeile): Projekt löschen / Aufbewahrung abgelaufen → `jobs/{id}/`
  und der Upload werden sofort versucht, sonst später erneut — jeder
  Fehlschlag verschiebt den nächsten Versuch (5 min, 10 min, 20 min, …
  höchstens 6 h), damit eine hängende Zeile die anderen nicht blockiert.
  Überholte Renders (`r{g}/`) und Vorschau-Versionen erst nach 24 h, die
  Teil-Ergebnisse eines fehlgeschlagenen Renders erst nach gut einer
  Stunde (ein Modal-Aufruf könnte noch schreiben). Log `[media] deleted …`;
  nach 10 Fehlschlägen **`[media] GC STUCK — …`** (Fehler-Level, Sentry).
- **Nur erlaubte Keys werden gelöscht:** `jobs/<id>/`, `jobs/<id>/r<n>/`,
  `jobs/<id>/preview/v<n>.mp4`, `jobs/<id>/source.<ext>` und
  `uploads/[<user>/]<uuid>.<ext>`. Alles andere (z. B. `jobs/`,
  `uploads/`, `backups/`) wird abgelehnt und geloggt.
- **Waisen-Check (nur mit `CLEO_MEDIA_ORPHAN_SWEEP=1`, wöchentlich,
  frühestens eine Woche nach dem Einschalten):** `jobs/{id}/`-Präfixe
  ohne Job-Zeile in *dieser* Datenbank, deren neuestes Objekt > 2 Tage
  alt ist, kommen in `media_gc` (höchstens `CLEO_MEDIA_ORPHAN_MAX` pro
  Lauf). Schutz: im Bucket liegt `jobs/.owner` mit der ID dieser
  Datenbank. Beim ersten Lauf wird sie nur geschrieben, wenn jedes
  vorhandene Präfix einen Job hat; passt sie nicht (anderes Deployment,
  Staging mit Prod-Bucket, Entwickler-Rechner mit der Prod-`.env`,
  zurückgespieltes Backup), löscht der Check **nichts** und loggt
  `ORPHAN SWEEP REFUSED`. Meldet er das in Produktion ohne erkennbaren
  Grund: Variable löschen und nachsehen, nicht die Marke überschreiben.
- `media_gc` ist Teil der Postgres-Backups und des SQLite→Postgres-Umzugs.
- `GET /admin/costs`: Speicher aus `media_bytes` der Jobs (R2-Preis für
  R2-Jobs), plus alte lokale Dateien.

### 10.8 Rollback

- **Einzelne Teile:** die Variable löschen (10.1, 10.4). Das ist immer
  der erste Weg.
- **Code:** nur auf **WP3-prep** zurückrollen (Railway → Deployments →
  der WP3-prep-Deploy → Redeploy), **nie weiter zurück**. Unter WP3-prep
  bleiben Jobs mit Medien in R2 (oder unter den neuen lokalen Keys)
  erhalten, zeigen aber "nicht verfügbar" (409 `media_unavailable`) und
  können nicht gelöscht werden, bis wieder vorwärts deployt wird. Ein
  Rollback hinter WP3-prep löscht die Medien-Felder dieser Jobs
  endgültig.
- **Website mit zurückrollen:** Vercel → Deployments → den Deploy von vor
  dem WP3-Merge → "Promote to Production" — Backend und Website immer
  zusammen (die neue Website wartet bei alten Backends zu kurz auf große
  Uploads).
- **Modal:** der alte `render_burn_concat` bleibt immer deployt; nichts
  zu tun.

### 10.9 Kosten (R2: $0,015/GB-Monat, Class A $4,50/M, Class B $0,36/M, Egress frei; gratis: 10 GB, 1 M A, 10 M B pro Monat)

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

### 10.10 Key-Layout

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
backups/pg/…                   Postgres-Backups (8.4; mit R2_BACKUP_BUCKET in dessen Bucket),
                               von nichts hier berührt (die Lösch-Warteschlange nimmt nur
                               jobs/<id>/… und uploads/…-Keys, siehe 10.7)
jobs/.owner                    Besitzer-Marke für den Waisen-Check (10.7)
```

Keys sind unveränderlich: ein Key, auf den ein Job zeigt, wird nie
überschrieben; eine neue Version bekommt einen neuen Key (daher
`Cache-Control: private, max-age=31536000, immutable` auf allen Objekten
unter `jobs/`).
