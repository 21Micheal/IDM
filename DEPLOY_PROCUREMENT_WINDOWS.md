# Procurement deployment on Ubuntu Server

Deploy Docker directly on the existing Ubuntu Server; no Windows VM or Hyper-V
is needed. The Compose stack runs the procurement application, PostgreSQL,
Redis, Elasticsearch, Celery, and nginx. It does not start MySQL or
OCR/Office-preview workers.

The intended host layout is:

- `/opt/flaxem/app/source` — source and deployment files.
- `/opt/flaxem/config` — protected `.env` file.
- `/opt/flaxem/data` — persistent database, cache, search index, and media data.

## 1. Confirm host access and permissions

The target already has Ubuntu 24.04, Docker 29.4.0, and Docker Compose 5.1.3.
Check that the Docker daemon is reachable by the deployment account:

```bash
docker info --format '{{.ServerVersion}}'
docker ps
```

`docker --version` checks only the client; it does not confirm daemon access.
Membership in the `docker` group grants root-equivalent control of the server.
Use it only for this deployment and avoid commands that alter other projects.

The deployment account has access to `/opt/flaxem`. Keep `.env` readable only
by the deployment account. Create the application data directories before
starting services:

```text
/opt/flaxem/data/postgres
/opt/flaxem/data/redis
/opt/flaxem/data/elasticsearch
/opt/flaxem/data/media
```

The Compose file maps named volumes to these paths, so they remain under
`/opt/flaxem/data` while retaining stable Docker volume names for backup and
restore.

Set Elasticsearch's host kernel parameter and persist it across reboots if
`sysctl vm.max_map_count` is below `262144`:

```bash
echo 'vm.max_map_count=262144' | sudo tee /etc/sysctl.d/99-elasticsearch.conf
sudo sysctl --system
```

## 2. Get the requisition source onto the server

Copy the `requisition` branch source from the authorized workstation over SSH
(for example, with `rsync`) into the prepared source directory. Do not copy
`.env`, certificates, database/media backups, `.git`, or local dependency
directories. The deployment files may include local changes not yet pushed.

```bash
cd /opt/flaxem/app/source
```

Do not put `.env`, certificates, or database/media backups in the source tree.

## 3. Prepare protected configuration

Copy the template to the protected configuration directory, then edit it using
the approved privileged method:

```bash
cp .env.procurement.example /opt/flaxem/config/.env
chmod 600 /opt/flaxem/config/.env
nano /opt/flaxem/config/.env
```

Set a strong `SECRET_KEY`, `PGPASSWORD`, and URL-safe `REDIS_PASSWORD`. For
initial access at `http://192.168.0.10:8080`, set `ALLOWED_HOSTS` to the server
IP/hostname, and set `CSRF_TRUSTED_ORIGINS` and `FRONTEND_URL` to that full URL.
Configure SMTP and SunSystems settings as applicable. Preserve the source
`SECRET_KEY` if restoring the existing database; use the matching `PGPASSWORD`
for its database. This setup uses HTTP; do not use it for sensitive production
traffic over an untrusted network.

## 4. Restore the PostgreSQL database and media

Transfer the successful PostgreSQL backup directory from the source host using
the approved secure method. It contains sensitive application data. From the
project directory, start only PostgreSQL, Redis, and Elasticsearch:

```bash
docker compose -p idm \
  --env-file /opt/flaxem/config/.env \
  -f docker-compose.procurement.prod.yml up -d postgres redis elasticsearch
```

Wait for PostgreSQL to become healthy, then restore `database.dump` into the
empty target database. Replace the backup path below with its actual location:

```bash
cat /path/to/backup/database.dump | docker compose -p idm \
  --env-file /opt/flaxem/config/.env \
  -f docker-compose.procurement.prod.yml exec -T postgres \
  pg_restore -U idm_user -d idm_db --no-owner --no-privileges
```

Restore the uploaded files into the named media volume:

```bash
docker run --rm \
  -v idm_media_files:/dest \
  -v /path/to/backup:/backup:ro \
  alpine tar -xzf /backup/media_files.tar.gz -C /dest
```

Restore only into an empty database and an empty media directory. Keep the
source deployment and backup unchanged until the new deployment is verified.

## 5. Build and start the application

From `/opt/flaxem/app/source`:

```bash
docker compose -p idm \
  --env-file /opt/flaxem/config/.env \
  -f docker-compose.procurement.prod.yml up -d --build
docker compose -p idm \
  --env-file /opt/flaxem/config/.env \
  -f docker-compose.procurement.prod.yml ps
```

After the services are healthy, rebuild the search index and verify login,
requisition submission, approval, attachments, and integrations:

```bash
docker compose -p idm \
  --env-file /opt/flaxem/config/.env \
  -f docker-compose.procurement.prod.yml exec -T backend \
  python manage.py search_index --rebuild -f
```

Open `http://192.168.0.10:8080/` from an authorized workstation.

## Operations and backup

Use the same Compose project name, config file, and data directories for later
updates. Keep database and media backups on storage separate from this server.
The nginx configuration currently serves `/media/` directly without checking
the user's login; use appropriate UAT data until media downloads have
application-level authorization.
