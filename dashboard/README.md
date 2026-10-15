# Ticket Control Dashboard

This is the first dashboard/controller slice. It uses Node's built-in HTTP server and SQLite. The recurring 30-minute worker is intentionally disabled.

> **See [HOSTING.md](./HOSTING.md)** for deployment: the systemd unit, a pm2
> command map, a fresh-server setup guide, backups, and troubleshooting.

## Requirements

- Node.js 22.5 or newer (`node:sqlite` is used).
- A provider-issued API key, set as `SERVITICKETS_API_KEY`. There is no built-in fallback.
- Provider authorization for any cart reuse or repeated holding.
- A strong `DASHBOARD_PASSWORD` for anything not on a trusted LAN. If it is
  empty the dashboard is open to anyone who can reach the port.

## Start

PowerShell:

```powershell
node server.mjs
```

A real environment variable always takes precedence over anything set in `.env`:

```powershell
$env:SERVITICKETS_API_KEY = "YOUR_API_KEY"
node server.mjs
```

Then open <http://localhost:3100>. (`PORT` defaults to 3100.)

Optional settings:

```powershell
$env:PORT = "3100"
$env:DASHBOARD_DB = "C:\path\to\ticket-dashboard.sqlite"
$env:PLACE_ID = "2"
$env:VISIT_ID = "25"
$env:TOUR_ID = "25"
$env:TICKET_ID = "34"
```

`ALLOW_CART_APPEND` defaults to `false`. Set it to `true` only after the provider confirms that later `/cart/add` calls may reuse the first cart ID:

```powershell
$env:ALLOW_CART_APPEND = "true"
```

## Current controller behavior

- Loads monthly calendar and daily occupation data for a selected date.
- Displays times, OccIDs, capacity, sold, and available tickets.
- Previews ticket chunks of 30 or less.
- Saves holding targets in `dashboard.sqlite`.
- Allows one deliberate **Add once** action.
- Stores API events, availability checks, cart items, prices, timestamps, expiration, and status.
- Allows **Stop** and then **Remove** for a saved holding.
- Executes `next_run_at` on a scheduler tick (`TICK_INTERVAL_MS`, default 15s) for
  any holding with `auto_enabled`, including re-buy after cart expiry.
- Throttles `/api/login` per client IP (5 failures, then a 15-minute lockout).

## Safety defaults

- API keys and bearer tokens are not stored in SQLite event logs.
- The API key must be supplied via `SERVITICKETS_API_KEY`; there is no hard-coded fallback.
- Login is gated by `DASHBOARD_PASSWORD`. If empty, the dashboard is unauthenticated.
- Cart append is disabled by default because the current API notes do not prove that reusing `cart_id` is supported.
- Do not rotate credentials to bypass provider limits or anti-automation controls.
