# Deploying RxGuard to a Linux server

One server runs everything with Docker Compose: **web** (Django + gunicorn), **mysql**, **frontend** (nginx) and
**Caddy**, which gets a free HTTPS certificate for your domain automatically.

## What you need

- A Linux VM (Ubuntu 22.04/24.04 tested) with **at least 4 GB RAM** (8 GB recommended), 2+ vCPUs and **25 GB disk**.
  The web image is about 4.5 GB because it bundles PyTorch and the embedding model.
- A domain or subdomain (e.g. `rxguard.example.org`) with a DNS **A record pointing at the server's public IP**.
  No domain? Skip Caddy and use `http://<server-ip>:8080` (no HTTPS; fine for a short demo only).
- Inbound ports **80 and 443** open in the cloud firewall / security group (port 22 for SSH).
- A Gemini API key (optional: without it RxGuard runs in template mode and every flag still appears).

## 0. Azure for Students: create the VM (portal, about 5 minutes)

1. [portal.azure.com](https://portal.azure.com) → **Virtual machines** → **Create** → **Azure virtual machine**.
2. Resource group `rxguard-rg` (create new) · name `rxguard-vm` · region close to the judges (e.g. *Central India*) ·
   image **Ubuntu Server 24.04 LTS - x64 Gen2** · size **Standard_B2s** (2 vCPU, 4 GiB; not B1s, it runs out of memory) ·
   authentication **SSH public key** (download the `.pem` key it generates) or a password · username `azureuser`.
3. **Inbound ports:** allow **SSH (22), HTTP (80), HTTPS (443)**.
4. **Disks:** OS disk 30 GiB or more (the default is fine). **Review + create** → **Create**.
5. Open the VM → **Overview** → **DNS name: Not configured** → set a label such as `rxguard-phc` → **Save**.
   Your domain is now `rxguard-phc.<region>.cloudapp.azure.com` (use it as `DOMAIN` below; Caddy gets the HTTPS
   certificate for it automatically).
6. Optional: **Auto-shutdown** at night while developing; switch it off before judging.
7. Connect: `ssh -i <downloaded-key>.pem azureuser@<public-ip>` (Windows PowerShell has `ssh` built in).

On a 4 GB VM set `GUNICORN_WORKERS=1` in `.env`: every gunicorn worker loads its own copy of the embedding model.

## 1. Install Docker (once)

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER && newgrp docker
docker compose version          # must print v2.x
```

## 2. Get the code and the data

```bash
git clone https://github.com/Nandith-0777/RxGuard.git && cd RxGuard
sudo apt-get install -y python3-yaml
python3 scripts/download_data.py      # DDInter, NLEM 2022, ICMR STWs -> data/raw (prints SHA-256 per file)
```

## 3. Configure `.env`

```bash
cp .env.example .env
nano .env
```

Set at least:

| Variable | Value |
|---|---|
| `DJANGO_SECRET_KEY` | a long random string: `python3 -c "import secrets; print(secrets.token_urlsafe(50))"` |
| `DJANGO_ALLOWED_HOSTS` | `localhost,127.0.0.1,web,rxguard.example.org` (your domain) |
| `DJANGO_CSRF_TRUSTED_ORIGINS` | `https://rxguard.example.org` |
| `DOMAIN` | `rxguard.example.org` (add this line; Caddy uses it) |
| `MYSQL_PASSWORD`, `MYSQL_ROOT_PASSWORD` | two different strong passwords |
| `DEMO_PHARMACIST_PASSWORD` | the password for the `pharmacist` and `admin` accounts (see the note below) |
| `GEMINI_API_KEY` | your key (optional) |
| `HTTP_PORT` | `127.0.0.1:8080` so nginx is reachable only through Caddy |
| `DEMO_TOGGLES_ENABLED` | `0` |
| `GUNICORN_WORKERS` | `1` on a 4 GB VM, `2` with 8 GB or more |

Keep the `LLM_*` model lines from `.env.example`: the evaluation and latency numbers were measured with them.

> **Demo login:** the sign-in page pre-fills `pharmacist` / `rxguard-demo` so judges can sign in with one click.
> That only works if `DEMO_PHARMACIST_PASSWORD=rxguard-demo`, and it means **anyone who finds the URL can sign in**.
> All data is synthetic, but take the deployment down (or change the password) after judging.

## 4. Start and load the knowledge base

```bash
docker compose --profile https up -d --build      # first build: 10-20 min
docker compose ps                                 # wait until web and frontend show "healthy"
docker compose exec web python manage.py seed     # ~5 min: DDInter + NLEM + corpus + FAISS index
docker compose restart web                        # load the new index in every worker
curl -s https://rxguard.example.org/readyz        # {"status": "ready", ...}
```

Open `https://rxguard.example.org` and sign in.

## Updating

```bash
git pull
docker compose --profile https up -d --build
```

The database and the search index live in Docker volumes (`mysql-data`, `index-data`) and survive rebuilds.
Re-run `seed` only when the source data changes; it creates a new knowledge-base version.

## Operations

| Task | Command |
|---|---|
| Logs | `docker compose logs -f web` |
| Health | `curl -s https://<domain>/readyz` |
| Backup | `docker compose exec mysql sh -c 'mysqldump -uroot -p"$MYSQL_ROOT_PASSWORD" rxguard' > backup.sql` |
| Evaluation | `make eval` |
| Stop | `docker compose --profile https down` (add `-v` only if you want to delete the data) |

## Troubleshooting

- **Caddy cannot get a certificate:** DNS must already point at the server and ports 80/443 must be open.
  `docker compose logs caddy` shows the reason.
- **`/readyz` says no KB version or no FAISS index:** the seed has not run (step 4).
- **Out of memory during build or seed:** use a VM with more RAM, or add swap
  (`sudo fallocate -l 4G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile`).
- **npm registry blocked:** set `NPM_REGISTRY=https://registry.npmmirror.com` in `.env`.
