# IDM — Native Windows Install (no Docker)

Stand up IDM directly on Windows Server with **MS SQL Server**, a
**Redis-compatible service** (free Redis-for-Windows or Memurai), **IIS** as the
front, and search degraded to the database (no Elasticsearch). Target host in
this guide: `192.168.100.244`.

```
Windows Server 2022
├─ IIS :80  ── serves SPA (dist) ── reverse-proxies /api, /ws → daphne :8000
├─ Python venv
│   ├─ daphne (ASGI: HTTP + WebSocket)        ─┐
│   ├─ celery worker  (default,indexing,…)     │  run as Windows
│   ├─ celery beat                             │  services via NSSM
│   └─ celery worker  (preview / ocr)         ─┘
├─ MS SQL Server  (idm_db)
└─ Redis service  (Celery broker + Channels + cache)  — Redis-for-Windows / Memurai
```

Search uses the DB fallback (`ELASTICSEARCH_ENABLED=False`); OCR, Office
previews, workflows, email/OTP all work natively.

---

## 0. Prerequisites to install (admin PowerShell unless noted)

| Component | Where | Notes |
|---|---|---|
| **Python 3.11 (64-bit)** | python.org | Tick "Add to PATH". 3.10–3.12 fine. |
| **Node.js 20 LTS** | nodejs.org | Only to build the SPA. |
| **Git** | git-scm.com | Or copy the source over. |
| **MS SQL Server 2019/2022** | Microsoft | Express edition is fine for small sites. |
| **Microsoft ODBC Driver 17 or 18 for SQL Server** | Microsoft | Required by pyodbc. Either works; use whichever is installed (set `DB_ODBC_DRIVER` to match). |
| **Redis-compatible service** | see §2 | Free Redis-for-Windows or Memurai; installs as a service. |
| **Tesseract OCR** | UB-Mannheim build | Default path `C:\Program Files\Tesseract-OCR`. |
| **LibreOffice** | libreoffice.org | For Office→PDF previews. |
| **Poppler for Windows** | poppler-windows releases | Unzip and **add its `\bin` to PATH** (pdf2image needs it). |
| **NSSM** | nssm.cc | Runs daphne/celery as services. |

Sizing: ≥ 4 vCPU, ≥ 8 GB RAM (PaddleOCR + LibreOffice are the heavy bits),
≥ 40 GB disk. SSD strongly recommended for preview/OCR speed.

---

## 1. Database — MS SQL Server

Create the database and a SQL login (skip the login for Windows/trusted auth).
In **SQL Server Management Studio** (or `sqlcmd`):

```sql
CREATE DATABASE idm_db;
GO
CREATE LOGIN idm_user WITH PASSWORD = 'CHANGE_ME_strong';
GO
USE idm_db;
CREATE USER idm_user FOR LOGIN idm_user;
ALTER ROLE db_owner ADD MEMBER idm_user;
GO
```

Make sure **TCP/IP is enabled** (SQL Server Configuration Manager → Protocols)
and the **SQL Server Browser** service is running if you use a named instance.

---

## 2. Redis (Redis-compatible service)

Redis backs the Celery broker, the Channels (websocket) layer, and the cache, so
it must stay up continuously. Any Redis-compatible Windows service works — it's a
drop-in via `REDIS_URL`. Options:

- **Free Redis-for-Windows** (tporadowski build) — free, unofficial, Redis ~5.x,
  installs as a Windows service. The default for these installs.
- **Memurai** — actively maintained; Developer edition is free for non-production,
  Enterprise (licensed) for production. **Avoid the RC/preview builds**: they
  carry a ~10-day max-uptime auto-shutdown that would take Redis (and thus
  background processing + websockets + cache) down until restarted.

Install your choice as a service on `localhost:6379`, then verify with its CLI:

```powershell
redis-cli ping          # -> PONG   (memurai-cli ping for Memurai)
```

If the service has a password, reflect it in `REDIS_URL`
(`redis://:YOUR_PASSWORD@localhost:6379/0`).

---

## 3. Get the code + Python environment

```powershell
git clone <your-repo-url> C:\IDM\app
cd C:\IDM\app
git checkout windows

py -3.11 -m venv C:\IDM\venv
C:\IDM\venv\Scripts\activate
python -m pip install --upgrade pip wheel
pip install -r requirements-windows.txt
python -m spacy download en_core_web_sm   # if not already pulled by the pin
```

Create the data folders referenced by the env:

```powershell
mkdir C:\IDM\media, C:\IDM\lo-profile -ErrorAction SilentlyContinue
```

---

## 4. Configure

```powershell
copy .env.windows.example .env
notepad .env
```

Fill in (see comments in the file):
- `SECRET_KEY` — generate one:
  `python -c "from django.core.management.utils import get_random_secret_key as g; print(g())"`
- `ALLOWED_HOSTS` / `CSRF_TRUSTED_ORIGINS` / `CORS_ALLOWED_ORIGINS` / `FRONTEND_URL` → `192.168.100.244` (and a hostname if you have one).
- `DB_*` — SQL auth (`DB_USER`/`DB_PASSWORD`) or Windows auth (blank user + `DB_EXTRA_PARAMS=Trusted_Connection=yes`).
- `REDIS_URL` — leave default unless Memurai has a password.
- `EMAIL_*` — your internal SMTP relay (login OTP needs working mail).
- Tool paths — match where you installed LibreOffice / Tesseract.

Use **forward slashes** in paths.

---

## 5. Migrate, static, admin user

```powershell
python manage.py migrate
python manage.py smoke_check          # validates DB + key queries + cache
python manage.py collectstatic --noinput
python manage.py createsuperuser
```

> First run against a fresh MS SQL DB applies all migrations. If a migration
> trips on an MSSQL-specific constraint, note which one and we'll adjust it —
> the schema is MySQL-developed, so a couple of edge cases may surface here.
>
> **`smoke_check`** is a read-only command that exercises the live stack against
> SQL Server right after migrate: DB connection + vendor, representative ORM
> queries (including the cross-DB JSON personal-tag filter and the analytics
> datetime arithmetic), a `DISTINCT`+`ORDER BY` query, and a cache round-trip to
> Memurai. Every line should read `[ OK ]`; it exits non-zero if anything fails,
> so it's the fastest way to confirm the MSSQL + Memurai wiring before going further.

Smoke-test ASGI from the venv (Ctrl+C to stop once it says *Listening*):

```powershell
daphne -b 127.0.0.1 -p 8000 IDM.asgi:application
```

---

## 6. Build the frontend (SPA)

```powershell
cd C:\IDM\app\frontend
npm ci
npm run build        # outputs C:\IDM\app\frontend\dist
```

No API URL is baked in — the SPA calls a relative `/api/v1`, so IIS serving it
same-origin is all that's needed.

---

## 7. Run the app as Windows services (NSSM)

daphne and the Celery workers must run as background services. Using NSSM:

```powershell
# Backend (ASGI: HTTP + WebSocket)
nssm install IDM-Daphne   C:\IDM\venv\Scripts\daphne.exe -b 127.0.0.1 -p 8000 IDM.asgi:application
nssm set     IDM-Daphne   AppDirectory C:\IDM\app

# Celery worker (default + indexing + notifications). Windows needs --pool=solo.
nssm install IDM-Celery   C:\IDM\venv\Scripts\celery.exe -A IDM worker -l info --pool=solo -Q default,indexing,notifications
nssm set     IDM-Celery   AppDirectory C:\IDM\app

# Celery worker for OCR + Office previews (solo keeps the warm LO profile safe)
nssm install IDM-CeleryHeavy C:\IDM\venv\Scripts\celery.exe -A IDM worker -l info --pool=solo -Q ocr,preview
nssm set     IDM-CeleryHeavy AppDirectory C:\IDM\app

# Celery beat (scheduled jobs: SLA checks, signature reminders)
nssm install IDM-Beat     C:\IDM\venv\Scripts\celery.exe -A IDM beat -l info
nssm set     IDM-Beat     AppDirectory C:\IDM\app

nssm start IDM-Daphne; nssm start IDM-Celery; nssm start IDM-CeleryHeavy; nssm start IDM-Beat
```

> Windows + Celery: always `--pool=solo` (the default prefork pool isn't
> supported on Windows). Each service inherits the machine env; ensure the venv
> and `.env` are reachable from `AppDirectory`. NSSM can also redirect stdout/err
> to log files (`nssm set <svc> AppStdout C:\IDM\logs\<svc>.log`).

---

## 8. IIS — serve the SPA + reverse-proxy the API

Install IIS with the needed pieces, then the proxy modules:

```powershell
Install-WindowsFeature -Name Web-Server,Web-Mgmt-Console,Web-WebSockets
# Then install (download from Microsoft): URL Rewrite 2.1 and
# Application Request Routing (ARR) 3.0. After installing ARR, enable proxy:
#   IIS Manager → server node → Application Request Routing Cache →
#   Server Proxy Settings → tick "Enable proxy".
```

Create a site whose **physical path is the SPA build** (`C:\IDM\app\frontend\dist`)
bound to port 80.

The required **`web.config`** (API/WS reverse-proxy + SPA fallback) now ships in
the repo at `frontend/public/web.config`, so `npm run build` copies it into
`dist/` automatically — there's nothing to add by hand.

> ⚠️ Don't drop a `web.config` directly into `dist/` — `npm run build` empties
> `dist/` first and would delete it. That's why it lives in `public/`. After any
> rebuild, confirm `dist\web.config` exists.

Also enable **"Preserve client Host header"** so the backend builds correct
absolute URLs (IIS Manager → server node → Application Request Routing Cache →
Server Proxy Settings → tick it). The frontend re-hosts API URLs as a safety net,
but preserving Host is the right proxy hygiene.

Notes:
- The **WebSocket feature** (installed above) lets ARR proxy `/ws/` for chat /
  live workflow updates.
- `maxAllowedContentLength=52428800` (in the web.config) = 50 MB uploads (match Django).
- `/media` and `/static` are proxied to daphne here for simplicity (WhiteNoise
  serves `/static`; Django serves `/media`). For higher throughput you can later
  point an IIS virtual directory straight at `C:\IDM\media`.

### "Edit in <Office app>" (WebDAV)

Opening a document in the desktop Office app uses WebDAV. The shipped `web.config`
**removes IIS's `WebDAVModule`/handler** so the WebDAV verbs (`PROPFIND`, `LOCK`,
`UNLOCK`, `PUT`) pass through to daphne — IIS's own WebDAV would otherwise grab
them and editing would silently fail. No extra IIS step beyond using the shipped
config. On the **client** machines:

- The **WebClient** service must be **Running** (it's the Windows WebDAV
  redirector Office uses): `Set-Service WebClient -StartupType Automatic; Start-Service WebClient`.
- **Add `http://192.168.100.244` to the Local Intranet zone** on client machines
  (Internet Options → Security → Local intranet → Sites → Advanced). This is the
  single biggest UX win: it stops Office opening the file in **Protected View**
  (read-only) first and re-fetching on "Enable Editing" — which is most of the
  "takes a while to launch" delay — and avoids repeated auth prompts.
- If editing still opens read-only or won't save over plain HTTP, set the WebClient
  registry value `HKLM\SYSTEM\CurrentControlSet\Services\WebClient\Parameters\BasicAuthLevel = 2`
  and restart the WebClient service. (Auth is via a one-time token in the WebDAV
  URL, not Windows creds.)
- Some launch/save latency is inherent to the WebDAV redirector and can't be tuned
  away server-side; the steps above remove the avoidable part.
- Saving in the desktop app writes back as a **new document version**.

---

## 9. Verify

From a client on the LAN, browse to **`http://192.168.100.244`**:
- Login page loads; sign in as the superuser; OTP email arrives.
- DevTools → Network: API calls hit `http://192.168.100.244/api/v1/...` (200).
- Upload a document → preview renders (LibreOffice), OCR completes (watch the
  `IDM-CeleryHeavy` log).
- Search returns results (DB fallback).

Server-side checks:
```powershell
C:\IDM\venv\Scripts\activate; cd C:\IDM\app
python manage.py check
python -c "import pyodbc, django, os; os.environ.setdefault('DJANGO_SETTINGS_MODULE','IDM.settings'); django.setup(); from django.db import connection; connection.ensure_connection(); print('DB OK')"
redis-cli ping          # (memurai-cli ping for Memurai) -> PONG
```

---

## 10. Known limitations / notes on this branch

- **No Elasticsearch** → search is a database `contains` query (no fuzzy/ranking).
  Set `ELASTICSEARCH_ENABLED=True` + run an ES service to restore full search.
- **"Open in desktop app" / WebDAV editing** generates Linux shell scripts
  (xdg-mime/nohup) — those won't run on Windows clients. The in-browser
  preview/download path works; native desktop-edit needs a Windows equivalent
  (future work).
- **Redis** runs continuously (broker + websockets + cache). Free Redis-for-Windows
  is the default here; Memurai is an alternative (Enterprise license for prod).
  Don't use Memurai RC/preview builds — they auto-shut-down after ~10 days uptime.
  Either way it's a `REDIS_URL` swap, no code change.
- **HTTP only** on the LAN. For HTTPS, add a binding + cert on the IIS site.
- **MS SQL migrations**: the schema was MySQL-developed; if `migrate` errors on
  a specific migration, capture it — a small number may need MSSQL-compatible
  tweaks.
```
