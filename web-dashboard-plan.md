# Web Dashboard and Cart-Holding Plan

## 1. Objective

Build a web dashboard where an authorized user can:

- Select one or more dates and times.
- Authenticate with the ticket API.
- Load available timetables and ticket counts.
- Choose a requested ticket quantity.
- Split quantities into cart items of no more than 30 tickets.
- Create the first cart item with `cart_id: null`.
- Reuse the returned cart ID for later items only if the provider confirms cart appending.
- Repeat the add-to-cart action at `30 minutes + 5 seconds` after the previous successful add.
- Track every availability check, cart, item, quantity, price, timestamp, token assignment, response, and error.
- Stop automatic holding.
- Remove held cart items only after the holding has been stopped.
- Manage multiple dates and multiple times independently.

## 2. API capability gate

The current API notes document these operations:

| Operation | API |
|---|---|
| Authenticate | `POST /places/authenticate` |
| Monthly calendar | `GET /visits/{visit_id}/calendar` |
| Daily occupation | `GET /visits/{visit_id}/calendar/day-occupation` |
| Add to cart | `POST /cart/add` |
| Inspect cart | `GET /cart/show/{cart_id}` |
| Remove cart item | `POST /cart/removeitem` |

Before production use, the provider must confirm all of the following:

1. An existing `cart_id` can be passed to `/cart/add` to append another item.
2. The same cart may contain multiple items for the same timetable.
3. Re-adding tickets after 30 minutes extends or renews the hold rather than creating a duplicate or failing.
4. Multiple provider-issued credentials/tokens may be used for different slots or runs.
5. The operation is authorized and does not bypass quantity, account, rate, or anti-automation limits.
6. The official checkout/payment flow, if required, is available.

Until these points are confirmed, the dashboard must show **Unverified API behavior** and allow dry-run/read-only testing only.

## 3. Recommended architecture

```text
Browser dashboard
        |
        v
Web/API server  ---- SQLite database
        |
        v
Scheduler/worker ---- Provider API
        |
        v
Audit log and alerts
```

Suggested implementation:

- Frontend: React/Next.js with TypeScript.
- Backend: Node.js/TypeScript API service.
- Worker: separate process for scheduled API calls.
- Database: SQLite in WAL mode for durable history and transactions.
- Job scheduling: a persistent SQLite jobs table processed by one scheduler worker; do not rely on an in-memory timer.
- Secrets: environment variables or a secrets manager. Store credential references, never raw API keys or bearer tokens in the database.
- Time zone: `Europe/Madrid` for ticket dates and timetable times; store timestamps internally in UTC.

SQLite is the required database for this project. Run the dashboard and scheduler on the same host or shared filesystem, enable WAL mode, set a busy timeout, and use one scheduler worker to avoid competing writers. If the system later needs multiple hosts or many concurrent workers, the database layer can be migrated to PostgreSQL.

Recommended SQLite settings:

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
PRAGMA synchronous = NORMAL;
```

Use versioned migrations and back up the database file together with its WAL/checkpoint state.

## 4. User workflow

### A. Create a holding

1. User signs in to the dashboard.
2. User clicks **New holding**.
3. User selects one or more dates.
4. For each date, the dashboard calls the monthly calendar endpoint.
5. The dashboard displays available times, timetable IDs, capacity, and current availability.
6. User selects one or more exact time slots.
7. User enters the requested quantity for each slot.
8. The dashboard previews the chunk plan.
9. User confirms the plan.
10. The server creates one independent holding target per date/time.
11. The worker starts the first run and updates the dashboard in real time or through polling.

### B. Calendar request

```http
GET /visits/25/calendar?place_id=2&tour=25&month=09&year=2026
Authorization: Bearer TOKEN
```

The response is used to find:

- Closed dates.
- The selected date.
- Active timetables.
- Timetable/occupation IDs.
- Start and end times.
- Capacity.

### C. Daily availability request

```http
GET /visits/25/calendar/day-occupation?place_id=2&tour=25&date=2026-09-15
Authorization: Bearer TOKEN
```

For the selected timetable, read:

```text
availables
available_capacity
is_fully_booked
sold
pending
```

The server must not trust an old dashboard value. It must check availability again immediately before every cart mutation.

## 5. Quantity and chunking rules

Use:

```text
quantity_to_take = min(requested_quantity, current_availables)
```

If `quantity_to_take` is zero, do not create a cart. If fewer than 30 are available, take all available tickets. Otherwise split into chunks of 30 or less.

Examples:

| Requested | Available | Cart item quantities |
|---:|---:|---|
| 68 | 68 | `30 + 30 + 8` |
| 68 | 45 | `30 + 15` |
| 68 | 24 | `24` |
| 30 | 8 | `8` |
| 30 | 0 | No cart |

The chunk planner must save its result before making API calls. Each chunk gets a stable `chunk_number` so retries cannot create duplicate chunks.

## 6. First cart and cart reuse

### First item

The first item for a holding uses:

```json
{
  "cart_id": null,
  "timetables": [{ "id": 7196 }],
  "tickets": [{ "id": 34, "quantity": 30 }]
}
```

Save the returned `cart_id`, `expires_at`, and any returned item ID.

### Later items in the same run

If cart appending is confirmed by the provider, submit later chunks using the same remote cart ID:

```json
{
  "cart_id": "CART_UUID_FROM_FIRST_REQUEST",
  "timetables": [{ "id": 7196 }],
  "tickets": [{ "id": 34, "quantity": 30 }]
}
```

Then submit the final chunk, for example quantity `8`, using the same cart ID. After every add, call:

```http
GET /cart/show/{cart_id}
```

Verify that the remote cart contains the expected total quantity.

If appending is not confirmed, the worker must not guess. It should either:

- Stop in `cart_append_unverified` state and alert the user; or
- Use separate carts only if the user explicitly enables that provider-approved mode.

## 7. Repeating after 30 minutes and 5 seconds

The repeat timer starts after the previous successful add-to-cart request has been recorded:

```text
next_run_at = last_successful_add_at + 30 minutes + 5 seconds
```

The scheduler should enqueue the job at `next_run_at`. A watchdog checks delayed jobs and records the actual request time. Exact network arrival at the provider cannot be guaranteed by a local timer.

For every later run:

1. Lock the holding row.
2. Confirm the holding is still `running`.
3. Confirm the cart has not expired.
4. Obtain or refresh an authorized provider-issued token.
5. Re-fetch the calendar and daily occupation.
6. Confirm that the target timetable still matches the selected date/time.
7. Calculate `quantity_to_take` again.
8. Split into chunks of 30 or less.
9. Add each chunk to the existing cart only if cart renewal/appending is confirmed.
10. Reconcile with `/cart/show/{cart_id}`.
11. Save the new last-add timestamp, quantity, price, response, and next run time.

If `expires_at` occurs before the next run, mark the holding as `expired`. A 30-minute schedule does not itself extend a temporary cart.

## 8. Token assignment

The user requested a different token for different times. The system should model this as an **authorized credential assignment**, not unrestricted token rotation.

```text
holding target -> credential reference -> current bearer token -> API calls
```

Rules:

- Use only credentials issued and authorized by the provider.
- Store `credential_id` and a short token fingerprint, not the bearer token.
- Refresh a token after documented expiry or `401 Unauthorized`.
- Do not rotate tokens to evade rate limits, purchase caps, anti-bot controls, or account restrictions.
- Record which authorized credential performed every run.
- If the provider permits one credential per time slot, configure that assignment in the dashboard.

## 9. Stop and remove controls

### Stop button

The **Stop automatic holding** button must:

1. Require confirmation.
2. Set the holding state to `stop_requested`.
3. Prevent new scheduled runs from starting.
4. Cancel queued jobs that have not started.
5. Allow an in-flight API request to finish safely.
6. Reconcile any uncertain cart request.
7. Set the final state to `stopped`.

The button must be idempotent; pressing it twice must not create another API request.

### Remove button

The **Remove held tickets** button must be disabled until the holding state is `stopped`, `expired`, or `failed`.

When used:

1. Require a second confirmation showing the cart IDs and quantities.
2. Lock the holding row.
3. Call `POST /cart/removeitem` for each saved remote item ID.
4. Record each response.
5. Call `GET /cart/show/{cart_id}` to verify the result.
6. Mark the holding `removed`, `partially_removed`, or `remove_failed`.

If the provider exposes only item removal, the system cannot assume that removing one item removes the entire cart.

## 10. Database design

### users

```text
id, email, password_hash, role, created_at, last_login_at
```

### credentials

```text
id, label, secret_reference, enabled, provider_scope,
last_authenticated_at, last_error, created_at
```

### holdings

```text
id, user_id, local_date, local_time, timezone,
requested_quantity, chunk_limit, repeat_minutes, repeat_offset_seconds,
status, timetable_id, place_id, visit_id, tour_id,
next_run_at, last_successful_add_at, stopped_at, created_at, updated_at
```

### holding_runs

```text
id, holding_id, run_number, credential_id, status,
available_before, quantity_requested, quantity_planned, quantity_added,
started_at, last_add_at, next_run_at, error_code, error_message
```

### availability_snapshots

```text
id, holding_id, run_id, timetable_id, checked_at,
sold, pending, available_capacity, availables, is_fully_booked,
raw_response_reference
```

### carts

```text
id, holding_id, run_id, remote_cart_id, status, append_mode,
expires_at, remote_status, first_created_at, last_checked_at
```

### cart_items

```text
id, cart_id, remote_item_id, chunk_number, timetable_id,
ticket_id, quantity, price_each, subtotal, added_at,
last_seen_at, status
```

### jobs

```text
id, holding_id, run_id, job_type, run_at, status,
attempts, locked_at, locked_by, last_error, created_at, updated_at
```

The scheduler claims due jobs inside a short `BEGIN IMMEDIATE` transaction, sets `locked_by` and `locked_at`, commits, and then performs network requests outside the transaction. A lease timeout makes abandoned jobs recoverable after a worker crash.

### api_events

```text
id, holding_id, run_id, endpoint, method, status_code,
request_id, duration_ms, redacted_request, redacted_response,
created_at
```

Never store raw API keys, bearer tokens, payment data, or identity documents in `api_events`.

## 11. State machine

```text
draft
  -> scheduled
  -> running
  -> holding
  -> stop_requested
  -> stopped
  -> remove_requested
  -> removed
```

Failure and expiry branches:

```text
running -> partial
running -> failed
holding -> expired
remove_requested -> partially_removed
remove_requested -> remove_failed
```

Each holding must have one independent state machine, so multiple dates and times do not interfere with one another.

## 12. Dashboard screens

### Overview

Show:

- Active holdings.
- Next run countdown.
- Selected date/time.
- Timetable/OccID.
- Requested, available, planned, and held quantities.
- Cart expiration.
- Last add time and price.
- Credential label, never the secret.
- Status and latest error.

### New holding

Fields:

- Date picker.
- Time-slot selector.
- Requested quantity.
- Credential assignment, if authorized.
- Repeat interval, default 30 minutes.
- Repeat offset, default 5 seconds.
- Cart-append mode, disabled until verified.

The preview must show the chunk plan before confirmation.

### Holding detail

Show:

- Availability history.
- Cart IDs and expiration times.
- Every cart item and chunk number.
- Quantity and price per request.
- API response status.
- Timeline of runs.
- Stop and remove controls.

### Design and accessibility

Use a dense real-time operations layout with clear status badges, accessible color contrast, visible keyboard focus, labeled controls, and no color-only status indicators. Use subtle motion only for state changes and respect `prefers-reduced-motion`. All destructive actions require confirmation.

## 13. Reliability and safety rules

- Use SQLite transactions and a lease/claim table so one holding cannot run twice at the same time.
- Keep one scheduler worker as the single writer for scheduled API mutations; the web server may read concurrently through WAL mode.
- Use `BEGIN IMMEDIATE` only for short state/lease updates; never hold a database write transaction during an HTTPS request.
- Add a unique key on `(holding_id, run_number, chunk_number)`.
- Use a global API rate limiter and per-credential rate limits.
- Do not blindly retry a timed-out `/cart/add`; reconcile with `/cart/show` first.
- Treat `401`, `403`, `429`, and `5xx` differently.
- Stop new runs after authentication, cart, or reconciliation failures until the user reviews them.
- Use server-side validation for date, time, quantity, and ticket IDs.
- Keep all dashboard mutations authenticated and audited.
- Protect the dashboard with admin authentication and HTTPS.
- Obtain provider authorization before enabling repeated holds, multiple credentials, cart reuse, or automated removal.

## 14. Implementation phases

### Phase 1 — Read-only dashboard

- User login.
- Date/time selection.
- Authentication.
- Calendar and occupation lookup.
- Availability table.
- Database audit trail.

### Phase 2 — One approved cart test

- Add one cart item.
- Save cart ID and expiration.
- Inspect cart.
- Verify quantity and price.
- No automatic repeat.

### Phase 3 — Approved cart append

- Confirm append behavior with the provider.
- Add a second chunk to the same cart.
- Reconcile after every add.
- Test `30 + 30 + 8` in a provider-approved environment.

### Phase 4 — Scheduler

- Durable jobs.
- `30m + 5s` scheduling.
- Stop/resume behavior.
- Token credential assignment.
- Multi-date and multi-time concurrency.

### Phase 5 — Removal and dashboard controls

- Stop gate.
- Remove-after-stop gate.
- Partial-removal handling.
- Alerts and audit exports.

### Phase 6 — Official checkout integration

- Customer fields.
- Payment or official reservation confirmation.
- Order status.
- Ticket delivery/download.

The current API list does not include this final phase's endpoints, so the system must not claim that a temporary cart is a completed purchase.
