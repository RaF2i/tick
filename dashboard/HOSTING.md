# Hosting the Ticket Control Dashboard

Everything below is the setup that is **actually running in production**, not a
generic template. Commands were run and verified against a live Ubuntu 24.04 VPS.

- [TL;DR](#tldr)
- [pm2 → systemd command map](#pm2--systemd-command-map)
- [What systemd gives you that pm2 doesn't](#what-systemd-gives-you-that-pm2-doesnt)
- [Hosting guide: fresh server from scratch](#hosting-guide-fresh-server-from-scratch)
- [Deploying updates](#deploying-updates)
- [Backups](#backups)
- [Firewall](#firewall)
- [Optional: put it behind HTTPS](#optional-put-it-behind-https)
- [Troubleshooting](#troubleshooting)
- [Known behaviours worth knowing](#known-behaviours-worth-knowing)

---

## TL;DR

| | |
|---|---|
| Process manager | systemd (`tick-dashboard.service`) |
| Runs as | `tickdash` (unprivileged) |
| Code location | `/var/www/tick` |
| Database | `/var/www/tick/dashboard/dashboard.sqlite` |
| Config | `/var/www/tick/dashboard/.env` (mode `600`, git-ignored) |
| Port | `3100` |
| URL | `http://<server-ip>:3100` |
| Node | `>= 22.5` required (uses `node:sqlite`); production runs 24.x |

Most of the time you only need three commands:

```bash
systemctl status tick-dashboard      # is it up?
journalctl -u tick-dashboard -f      # live logs
sudo systemctl restart tick-dashboard  # restart it
```

---

## pm2 → systemd command map

| Task | pm2 | systemd |
|---|---|---|
| See status | `pm2 list` | `systemctl status tick-dashboard` |
| Live logs (follow) | `pm2 logs tick-dashboard` | `journalctl -u tick-dashboard -f` |
| Last 100 log lines | `pm2 logs --lines 100` | `journalctl -u tick-dashboard -n 100` |
| Logs since boot | — | `journalctl -u tick-dashboard -b` |
| Logs, last hour | — | `journalctl -u tick-dashboard --since "1 hour ago"` |
| Start | `pm2 start tick-dashboard` | `sudo systemctl start tick-dashboard` |
| Stop | `pm2 stop tick-dashboard` | `sudo systemctl stop tick-dashboard` |
| Restart | `pm2 restart tick-dashboard` | `sudo systemctl restart tick-dashboard` |
| Start automatically on boot | `pm2 startup && pm2 save` | `sudo systemctl enable tick-dashboard` |
| Disable on boot | `pm2 unstartup` / `pm2 delete tick-dashboard` | `sudo systemctl disable tick-dashboard` |
| List every service | `pm2 list` | `systemctl list-units 'tick*'` |
| Show config in use | `pm2 show tick-dashboard` | `systemctl cat tick-dashboard` |
| Show resolved settings | `pm2 env <id>` | `systemctl show tick-dashboard` |
| Is it enabled/active? (scripting) | — | `systemctl is-enabled tick-dashboard`<br>`systemctl is-active tick-dashboard` |
| Resource usage (live) | `pm2 monit` | `watch -n2 systemctl status tick-dashboard` |
| Rotate + vacuum logs | `pm2 flush` | `journalctl --rotate && journalctl --vacuum-time=1s` |
| Remove entirely | `pm2 delete tick-dashboard && pm2 save` | `sudo systemctl disable --now tick-dashboard`<br>`sudo rm /etc/systemd/system/tick-dashboard.service`<br>`sudo systemctl daemon-reload` |
| Re-read config after editing unit | `pm2 reload` | `sudo systemctl daemon-reload` |

**Note:** `systemctl status` tells you the process is alive — it does **not** tell
you the auto-runner is actually working. For that, check the app's own log:

```bash
tail -20 /var/www/tick/dashboard/logs/dashboard-$(date +%F).log
```

You want to see recurring `START`/`run` lines, not just the one from boot.

---

## What systemd gives you that pm2 doesn't

**No extra dependency.** pm2 is an npm package plus its own daemon and a
`~/.pm2` directory. This project has *zero* npm dependencies, so pm2 would be
pure overhead.

**No separate daemon to keep alive.** pm2 is itself a background process that can
die and take your app's restart ability with it. systemd is PID 1's own
supervisor — if it is running, your restart policy is running.

**Declarative restart policy.** `Restart=always` + `RestartSec=5` is checked by
the kernel's init. pm2's equivalent depends on its own supervision loop staying
healthy.

**Boot ordering.** `After=network-online.target` means the app starts *after* the
network is actually up, not merely after the network service is launched. This
matters here: the app makes outbound API calls on startup.

**Journal integration.** Logs go straight to `journalctl`, so they survive
reboots, rotate automatically, and are readable with standard tools. pm2 writes
its own flat files.

### One pm2 feature you must NOT use here

```bash
pm2 start server.mjs -i max     # DO NOT
```

Cluster mode is unavailable for this app, for two independent reasons:

1. `node:sqlite` is **synchronous**. Multiple processes means multiple write
   connections to the same WAL database — SQLite serialises them, so you gain
   nothing and risk `SQLITE_BUSY` under contention.
2. Login sessions live in an **in-memory `Set`**. Each worker process would have
   its own set, so a session cookie minted by one worker would be rejected by the
   next request that landed on a different worker. Users would be logged out at
   random.

It must run as a **single process**. systemd's default is correct.

---

## Hosting guide: fresh server from scratch

Assumes a fresh Ubuntu 24.04 LTS VPS that you can `root` into.

> **Before you enable a firewall**, make sure you can still reach SSH. Add the
> SSH rule *before* turning UFW on, or you will lock yourself out.

### 1. Update the server

```bash
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get -y -qq full-upgrade
apt-get -y -qq autoremove
apt-get clean
```

### 2. Install Node.js 24

Ubuntu 24.04 does not ship a new enough Node. The app needs **>= 22.5** for the
built-in `node:sqlite` module (no external database package is used).

```bash
curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
apt-get install -y nodejs
node --version          # expect v24.x
```

### 3. Create the service user and clone

```bash
useradd -r -m -d /opt/tickdash -s /bin/bash tickdash
mkdir -p /var/www
git clone https://github.com/RaF2i/tick.git /var/www/tick
chown -R tickdash:tickdash /var/www/tick
```

If the repository is private, configure a deploy key rather than using a
personal token.

### 4. Upload the config file

`.env` is in `.gitignore`, so `git clone` will **not** bring it. Copy it up
separately and lock it down — it contains the provider API key and the login
password.

```bash
# from your local machine
pscp -pw 'YOUR_PASSWORD' dashboard/.env root@SERVER_IP:/root/tick.env

# on the server
install -o tickdash -g tickdash -m 600 /root/tick.env /var/www/tick/dashboard/.env
shred -u /root/tick.env        # remove the staging copy in /root
```

At minimum these must be set in `.env`:

```ini
PORT=3100
SERVITICKETS_API_KEY=<provider key>
DASHBOARD_PASSWORD=<strong password>   # empty = the dashboard is WIDE OPEN
AUTOMATION_ENABLED=true
TICK_INTERVAL_MS=15000
```

`server.mjs` reads `.env` automatically from its own directory. Real environment
variables always take precedence over values in the file.

> **Do not skip `DASHBOARD_PASSWORD`.** If it is empty, the login check returns
> "allowed" for every request — the entire API, including cart control, is
> public. The startup log prints `web password=OFF` when this is wrong.

### 5. Install the systemd unit

```bash
cat > /etc/systemd/system/tick-dashboard.service <<'UNIT'
[Unit]
Description=Ticket Control Dashboard
Documentation=https://github.com/RaF2i/tick
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

sudo systemctl daemon-reload
sudo systemctl enable --now tick-dashboard
systemctl is-active tick-dashboard   # expect: active
```

**About the hardening block.** `ProtectSystem=strict` makes the entire filesystem
read-only to the service except `ReadWritePaths`. The app needs to write the
SQLite database (`dashboard.sqlite`, `-wal`, `-shm`) and its `logs/` directory,
both of which live under `/var/www/tick/dashboard`. If you ever point `DASHBOARD_DB`
or `DASHBOARD_LOG_DIR` somewhere else in `.env`, **add that path to
`ReadWritePaths`** or those writes will fail silently — the app swallows logging
errors by design.

### 6. Firewall

```bash
ufw allow 22/tcp    comment 'SSH'      # ALWAYS FIRST
ufw allow 3100/tcp  comment 'Dashboard'
ufw --force enable
ufw status verbose
```

Confirm from your own machine that you can still reach SSH **before** walking
away from the console:

```powershell
Test-NetConnection SERVER_IP -Port 22
```

Only ports you explicitly allow are reachable. Everything else is denied.

### 7. Verify

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3100/login.html   # 200
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3100/api/holdings # 401 = auth working
```

Then open `http://SERVER_IP:3100` in a browser and log in.

---

## Deploying updates

Frontend and code updates are safe to deploy live — the database is never
touched by a pull.

```bash
cd /var/www/tick
git pull --ff-only origin main
sudo systemctl restart tick-dashboard
```

`-b` (`journalctl -u tick-dashboard -b`) shows the restart banner. A healthy
start prints the port, database path, automation settings, and `web password=ON`.

**The database is never replaced.** It is a file on disk at
`dashboard/dashboard.sqlite` and `git pull` does not touch untracked files. It
survives restarts and deploys untouched. Verify any time:

```bash
md5sum /var/www/tick/dashboard/dashboard.sqlite
```

> The checksum **does** change between deploys even though nothing "happened" —
> the scheduler writes on every 15-second tick. Check row counts and
> `PRAGMA integrity_check`, not the md5, to confirm the data is intact.

**Restarting logs everyone out.** Sessions are held in memory, so there is no
surviving restart. Use `systemctl reload-or-restart` if you want the same
behaviour.

---

## Backups

The database holds live cart state. Back it up with `VACUUM INTO`, which takes a
consistent snapshot **without stopping the service** and without needing the
`sqlite3` CLI (which is not installed by default).

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

Nightly, keep 7 days:

```bash
cat > /etc/cron.d/tick-backup <<'CRON'
15 3 * * * root /usr/local/bin/tick-backup.sh
CRON
```

> **Do not `cp` the database file while the service is running.** The database is
> in WAL mode, so the live data lives across three files (`-wal` and `-shm`
> alongside the main DB). Copying only the `.sqlite` file gives you a torn,
> incomplete backup. `VACUUM INTO` handles this correctly.

---

## Optional: put it behind HTTPS

Running on plain HTTP means the login password and session cookie travel in
cleartext. For anything beyond a trusted LAN, terminate TLS with a reverse proxy.

With a domain pointing at the server, Caddy does it in about a minute:

```bash
apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
  | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
  > /etc/apt/sources.list.d/caddy-stable.list
apt-get update && apt-get install -y caddy

cat > /etc/caddy/Caddyfile <<'CADDY'
dashboard.yourdomain.com {
    encode zstd gzip
    reverse_proxy 127.0.0.1:3100
}
CADDY

systemctl enable --now caddy
```

Caddy obtains and renews the certificate automatically. Then tighten the firewall
so 3100 is no longer reachable from outside — keep only SSH and 443:

```bash
ufw delete allow 3100/tcp
ufw allow 443/tcp comment 'HTTPS'
```

> **A bare IP address cannot get a Let's Encrypt certificate.** Caddy falls back
> to a self-signed certificate, which makes browsers show a warning. You need a
> real domain for a trusted cert.

---

## Troubleshooting

**Service will not start**

```bash
systemctl status tick-dashboard
journalctl -u tick-dashboard -n 50 --no-pager
```

Common causes:

- `Cannot find module` / wrong Node → check `node --version` is >= 22.5
- Permission errors writing the database → the `.env` is missing or not `600`, or
  `ReadWritePaths` does not cover the path in `DASHBOARD_DB`
- Repeated crash-restart loop → `journalctl -u tick-dashboard -p err`

**Service runs but the site will not load**

```bash
ss -tlnp | grep 3100          # is it listening?
ufw status                    # is the port allowed?
```

**"Wrong password" but you are sure it is right**

Check that the service actually picked up the file:

```bash
sudo -u tickdash stat -c '%a %U %n' /var/www/tick/dashboard/.env
```

You should see `600 tickdash`. Also note the login endpoint locks an IP out for
15 minutes after 5 failed attempts (`LOGIN_MAX_FAILS` / `LOGIN_LOCK_MS` in
`.env`). Waiting it out or `systemctl restart tick-dashboard` clears it, since
the counter is in memory.

**Check the data is intact**

```bash
sudo -u tickdash node -e "
const {DatabaseSync}=require('node:sqlite');
const d=new DatabaseSync('/var/www/tick/dashboard/dashboard.sqlite',{readOnly:true});
console.log('integrity:',d.prepare('PRAGMA integrity_check').get().integrity_check);
console.log('holdings :',d.prepare('select count(*) c from holdings').get().c);
d.close();"
```

---

## Known behaviours worth knowing

- **Sessions are in memory.** Every restart logs out every user.
- **All times display in Europe/Madrid**, regardless of server timezone. The app
  formats with `Intl.DateTimeFormat` and an explicit `APP_TZ`.
- **The log files rotate** at `LOG_RETENTION_DAYS` (default 7), but that pruning
  covers the audit event log. The `availability_checks` and `runs` tables grow
  continuously and are **not** pruned — the database will keep growing. Plan a
  retention policy before it becomes large.
- **`.env` is git-ignored on purpose.** It holds a live provider API key. Never
  commit it.