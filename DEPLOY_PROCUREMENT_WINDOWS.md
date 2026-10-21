# Procurement deployment on Ubuntu Server

Deploy Docker directly on the existing Ubuntu Server; no Windows VM or Hyper-V
is needed. The Compose stack runs the procurement application, PostgreSQL,
Redis, Elasticsearch, Celery, and nginx. It does not start MySQL or
OCR/Office-preview workers.

The intended host layout is:

- `/opt/flaxem/app/source` — source and deployment files.
- `/opt/flaxem/config` — protected `.env` and TLS certificate files.
- `/opt/flaxem/data` — persistent database, cache, search index, and media data.

## 1. Confirm host access and permissions

The target already has Ubuntu 24.04, Docker 29.4.0, and Docker Compose 5.1.3.
Check that the Docker daemon is reachable by the deployment account:

```bash
docker info --format '{{.ServerVersion}}'
docker ps
```

`docker --version` checks only the client; it does not confirm daemon access.
If these commands report permission denied, ask IT for an approved deployment
method. Membership in the `docker` group grants root-equivalent control of the
server, so have IT authorize it explicitly or provide an approved `sudo`
workflow.

The source directory is writable by the deployment account. The config and
data directories are currently root-owned and not writable by that account.
Keep configuration root-controlled. Have IT prepare these paths and ensure each data directory is
writable by the UID used by its container image before starting the services:

```text
/opt/flaxem/data/postgres
/opt/flaxem/data/redis
/opt/flaxem/data/elasticsearch
/opt/flaxem/data/media
```

The Compose file maps named volumes to these paths, so they remain under
`/opt/flaxem/data` while retaining stable Docker volume names for backup and
restore.

Set Elasticsearch's host kernel parameter and persist it across reboots:

```bash
echo 'vm.max_map_count=262144' | sudo tee /etc/sysctl.d/99-elasticsearch.conf
sudo sysctl --system
```

## 2. Get the requisition source onto the server

Clone the pushed `requisition` branch into the prepared source directory. Use
the repository URL configured for this project:

```bash
git clone --branch requisition <repository-url> /opt/flaxem/app/source
cd /opt/flaxem/app/source
```

Do not put `.env`, certificates, or database/media backups in the source tree.

## 3. Prepare protected configuration and TLS

Copy the template to the protected configuration directory, then edit it using
the approved privileged method:

```bash
sudo install -o root -g root -m 600 \
  .env.procurement.example /opt/flaxem/config/.env
sudoedit /opt/flaxem/config/.env
```

Set a strong `SECRET_KEY`, `PGPASSWORD`, and URL-safe `REDIS_PASSWORD`. Set
`ALLOWED_HOSTS`, `CSRF_TRUSTED_ORIGINS`, and `FRONTEND_URL` to the application
hostname, using `https://` for the origin and URL. Configure SMTP and
SunSystems settings as applicable. Preserve the source `SECRET_KEY` if restoring
the existing database; use the matching `PGPASSWORD` for its database.

Place the certificate chain at
`/opt/flaxem/config/tls/fullchain.pem` and its matching private key at
`/opt/flaxem/config/tls/privkey.pem`. Keep the private key root-controlled and
out of source control and routine application-data exports. The nginx proxy
serves HTTPS on 443 and redirects HTTP on 80 to HTTPS. Allow 443 through the
host/network firewalls; allow 80 if users should receive the redirect.

## 4. Restore the PostgreSQL database and media

Transfer the successful PostgreSQL backup directory from the source host using
the approved secure method. It contains sensitive application data. From the
project directory, start only PostgreSQL, Redis, and Elasticsearch:

```bash
sudo docker compose -p idm \
  --env-file /opt/flaxem/config/.env \
  -f docker-compose.procurement.prod.yml up -d postgres redis elasticsearch
```

Wait for PostgreSQL to become healthy, then restore `database.dump` into the
empty target database. Replace the backup path below with its actual location:

```bash
cat /path/to/backup/database.dump | sudo docker compose -p idm \
  --env-file /opt/flaxem/config/.env \
  -f docker-compose.procurement.prod.yml exec -T postgres \
  pg_restore -U idm_user -d idm_db --no-owner --no-privileges
```

Restore the uploaded files into the named media volume:

```bash
sudo docker run --rm \
  -v idm_media_files:/dest \
  -v /path/to/backup:/backup:ro \
  alpine tar -xzf /backup/media_files.tar.gz -C /dest
```

Restore only into an empty database and an empty media directory. Keep the
source deployment and backup unchanged until the new deployment is verified.

## 5. Build and start the application

From `/opt/flaxem/app/source`:

```bash
sudo docker compose -p idm \
  --env-file /opt/flaxem/config/.env \
  -f docker-compose.procurement.prod.yml up -d --build
sudo docker compose -p idm \
  --env-file /opt/flaxem/config/.env \
  -f docker-compose.procurement.prod.yml ps
```

After the services are healthy, rebuild the search index and verify login,
requisition submission, approval, attachments, and integrations:

```bash
sudo docker compose -p idm \
  --env-file /opt/flaxem/config/.env \
  -f docker-compose.procurement.prod.yml exec -T backend \
  python manage.py search_index --rebuild -f
```

Open `https://<application-hostname>/` from a workstation.

## Operations and backup

Use the same Compose project name, config file, and data directories for later
updates. Keep database and media backups on storage separate from this server.
The nginx configuration currently serves `/media/` directly without checking
the user's login; use appropriate UAT data until media downloads have
application-level authorization.
