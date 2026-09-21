# IDM — PostgreSQL Deployment Guide

This guide adds PostgreSQL as the active database backend for IDM. The same
application image and codebase run on all three backends; only the environment
variables and database service differ.

**Backend selection summary:**

| `DB_ENGINE` value | Backend | Driver |
|---|---|---|
| `mysql` (default) | MySQL 8 | mysqlclient |
| `mssql` / `sqlserver` | MS SQL Server | mssql-django + pyodbc |
| `postgres` / `postgresql` / `pgsql` | PostgreSQL 16+ | psycopg (v3) |

---

## Prerequisites

| Component | Notes |
|---|---|
| **Docker + Compose v2** | Standard Linux install; see DEPLOY_UAT.md §2 |
| **PostgreSQL 16** | Provided by the Compose overlay (postgres:16-alpine) |
| **psycopg[binary]** | Included in `requirements.txt`; no system package needed (binary wheel bundles libpq) |

For a **bare-metal** (non-Docker) PostgreSQL install, ensure `psycopg[binary]>=3.1`
is installed in the virtualenv:

```bash
pip install "psycopg[binary]>=3.1,<4"
```

---

## 1. Create the PostgreSQL database and user

### Docker (automatic via Compose overlay)

The overlay creates the database and user automatically using the
`POSTGRES_DB` / `POSTGRES_USER` / `POSTGRES_PASSWORD` environment variables.
Skip to §2.

### Bare-metal / existing PostgreSQL instance

Connect as a superuser and run:

```sql
CREATE USER idm_user WITH PASSWORD 'CHANGE_ME_strong';
CREATE DATABASE idm_db OWNER idm_user;
-- Grant all privileges (idm_user is already the owner, but explicit is safer)
GRANT ALL PRIVILEGES ON DATABASE idm_db TO idm_user;
```

---

## 2. Configure

```bash
cp .env.postgres.example .env
nano .env         # or your editor of choice
```

Fill in at minimum:

- `SECRET_KEY` — generate one:
  ```bash
  python -c "from django.core.management.utils import get_random_secret_key as g; print(g())"
  ```
- `DB_PASSWORD` / `PGPASSWORD` — use the same password you set in §1.
- `ALLOWED_HOSTS` / `CSRF_TRUSTED_ORIGINS` / `CORS_ALLOWED_ORIGINS` — your
  real hostname(s) / IP.
- `REDIS_PASSWORD` — any strong password.
- `EMAIL_*` — your SMTP relay (OTP login requires working mail in production).

**Connection style — choose one:**

Option A (discrete vars, recommended for Docker):
```env
DB_ENGINE=postgres
DB_HOST=postgres          # Docker service name; use "localhost" for bare-metal
DB_PORT=5432
DB_NAME=idm_db
DB_USER=idm_user
DB_PASSWORD=CHANGE_ME
```

Option B (`DATABASE_URL`):
```env
DB_ENGINE=postgres
DATABASE_URL=postgresql://idm_user:CHANGE_ME@localhost:5432/idm_db
```

`DATABASE_URL` takes priority if both are set.

---

## 3. Start the stack (Docker)

```bash
# Dev stack — MySQL replaced by PostgreSQL (Vite hot-reload frontend included)
docker compose -f docker-compose.yml -f docker-compose.postgres.yml up -d

# Watch startup
docker compose -f docker-compose.yml -f docker-compose.postgres.yml logs -f backend
```

The `backend` container automatically runs `migrate` on startup. Wait for the
log line `Watching for file changes with StatReloader` (or the Daphne startup
message) before proceeding.

> **MySQL is still defined in the base file** — it just won't be used (no
> service depends on it in the overlay). You can suppress it entirely with
> `--scale db=0` if desired, but it is harmless to leave it.

---

## 4. Migrate, static files, and admin user

### Docker

```bash
COMPOSE="docker compose -f docker-compose.yml -f docker-compose.postgres.yml"

# The backend container runs migrate automatically, but you can also run it
# manually (useful to inspect the plan first):
$COMPOSE exec backend python manage.py migrate --plan
$COMPOSE exec backend python manage.py migrate

# Smoke-test the live stack (DB connection, JSON filters, analytics, cache):
$COMPOSE exec backend python manage.py smoke_check

# Create the first admin user:
$COMPOSE exec backend python manage.py createsuperuser

# Build Elasticsearch indexes (if ELASTICSEARCH_ENABLED=True):
$COMPOSE exec backend python manage.py search_index --rebuild -f
```

### Bare-metal

```bash
# Activate your virtualenv first
source /path/to/venv/bin/activate
export DB_ENGINE=postgres DB_HOST=localhost DB_PORT=5432 \
       DB_NAME=idm_db DB_USER=idm_user DB_PASSWORD=CHANGE_ME

python manage.py check --database default
python manage.py migrate
python manage.py smoke_check
python manage.py createsuperuser
```

---

## 5. Verify

### Backend health

```bash
COMPOSE="docker compose -f docker-compose.yml -f docker-compose.postgres.yml"

# All checks should print [ OK ]
$COMPOSE exec backend python manage.py smoke_check

# Confirm the active vendor and engine
$COMPOSE exec backend python -c "
import django, os
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'IDM.settings')
django.setup()
from django.db import connection
print('vendor :', connection.vendor)
print('engine :', connection.settings_dict['ENGINE'])
"
# Expected output:
#   vendor : postgresql
#   engine : django.db.backends.postgresql
```

### Run the test suite

```bash
$COMPOSE exec backend python manage.py test
```

---

## 6. Backup and restore

### Backup

```bash
# Docker — dump from the running container
docker compose -f docker-compose.yml -f docker-compose.postgres.yml \
  exec -T postgres pg_dump -U idm_user idm_db > idm_$(date +%F).sql

# Bare-metal
pg_dump -U idm_user -h localhost idm_db > idm_$(date +%F).sql

# Compressed format (faster restore, smaller file)
pg_dump -U idm_user -h localhost -Fc idm_db > idm_$(date +%F).dump
```

### Restore

```bash
# Plain SQL
psql -U idm_user -h localhost idm_db < idm_2026-09-18.sql

# Custom format (parallel restore, faster for large databases)
pg_restore -U idm_user -h localhost -d idm_db -j 4 idm_2026-09-18.dump
```

> **Media files** are stored on disk (or S3) and are not in the database dump.
> Back them up separately:
> ```bash
> # Docker volume → tar
> docker run --rm \
>   -v idm_media_files:/m \
>   -v "$PWD":/b \
>   alpine tar czf /b/media_$(date +%F).tgz -C /m .
> ```

---

## 7. Day-2 operations

```bash
alias pg="docker compose -f docker-compose.yml -f docker-compose.postgres.yml"

pg logs -f backend celery_worker   # tail logs
pg restart backend                 # restart a service
pg down                            # stop (keeps data volumes)
pg up -d --build                   # rebuild image and redeploy
```

> ⚠️ **Never** run `docker system prune --volumes` or `docker volume prune` —
> that deletes the `postgres_data` (and `media_files`, `es_data`, …) volumes.
> Use `docker image prune -f` to reclaim space from old images only.

---

## 8. Cross-backend compatibility matrix

The same codebase is validated against all three backends. Run this checklist
manually (or in CI) when updating migrations or backend-sensitive queries:

| Check | MySQL 8 | PostgreSQL 16 | SQL Server |
|---|---|---|---|
| `manage.py check --database default` | ✓ | ✓ | ✓ |
| `manage.py migrate` (clean DB) | ✓ | ✓ | ✓ |
| `manage.py smoke_check` | ✓ | ✓ | ✓ |
| `manage.py test` | ✓ | ✓ | N/A (no CI runner) |
| JSONField storage + retrieval | ✓ | ✓ (native jsonb) | ✓ (limited) |
| `metadata__personal_tags__contains` | ✓ JSON_CONTAINS | ✓ `@>` operator | ✓ Python fallback |
| `duration_hours_expr()` analytics | ✓ | ✓ interval math | ✓ |
| `DISTINCT + ORDER BY` | ✓ | ✓ | ✓ |
| `bulk_create(ignore_conflicts=True)` | ✓ | ✓ | ✗ (feature flag) |
| Celery result/beat (django-db backend) | ✓ | ✓ | ✓ |

### ORM compatibility notes

- **`metadata__personal_tags__contains=[value]`** — works on MySQL and
  PostgreSQL via their native JSON containment operators. The existing
  `connection.vendor == "microsoft"` guard in
  `apps/documents/filters.py` falls back to a Python membership check on
  SQL Server only; no change required for PostgreSQL.

- **`duration_hours_expr()`** — divides a `timedelta` expression by
  `timedelta(hours=1)`. Django maps this to native interval arithmetic on
  all three backends; no backend-specific code is needed.

- **Migrations** — all migrations are shared across backends. PostgreSQL
  natively supports `JSONField` as `jsonb`, which has better index support
  than MySQL's `JSON` column type. No PostgreSQL-specific migration files
  are needed.

---

## Notes / known limitations

- **SQL mode** — The `SET sql_mode='STRICT_TRANS_TABLES'` MySQL option is
  **not** applied to PostgreSQL (PostgreSQL is strict by default).
- **charset** — The `charset=utf8mb4` MySQL option is **not** applied to
  PostgreSQL (UTF-8 is always the default).
- **Port conflict** — The Compose overlay publishes PostgreSQL on `5432`.
  If you also have a local PostgreSQL instance, either stop it or change
  the host port in the overlay (`"15432:5432"`).
- **MySQL service** — When using the Compose overlay, the `db` (MySQL)
  service is still defined but receives no `depends_on` references. It
  will not start unless explicitly requested. Add `--scale db=0` to
  suppress it completely.
