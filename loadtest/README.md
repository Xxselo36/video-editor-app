# Lasttest (WP7)

Python-Harness für den Go/No-Go-Lasttest vor dem Launch (scaleplan §WP7).
Kein k6, nur Python 3.11+ und `aiohttp`.

```bash
pip install -r loadtest/requirements.txt
python -m loadtest <szenario> --help      # alle Optionen
```

Jeder Lauf schreibt einen Markdown- und einen JSON-Bericht nach `loadtest/results/`
(`--out`). In GitHub Actions landet der Bericht zusätzlich in der Job-Summary.
Exit-Code: `0` bestanden, `1` durchgefallen, `2` Aufruf-/Setup-Fehler.

**Sicherheit:** Nur `poll-soak` läuft ohne `--base-url` (dann gegen
`https://api.cleocuts.com`). Alle anderen Szenarien brauchen `--base-url` explizit.
`burst` braucht zusätzlich `--i-understand-this-costs-money`.

## Identität

| Variable | Wirkung |
|---|---|
| `CLEO_ADMIN_TOKEN` | Service-Identität (`X-Admin-Token`): sieht alle Jobs, kein Kontingent, kein Pro-Nutzer-Limit. Standard, wenn gesetzt. |
| `CLEO_TEST_BEARER` | Clerk-Session-Tokens von Testnutzern (Komma-getrennt). Leben nur 60 s (+60 s Toleranz) – nur für kurze Läufe. |
| `CLEO_TEST_SESSION_IDS` + `CLERK_SECRET_KEY` | Session-IDs von Testnutzern; die Harness holt alle 40 s frische Tokens über die Clerk Backend API. |

`--identity admin|user|none` wählt, als wer die Last läuft. Vorher prüfen:
`python -m loadtest whoami --base-url …` (ruft `GET /me` für jede Identität).
Das Backend verlangt ein `azp` aus `CLERK_AUTHORIZED_PARTIES` – ob Tokens aus der
Clerk Backend API das haben, zeigt `whoami`.

## Szenarien

| Szenario | Was | Kosten |
|---|---|---|
| `poll-soak` | N Nutzer pollen `GET /jobs/status?ids=…` alle 2 s (mit ETag/304 wie das Dashboard), ~1×/min `GET /jobs`; `/health` + `/ready` jede Sekunde | praktisch nichts (nur Lesezugriffe) |
| `editor-saves` | N Editoren speichern alle 5–10 s die Timeline (`POST /jobs/{id}/edit-segments`), inkl. Umsortieren; misst parallel `/health` + Status | CPU auf dem Server (Preview-Encode je Speichern, bis WP5) |
| `media` | M Player mit Range-Requests im Abspieltempo + D Downloads | Railway-Egress, ≈ 0,05 $/GB (Schätzung vorab; Abbruch über `--max-egress-gb`, Standard 25) |
| `abuse` | 413 für übergroße Bodys, 401 ohne Token, 413 für Größen-/Längen-Limits, 400 für >50 IDs; optional 429 pro Nutzer und 503+Retry-After bei voller Queue | ohne Uploads nichts; mit Uploads ein paar kurze Analysen à 20 s (Cent-Bereich; der Testnutzer braucht einen Plan mit Minuten) |
| `burst` | K echte Uploads (Clips aus `.github/scripts/cost_test.py`) innerhalb von 60 s, beobachtet Queue-Positionen bis zum Analyse-Ende, optional Render | **teuer**: Groq + Claude (+ Modal mit `--render`); Schätzung aus `/admin/costs` vorab, Abbruch über `--max-usd` (Standard 5) |

Bestehen (Standard): p95 < 200 ms für billige Lesezugriffe (`--p95-ms`), nur
beabsichtigte Statuscodes (429/503 nur mit `Retry-After` und höchstens 1 % je
Endpunkt, `--max-refusal-rate`; ihre Latenzen zählen nicht ins p95), 0 Token-Fehler,
die Hauptmessung hat Antworten (poll-soak: Poll-Rate ≥ 90 % des Ziels), `/health` 100 %
beantwortet, ≤ 0,1 % Transportfehler (`--max-error-rate`), 0 verlorene /
doppelte Jobs. Warnung, wenn der Lastgenerator selbst ausgelastet ist
(Event-Loop-Lag) – dann mehr `--procs` oder mehrere Runner.

### Beispiele

```bash
# Dashboard-Poll wie in WP7 (1000 Nutzer, 30 min) – billig
python -m loadtest poll-soak --users 1000 --minutes 30 --ids <job-ids>

# Editor – nur Test-Jobs! (z. B. Cost-Test-Workflow mit keep_jobs)
python -m loadtest editor-saves --base-url https://api.cleocuts.com \
  --editors 100 --minutes 10 --ids <job-ids>

# Media: 200 Player + 50 Downloads
python -m loadtest media --base-url https://api.cleocuts.com \
  --streams 200 --downloads 50 --minutes 5 --ids <gerenderte-job-ids> --max-egress-gb 60

# Missbrauch; mit Testnutzer: 20 Uploads eines Nutzers → max. 2 angenommen, Rest 429
python -m loadtest abuse --base-url https://api.cleocuts.com \
  --per-user-uploads 20 --queue-cap-uploads 25 --i-understand-this-costs-money

# Burst wie WP4 (teuer!)
python -m loadtest burst --base-url https://api.cleocuts.com \
  --clips synthetic:2x50,synthetic:10x10 --max-usd 20 --i-understand-this-costs-money
```

Hinweise:
- `editor-saves` verändert die Jobs und stellt am Ende die ursprüngliche Timeline
  wieder her. Gegen ein nicht-lokales Ziel werden nur Jobs akzeptiert, die
  `/admin/costs` als Test-Jobs führt (sonst `--allow-foreign-jobs`).
- `burst` löscht seine Jobs immer (auch bei Fehler/Strg-C/SIGTERM). Jede angelegte
  Job-ID steht sofort in `<--out>/created-ids.txt` (auch bei `abuse`); nach einem
  Abbruch: `python -m loadtest cleanup --base-url … --ids-file <out>/created-ids.txt`.
  Der Workflow macht das in einem `always()`-Schritt selbst.
- `burst` schlägt fehl, wenn weniger als `--min-accepted` Uploads angenommen werden
  (Standard min(K, `CLEO_MAX_ANALYZE` + `CLEO_MAX_QUEUE`), 0 angenommen immer FAIL),
  und wenn die Queue langsamer als 80 % der Vorhersage abläuft
  (`--expect-video-min-per-hour` oder aus den nie wartenden Jobs des Laufs).
- Als Service-Identität (`--identity auto`/`admin`) gibt es eine WARN-Zeile: JWT-Prüfung,
  Besitzer-Filter und Library werden dann nicht gemessen – für das WP7-Gate `--identity user`.
- Als Service-Identität listet `GET /jobs` die Jobs *aller* Nutzer – `poll-soak`
  schickt es dann nur alle 60 s; die echte Library-Last misst `--identity user`.
- Alle Anfragen kommen von einer IP: WAF/Rate-Limits (Cloudflare, WP6) können
  429 liefern – mit `Retry-After` zählt das als beabsichtigte Ablehnung.

## GitHub Actions

Workflow **Load test (WP7)** (`.github/workflows/load-test.yml`, manuell starten):
Szenario, `base_url`, Job-IDs, Zusatzargumente, Identität, Kosten-Häkchen.
Secrets: `CLEO_ADMIN_TOKEN`, optional `CLEO_TEST_BEARER`,
`CLEO_TEST_SESSION_IDS`, `CLERK_SECRET_KEY`.

## Selbsttest

```bash
python -m unittest discover -s loadtest/tests -t .
```

Lokal gegen das Stub-Backend (`uvicorn` mit `backend.main`, SQLite, ohne
`CLEO_ALLOWED_ORIGINS`) laufen alle Szenarien mit `--base-url http://127.0.0.1:<port>`;
Uploads in `abuse` brauchen dort kein Kosten-Häkchen.
