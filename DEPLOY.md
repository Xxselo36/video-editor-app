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
   erste eingeloggte User, der sie öffnet. `/app/edit/…`-Links
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
- **R2:** Lifecycle-Regel auf `uploads/` (9 Tage, 10.2) für hochgeladene,
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
`CLEO_MEDIA_OWNER_REARM` (nur einmalig nach Umzug/Restore, 10.7),
`CLEO_PROXY_CACHE_GB` (5), `CLEO_PROBE_WORKERS` (4),
`CLEO_MODAL_DEADLINE_S_PER_GB` (60, siehe 9.3), `CLEO_MEDIA_ROOT`
(Ordner der lokalen Medien, Default `<CLEO_WORK_ROOT>/media`),
`R2_ENDPOINT_URL` (nur Tests), `CLEO_UPLOAD_INITS_PER_HOUR` (60:
so viele fortsetzbare Uploads darf ein Nutzer pro Stunde beginnen —
bzw. eine Adresse, wenn Accounts aus sind; Fortsetzen und "Nochmal"
eines gestoppten Uploads zählen nicht; darüber 429 `too_many_uploads`,
die Web-App (v2) sagt "Zu viele Uploads in kurzer Zeit"; 0 = kein Limit),
`CLEO_DISK_MEZZ_MBPS` (40) / `CLEO_DISK_PREVIEW_MBPS` (10): die
Platz-Reservierung einer Analyse mit bekannter Länge (Upload + Mezz bei
1080p + Proxy/Vorschau, gemessen; nie mehr als `CLEO_DISK_FACTOR` × Upload,
das ohne bekannte Länge gilt; die Analyse hört bei dieser Länge + 5 s
auf, auch ohne Abrechnung), `CLEO_DISK_GUARD_S` (2: so oft prüft eine
laufende Analyse den freien Platz; unter `CLEO_MIN_FREE_GB` bricht sie
mit `server_storage_full` ab, Minuten zurück; 0 = aus),
`CLEO_PROXY_RECLAIM_MIN_AGE_S` (600: ein Editor-Proxy im Cache, der
kürzer her benutzt wurde, wird für einen Upload nicht gelöscht),
`CLEO_UPLOAD_ENTRY_TTL_S` (7200: ein
nicht freigegebener Upload-Platz verfällt danach). Ablehnungen der
Upload-Routen stehen als `upload_refused` in `job_events`;
`GET /admin/capacity` bzw. die GitHub-Action "Ops inspect" zeigt sie.

Außerhalb von Railway:
- **Modal-Secret `cleocuts-r2`** (10.2 Schritt 3, am einfachsten per
  GitHub-Action "R2 setup"): ohne es wird nur
  `render_burn_concat` deployt (die GitHub-Action prüft das selbst und
  warnt). Beim Deploy von Hand: `CLEO_MODAL_R2=1 modal deploy
  backend/modal_render.py` (mit Secret) bzw. ohne die Variable (ohne).
  Mit dem zweiten Secret `cleocuts-ai` kommt `analyze_r2` dazu (11.5;
  von Hand: `CLEO_MODAL_R2=1 CLEO_MODAL_ANALYZE=1 modal deploy …`).
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

**Schritt 2 + 3 ohne eigenen Rechner — GitHub-Action "R2 setup"
(empfohlen).** Sie setzt CORS und Lifecycle des Buckets (genau das JSON
aus Schritt 2, Punkt 3 und 4), legt das Modal-Secret `cleocuts-r2` an
bzw. ersetzt es und prüft danach alles (Punkt 5 und Schritt 3). Den
Bucket selbst (Punkt 1) legt sie nicht an.
1. Cloudflare → R2 → *Manage API tokens* → **zwei R2-Tokens** anlegen.
   Nach dem Anlegen zeigt Cloudflare u. a. *Access Key ID* und *Secret
   Access Key* — genau diese beiden Werte brauchen wir (nicht den
   "Token value"):
   - **Admin-Token**: Permission *Admin Read & Write*. Achtung:
     Cloudflare lässt *Admin*-Rechte **nicht auf einen Bucket
     beschränken** — dieser Token darf alle Buckets des Accounts ändern
     und löschen. Darum nur als GitHub-Secret ablegen, nirgends sonst
     (nie auf Railway/Modal). Wer mag, löscht ihn nach dem Lauf in
     Cloudflare wieder — für spätere Läufe (auch mode check) dann neu
     anlegen und die zwei Admin-Secrets ersetzen.
   - **Modal-Token**: Permission *Object Read & Write*, *Apply to
     specific buckets only* → **nur der Media-Bucket**.
2. GitHub → Repo → Settings → Secrets and variables → Actions → *New
   repository secret*, Namen exakt so:

   | Secret | Wert |
   |---|---|
   | `R2_ACCOUNT_ID` | Cloudflare Account ID (32 Zeichen, steht in R2 auf der Übersichtsseite) |
   | `R2_BUCKET` | Name des Media-Buckets — derselbe wie `R2_BUCKET` auf Railway |
   | `R2_ADMIN_ACCESS_KEY_ID` | Access Key ID des Admin-Tokens |
   | `R2_ADMIN_SECRET_ACCESS_KEY` | Secret Access Key des Admin-Tokens |
   | `R2_MODAL_ACCESS_KEY_ID` | Access Key ID des Modal-Tokens |
   | `R2_MODAL_SECRET_ACCESS_KEY` | Secret Access Key des Modal-Tokens |

   `MODAL_TOKEN_ID` und `MODAL_TOKEN_SECRET` sind schon da ("Deploy
   Modal render").
3. GitHub → Actions → **"R2 setup"** → *Run workflow* → mode **apply**
   → *Run workflow*. Grün = fertig. Rot: oben im Lauf steht, welches
   Secret fehlt oder falsch ist. Werte stehen nie im Log (das Repo ist
   öffentlich); Bucket-Name und Account ID erscheinen als `***`.
   Lifecycle-Regeln, die schon am Bucket hängen (z. B. eine
   Standard-Regel von Cloudflare), ersetzt apply — das Log nennt ihre
   IDs unter "replaced".
4. Danach **einmal** GitHub → Actions → **"Deploy Modal render"** →
   *Run workflow* (diagnose nicht ankreuzen): findet das Secret und
   deployt `render_r2` (Log: "Modal secret cleocuts-r2 found — deploying
   render_burn_concat and render_r2").

Später jederzeit prüfen: "R2 setup" mit mode **check** (ändert nichts;
nur kurz ein paar Testdateien unter `uploads/_r2check/`). Den
Railway-Token prüft die Action nicht (dessen Werte stehen nur auf
Railway). Mit der Action bleiben von Schritt 2 unten nur Punkt 1
(Bucket) und der Railway-Token aus Punkt 2; Punkt 3–5 und Schritt 3 sind
der Weg von Hand.

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
   - Ein Admin-Token für CORS und Lifecycle — nur als GitHub-Secret für
     "R2 setup" (oben) oder auf dem eigenen Rechner, nie deployen.
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
    {"ID":"uploads-expire-9d","Status":"Enabled","Filter":{"Prefix":"uploads/"},"Expiration":{"Days":9}},
    {"ID":"uploads-abort-mpu-8d","Status":"Enabled","Filter":{"Prefix":"uploads/"},"AbortIncompleteMultipartUpload":{"DaysAfterInitiation":8}},
    {"ID":"jobs-abort-mpu-2d","Status":"Enabled","Filter":{"Prefix":"jobs/"},"AbortIncompleteMultipartUpload":{"DaysAfterInitiation":2}}]}
   ```
   Ein abgebrochener Upload lässt sich so **7 Tage** lang fortsetzen: Das
   Backend liest diese Regeln (alle 6 h) und gibt Upload-Tickets nie
   länger, als der Bucket die Teile behält (`[upload] resumable for … h`
   im Log; Regeln nicht lesbar → 23 h wie bisher). Mit den alten Regeln
   (2 d / 1 d) bleibt es bei 23 h, bis die neuen angewendet sind
   (Workflow "R2 setup", mode=apply).
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
setzen — gegen den Job, wie er *jetzt* ist: Hat der Nutzer ihn in der
Zwischenzeit bearbeitet, gewinnt seine Änderung (neue Vorschau,
Zeitstempel für die Aufbewahrung); der Backfill setzt nur, was noch
fehlt, und nicht mehr gebrauchte Kopien (alte Vorschau-Version) werden
einen Tag später gelöscht. Ein verschobener Job ("keyed-local") wird
ganz oder gar nicht umgestellt (sonst "skipped", der nächste Lauf macht
ihn). Danach liefert R2 aus; die lokale Kopie eines verschobenen Jobs
wird einen Tag später gelöscht. Ein Proxy, der sich nicht erzeugen
lässt, wird gemerkt und nicht jede Stunde neu versucht ("skipped: proxy
could not be made"; der Editor spielt dann die Vorschau). Idempotent:
ein zweiter Lauf tut nichts. Am Ende eine Zusammenfassung mit
`local_only_left` — **Ziel: 0**. Alternativ `CLEO_BACKFILL=1`: der
stündliche Loop erledigt es in kleinen Portionen (danach wieder
entfernen). Grob 5 GB insgesamt ≈ $0,25 Railway-Egress.

Frühestens **7 Tage später** die lokalen Dateien der alten Jobs löschen:

```
python -m backend.r2_backfill --delete-local --dry-run
python -m backend.r2_backfill --delete-local
```

Löscht nur bei Jobs, für die der Backfill nichts mehr zu tun hat und bei
denen **jede** zu löschende Datei eine Kopie in R2 hat, die per HEAD mit
der gespeicherten Größe bestätigt ist (sonst "skipped" mit Grund). Die
Pfade am Job werden zuerst geleert (nur wenn sich der Job nicht geändert
hat), erst danach werden die Dateien gelöscht. Das Volume selbst fällt
erst in WP6 weg.

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
  Entwickler-Rechner mit der Prod-`.env`), löscht der Check **nichts**
  und loggt `ORPHAN SWEEP REFUSED`. Die ID steht in `meta` und wird von
  jeder Kopie der Datenbank mitkopiert — deshalb ist sie zusätzlich an
  *diese* Datenbank gebunden (Postgres: Cluster-`system_identifier` +
  Datenbank-OID; SQLite: die Datei; dazu `RAILWAY_ENVIRONMENT_ID`). Eine
  geklonte Datenbank (Staging aus Prod geklont), ein in eine neue
  Datenbank zurückgespieltes Backup (`pg_backup restore`, der Dump
  enthält die Bindung nicht) und der Umzug SQLite→Postgres verweigern
  deshalb ebenfalls (`ORPHAN SWEEP REFUSED: this database is not where
  its media owner id was made …`). **Nicht** erkannt wird eine Kopie, die
  dieselbe Datenbank *an Ort und Stelle* überschreibt (Railway-Volume-
  Backup derselben Postgres-Instanz, SQLite-Datei per `cp` über die alte
  kopiert): vor so einer Wiederherstellung `CLEO_MEDIA_ORPHAN_SWEEP`
  löschen — sonst löscht der nächste Lauf die Medien der Jobs, die nach
  dem Backup entstanden sind. Grundsätzlich: Staging nie mit dem
  Prod-Bucket und `CLEO_MEDIA_ORPHAN_SWEEP=1` betreiben.
  Nach einem Umzug oder Restore *der Produktion* (und nur dort, wenn
  keine Job-Zeilen fehlen): den im Log genannten Wert einmal als
  `CLEO_MEDIA_OWNER_REARM=<wert>` setzen, Log `orphan sweep re-armed`
  abwarten, Variable wieder löschen. Meldet er `REFUSED` in Produktion
  ohne erkennbaren Grund: Variable löschen und nachsehen, nicht die Marke
  überschreiben.
- `media_gc` ist Teil der Postgres-Backups und des SQLite→Postgres-Umzugs.
- **Lifecycle-Regeln für `uploads/`** prüft das Backend einmal am Tag
  selbst (mit `R2_*`): fehlen sie, steht im Log **`[media] R2 LIFECYCLE
  MISSING`** (Fehler-Level) — dann bleiben abgebrochene Uploads für
  immer liegen; 10.2 Schritt 4 nachholen. Darf der Token sie nicht lesen,
  steht dort nur ein Hinweis.
- **Videos ohne Längenangabe** (Bildschirmaufnahmen als "Streaming"-WebM,
  der Browser kennt die Länge auch nicht): werden angenommen; die Analyse
  misst die Länge zuerst selbst. Zu lang → Fehler "video_too_long", mit
  Abrechnung: erst dann abgebucht, zu wenig Minuten → "quota_exceeded" —
  in beiden Fällen wird nichts transkribiert und der Upload gelöscht.
  Jede Analyse hört spätestens bei `CLEO_MAX_MINUTES` auf.
- **Grenzen fürs Web (UX5)**: das Frontend liest `CLEO_MAX_UPLOAD_GB`,
  `CLEO_MAX_MINUTES` und `CLEO_MIN_SECONDS` (Standard 3; `0` = aus) über
  `GET /config` — keine `NEXT_PUBLIC_MAX_*`-Variablen und kein Web-Build
  mehr nötig, wenn sie sich ändern. Audiodateien (`no_video`), Videos ohne
  Ton (`no_audio`) und Clips unter `CLEO_MIN_SECONDS` (`video_too_short`)
  lehnt `POST /jobs` vor jeder Abbuchung ab.
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

## 11. Task-Warteschlange (WP4)

**Kurz:** Mit `CLEO_TASK_QUEUE=1` laufen Analysen und Renders nicht mehr
als Threads, die mit dem Prozess sterben, sondern als **dauerhafte
Tasks in der Datenbank** (Tabelle `tasks`, gleiche Transaktion wie der
Job). Ein **Leader** — genau ein Prozess, per Postgres-Advisory-Lock
gewählt (auf SQLite: der eine Prozess) — verteilt sie an den
**`local`-Executor** (Threads desselben Prozesses, also dieselbe
Maschine und derselbe Code wie bisher), holt verlorene Arbeit zurück
(**Reaper**: Lease ohne Heartbeat → neuer Versuch mit Backoff) und
schließt fertige/fehlgeschlagene Tasks ab (**Finalizer**: Job-Status,
Erstattung/True-up, Medien-GC, Metrik-Event). Ein Deploy oder Absturz
mitten in einer Analyse oder einem Render verliert den Job nicht mehr:
er läuft nach dem Neustart erneut (höchstens 3 gezählte Versuche, danach
Fehler + Erstattung bzw. zurück in den Editor wie heute).

**Nach dem Merge ist die Queue aus** (Phase P0): ohne die Variable läuft
exakt der bisherige Weg (WP1). Für Nutzer ändert sich auch mit Queue
nichts sichtbar: gleiche Status, `queued` + `queue_position`, gleiche
Ablehnungen (429 `too_many_active_jobs`, 503 `server_busy` +
Retry-After, 507, 413). Einziger Unterschied: ein frisch hochgeladener
Job steht sofort auf `processing` / `queued` statt kurz auf `pending`.

Code: `backend/taskq.py` (Schalter, Regeln), `backend/leader.py`
(Leader, Dispatcher, Reaper, Finalizer), `backend/worker.py` (ein
Versuch eines Tasks), `backend/pg_tasks.py` / `backend/jobs.py`
(`PgTaskStore` / `SqliteTaskStore`), Schema-Migration v5
(`tasks`, `provider_state`, `queue_positions`).

### 11.1 Schalter (Railway → Backend-Service → Variables)

| Variable | Default | Bedeutung |
|---|---|---|
| `CLEO_TASK_QUEUE` | aus | `1`: Task-Warteschlange an (dieser Abschnitt). Löschen = zurück zu WP1 |
| `CLEO_EXECUTOR_INGEST` | `local` (auch wenn `MODAL_TOKEN_ID` gesetzt ist) | `modal`: Analysen laufen auf Modal statt auf Railway (Phase P1, **11.5**). Braucht `CLEO_TASK_QUEUE=1`, `CLEO_MEDIA_BACKEND=r2` und `MODAL_TOKEN_ID` — sonst startet das Backend nicht (`[queue] NOT STARTING`); ohne `CLEO_TASK_QUEUE` wird es ignoriert (Log-Hinweis) |
| `CLEO_EXECUTOR_RENDER` | `local` | `modal` gibt es für Renders nicht (sie laufen schon vom `local`-Executor aus auf Modal, `CLEO_MODAL_RENDER_FN`) — gesetzt startet das Backend nicht |
| `CLEO_MAX_RUNNING_INGEST` | `CLEO_MAX_ANALYZE`, sonst 2; mit `CLEO_EXECUTOR_INGEST=modal`: **20** | gleichzeitige Analysen (wie bisher `CLEO_MAX_ANALYZE`; mit Modal brauchen sie hier weder Platte noch CPU) |
| `CLEO_MAX_RUNNING_RENDER` | `CLEO_MAX_RENDER`, sonst 4 mit Modal / 2 ohne | gleichzeitige Renders (wie bisher `CLEO_MAX_RENDER`) |
| `CLEO_MAX_QUEUE` | 20; mit `CLEO_EXECUTOR_INGEST=modal`: 200 | wartende Analysen, danach 503 `server_busy` (wie bisher) |
| `CLEO_MAX_ACTIVE_PER_USER` | 2 | laufende Jobs pro Konto, danach 429 (wie bisher) |
| `CLEO_TASK_MAX_ATTEMPTS` | 3 | gezählte Versuche (verlorene Lease, Infrastruktur-Fehler) |
| `CLEO_TASK_RETRY_BACKOFF_S` | `30,120,600` | Wartezeit vor Versuch 2, 3, … |
| `CLEO_TASK_LEASE_S` / `CLEO_TASK_HEARTBEAT_S` | 180 / 30 | ohne Heartbeat so lange → Reaper holt den Task zurück |
| `CLEO_START_TIMEOUT_S` | 300 | verteilt, aber von keinem Worker übernommen → zurück |
| `CLEO_REAPER_GRACE_S` | 200 | nach Übernahme der Führung so lange nichts zurückholen (laufende Worker bekommen eine volle Lease) |
| `CLEO_PRIORITY_OFFSETS_S` | `{"studio":-120,"pro":-60,"starter":0,"service":600}` | Vorrang als Zeitgutschrift (Kosten-/Lasttests weichen 10 min) |
| `CLEO_GROQ_ASH_BUDGET` | 160000 | geschätzte Groq-Audio-Sekunden pro Stunde, darüber warten Analysen |
| `CLEO_PROVIDER_HOLD_S` | 1800 | so lange wartet ein Task auf Groq / Anthropic-Ausgabenlimit / Plattenplatz, dann Fehler + Erstattung (Anthropic: danach ohne LLM-Schritte weiter) |
| `CLEO_LLM_OUTAGE_POLICY` | `hold` | `degrade`: bei Anthropic-Ausgabenlimit sofort ohne LLM-Schritte weiter (mit `processing_warnings`) |
| `CLEO_PROVIDER_RETRY_MIN_S` | 60 | kürzeste Wartezeit nach einem Provider-Fehler |
| `DATABASE_DIRECT_URL` | = `DATABASE_URL` | nur falls `DATABASE_URL` über einen Transaction-Pooler geht: direkte URL für den Leader-Lock |
| `CLEO_FAULT_GROQ_429` | aus | nur Staging/Tests: `1` bzw. `0.2` = jede bzw. jede fünfte Analyse scheitert wie ein Groq-429 |

Mit Queue laufen Aufräumen, Medien-GC, Waisen-Check, Backfill,
Postgres-Backup und Lemon-Squeezy-Abgleich **im Leader** (nur ein
Prozess). Die Boot-Scans (`mark_stuck_as_error` …) und der stündliche
Waisen-Job-Sweep entfallen: der Leader nimmt Jobs ohne Task beim Start
selbst auf (Upload noch da → Analyse läuft erneut; sonst Fehler +
Erstattung; Render → zurück in den Editor).

### 11.2 Einschalten

1. Merge + Deploy wie immer. Railway-Log: `[db] applied schema
   migration(s) [5]` (einmal), sonst keine Änderung.
2. Einen ruhigen Moment wählen (Variablen-Änderung = Neustart; mit Queue
   ist das künftig egal, beim Umschalten selbst gilt noch WP1).
3. Railway → Backend-Service → Variables → `CLEO_TASK_QUEUE` = `1` →
   Deploy.
4. Im Log beim Start prüfen:
   - `[queue] task queue ON (CLEO_TASK_QUEUE=1): executors ingest=local render=local, running limits 2/4, queue cap 20`
   - `[leader] leader:… leads (dispatcher, reaper, finalizer, maintenance); executors ingest=local render=local`
   - falls es beim Umschalten laufende Jobs gab:
     `[leader] took over: N job(s) without a task re-queued or settled`.
5. Kosten-Test (`synthetic:1`) laufen lassen: muss wie vorher `done`
   erreichen; `GET /admin/queue` (Header `X-Admin-Token`) zeigt Zähler,
   ältesten wartenden Task und Breaker.

### 11.3 Drei Tage beobachten (Ausstiegskriterium Phase P0)

Täglich im Railway-Log suchen:

| Suche | Erwartet | Wenn nicht |
|---|---|---|
| `[queue] ` (alle 5 min) | `oldest …` nie über ein paar Minuten, `running` ≤ Limit | hängt eine Kind fest: `GET /admin/queue`, dann 11.4 |
| `[reaper]` | selten, nur nach Deploys/Abstürzen, danach `→ queued` und der Job wird fertig | häufig → Worker hängen (Heartbeats fehlen): Log um die Zeit prüfen |
| `→ dead` / `given up` / `LEADERSHIP LOST` | keine | Job-ID notieren, `inspect_jobs` im Kosten-Test-Workflow |
| `[finalizer] … not settled yet` | keine (einzelne bei DB-Aussetzern ok) | wiederholt → DB-Problem; Tasks bleiben liegen, nichts geht verloren |
| `BREAKER OPEN`, `SPEND LIMIT`, `audio budget` | keine | OPERATIONS.md „Task-Warteschlange“ |
| `/admin/metrics` | Erfolgsraten wie vor dem Umschalten | Rückfall (11.4) |

Nach drei Tagen ohne hängende Tasks und mit grünen Metriken ist P0 durch.

### 11.4 Ausschalten / Rollback

- **Schalter:** `CLEO_TASK_QUEUE` löschen → Deploy. Der WP1-Weg läuft
  wieder. Beim Start markiert WP1 wie bisher alle Jobs in
  `pending`/`processing` als unterbrochen (`container_restart`, Minuten
  erstattet, Renders zurück in den Editor) — auch Jobs, die nur in der
  Warteschlange standen. Deren Tasks bleiben unbeachtet in der Tabelle
  liegen. Harmlos: schaltet man die Queue wieder ein, beendet ein Worker
  so einen Task sofort ohne Arbeit, weil sein Job nicht mehr läuft.
- **Code-Rollback** auf eine Version vor WP4: genauso (die neuen
  Tabellen stören alte Versionen nicht; die Migration bleibt).

### 11.5 Analysen auf Modal (Phase P1, `CLEO_EXECUTOR_INGEST=modal`)

**Wozu:** Heute läuft jede Analyse auf dem einen Railway-Container und
braucht dort `CLEO_DISK_FACTOR` (3,5) × die Upload-Größe an Platte —
große iPhone-Videos (1–4 GB) bekommen 507 `server_storage_full`, mehrere
gleichzeitig passen nicht. Mit dem Schalter läuft jede Analyse in einem
eigenen Modal-Container (8 Kerne, 16 GiB RAM, 100 GiB Platte, höchstens
2 h); Railway braucht dafür **keine Platte und kaum CPU**.

**Was wo läuft:**

| Schritt | Wo |
|---|---|
| Upload | Browser → R2 (wie bisher) |
| `POST /jobs`: Prüfung, Abbuchung, Task | Railway — Zulassung nur noch über Warteschlange/Limits, **keine Plattenprüfung** (auch nicht bei `/uploads/presign` und `/uploads/init`) |
| Längenprüfung (nur wenn `POST /jobs` die Länge nicht kannte) | Railway, per ffprobe über einen presigned R2-Link |
| Download, Normalisieren (Mezz + Proxy), SmartCam, Lautheit/Peaks, **Groq-Transkription, Claude-Schritte**, Schnitt-Vorschau, Poster, CJK-Schriften, Filmstreifen | Modal `analyze_r2` (`backend/modal_analyze.py`) — dieselbe Funktion `pipeline.analyze_only` wie lokal |
| Speichern | Modal → R2, **dieselben Keys** `jobs/{id}/…` und dieselben Felder (`pipeline.store_analysis_outputs`, auch der lokale Weg speichert darüber) |
| Commit, Erstattung, True-up, Medien-GC, Events | Railway (Worker-Thread + Finalizer wie in P0) |

**Warum Groq und Claude mit auf Modal:** Transkription und LLM-Schritte
stecken mitten in der gemeinsamen Analyse (`src/plugin_api.analyze_video`
liest das ganze Video für Länge und Ton und ruft das LLM zwischen seinen
Durchgängen; Vorschau, Poster und Schriften brauchen das Transkript).
Sie auf Railway zu lassen hieße, Desktop-Code in `src/` zu ändern oder
`analyze_only` zu kopieren — und Railway bräuchte trotzdem die Mezzanine
auf der Platte. Deshalb bekommt Modal die beiden API-Keys über **ein**
neues Modal-Secret `cleocuts-ai`; die Keys auf Railway bleiben, wo sie
sind (Renders, Beiträge, Fallback). Fehler von Groq/Claude kommen
beschrieben zurück und werden auf Railway genau wie lokal eingeordnet
(Groq-Breaker, Anthropic-Ausgabenlimit, `no_speech`-Erstattung, …).

**Lease, Heartbeat, Fencing, Erstattung** bleiben wie in P0: ein
Worker-Thread auf Railway hält die Lease, solange Modal arbeitet, und
schreibt den Fortschritt (über ein `modal.Dict` `cleocuts-analyze`) in
den Job. Wird der Task weggenommen (Lease verloren, Neustart), wird der
Modal-Aufruf abgebrochen; ein Aufruf, den niemand mehr abbrechen konnte
(Railway neu gestartet), sieht am Dict, dass ein späterer Versuch
läuft, und speichert nichts mehr. Modal-Timeout, abgestürzter Container,
nicht deployt, Ausgabenlimit oder kein Ergebnis innerhalb der Frist →
Infrastruktur-Fehler: neuer Versuch (höchstens `CLEO_TASK_MAX_ATTEMPTS`,
3), danach Fehler + Erstattung (`processing_interrupted`). Jobs, deren
Upload noch als Datei auf Railway liegt (von vor R2), analysiert Railway
selbst wie bisher (Log `analysed here, not on Modal`).

**Einschalten** (Voraussetzung: 11.2 läuft, `CLEO_TASK_QUEUE=1`;
`CLEO_MEDIA_BACKEND=r2` und das Modal-Secret `cleocuts-r2` gibt es schon,
10.2):

1. **Modal-Secret `cleocuts-ai` anlegen** (einmalig, das ist das einzige
   neue Secret): Modal → Secrets → Create → Custom, Name `cleocuts-ai`,
   zwei Einträge mit **denselben Werten wie auf Railway**:
   `GROQ_API_KEY`, `ANTHROPIC_API_KEY`. (Oder auf einem Rechner mit
   Modal-Login: `modal secret create cleocuts-ai GROQ_API_KEY=… ANTHROPIC_API_KEY=…`
   — nicht in ein geteiltes Terminal-Log.) Wer einen Key auf Railway
   wechselt, wechselt ihn hier mit.
2. **GitHub → Actions → "Deploy Modal render" → Run workflow.** Im Log:
   `Modal secret cleocuts-ai found — deploying analyze_r2 too.` (Ohne das
   Secret: `analyze_r2 not deployed …` — dann nicht weitermachen.)
   Danach deployt jeder Push auf `main` analyze_r2 automatisch mit.
3. **Kosten-Test vorher** (optional, empfohlen): erst Schritt 4 in einem
   ruhigen Moment, dann sofort GitHub → Actions → "Cost test" mit
   `runs` = `synthetic:1`, `ingest_executor` = `modal`; der Lauf bricht
   vor dem Upload ab, wenn der Server nicht auf Modal analysiert, und
   druckt die Analyse-Zeit. Danach `iphone4kloop:10` (≈ 2 GB 4K-HEVC,
   10 min) — genau der Fall, der heute mit 507 abgelehnt wird.
4. **Railway → Backend-Service → Variables:** `CLEO_EXECUTOR_INGEST` =
   `modal` → Deploy. Im Log beim Start:
   `[queue] task queue ON (CLEO_TASK_QUEUE=1): executors ingest=modal render=local, running limits 20/4, queue cap 200`.
   Pro Analyse: `[modal] analyze_r2 for job … spawned, deadline … s`.
   `GET /admin/queue` zeigt `"executor": "modal"`, `limit` 20,
   `max_queue` 200.
5. Optional `CLEO_MAX_RUNNING_INGEST` (20) und `CLEO_MAX_QUEUE` (200)
   anpassen. Die echte Obergrenze ist meist Groq: das Audio-Budget
   `CLEO_GROQ_ASH_BUDGET` (11.1) gilt weiter und lässt Analysen sonst
   warten.

**Ausschalten:** Railway → `CLEO_EXECUTOR_INGEST` löschen → Deploy.
Neue Analysen laufen wieder auf Railway (mit Plattenprüfung, Limits 2/20
wie vorher). Analysen, die beim Umschalten auf Modal liefen, werden beim
Neustart wie jede unterbrochene Analyse erneut eingereiht (11.1: Reaper)
und laufen dann lokal. analyze_r2 und das Secret dürfen deployt bleiben
— ohne die Variable ruft sie niemand. (Ganz zurück: das Secret
`cleocuts-ai` löschen, dann deployt "Deploy Modal render" analyze_r2
nicht mehr.)

**Weitere Variablen** (nur bei Bedarf):

| Variable | Default | Wirkung |
|---|---|---|
| `CLEO_MODAL_ANALYZE_DEADLINE_S_BASE` / `_PER_S` / `_PER_GB` / `_MAX` | 900 / 3 / 120 / 7500 | Wartezeit auf einen Modal-Aufruf: 900 s + 3 × Videolänge + 120 s pro GB Upload, höchstens 2 h 5 min (Modals eigene Grenze für analyze_r2: 2 h); danach Abbruch + neuer Versuch |
| `CLEO_MODAL_POLL_S`, `CLEO_MODAL_START_TIMEOUT_S` | 10, 120 | wie beim Render (9.3); nicht gestartet nach 120 s und kein Container → neuer Versuch |

Nicht-geheime Analyse-Schalter von Railway (`CLEO_DISFLUENT_PROMPT`,
`CLEO_SUSTAINED_VOWEL_CUTS`, `CLEO_GROQ_MAX_RETRY_WAIT`,
`CLEO_GROQ_DEBUG`, `CLEO_CAPTION_PRESETS_LIVE`) schickt das Backend bei
jedem Aufruf mit; Keys nie.

**Kosten** (Modal $0,0000131 pro Kern-s und $0,00000222 pro GiB-s →
8 Kerne + 16 GiB ≈ **$0,00014/s ≈ $0,50 pro Container-Stunde**, nur
solange er läuft; Leerlauf nach 10 s beendet): geschätzt 15–25 s
Container-Zeit pro Videominute bei 1080p, 40–60 s bei 4K-HEVC-HDR →
**≈ $0,002–0,004 bzw. $0,006–0,009 pro analysierter Minute**. Dafür
entfallen auf Railway die Analyse-CPU (≈ $0,002/min nach
`CLEO_COST_RATES`) und der Egress beim Hochladen der Ergebnisse nach R2
(≈ $0,015/min, 10.9). Groq (≈ $0,0037/min, zwei Durchgänge) und Claude
bleiben gleich. Die echten Zahlen: `GET /admin/costs` (`usd_modal`,
`modal_s`, `wall_s_analyze` je Job) bzw. die Tabelle des Kosten-Tests.

## 12. Untertitel v2 im Export (UT4)

Der Export zeichnet die Untertitel mit derselben Engine wie die Vorschau
im Editor (`web/src/lib/captions`, auf dem Render-Server per Node), in
**einem** ffmpeg-Durchgang statt Brennen pro Clip + Zusammenfügen.
Code: `backend/captions_v2.py`, `backend/captions/` (Node-Paket + Build),
`web/src/lib/captions/node/`.

| Variable (Railway) | Default | Eingeschaltet | Zurück |
|---|---|---|---|
| `CLEO_CAPTION_ENGINE` | nicht gesetzt = Opt-in: alle bekommen v1, nur ein Browser, der einmal mit `?captions=v2` geöffnet wurde, bekommt v2 (unten) | `v2`: der **erste** Export jedes Projekts mit Edit-Dokument (UT3) läuft mit v2, wenn sein Stil in `CLEO_CAPTION_PRESETS_LIVE` steht und die Sprache kann | `v1` oder `off`: niemand bekommt v2, auch nicht per `?captions=v2` |
| `CLEO_LOUDNORM` | aus: Lautstärke wie aufgenommen | `1`: v2-Exporte auf −14 LUFS (Messung aus der Analyse) | Variable löschen |

- **Ein Projekt behält seine Technik:** Beim ersten Export wird `v1`
  oder `v2` am Job gespeichert (`caption_engine`) und nie mehr geändert.
  Umschalten wirkt also nur auf Projekte, die noch nie exportiert wurden.
- **Voraussetzung:** Modal ist neu deployt (GitHub-Action "Deploy Modal
  render" läuft bei jedem Push auf main von selbst; das Image baut
  dann Node 22 und den Untertitel-Layer, der erste Build dauert einige
  Minuten länger) **und** `CLEO_MODAL_RENDER_FN=render_r2`. Auf dem
  alten Volume-Weg (`render_burn_concat`) und beim lokalen Notfall-Render
  ohne Node wird auch ein v2-Projekt mit v1 exportiert (Log-Zeile
  `[captions] … rendering v1 captions`).
- **Nur für dich testen (ohne Railway, wie der Editor-Schalter #44):**
  solange `CLEO_CAPTION_ENGINE` nicht gesetzt ist, bleiben alle Kunden
  bei v1. Öffne einmal `cleocuts.com/app?editor=v2&captions=v2` (oder
  nur `?captions=v2`) — dein Browser merkt sich das, im Export-Bereich
  des Editors steht dann klein „Neue Untertitel (Test)“. Jeder **erste**
  Export eines Projekts aus diesem Browser fragt v2 an (sonst gelten
  dieselben Regeln: Edit-Dokument, Stil live, Sprache passt; danach
  bleibt das Projekt dabei). `?captions=v1` schaltet deinen Browser
  zurück. Mit `v1`/`off` wird die Anfrage ignoriert, mit `v2` ist sie
  unnötig.
- **Reihenfolge:** selbst ein neues Projekt mit `?captions=v2`
  exportieren und ansehen (Log: `[captions] v2 primary: … frames`),
  dann `CLEO_CAPTION_ENGINE=v2` für alle. Notbremse: `off`.
- **Stile:** Seit UT5 sind alle 12 Stile live (Default von
  `CLEO_CAPTION_PRESETS_LIVE`; jeder steht in der Paritätsprüfung
  Vorschau ↔ Export). Ein Stil, den du im Abnahmeblatt **nicht**
  abhakst, fliegt raus, indem du die Liste setzt, z. B.
  `CLEO_CAPTION_PRESETS_LIVE=power,clipper,karaoke` — der Stil-Tab
  bietet dann nur diese an.
- **Editor (UT5):** Mit v2 (oder deinem `?captions=v2`-Browser) zeigt
  der neue Editor die Untertitel so, wie der Export sie zeichnet: Stil
  wählen im Tab „Stil“, einen Untertitel in der Vorschau ziehen
  (Position) oder an der Ecke ziehen (Größe), dann „Nur hier“ oder
  „Überall“. Ohne v2 bleibt der Editor wie bisher.
- **Emoji:** Emoji und Symbole, die keine Untertitel-Schrift hat, lässt
  die Engine weg — in der Vorschau und im Export gleich, der Export
  scheitert nie daran (Log: `[captions] warning: N emoji/symbol
  character(s) … left out`, nur die Anzahl). Eine Farb-Emoji-Schrift im
  Render-Image (Noto Color Emoji, 10,8 MB; @napi-rs/canvas könnte sie
  zeichnen) ist bewusst nicht drin: die Vorschau bräuchte dieselbe
  Schrift (10,8 MB im Browser), sonst sähen Emoji und Zeilenumbrüche
  anders aus als im Export.
- **Japanisch/Koreanisch/Chinesisch:** Fehlt der Teil-Schriftsatz des
  Projekts ein Zeichen (z. B. nach einer Korrektur), wird er vor dem
  Export neu erzeugt. Klappt das nicht, läuft ein noch nie exportiertes
  Projekt mit v1; ein v2-Projekt bekommt „Render failed“ (nie Kästchen
  statt Zeichen).

## 13. Nochmal bearbeiten, Fair Use, Sofort-Export (UX11)

Ein fertiges Video lässt sich wieder öffnen und neu exportieren; der
Export im neuen Editor bleibt im Editor (Export-Blatt → Fertig-Ansicht).
**Die Oberfläche (Export-Blatt, neue Fertig-Ansicht, „Nochmal
bearbeiten“) gehört zum Editor-v2-Opt-in** (`NEXT_PUBLIC_EDITOR_V2`,
`?editor=v2`): v1-Kunden behalten ihren Export-Ablauf und die alte
Fertig-Ansicht unverändert. **Auch serverseitig gilt jede UX11-Regel
nur für Exporte aus dem v2-Export-Blatt** (`POST /render` mit
`"client": "v2"`, am Job als `export_client` vermerkt): Schutzgrenzen,
Fair-Use-Abbuchung, Sofort-Export, Bonus-Clips nur bei unveränderter
Timeline, Post-Text behalten. Ein v1-Export (ohne Marker) verhält sich
genau wie vor UX11 (inkl. Warteschlange statt 429 beim zweiten Export,
Post-Text bei jedem Export neu, Dateiname `cleo_{id}_{format}.mp4`).
Neue Dateinamen nur mit `GET /jobs/{id}/download?name=v2` (die
v2-Fertig-Ansicht). Fair Use und Schutzgrenzen pro Konto nur mit Konten
bzw. Abrechnung.
Code: `backend/exports.py` (Regeln), `backend/main.py` (`POST
/jobs/{id}/reopen`, `POST /jobs/{id}/render`, `_run_spec`),
`web/src/features/editor/export/`, `web/src/features/project/DoneView.tsx`.

| Variable (Railway) | Default | Wirkung |
|---|---|---|
| `CLEO_FREE_RENDERS` | `3` | erfolgreiche Exporte pro Video, die nichts kosten |
| `CLEO_RENDER_FAIRUSE_PCT` | `25` | jeder weitere Export bucht so viel % der **hochgeladenen** (abgerechneten) Länge von den Minuten ab |
| `CLEO_MAX_RENDERS_PER_USER` | `1` | gleichzeitige Exporte pro Konto (mit Konten); mehr → 429 `too_many_renders` („Bitte warte …“). `0` = aus |
| `CLEO_MAX_RENDERS_PER_JOB_DAY` | `20` | Exporte pro Video in 24 h → 429 `render_limit`. `0` = aus |
| `CLEO_MAX_RENDER_QUEUE` | `50` | wartende Exporte, darüber 503 `server_busy` + Retry-After. `0` = aus |
| `CLEO_SPECULATIVE_RENDER` | aus | `1`: Sofort-Export (unten) |
| `CLEO_SPEC_WORKERS` | `1` | gleichzeitige Vorab-Renders (eigener Pool, nie ein Kunden-Slot) |

**Nochmal bearbeiten** (`POST /jobs/{id}/reopen`): fertig → „Bereit zum
Bearbeiten“. Der bisherige Export (Video, Vorschaubild, Bonus-Clips,
Post-Text, SRT/VTT) bleibt herunterladbar, bis ein neuer Export fertig
ist; scheitert der neue, bleibt der alte. Antworten: 409 `busy` (läuft
gerade), 409 `media_unavailable` (Original weg), 410 `media_expired`
(Aufbewahrung abgelaufen), 409 `not_editable` (Analyse war
fehlgeschlagen). Das Wiederöffnen startet die Aufbewahrungsfrist neu
(`expires_at` folgt `updated_at`) — gehört in die FAQ.

**Untertitel-Technik bei Nochmal bearbeiten (UT4-Pinning):** ein Projekt
behält die Technik seines **ersten** Exports bei jedem weiteren Export.
- Vor UT4 exportierte Projekte (kein `caption_engine`, aber Ausgaben
  vorhanden) exportieren wieder mit v1 und werden dabei auf v1 gepinnt
  (`exported_before`) — sie sehen nach dem Neu-Export aus wie vorher.
- Ein auf v1 gepinntes Projekt im neuen Editor (`?editor=v2`): der
  Stil-Tab ändert seinen Export nicht; der Editor sagt das im
  Hinweis „Seine Untertitel behalten den Look des ersten Exports“.
- Ein auf v2 gepinntes Projekt exportiert immer v2 — auch wenn
  `CLEO_CAPTION_ENGINE` später auf `v1`/`off` gestellt wird (das wirkt
  nur auf nie exportierte Projekte); scheitert dann der v2-Aufbau, gibt
  es „Export fehlgeschlagen“ statt eines anderen Looks.
- Der Vorab-Render (Sofort-Export) ist der erste Render eines Projekts
  und pinnt v2; scheitert er, wird das Pinning zurückgenommen.

**Fair Use (Owner-Entscheidung, PLAN 2.6 B):** nur mit Abrechnung an und
für echte Konten (nicht der Service-Nutzer). Die ersten 3 erfolgreichen
Exporte eines Videos sind frei; jeder weitere bucht
`ceil(25 % × abgerechnete Länge)` als eigene Zeile im Minuten-Ledger
(`usage.job_id = "{job}#r{gen}"`, `enforce=False`: blockiert nie, auch
nicht bei leerem Kontingent — das Kontoblatt zeigt dann die
Überschreitung). Ein fehlgeschlagener Export bucht dieselbe Zeile zurück
(auch nach Container-Neustart / Übernahme durch den Leader). Der
Sofort-Export zählt nie. Scheitert die Rückbuchung selbst (Datenbank
weg), merkt sie sich der Server als Job-Event `refund_pending` und holt
sie beim Start und stündlich nach (idempotent über den Ledger-Schlüssel;
Log `[fair-use] pending refund … settled`). Ohne Abrechnung (heute in Produktion) zeigt die
App nur „Kostenlos“, keinen Zähler. Kein freiwilliges Geld-zurück.

**Sofort-Export** (`CLEO_SPECULATIVE_RENDER=1`): direkt nach der Analyse
rendert der Server ein Projekt, dessen erster Export v2 wäre (also mit
`CLEO_CAPTION_ENGINE=v2`), einmal vorab — auf einem eigenen kleinen Pool,
nie über einen Kunden-Slot, und nicht, wenn mehr als die Hälfte von
`CLEO_MAX_RENDER_QUEUE` wartet. Exportiert der Nutzer ohne Änderung
(gleiche Schnitte, gleicher Stil, gleicher Text — auch keine noch nicht
gespeicherte Änderung), ist die Fertig-Ansicht sofort da, ohne Kosten.
Jede Änderung macht den Vorab-Render ungültig; seine Dateien werden beim
nächsten Export gelöscht. Sinnvoll nur mit `render_r2` auf Modal (sonst
rendert der API-Server selbst). Ein Vorab-Render, den ein Neustart
abgeschnitten hat (bleibt „running“), wird beim Start (ohne
Warteschlange sofort, mit Warteschlange nach Modal-Timeout + 5 min) und
stündlich als gescheitert abgeschlossen: Pinning zurück, `r{gen}/` zum
Löschen vorgemerkt (Log `[spec] settled …`). Notbremse: Variable löschen.

**Fertig-Ansicht:** Download (ein Knopf pro echter Datei,
Dateiname `{titel}_cleocuts_9x16.mp4`, auch bei japanischen/russischen
Titeln), am Handy „In Fotos sichern / Teilen“ (bis 250 MB), Post-Text
bearbeiten/kopieren (beim Export aus dem bearbeiteten Text erzeugt; ein
v2-Neu-Export mit gleichem Text und Schnitt behält ihn, kein „Neu
erzeugen“), SRT/VTT (`GET /jobs/{id}/captions.srt|vtt`), Bonus-Clips nur
bei unveränderter Timeline und ≥ 90 s, „Cleo cut“-Tipp, Umfrage
„Musstest du woanders schneiden?“ ab dem 2. Export (max. 1×/Woche,
`POST /feedback` → Job-Event `feedback_post_export`).

**Noch nicht drin (eigene Pakete):** Testimonial-Anfrage nach dem 3.
Export (braucht die versionierte Einwilligung aus UX14), „Jetzt
herunterladen“ in der Fertig-Mail (UX13), „Nochmal bearbeiten“ im ⋯-Menü
der Projekt-Kacheln (UX12).
