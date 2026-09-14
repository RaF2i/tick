# Ticket Control Dashboard

This is the first dashboard/controller slice. It uses Node's built-in HTTP server and SQLite. The recurring 30-minute worker is intentionally disabled.

## Requirements

- Node.js 22.5 or newer (`node:sqlite` is used).
- A provider-issued API key. The controller currently includes the existing local key as a fallback.
- Provider authorization for any cart reuse or repeated holding.

## Start

PowerShell:

```powershell
node server.mjs
```

An environment variable can still override the hard-coded fallback:

```powershell
$env:SERVITICKETS_API_KEY = "YOUR_API_KEY"
node server.mjs
```

Then open <http://localhost:3000>.

Optional settings:

```powershell
$env:PORT = "3000"
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
- Calculates and stores a future `next_run_at`, but does not execute it.

## Safety defaults

- API keys and bearer tokens are not stored in SQLite event logs.
- The API key is hard-coded as a local fallback for convenience; rotate it and remove the fallback before sharing or deploying this project.
- The dashboard does not implement a recurring cron/worker loop yet.
- Cart append is disabled by default because the current API notes do not prove that reusing `cart_id` is supported.
- Do not rotate credentials to bypass provider limits or anti-automation controls.
