# IDM — Native Windows Install (no Docker)

Stand up IDM directly on Windows Server with **MS SQL Server**, **Memurai**
(Redis-compatible), **IIS** as the front, and search degraded to the database
(no Elasticsearch). Target host in this guide: `192.168.100.244`.

```
Windows Server 2022
├─ IIS :80  ── serves SPA (dist) ── reverse-proxies /api, /ws → daphne :8000
├─ Python venv
│   ├─ daphne (ASGI: HTTP + WebSocket)        ─┐
│   ├─ celery worker  (default,indexing,…)     │  run as Windows
│   ├─ celery beat                             │  services via NSSM
│   └─ celery worker  (preview / ocr)         ─┘
├─ MS SQL Server  (idm_db)
└─ Memurai        (Celery broker + Channels + cache)
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
| **Microsoft ODBC Driver 18 for SQL Server** | Microsoft | Required by pyodbc. |
| **Memurai** | memurai.com | Redis-compatible; installs as a service. |
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

## 2. Memurai (Redis)

Install Memurai (Developer edition is free) — it registers a Windows service on
`localhost:6379`. Verify:

```powershell
memurai-cli ping        # -> PONG
```

If you set a password in `memurai.conf`, reflect it in `REDIS_URL`.

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
python manage.py collectstatic --noinput
python manage.py createsuperuser
```

> First run against a fresh MS SQL DB applies all migrations. If a migration
> trips on an MSSQL-specific constraint, note which one and we'll adjust it —
> the schema is MySQL-developed, so a couple of edge cases may surface here.

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
bound to port 80. Add a `web.config` in that folder:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<configuration>
  <system.webServer>
    <rewrite>
      <rules>
        <!-- API + websockets → daphne -->
        <rule name="api" stopProcessing="true">
          <match url="^(api|ws|static|media)/.*" />
          <action type="Rewrite" url="http://127.0.0.1:8000/{R:0}" />
        </rule>
        <!-- SPA client-side routing: everything else → index.html -->
        <rule name="spa" stopProcessing="true">
          <match url=".*" />
          <conditions logicalGrouping="MatchAll">
            <add input="{REQUEST_FILENAME}" matchType="IsFile" negate="true" />
            <add input="{REQUEST_FILENAME}" matchType="IsDirectory" negate="true" />
          </conditions>
          <action type="Rewrite" url="/index.html" />
        </rule>
      </rules>
    </rewrite>
    <security>
      <requestFiltering><requestLimits maxAllowedContentLength="52428800" /></requestFiltering>
    </security>
  </system.webServer>
</configuration>
```

Notes:
- The **WebSocket feature** (installed above) lets ARR proxy `/ws/` for chat /
  live workflow updates.
- `maxAllowedContentLength=52428800` = 50 MB uploads (match Django).
- `/media` and `/static` are proxied to daphne here for simplicity (WhiteNoise
  serves `/static`; Django serves `/media`). For higher throughput you can later
  point an IIS virtual directory straight at `C:\IDM\media`.

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
memurai-cli ping
```

---

## 10. Known limitations / notes on this branch

- **No Elasticsearch** → search is a database `contains` query (no fuzzy/ranking).
  Set `ELASTICSEARCH_ENABLED=True` + run an ES service to restore full search.
- **"Open in desktop app" / WebDAV editing** generates Linux shell scripts
  (xdg-mime/nohup) — those won't run on Windows clients. The in-browser
  preview/download path works; native desktop-edit needs a Windows equivalent
  (future work).
- **Memurai** Developer edition is free for non-production; production use needs
  a Memurai license (or swap in another Redis-compatible service via `REDIS_URL`).
- **HTTP only** on the LAN. For HTTPS, add a binding + cert on the IIS site.
- **MS SQL migrations**: the schema was MySQL-developed; if `migrate` errors on
  a specific migration, capture it — a small number may need MSSQL-compatible
  tweaks.
```
