# Hosting the Ticket Control Dashboard

The setup running in production: a single Node process under systemd.

| | |
|---|---|
| Service | `tick-dashboard` |
| Runs as | `tickdash` (unprivileged) |
| Code | `/var/www/tick` |
| Database | `/var/www/tick/dashboard/dashboard.sqlite` |
| Config | `/var/www/tick/dashboard/.env` (mode `600`, git-ignored) |
| Port | `3100` |
| URL | `http://<server-ip>:3100` |
| Node | `>= 22.5` (production runs 24.x) |

---

## Commands

### Check on it

| Command | What it does |
|---|---|
| `systemctl status tick-dashboard` | Is it running, since when, any errors |
| `systemctl is-active tick-dashboard` | Prints `active` / `inactive` — for scripts |
| `systemctl is-enabled tick-dashboard` | Prints `enabled` — will it start on boot |
| `systemctl cat tick-dashboard` | Print the unit file as it is installed |
| `systemctl show tick-dashboard` | All resolved settings (user, limits, paths) |

### Logs

| Command | What it does |
|---|---|
| `journalctl -u tick-dashboard -f` | Follow logs live |
| `journalctl -u tick-dashboard -n 100` | Last 100 lines |
| `journalctl -u tick-dashboard -b` | Everything since the last boot |
| `journalctl -u tick-dashboard --since "1 hour ago"` | Logs for a time window |
| `journalctl -u tick-dashboard -p err` | Errors only |
| `journalctl --disk-usage` | How much journal space is used |

Journal logs survive reboots and rotate on their own. The app's own audit log is
separate, at `logs/dashboard-<date>.log`.

### Control

| Command | What it does |
|---|---|
| `sudo systemctl restart tick-dashboard` | Restart it |
| `sudo systemctl stop tick-dashboard` | Stop it |
| `sudo systemctl start tick-dashboard` | Start it |
| `sudo systemctl reload-or-restart tick-dashboard` | Restart only if not already running |

### Uninstall

```bash
sudo systemctl disable --now tick-dashboard
sudo rm /etc/systemd/system/tick-dashboard.service
sudo systemctl daemon-reload
```

---

## Setup on a fresh Ubuntu 24.04 server

**Allow SSH before enabling the firewall**, or you will lock yourself out.

```bash
# 1. Update
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq && apt-get -y -qq full-upgrade
apt-get -y -qq autoremove && apt-get clean

# 2. Node 24 (Ubuntu does not ship a new enough version)
curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
apt-get install -y nodejs
node --version

# 3. Service user + code
useradd -r -m -d /opt/tickdash -s /bin/bash tickdash
mkdir -p /var/www
git clone https://github.com/RaF2i/tick.git /var/www/tick
chown -R tickdash:tickdash /var/www/tick

# 4. Config — .env is git-ignored, clone does not bring it
#    (from your machine: pscp -pw 'PW' dashboard/.env root@IP:/root/tick.env)
install -o tickdash -g tickdash -m 600 /root/tick.env /var/www/tick/dashboard/.env
shred -u /root/tick.env

# 5. Firewall — SSH FIRST
ufw allow 22/tcp comment 'SSH'
ufw allow 3100/tcp comment 'Dashboard'
ufw --force enable
ufw status verbose

# 6. Service
cat > /etc/systemd/system/tick-dashboard.service <<'UNIT'
[Unit]
Description=Ticket Control Dashboard
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=tickdash
Group=tickdash
WorkingDirectory=/var/www/tick/dashboard
ExecStart=/usr/bin/node server.mjs
Restart=always
RestartSec=5
Environment=TZ=Europe/Madrid
StandardOutput=journal
StandardError=journal
SyslogIdentifier=tick-dashboard

NoNewPrivileges=true
PrivateTmp=true
PrivateDevices=true
ProtectSystem=strict
ProtectHome=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
ReadWritePaths=/var/www/tick/dashboard

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable --now tick-dashboard
```

### `.env` essentials

```ini
PORT=3100
SERVITICKETS_API_KEY=<provider key>
DASHBOARD_PASSWORD=<strong password>
AUTOMATION_ENABLED=true
TICK_INTERVAL_MS=15000
```

`server.mjs` reads `.env` from its own directory automatically. Real environment
variables win over the file.

Verify from outside the server that SSH is still reachable:

```powershell
Test-NetConnection SERVER_IP -Port 22
```

---

## Egress — WARP / Tor

When the provider WAF blocks the VPS IP (`403 IP_BLOCKED — Su solicitud ha sido rechazada`), route provider calls through a local proxy instead. Three modes:

| Mode | Proxy | Install |
|---|---|---|
| `direct` | — | none (default) |
| `warp` | `127.0.0.1:40000` | `cloudflare-warp` |
| `tor` | `127.0.0.1:8118` (Privoxy → Tor 9050) | `tor privoxy` |

**WARP setup (Ubuntu 24.04):**

```bash
# 1. Cloudflare repo + install (see https://one.one.one/install/ for current URLs)
curl -fsSL https://pkg.cloudflareclient.com/pubkey.gpg | sudo gpg --dearmor -o /usr/share/keyrings/cloudflare-warp-archive-keyring.gpg
echo "deb [arch=amd64 signed-by=/usr/share/keyrings/cloudflare-warp-archive-keyring.gpg] https://pkg.cloudflareclient.com/cloudflare-main any main" | sudo tee /etc/apt/sources.list.d/cloudflare-client.list
sudo apt-get update && sudo apt-get install -y cloudflare-warp

# 2. PROXY mode on port 40000 (never "mode warp" on a VPS — full tunnel
#    hijacks SSH and nothing listens on 40000 in that mode)
warp-cli --accept-tos mode proxy
warp-cli --accept-tos proxy port 40000
warp-cli --accept-tos registration new
warp-cli --accept-tos connect
warp-cli --accept-tos status   # should say Connected

# 3. privoxy bridges SOCKS5 40000 -> HTTP 8118 (Node speaks HTTP proxies)
sudo apt-get install -y privoxy
echo 'forward-socks5 / 127.0.0.1:40000 .' | sudo tee -a /etc/privoxy/config
sudo systemctl enable --now privoxy

# 4. verify: trace through the bridge must say warp=on
curl -s -x http://127.0.0.1:8118 https://www.cloudflare.com/cdn-cgi/trace | grep -E '^(ip|warp)='
```

**Docker deployments** — the container has no `warp-cli`, so rotation is delegated
to a helper on the host:

```bash
# one-shot manual test:
ROTATE_TOKEN=optional-secret node dashboard/tools/warp-rotate-helper.mjs
curl -X POST -H "Authorization: Bearer optional-secret" http://127.0.0.1:3101/rotate

# under systemd (tick-rotate.service): ExecStart=/usr/bin/node /root/tick-docker/tools/warp-rotate-helper.mjs
# container env:
#   EGRESS_ROTATE_COMMAND=node /app/tools/host-rotate-client.mjs
#   ROTATE_HELPER_URL=http://172.17.0.1:3101/rotate   (docker bridge -> host)
#   ROTATE_TOKEN=optional-secret
```

**Tor setup:**

```bash
sudo apt-get install -y tor privoxy
# privoxy: forward 8118 -> tor socks 9050
echo 'forward-socks5 / 127.0.0.1:9050 .' | sudo tee -a /etc/privoxy/config
sudo systemctl enable --now tor privoxy
```

**Enable in the dashboard:**

```ini
# dashboard/.env
EGRESS_MODE=warp        # or tor, or direct
EGRESS_PROXY_URL=        # leave empty for the mode default above
EGRESS_HEALTH_INTERVAL_SEC=60
```

Or flip it live from the UI: **Controller settings → Egress**. The mode persists in `scheduler_state` across restarts, and switching clears the provider cooldown (new IP = clean slate). Health is logged every `EGRESS_HEALTH_INTERVAL_SEC` while warp/tor is active.

**Auto-rotation on IP_BLOCKED:** when a `403 IP_BLOCKED` comes back in warp/tor mode, the dashboard rotates and retries the same call on the fresh route — no 6h park. A rotation only counts when the new route **verifies** (trace through the proxy says `warp=on`/`plus`, exit IP differs from the last accepted one). Tor via `systemctl restart tor privoxy` (falls back to pkill/start, polls the proxy up to 60s). Tunables:

```ini
ROTATE_TRIES_MAX=4             # rotations per IP_BLOCKED (min 1)
ROTATE_COOLDOWN_SEC=8          # space between rotations (Cloudflare throttles bursts)
ROTATE_COMMAND_TIMEOUT_MS=30000
ROTATE_INTERVAL_SEC=7200       # fresh exit IP every 2h (0 = off)
EGRESS_VERIFY_WAIT_SEC=45      # seconds a rotation gets to prove the new route
ROTATE_RETRY_AFTER_BLOCK_SEC=90  # re-run a holding failed by IP_BLOCKED-after-rotation
EGRESS_SHORT_BLOCK_COOLDOWN_SEC=180  # breaker cap when a FRESH IP gets blocked
EGRESS_ROTATE_COMMAND=         # host helper command when the dashboard runs in Docker
```

On startup in proxy modes the dashboard **bootstraps**: it overrides any restored breaker, verifies the route and rotates until a fresh verified exit IP is live — so an already-blocked VPS IP starts working immediately. Scheduled rotation (every `ROTATE_INTERVAL_SEC`) resets on any manual/block rotation. The footer shows the current exit IP and the total verified IP changes (`egress_ip_changes` in `scheduler_state`).

**Verify on the VPS:**

```bash
curl -s -x http://127.0.0.1:40000 https://example.com -o /dev/null -w '%{http_code}\n'   # WARP
curl -s -x http://127.0.0.1:8118 https://example.com -o /dev/null -w '%{http_code}\n'    # Tor
journalctl -u tick-dashboard -f | grep EGRESS
```

> WARP and Tor are **mutually exclusive on one box** — pick one `EGRESS_MODE` per VPS. WARP needs systemd (`warp-svc`); Tor exit IPs are slower and more heavily flagged by the provider, but still rotate when the WAF trips. After installing `undici`, run `cd /var/www/tick/dashboard && npm install` once.

---

## Updates

```bash
cd /var/www/tick
git pull --ff-only origin main
sudo systemctl restart tick-dashboard
```

**The database is never replaced.** It is an untracked file on disk, so a pull
does not touch it. Frontend-only changes need nothing more than the restart.

Restarting logs everyone out — sessions are held in memory.

---

## Backups

Use `VACUUM INTO`. It snapshots a live database without stopping the service,
and needs no `sqlite3` CLI (not installed by default).

```bash
mkdir -p /var/backups/tick && chown tickdash:tickdash /var/backups/tick

cat > /tmp/backup.mjs <<'JS'
import { DatabaseSync } from 'node:sqlite';
const [src, dest] = process.argv.slice(2);
const d = new DatabaseSync(src);
d.exec(`VACUUM INTO '${dest}'`);
d.close();
JS

sudo -u tickdash node /tmp/backup.mjs \
  /var/www/tick/dashboard/dashboard.sqlite \
  /var/backups/tick/snapshot-$(date +%F-%H%M%S).sqlite
```

Do not `cp` the database while the service runs — it is in WAL mode, so live data
is spread across three files and a plain copy is incomplete.

---

## Troubleshooting

**Check the data is intact:**

```bash
sudo -u tickdash node -e "
const {DatabaseSync}=require('node:sqlite');
const d=new DatabaseSync('/var/www/tick/dashboard/dashboard.sqlite',{readOnly:true});
console.log('integrity:',d.prepare('PRAGMA integrity_check').get().integrity_check);
console.log('holdings :',d.prepare('select count(*) c from holdings').get().c);
d.close();"
```

| Symptom | Cause / fix |
|---|---|
| Will not start | `journalctl -u tick-dashboard -n 50` — old Node, or `.env` not `600` |
| Crash loop | `journalctl -u tick-dashboard -p err` |
| Site will not load | `ss -tlnp \| grep 3100` then `ufw status` |
| Wrong password | Check `.env` is `600 tickdash`; you may be IP-locked out |
| Database unwritable | `ReadWritePaths` must cover the path in `DASHBOARD_DB` |

The database md5 changes between deploys — the scheduler writes every 15s. Check
row counts and `integrity_check` instead, not the md5.

---

## Notes

- **Never leave `DASHBOARD_PASSWORD` empty** on a public server. Empty means no
  login at all — the whole API, including cart control, is open. Startup log
  prints `web password=ON` when it is set correctly.
- **Log in is rate limited**: 5 failures locks that IP for 15 minutes
  (`LOGIN_MAX_FAILS`, `LOGIN_LOCK_MS`). A restart clears it.
- **Run one process only.** `node:sqlite` is synchronous and sessions are
  in-memory, so a second worker would cause lock contention and random logouts.
- **Times display in Europe/Madrid** regardless of server timezone.
- **Database growth is unbounded.** `LOG_RETENTION_DAYS` prunes the audit log,
  but `availability_checks` and `runs` are never pruned.
- **Plain HTTP sends the password in cleartext.** To add TLS, front it with Caddy
  and a real domain — a bare IP cannot get a trusted certificate.