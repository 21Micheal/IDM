# IDM — Internal UAT Deployment (Windows Server 2019)

This runbook stands up the IDM document-management system for **internal UAT** on a
Windows Server 2019 host, reachable by hostname over the LAN (e.g. `http://fsedms`).

The whole stack is **Linux containers**, so we don't run Docker on Windows directly.
We run a small **Ubuntu Server VM under Hyper-V** (built into Server 2019) and run
Docker inside it. This is the most robust, snapshot-able, license-clean path.

```
Windows Server 2019 (host)
└─ Hyper-V role
   └─ Ubuntu Server 22.04 VM  ──(LAN IP, e.g. 10.0.0.50)
      └─ Docker Engine + Compose
         └─ nginx :80 ─ backend(Daphne) ─ MySQL ─ Redis ─ Elasticsearch ─ Celery ×4
```

---

## 0. Host sizing (give the VM, not just the host)

| Resource | Minimum | Comfortable |
|----------|---------|-------------|
| vCPU     | 4       | 6–8         |
| RAM      | 8 GB    | 12–16 GB    |
| Disk     | 40 GB   | 80 GB       |

Elasticsearch + PaddleOCR + LibreOffice + 4 Celery workers make this RAM-hungry.
Below 8 GB, Elasticsearch or OCR will OOM.

---

## 1. Enable Hyper-V + create the Ubuntu VM (on the Windows host)

In an **elevated PowerShell**:

```powershell
# 1a. Enable Hyper-V (reboots the server)
Enable-WindowsOptionalFeature -Online -FeatureName Microsoft-Hyper-V -All
# …reboot when prompted…

# 1b. Create an EXTERNAL virtual switch bound to the physical NIC, so the VM
#     gets a real LAN IP that testers can reach. Replace the NIC name.
Get-NetAdapter        # find the wired adapter name, e.g. "Ethernet"
New-VMSwitch -Name "LAN" -NetAdapterName "Ethernet" -AllowManagementOS $true
```

Download the **Ubuntu Server 22.04 LTS** ISO, then create the VM (adjust the path):

```powershell
New-VM -Name "fsedms" -Generation 2 -MemoryStartupBytes 12GB `
  -NewVHDPath "D:\VMs\fsedms.vhdx" -NewVHDSizeBytes 80GB -SwitchName "LAN"
Set-VM -Name "fsedms" -ProcessorCount 6
Set-VMDvdDrive -VMName "fsedms" -Path "C:\iso\ubuntu-22.04-live-server-amd64.iso"
# Gen-2 VMs need Secure Boot set to the MS UEFI CA for Ubuntu to boot:
Set-VMFirmware -VMName "fsedms" -SecureBootTemplate MicrosoftUEFICertificateAuthority
Start-VM -Name "fsedms"
```

Connect with **Hyper-V Manager → fsedms → Connect**, run the Ubuntu installer:
- Set hostname `fsedms` (lowercase). Hostnames are case-insensitive on the
  network, so testers can still type `fseDMS`; keep the OS hostname and
  `ALLOWED_HOSTS` lowercase to avoid tooling/Host-header surprises. Brand the
  UI/docs "fseDMS" freely — only the machine name needs to be lowercase.
- Install **OpenSSH server** when prompted (lets you SSH in instead of the console).
- Give it a static lease/IP from your network team (or a DHCP reservation) so the
  hostname stays put.

After install, from the Windows host (or your workstation):

```powershell
ssh youruser@fsedms        # or the VM's IP
```

> **Internal DNS:** ask your network team to point `fsedms` (and
> `fsedms.company.local`) at the VM's IP so testers can use the friendly name.
> Until then you can test with the raw IP.

---

## 2. Install Docker inside the Ubuntu VM

```bash
# Docker Engine + Compose plugin (official convenience script)
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER       # run docker without sudo
newgrp docker                       # apply group now (or log out/in)

# Elasticsearch REQUIRES this kernel setting or it refuses to start:
echo 'vm.max_map_count=262144' | sudo tee /etc/sysctl.d/99-es.conf
sudo sysctl --system

docker version && docker compose version   # verify
```

---

## 3. Get the code onto the VM

```bash
# Option A — clone (if the VM can reach your git server)
git clone <your-repo-url> idm && cd idm
git checkout version2          # the branch you're testing

# Option B — no git on the VM: copy from your workstation
#   scp -r ./IDM youruser@fsedms:~/idm     (run on your workstation)
```

---

## 4. Configure secrets

```bash
cp .env.uat.example .env.uat
nano .env.uat
```

Fill in, at minimum:
- `SECRET_KEY` — generate after the first image build (step 5) with:
  `docker run --rm idm-app:uat python -c "from django.core.management.utils import get_random_secret_key as g; print(g())"`
  (or paste any 50+ char random string now).
- `ALLOWED_HOSTS` / `CSRF_TRUSTED_ORIGINS` — set to your real hostname(s),
  e.g. `fsedms,fsedms.company.local`.
- `DB_PASSWORD`, `DB_ROOT_PASSWORD`, `REDIS_PASSWORD` — strong unique values.
- (Optional) `ANTHROPIC_API_KEY` for AI field extraction; internal SMTP under
  `EMAIL_*` if you want real notification emails.

`.env.uat` is gitignored — keep it on the server only.

---

## 5. Build and launch

```bash
docker compose --env-file .env.uat -f docker-compose.uat.yml up -d --build
```

First build takes a while (LibreOffice, PaddleOCR models, spaCy, npm build).
Watch it come up:

```bash
docker compose --env-file .env.uat -f docker-compose.uat.yml ps
docker compose --env-file .env.uat -f docker-compose.uat.yml logs -f backend
```

The `backend` container runs migrations + `collectstatic` on start, and
`frontend_build` compiles the SPA into a shared volume before nginx serves it.

---

## 6. First-run setup (one-off)

```bash
C="docker compose --env-file .env.uat -f docker-compose.uat.yml exec -T backend"

# Create the first admin user
$C python manage.py createsuperuser

# Build the Elasticsearch indexes so search works
$C python manage.py search_index --rebuild -f
```

---

## 7. Verify

From a tester's machine on the LAN, browse to **`http://fsedms`**:

- Login page loads, you can sign in as the superuser.
- Open DevTools → Network: API calls go to `http://fsedms/api/v1/...` (same origin)
  and return 200, not CORS errors.
- Upload a document → it appears, preview renders, OCR/extraction completes
  (watch `logs -f celery_ocr`).
- The Analytics dashboard loads for an admin / HOD user.

Quick backend health check from the VM:

```bash
curl -I http://localhost/        # 200 from nginx (SPA)
curl -s http://localhost/api/v1/ # backend responds
```

---

## 8. Day-2 operations

```bash
# Shorthand
alias dcu='docker compose --env-file .env.uat -f docker-compose.uat.yml'

dcu logs -f backend celery_worker   # tail logs
dcu restart backend                 # restart a service
dcu down                            # stop (keeps data volumes)

# Ship new code — preferred: prunes safely, then builds & deploys
git pull                            # or: git checkout <branch>
./scripts/deploy-uat.sh

# …equivalent manual build if you skip the script:
dcu up -d --build

# Backups (mysql + uploaded files)
dcu exec -T db sh -c 'exec mysqldump -uroot -p"$MYSQL_ROOT_PASSWORD" idm_db' > idm_$(date +%F).sql
docker run --rm -v idm_media_files:/m -v "$PWD":/b alpine tar czf /b/media_$(date +%F).tgz -C /m .
```

> **Snapshot the VM** in Hyper-V before each redeploy — instant rollback if a
> UAT build goes sideways.

### Disk hygiene (avoids the `no space left on device` build failure)

Every `dcu up -d --build` creates a fresh `idm-app:uat` and leaves the previous
one as a **dangling image**; BuildKit's layer cache also grows over time. Left
alone, the disk fills and image *export* fails mid-build. `./scripts/deploy-uat.sh`
handles this each deploy — before building it removes dangling images and caps
the build cache (`BUILD_CACHE_BUDGET`, default `10GB`), and after building it
drops the freshly-orphaned image. The named data volumes (`mysql_data`,
`media_files`, `es_data`, …) are **never** touched.

If you ever need to reclaim space by hand:

```bash
docker image prune -f                       # dangling images only
docker builder prune -f --keep-storage 10GB # trim cache to a budget
df -h /
```

> ⚠️ **Never** run `docker system prune --volumes` or `docker volume prune`
> here — that deletes MySQL/media/ES data. Stick to `image`/`builder` prune.

---

## Notes / gotchas

- **HTTP only.** This UAT serves plain HTTP on the LAN. Fine for internal testing;
  do **not** expose it to the internet. For HTTPS later, terminate TLS at the edge
  nginx (add a `443` server block + cert) or front it with IIS/ARR on the Windows
  host.
- **Windows host firewall:** if testers can't reach `http://fsedms`, confirm the
  VM's `LAN` switch is *external* and allow inbound TCP 80 to the VM's IP.
- **db/redis/elasticsearch are not published** — they're reachable only inside the
  compose network, by design. Use `dcu exec` to inspect them.
- **Changing `.env.uat`** (hosts, secrets) requires `dcu up -d` to recreate the
  affected containers.
- This is the **UAT** stack. The dev stack (`docker-compose.yml`, Vite, DEBUG=True)
  is unchanged and still what you use locally.
```
