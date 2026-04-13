# DocVault — Enterprise Document Management System

## Quick start (local development)

```bash
# 1. Clone and configure
cp .env.example .env
# Edit .env — at minimum change SECRET_KEY and passwords

# 2. Start all services
docker compose up --build

# 3. Run migrations and create a superuser
docker compose exec backend python manage.py makemigrations
docker compose exec backend python manage.py migrate accounts
docker compose exec backend python manage.py migrate
docker compose exec backend python manage.py createsuperuser

# 4. Create Elasticsearch index
docker compose exec backend python manage.py search_index --rebuild

# 5. Visit the app
open http://localhost        # Full app via Nginx
open http://localhost:3000   # React dev server (hot reload)
open http://localhost:8000/admin  # Django admin
```

## Architecture overview

| Layer              | Technology          | Purpose                                    |
|--------------------|---------------------|--------------------------------------------|
| Frontend           | React 18 + Vite     | SPA: upload, search, viewer, workflow UI   |
| API                | Django 5 + DRF      | REST endpoints, auth, RBAC, business logic |
| Task queue         | Celery + Redis      | Text extraction, indexing, notifications   |
| Search             | Elasticsearch 8     | Full-text + metadata search                |
| Database           | MySQL 8.0           | Metadata, users, workflows, audit log      |
| File storage       | Filesystem / S3     | Document binary storage                    |
| Reverse proxy      | Nginx               | Routing, TLS termination, media serving    |
| Containerisation   | Docker Compose      | Unified local + prod deployment            |

## Document reference format

Each document type has a configurable prefix and padding:

| Type              | Prefix | Example ref   |
|-------------------|--------|---------------|
| Supplier Invoice  | INV    | INV-00042     |
| Purchase Order    | PO     | PO-00007      |
| Contract          | CTR    | CTR-00001     |
| Bill              | BIL    | BIL-00015     |
| Imprest Form      | IMP    | IMP-00003     |

## Roles & permissions

| Role       | Upload | Approve | Audit log | Admin panel |
|------------|--------|---------|-----------|-------------|
| Admin      | ✓      | ✓       | ✓         | ✓           |
| Finance    | ✓      | ✓       | ✗         | ✗           |
| Auditor    | ✗      | ✗       | ✓         | ✗           |
| Viewer     | ✗      | ✗       | ✗         | ✗           |

## Adding a new document type (admin UI)

1. Log in as admin → **Admin → Document types → New document type**
2. Set name, code, reference prefix
3. Add custom metadata fields (text, number, date, currency, dropdown, etc.)
4. Assign a workflow template for approval routing
5. The upload form will automatically render the new fields

## Migrating to cloud storage (S3/Azure)

```bash
# In .env:
USE_S3=True
AWS_STORAGE_BUCKET_NAME=my-dms-bucket
AWS_S3_REGION_NAME=us-east-1

# Restart backend + celery
docker compose restart backend celery_worker
```

## Key API endpoints

| Method | Path                                  | Description                   |
|--------|---------------------------------------|-------------------------------|
| POST   | /api/v1/auth/login/                   | Login → JWT tokens            |
| POST   | /api/v1/auth/verify-otp/              | MFA OTP verification          |
| GET    | /api/v1/documents/                    | List/filter documents         |
| POST   | /api/v1/documents/                    | Upload document                |
| GET    | /api/v1/documents/{id}/               | Document detail               |
| POST   | /api/v1/documents/{id}/submit/        | Submit for approval           |
| GET    | /api/v1/documents/{id}/preview_url/   | Viewer URL (PDF.js / GDocs)   |
| POST   | /api/v1/search/                       | Full-text Elasticsearch search |
| POST   | /api/v1/workflows/tasks/{id}/approve/ | Approve a workflow task       |
| POST   | /api/v1/workflows/tasks/{id}/reject/  | Reject a workflow task        |
| GET    | /api/v1/audit/                        | System-wide audit trail       |
