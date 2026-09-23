"""
DMS Django Settings
Reads environment via django-environ. Copy .env.example → .env and adjust.
"""
from pathlib import Path
from datetime import timedelta
from decimal import Decimal
from urllib.parse import urlparse
import environ
import dj_database_url
from celery.schedules import crontab

BASE_DIR = Path(__file__).resolve().parent.parent

env = environ.Env(DEBUG=(bool, False))
environ.Env.read_env(BASE_DIR / ".env")

SECRET_KEY = env("SECRET_KEY")
DEBUG = env("DEBUG")
NGROK_URL = env("NGROK_URL", default="")
NGROK_HOST = urlparse(NGROK_URL).hostname if NGROK_URL else ""

ALLOWED_HOSTS = env.list(
    "ALLOWED_HOSTS",
    default=[
        "localhost",
        "127.0.0.1",
        # Docker internal service names (Vite proxy / nginx upstreams)
        "backend",
        "frontend",
        "nginx",
        ".ngrok-free.dev",
    ],
)
if NGROK_HOST and NGROK_HOST not in ALLOWED_HOSTS:
    ALLOWED_HOSTS.append(NGROK_HOST)

# Required for ngrok/production: Allows Django to trust the CSRF header sent over HTTPS
CSRF_TRUSTED_ORIGINS = env.list(
    "CSRF_TRUSTED_ORIGINS",
    default=[
        "https://*.ngrok-free.dev",
        "http://localhost:3000",
    ]
)
if NGROK_URL and NGROK_URL not in CSRF_TRUSTED_ORIGINS:
    CSRF_TRUSTED_ORIGINS.append(NGROK_URL)

# Public base URL of the app, used to build clickable links in outgoing emails
# (welcome email, workflow/notification emails). Set this to whatever address
# users actually reach the system on — e.g. http://192.168.100.40 — otherwise
# email links point at the developer default below.
FRONTEND_URL = env("FRONTEND_URL", default="http://localhost:3000")

# ── Proxy / Forwarded Headers (Critical for ngrok + Google Docs / Office previews) ──
# Without these, request.build_absolute_uri() returns http://localhost/... instead
# of the public ngrok URL, breaking external document viewers.
USE_X_FORWARDED_HOST = True
SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https")

# ── Apps ────────────────────────────────────────────────────────────────────
INSTALLED_APPS = [
    "django.contrib.admin",
    "django.contrib.auth",
    "django.contrib.contenttypes",
    "django.contrib.sessions",
    "django.contrib.messages",
    "django.contrib.staticfiles",
    # Third-party
    "rest_framework",
    "rest_framework_simplejwt",
    "corsheaders",
    "django_filters",
    "django_otp",
    "django_otp.plugins.otp_totp",
    "django_otp.plugins.otp_email",
    "django_elasticsearch_dsl",
    "celery",
    "django_celery_beat",
    "django_celery_results",
    "auditlog",
    "channels",
    # Local
    "apps.accounts",
    "apps.documents",
    "apps.workflows",
    "apps.audit",
    "apps.search.apps.SearchConfig",
    "apps.notifications",
    "apps.chat",
    "apps.templates_engine",
    "apps.sunsystems",
    "apps.billing",
]

MIDDLEWARE = [
    "django.middleware.security.SecurityMiddleware",
    "whitenoise.middleware.WhiteNoiseMiddleware",
    "corsheaders.middleware.CorsMiddleware",
    "django.contrib.sessions.middleware.SessionMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.middleware.csrf.CsrfViewMiddleware",
    "django.contrib.auth.middleware.AuthenticationMiddleware",
    "django_otp.middleware.OTPMiddleware",
    "auditlog.middleware.AuditlogMiddleware",
    "django.contrib.messages.middleware.MessageMiddleware",
    "django.middleware.clickjacking.XFrameOptionsMiddleware",
]

ROOT_URLCONF = "IDM.urls"
WSGI_APPLICATION = "IDM.wsgi.application"
ASGI_APPLICATION = "IDM.asgi.application"

# ── Database ────────────────────────────────────────────────────────────────
# DB_ENGINE selects the active database backend for this deployment.
# One backend is active at a time; choose it via DB_ENGINE in your .env.
#
#   mysql (default)           — DATABASE_URL=mysql://user:pass@host:3306/db
#   mssql / sqlserver         — discrete DB_* vars + Microsoft ODBC Driver
#   postgres / postgresql / pgsql — DATABASE_URL=postgresql://... OR
#                                   discrete DB_HOST / DB_PORT / DB_NAME /
#                                   DB_USER / DB_PASSWORD vars
#
# An unrecognised value raises ImproperlyConfigured at startup (fail loud).
from django.core.exceptions import ImproperlyConfigured

DB_ENGINE = env("DB_ENGINE", default="mysql").lower()

if DB_ENGINE in ("mssql", "sqlserver"):
    DATABASES = {
        "default": {
            "ENGINE": "mssql",
            "NAME": env("DB_NAME", default="idm_db"),
            "USER": env("DB_USER", default=""),          # blank = Windows/trusted auth
            "PASSWORD": env("DB_PASSWORD", default=""),
            "HOST": env("DB_HOST", default="localhost"),
            "PORT": env("DB_PORT", default=""),
            "CONN_MAX_AGE": env.int("DB_CONN_MAX_AGE", default=600),
            "OPTIONS": {
                "driver": env("DB_ODBC_DRIVER", default="ODBC Driver 18 for SQL Server"),
                # SQL auth over a self-signed cert by default; for Windows auth set
                # DB_EXTRA_PARAMS=Trusted_Connection=yes (and leave DB_USER blank).
                "extra_params": env("DB_EXTRA_PARAMS", default="TrustServerCertificate=yes"),
            },
        }
    }

elif DB_ENGINE in ("postgres", "postgresql", "pgsql"):
    # PostgreSQL — accepts either DATABASE_URL (postgres:// or postgresql://)
    # or the same discrete DB_* variables used by the SQL Server branch.
    # No MySQL-only OPTIONS (charset / init_command) are applied.
    _pg_url = env("DATABASE_URL", default="")
    if _pg_url:
        DATABASES = {
            "default": dj_database_url.parse(
                _pg_url,
                conn_max_age=env.int("DB_CONN_MAX_AGE", default=600),
                engine="django.db.backends.postgresql",
            )
        }
    else:
        DATABASES = {
            "default": {
                "ENGINE": "django.db.backends.postgresql",
                "NAME": env("DB_NAME", default="idm_db"),
                "USER": env("DB_USER", default=""),
                "PASSWORD": env("DB_PASSWORD", default=""),
                "HOST": env("DB_HOST", default="localhost"),
                "PORT": env("DB_PORT", default="5432"),
                "CONN_MAX_AGE": env.int("DB_CONN_MAX_AGE", default=600),
            }
        }

elif DB_ENGINE == "mysql":
    DATABASES = {
        "default": dj_database_url.parse(
            env("DATABASE_URL"),
            conn_max_age=600,
            engine="django.db.backends.mysql",
        )
    }
    # MySQL options to avoid charset warnings and ensure strict mode
    DATABASES["default"]["OPTIONS"] = {
        "charset": "utf8mb4",
        "init_command": "SET sql_mode='STRICT_TRANS_TABLES'",
    }

else:
    raise ImproperlyConfigured(
        f"Unsupported DB_ENGINE value: {DB_ENGINE!r}. "
        "Expected one of: mysql, postgres, postgresql, pgsql, mssql, sqlserver."
    )

# ── Auth & JWT ───────────────────────────────────────────────────────────────
AUTH_USER_MODEL = "accounts.User"

REST_FRAMEWORK = {
    "DEFAULT_AUTHENTICATION_CLASSES": [
        "rest_framework_simplejwt.authentication.JWTAuthentication",
    ],
    "DEFAULT_PERMISSION_CLASSES": [
        "rest_framework.permissions.IsAuthenticated",
    ],
    "DEFAULT_FILTER_BACKENDS": [
        "django_filters.rest_framework.DjangoFilterBackend",
        "rest_framework.filters.SearchFilter",
        "rest_framework.filters.OrderingFilter",
    ],
    "DEFAULT_PAGINATION_CLASS": "IDM.pagination.StandardResultsSetPagination",
    "PAGE_SIZE": 20,
}

SIMPLE_JWT = {
    "ACCESS_TOKEN_LIFETIME": timedelta(minutes=30),
    "REFRESH_TOKEN_LIFETIME": timedelta(hours=6),
    "ROTATE_REFRESH_TOKENS": True,
    "AUTH_HEADER_TYPES": ("Bearer",),
}

# Use the same Redis instance you're using for Celery
REDIS_URL = env("REDIS_URL", default="redis://redis:6379/0")

CACHES = {
    "default": {
        "BACKEND": "django.core.cache.backends.redis.RedisCache",
        "LOCATION": REDIS_URL,
    }
}

# ── CORS ─────────────────────────────────────────────────────────────────────
CORS_ALLOWED_ORIGINS = env.list(
    "CORS_ALLOWED_ORIGINS",
    default=["http://localhost:3000", "http://127.0.0.1:3000"],
)
if NGROK_URL and NGROK_URL not in CORS_ALLOWED_ORIGINS:
    CORS_ALLOWED_ORIGINS.append(NGROK_URL)
CORS_ALLOW_CREDENTIALS = True

# ── Storage ──────────────────────────────────────────────────────────────────
MEDIA_ROOT = env("MEDIA_ROOT", default=str(BASE_DIR / "media"))
MEDIA_URL = "/media/"
# When False (default in production), do not expose /media/ via Django — use authenticated
# document file endpoints instead. Set SERVE_MEDIA_PUBLIC=True for local dev without DEBUG.
SERVE_MEDIA_PUBLIC = env.bool("SERVE_MEDIA_PUBLIC", default=False)
STATIC_ROOT = BASE_DIR / "staticfiles"
STATIC_URL = "/static/"

# Logical storage allowance for documents, used by the dashboard "Storage Used"
# panel as the percentage denominator. This is a soft quota for reporting only
# (not enforced) — set it to whatever capacity you want to track against.
STORAGE_QUOTA_GB = env.int("STORAGE_QUOTA_GB", default=50)

# Default authentication always includes local Django auth.
# If LDAP/AD is configured via LDAP_SERVER_URI, it will be enabled first.
AUTHENTICATION_BACKENDS = ["django.contrib.auth.backends.ModelBackend"]

# ── OIDC (Keycloak) ───────────────────────────────────────────────────────────
# Split-horizon URL configuration — see ~/Projects/idp/README.md §5.
#
# OIDC_OP_JWKS_ENDPOINT: machine-to-machine call from the backend container
#   to Keycloak via Docker service DNS — no host routing, reliable and fast.
#
# OIDC_OP_ISSUER: the string that must match the `iss` claim in Keycloak JWTs.
#   Keycloak stamps tokens with the browser-facing URL (KC_HOSTNAME=localhost:8080),
#   so this must be the localhost URL even though we fetch keys internally.
#
# OIDC_CLIENT_ID: the Keycloak client ID for this application.
OIDC_OP_JWKS_ENDPOINT = env(
    "OIDC_OP_JWKS_ENDPOINT",
    default="http://keycloak:8080/realms/idp-dev/protocol/openid-connect/certs",
)
OIDC_OP_ISSUER = env(
    "OIDC_OP_ISSUER",
    default="http://localhost:8080/realms/idp-dev",
)
OIDC_CLIENT_ID = env("OIDC_CLIENT_ID", default="dms-client")
# Cache JWKS public keys for this many seconds. On a key-ID miss (Keycloak
# rotated its signing key) the cache is bypassed automatically.
OIDC_JWKS_CACHE_TTL = env.int("OIDC_JWKS_CACHE_TTL", default=3600)

# Shared secret for Keycloak's User Storage SPI and protocol mapper when they
# call the DMS-only internal identity endpoints. Leave blank to disable those
# endpoints until the IdP service is configured.
DMS_INTERNAL_IDP_API_KEY = env("DMS_INTERNAL_IDP_API_KEY", default="")

# ── Auth Mode ────────────────────────────────────────────────────────────────
# Controls which authentication method the login page displays:
#   keycloak  — Show only "Sign in with Keycloak" button (IdP-connected deployments)
#   native    — Show native username/password form (standalone on-prem deployments)
# This is a deployment-time configuration, not a runtime user toggle.
# POST /api/v1/auth/login remains functional in both modes for break-glass access.
AUTH_MODE = env("AUTH_MODE", default="native")

# Switch to S3 by setting USE_S3=True in env
if env.bool("USE_S3", default=False):
    DEFAULT_FILE_STORAGE = "storages.backends.s3boto3.S3Boto3Storage"
    AWS_STORAGE_BUCKET_NAME = env("AWS_STORAGE_BUCKET_NAME")
    AWS_S3_REGION_NAME = env("AWS_S3_REGION_NAME", default="us-east-1")
    AWS_DEFAULT_ACL = "private"
    AWS_S3_FILE_OVERWRITE = False

# ── Redis / Celery ───────────────────────────────────────────────────────────
REDIS_URL = env("REDIS_URL", default="redis://localhost:6379/0")

CELERY_BROKER_URL = REDIS_URL
CELERY_RESULT_BACKEND = "django-db"
CELERY_ACCEPT_CONTENT = ["json"]
CELERY_TASK_SERIALIZER = "json"
CELERY_BEAT_SCHEDULER = "django_celery_beat.schedulers:DatabaseScheduler"
CELERY_TASK_ROUTES = {
    "apps.search.tasks.*": {"queue": "indexing"},
    "apps.notifications.tasks.*": {"queue": "notifications"},
    # Document tasks — queue assignments must match the @shared_task(queue=...) decorators.
    # generate_document_preview moved to "preview" so long LibreOffice conversions
    # don't starve text-indexing jobs on the "indexing" queue.
    "apps.documents.tasks.ocr_document": {"queue": "ocr"},
    "apps.documents.tasks.extract_text": {"queue": "indexing"},
    "apps.documents.tasks.generate_document_preview": {"queue": "preview"},
    "apps.documents.tasks.auto_archive_documents": {"queue": "default"},
    "apps.documents.tasks.empty_trash": {"queue": "default"},
    "apps.documents.tasks.run_migration_job": {"queue": "default"},
    "apps.documents.tasks.poll_mailbox": {"queue": "default"},
    "apps.documents.tasks.poll_active_mailboxes": {"queue": "default"},
    "apps.sunsystems.tasks.post_journal_for_document": {"queue": "default"},
}
WORKFLOW_SLA_WARNING_HOURS = env.int("WORKFLOW_SLA_WARNING_HOURS", default=4)
WORKFLOW_HOLD_WARNING_HOURS = env.int("WORKFLOW_HOLD_WARNING_HOURS", default=2)
CELERY_BEAT_SCHEDULE = {
    "workflow-sla-warning-backstop": {
        "task": "apps.workflows.tasks.notify_sla_warning_tasks",
        "schedule": 15 * 60,
    },
    "workflow-overdue-escalation-backstop": {
        "task": "apps.workflows.tasks.escalate_overdue_tasks",
        "schedule": 15 * 60,
    },
    "workflow-hold-ending-backstop": {
        "task": "apps.workflows.tasks.notify_hold_ending_tasks",
        "schedule": 15 * 60,
    },
    "documents-auto-archive": {
        "task": "apps.documents.tasks.auto_archive_documents",
        "schedule": 60 * 60,
    },
    "documents-empty-trash": {
        "task": "apps.documents.tasks.empty_trash",
        "schedule": 60 * 60,
    },
    "signature-pending-reminders": {
        "task": "apps.notifications.tasks.remind_pending_signatures",
        "schedule": 24 * 60 * 60,
    },
    "mailbox-email-ingestion-poll": {
        "task": "apps.documents.tasks.poll_active_mailboxes",
        # Short tick: each mailbox decides due-ness via its own
        # poll_interval_seconds. IMAP_POLL_INTERVAL_SECONDS remains the
        # default interval applied to new mailboxes.
        "schedule": 60,
    },
    "billing-sync-anthropic-usage": {
        "task": "apps.billing.tasks.sync_anthropic_usage",
        # 02:15 UTC daily — pulls yesterday's Admin Usage/Cost into snapshots.
        "schedule": crontab(hour=2, minute=15),
    },
}

# ── Elasticsearch ─────────────────────────────────────────────────────────────
# Full-text search via Elasticsearch is optional. When ELASTICSEARCH_ENABLED is
# False (e.g. lean native-Windows installs), index sync is skipped and the search
# API falls back to a database query — no ES server required. The ES client libs
# stay installed (pure Python) but never contact a server.
ELASTICSEARCH_ENABLED = env.bool("ELASTICSEARCH_ENABLED", default=True)
ELASTICSEARCH_DSL = {
    "default": {"hosts": env("ELASTICSEARCH_URL", default="http://localhost:9200")},
}
# Turn off django-elasticsearch-dsl's auto-indexing signal processor when off.
ELASTICSEARCH_DSL_AUTOSYNC = ELASTICSEARCH_ENABLED

# ── OCR ───────────────────────────────────────────────────────────────────────
OCR_ENGINE = env("OCR_ENGINE", default="paddle")
TESSERACT_CMD = env("TESSERACT_CMD", default="")
OCR_LANGUAGES = env("OCR_LANGUAGES", default="eng")
OCR_DPI = env.int("OCR_DPI", default=300)
OCR_CONFIDENCE_THRESHOLD = env.int("OCR_CONFIDENCE_THRESHOLD", default=40)
OCR_QUALITY_RATIO = env.float("OCR_QUALITY_RATIO", default=0.50)
# If OCR remains pending/processing beyond this age, treat it as stale/failed.
OCR_PROCESSING_STALE_SECONDS = env.int("OCR_PROCESSING_STALE_SECONDS", default=300)

# PaddleOCR runtime settings
OCR_PADDLE_LANG = env("OCR_PADDLE_LANG", default="en")
OCR_PADDLE_USE_GPU = env.bool("OCR_PADDLE_USE_GPU", default=False)
OCR_PADDLE_USE_ANGLE_CLS = env.bool("OCR_PADDLE_USE_ANGLE_CLS", default=True)

# spaCy NER post-processing settings
OCR_SPACY_ENABLED = env.bool("OCR_SPACY_ENABLED", default=True)
OCR_SPACY_MODEL = env("OCR_SPACY_MODEL", default="en_core_web_sm")

# ── Infor IDM migration (ION API) ───────────────────────────────────────────
# Default ION connection settings used to migrate documents out of Infor IDM.
# Each MigrationJob may override these in its own `connection` JSON; anything
# left blank on a job falls back to the environment defaults exposed here.
ION_API_URL       = env("ION_API_URL", default="")        # gateway base, ends with tenant: https://.../TENANT/
ION_TOKEN_URL     = env("ION_TOKEN_URL", default="")      # full OAuth2 token endpoint (pu + ot)
ION_TENANT        = env("ION_TENANT", default="")
ION_CLIENT_ID     = env("ION_CLIENT_ID", default="")
ION_CLIENT_SECRET = env("ION_CLIENT_SECRET", default="")
ION_SAAK          = env("ION_SAAK", default="")           # service account access key
ION_SASK          = env("ION_SASK", default="")           # service account secret key
ION_SCOPE         = env("ION_SCOPE", default="")
ION_IDM_PATH      = env("ION_IDM_PATH", default="IDM/api") # IDM REST path under the gateway
ION_VERIFY_TLS    = env.bool("ION_VERIFY_TLS", default=True)

# ── Email ingestion (IMAP) ──────────────────────────────────────────────────
# Default IMAP connection settings used to ingest documents from a mailbox.
# Each Mailbox may override these in its own `connection` JSON; anything left
# blank on a mailbox falls back to the environment defaults exposed here.
# Celery beat ticks every 60s and fans out poll_active_mailboxes for mailboxes
# with auto_poll enabled whose poll_interval_seconds has elapsed.
# IMAP_POLL_INTERVAL_SECONDS is the default per-mailbox interval.
IMAP_HOST       = env("IMAP_HOST", default="")
IMAP_PORT       = env.int("IMAP_PORT", default=993)
IMAP_USE_SSL    = env.bool("IMAP_USE_SSL", default=True)
IMAP_USERNAME   = env("IMAP_USERNAME", default="")
IMAP_PASSWORD   = env("IMAP_PASSWORD", default="")
IMAP_FOLDER     = env("IMAP_FOLDER", default="INBOX")
IMAP_VERIFY_TLS = env.bool("IMAP_VERIFY_TLS", default=True)
IMAP_POLL_INTERVAL_SECONDS = env.int("IMAP_POLL_INTERVAL_SECONDS", default=5 * 60)

# ── Infor SunSystems (SunSystems Connect / SSC web services) ─────────────────
# Default connection used to reach a SunSystems Connect SOAP gateway for budget
# inquiries and journal (Ledger Import) postings. Two SOAP endpoints under one
# base URL: SecurityProvider (authenticate -> token) and ComponentExecutor (run
# a component/method with an <SSC> payload). A per-template mapping may override
# the business unit / budget code; anything left blank falls back to these env
# defaults. See apps/sunsystems/client.py.
SUNSYSTEMS_BASE_URL       = env("SUNSYSTEMS_BASE_URL", default="http://sunsrv02.flaxem.int:81/sunsystems-connect/wsdl")
SUNSYSTEMS_SECURITY_PATH  = env("SUNSYSTEMS_SECURITY_PATH", default="SecurityProvider")
SUNSYSTEMS_EXECUTOR_PATH  = env("SUNSYSTEMS_EXECUTOR_PATH", default="ComponentExecutor")
SUNSYSTEMS_USERNAME       = env("SUNSYSTEMS_USERNAME", default="")
SUNSYSTEMS_PASSWORD       = env("SUNSYSTEMS_PASSWORD", default="")
SUNSYSTEMS_BUSINESS_UNIT  = env("SUNSYSTEMS_BUSINESS_UNIT", default="")   # default SunSystemsContext/BusinessUnit
SUNSYSTEMS_BUDGET_CODE    = env("SUNSYSTEMS_BUDGET_CODE", default="A")    # default SunSystemsContext/BudgetCode
SUNSYSTEMS_VERIFY_TLS     = env.bool("SUNSYSTEMS_VERIFY_TLS", default=True)
# Until a real SunSystems Connect budget-inquiry sample is wired, budget checks
# return a deterministic stub answer so the form UI is fully functional. Flip to
# False once apps/sunsystems/budget.py:_real_budget_query is implemented.
SUNSYSTEMS_BUDGET_STUB    = env.bool("SUNSYSTEMS_BUDGET_STUB", default=True)

# ── Email ingestion (Microsoft Graph) ───────────────────────────────────────
# Optional default Microsoft 365 / Outlook connection used by Graph mailboxes.
# App-only auth (OAuth2 client credentials); the Azure app registration needs
# the application permission Mail.Read with admin consent. Per-mailbox
# `connection` JSON overrides any blank fields here.
GRAPH_TENANT_ID     = env("GRAPH_TENANT_ID", default="")
GRAPH_CLIENT_ID     = env("GRAPH_CLIENT_ID", default="")
GRAPH_CLIENT_SECRET = env("GRAPH_CLIENT_SECRET", default="")
GRAPH_MAILBOX       = env("GRAPH_MAILBOX", default="")        # user principal name / email to read
GRAPH_FOLDER        = env("GRAPH_FOLDER", default="inbox")
GRAPH_VERIFY_TLS    = env.bool("GRAPH_VERIFY_TLS", default=True)

# ── IDP (Intelligent Document Processing) ───────────────────────────────────
# Provider selection:
#   anthropic → Claude via Anthropic API
#   regex     → skip LLM and use local OCR + regex pipeline
#   huggingface is intentionally commented out until it is ready for testing.
IDP_PROVIDER = env("IDP_PROVIDER", default="anthropic")

ANTHROPIC_API_KEY = env("ANTHROPIC_API_KEY", default="")
# Org Admin API key (sk-ant-admin01-…) for Flaxem control-plane Usage/Cost sync.
# Distinct from per-client workspace keys used for OCR.
ANTHROPIC_ADMIN_KEY = env("ANTHROPIC_ADMIN_KEY", default="")
# Optional default inbox for 90% monthly-cap spend alerts (ops only).
FLAXEM_OPS_ALERT_EMAIL = env("FLAXEM_OPS_ALERT_EMAIL", default="")

# HuggingFace provider placeholders remain commented out for later testing.
# HF_API_KEY = env("HF_API_KEY", default="")
# HF_IDP_MODEL = env("HF_IDP_MODEL", default="Qwen/Qwen2-VL-7B-Instruct")

OCR_IDP_ENGINE = env("OCR_IDP_ENGINE", default="auto")
OCR_IDP_MODEL = env("OCR_IDP_MODEL", default="claude-haiku-4-5")
OCR_IDP_VISION_DPI = env.int("OCR_IDP_VISION_DPI", default=150)
OCR_IDP_TIMEOUT = env.int("OCR_IDP_TIMEOUT", default=60)
OCR_IDP_MAX_PAGES = env.int("OCR_IDP_MAX_PAGES", default=3)
# Estimated USD per million tokens for ops reporting (Haiku-class defaults).
IDP_COST_INPUT_PER_MTOK = Decimal(str(env("IDP_COST_INPUT_PER_MTOK", default="0.80")))
IDP_COST_OUTPUT_PER_MTOK = Decimal(str(env("IDP_COST_OUTPUT_PER_MTOK", default="4.00")))

# Persistent, reusable LibreOffice profile dir for Office→PDF previews. When set
# (see the preview worker in docker-compose), the warm profile is reused across
# conversions instead of rebuilt each time, cutting per-preview latency. Empty =
# original per-call isolated profile.
LIBREOFFICE_PROFILE_DIR = env("LIBREOFFICE_PROFILE_DIR", default="")
LIBREOFFICE_CMD = env("LIBREOFFICE_CMD", default="libreoffice")
# Backward-compatible alias used by tasks.py
LIBREOFFICE_BIN = env("LIBREOFFICE_BIN", default=LIBREOFFICE_CMD)
LIBREOFFICE_TIMEOUT = env.int("LIBREOFFICE_TIMEOUT", default=120)
# If a preview stays in "processing" beyond this age, allow retry to reset it.
PREVIEW_PROCESSING_STALE_SECONDS = env.int("PREVIEW_PROCESSING_STALE_SECONDS", default=300)

AWS_TEXTRACT_REGION    = env("AWS_TEXTRACT_REGION", default="us-east-1")
AWS_TEXTRACT_S3_BUCKET = env("AWS_TEXTRACT_S3_BUCKET", default="")

# ── Channels (WebSocket) ──────────────────────────────────────────────────────
CHANNEL_LAYERS = {
    "default": {
        "BACKEND": "channels_redis.core.RedisChannelLayer",
        "CONFIG": {"hosts": [REDIS_URL]},
    }
}

# ── LDAP (optional) ───────────────────────────────────────────────────────────
LDAP_SERVER_URI = env("LDAP_SERVER_URI", default="")
if LDAP_SERVER_URI:
    import ldap
    from django_auth_ldap.config import LDAPSearch

    AUTH_LDAP_SERVER_URI = LDAP_SERVER_URI
    AUTH_LDAP_BIND_DN = env("LDAP_BIND_DN", default="")
    AUTH_LDAP_BIND_PASSWORD = env("LDAP_BIND_PASSWORD", default="")
    AUTH_LDAP_USER_SEARCH = LDAPSearch(
        env("LDAP_USER_SEARCH_BASE", default="ou=users,dc=example,dc=com"),
        ldap.SCOPE_SUBTREE,
        "(sAMAccountName=%(user)s)",
    )
    AUTH_LDAP_USER_ATTR_MAP = {
        "first_name": "givenName",
        "last_name": "sn",
        "email": "mail",
    }
    AUTHENTICATION_BACKENDS = [
        "django_auth_ldap.backend.LDAPBackend",
        "django.contrib.auth.backends.ModelBackend",
    ]

# ── Email ────────────────────────────────────────────────────────────────────
EMAIL_BACKEND = env("EMAIL_BACKEND", default="django.core.mail.backends.console.EmailBackend")
EMAIL_HOST = env("EMAIL_HOST", default="")
EMAIL_PORT = env.int("EMAIL_PORT", default=587)
EMAIL_USE_TLS = env.bool("EMAIL_USE_TLS", default=True)
EMAIL_HOST_USER = env("EMAIL_HOST_USER", default="")
EMAIL_HOST_PASSWORD = env("EMAIL_HOST_PASSWORD", default="")
DEFAULT_FROM_EMAIL = env("DEFAULT_FROM_EMAIL", default="dms@example.com")

LOGGING = {
    'version': 1,
    'disable_existing_loggers': False,
    'formatters': {
        'verbose': {
            'format': '{levelname} {asctime} {module} {process:d} {thread:d} {message}',
            'style': '{',
        },
        'simple': {
            'format': '{levelname} {message}',
            'style': '{',
        },
    },
    'handlers': {
        'console': {
            'class': 'logging.StreamHandler',
            'formatter': 'simple',
        },
    },
    'root': {
        'handlers': ['console'],
        'level': 'WARNING',
    },
    'loggers': {
        'apps.documents.tasks': {'level': 'DEBUG', 'handlers': ['console'], 'propagate': False},
    }
}

# ── Security ─────────────────────────────────────────────────────────────────
# HTTPS hardening is on by default whenever DEBUG is off. An internal, HTTP-only
# UAT behind a plain reverse proxy must opt out (SECURE_SSL=False) — otherwise
# Django 301-redirects every request to https:// and sets secure-only cookies,
# which breaks login over HTTP. Leave SECURE_SSL=True (the default) in production
# where TLS terminates at the edge.
if not DEBUG:
    SECURE_SSL = env.bool("SECURE_SSL", default=True)
    SECURE_SSL_REDIRECT = SECURE_SSL
    SESSION_COOKIE_SECURE = SECURE_SSL
    CSRF_COOKIE_SECURE = SECURE_SSL
    SECURE_HSTS_SECONDS = 31536000 if SECURE_SSL else 0

TEMPLATES = [
    {
        "BACKEND": "django.template.backends.django.DjangoTemplates",
        "DIRS": [BASE_DIR / "templates"],
        "APP_DIRS": True,
        "OPTIONS": {
            "context_processors": [
                "django.template.context_processors.debug",
                "django.template.context_processors.request",
                "django.contrib.auth.context_processors.auth",
                "django.contrib.messages.context_processors.messages",
            ],
        },
    },
]

DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"
LANGUAGE_CODE = "en-us"
TIME_ZONE = "Africa/Nairobi"
USE_I18N = True
USE_TZ = True
