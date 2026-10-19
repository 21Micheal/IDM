# Deploy the procurement stack using a Linux VM

This deployment runs Docker Engine inside an Ubuntu Server VM. Use an existing
VM if available. If Windows Server is used to host it, Hyper-V is one option,
but it is not installed or required by the application Compose stack. The stack
contains the procurement application, PostgreSQL, Redis, Elasticsearch,
Celery, and nginx; it does not start MySQL or OCR/Office-preview workers.

## 1. Prepare the Ubuntu VM

Use an existing Ubuntu Server VM if one is available and suitable. Confirm its
LAN address, available disk/RAM, and SSH access, then install Docker Engine and
the Compose plugin if they are not already installed. If this Windows Server
is to host the VM, the Hyper-V role must be installed; the reported role state
`Available` means installable, not installed. The CPU virtualization flags are
enabled, so the processor prerequisites are present. Installing the role
requires a planned host reboot. If there is no suitable VM and that reboot is
not approved, use another approved Linux VM host. Allow inbound TCP port 443
through the VM and network firewalls. Port 80 is also published to redirect
HTTP requests to HTTPS; allow it if users need that redirect. Elasticsearch
needs a host setting of
`vm.max_map_count=262144`; apply it in Ubuntu and make it persistent across
reboots.

If a new VM must be provisioned on another approved host, start UAT at 4 vCPUs,
8 GB RAM, and an 80 GB disk, then monitor resource use. The supplied DL380 has
32 GB RAM and 16 logical processors, but the 15 GB available figure is only a
point-in-time reading and Hyper-V is not installed there. The CPU virtualization
features are enabled. Installing Hyper-V on that server requires a planned
reboot and is outside this deployment path unless separately approved.

Copy the project to the VM, including `docker-compose.procurement.prod.yml`,
`Dockerfile`, `frontend/`, `docker/`, and the application source. From the
project directory, prepare the deployment environment:

```bash
cp .env.procurement.example .env
chmod 600 .env
nano .env
```

Set unique strong values for `SECRET_KEY`, `PGPASSWORD`, and `REDIS_PASSWORD`.
Set `ALLOWED_HOSTS`, `CSRF_TRUSTED_ORIGINS`, and `FRONTEND_URL` to the DNS name
users will use, with `https://` for the latter two. Place a certificate chain
named `fullchain.pem` and its matching private key named `privkey.pem` in the
directory configured by `TLS_CERT_DIR`. Keep the private key out of source
control and backups. The included nginx configuration terminates TLS on port
443 and redirects port 80 to HTTPS. Configure SMTP and SunSystems values if
needed.

## 2. Take a source backup

On the current host, run `./postgres_backup.sh`. Copy the resulting timestamped
backup directory to the VM. It contains a PostgreSQL custom-format dump, the
media volume archive, the production Compose file, and the current `.env`.
Treat the backup directory as confidential because it includes credentials and
application data.

The script now targets the standalone PostgreSQL Compose stack. If the current
live installation is still running the older MySQL-based Compose files, do not
run this PostgreSQL backup script against it: take a MySQL backup and migrate
the data to PostgreSQL first. A PostgreSQL dump cannot be restored directly
into MySQL (or vice versa).

## 3. Restore database and uploaded files

On the VM, use the same `.env` values as the source deployment when preserving
the existing database. Start PostgreSQL and create the named media volume:

```bash
docker compose -p idm --env-file .env -f docker-compose.procurement.prod.yml up -d postgres
docker volume create idm_media_files
```

From the backup directory, restore the dump into a fresh PostgreSQL database:

```bash
cat database.dump | docker compose -p idm --env-file /path/to/project/.env \
  -f /path/to/project/docker-compose.procurement.prod.yml exec -T postgres \
  pg_restore -U idm_user -d idm_db --no-owner --no-privileges
```

This assumes the target database is empty. Restoring over an existing database
can leave conflicting objects; use a fresh volume for a clean migration.
Restore uploaded files into the named media volume:

```bash
docker run --rm \
  -v idm_media_files:/dest \
  -v "$PWD:/backup:ro" \
  alpine tar -xzf /backup/media_files.tar.gz -C /dest
```

If the application was already running on the source, keep it stopped for the
final backup and copy so new submissions or uploads are not missed during
cutover.

## 4. Start the application

From the project directory on the VM:

```bash
docker compose -p idm --env-file .env -f docker-compose.procurement.prod.yml up -d --build
docker compose -p idm --env-file .env -f docker-compose.procurement.prod.yml ps
docker compose -p idm --env-file .env -f docker-compose.procurement.prod.yml logs -f backend
```

Once the app is healthy and the hostname points to the VM, open
`https://<deployment-hostname>/` from a workstation and
check login, requisition submission, approval, attachments, and integrations.
Keep the source deployment and backup unchanged until these checks pass.

The current nginx configuration serves `/media/` directly from the shared
volume without checking the user's login. Use only appropriate UAT data until
media downloads are protected by application authorization.

## Operations

Use the same project name and Compose file for updates and backups so Docker
continues to use the `idm_*` named volumes:

```bash
docker compose -p idm --env-file .env -f docker-compose.procurement.prod.yml up -d --build
./postgres_backup.sh -o /path/to/backup-storage
```

Keep backups on storage outside the VM and periodically verify that a backup
can be restored. The production Compose file binds only nginx to the host; the
database, Redis, and Elasticsearch ports remain private to the Docker network.
