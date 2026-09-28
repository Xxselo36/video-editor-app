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

- **Billing braucht das Volume.** Liegt die DB auf `/tmp` (kein `/data`,
  kein `CLEO_JOB_DB`), bleibt Billing aus — Log beim Start:
  `[billing] !!! BILLING DISABLED: the job DB is on /tmp …`,
  `GET /billing/config` meldet `"reason": "db_not_persistent"`.
- **Backup:** Abos lassen sich aus der LS-API neu aufbauen, das
  Minuten-Ledger (`usage`-Tabelle in `/data/cleo_jobs.db`) nicht →
  Railway-Volume-Backups einschalten.
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
| `GET /jobs` | Projekte des Users (AUTH aus: 404 `not_available`) |
| `GET /billing/config` | öffentlich: Billing an?, Pläne + Preise |
| `POST /billing/checkout` | `{plan}` → `{url}`; 409 `already_subscribed` → Portal |
| `GET /billing/portal` | frische Customer-Portal-URL |
| `POST /billing/webhook` | Lemon Squeezy (HMAC-signiert) |

Entfernt: `/uploads/multipart/*` und `/jobs/{id}/source-video` (vom
Frontend nie benutzt).
