# Automatic Ticket Purchase Plan

This document describes the documented Servitickets API flow for selecting a date and time, finding an occupation/timetable ID, adding up to 30 tickets to a cart, verifying the cart, and repeating the process after 30 minutes.


## Configuration

```text
DATE     = YYYY-MM-DD
QUANTITY = 30
WAIT     = 30 minutes
```

Store the API key and bearer token in environment variables or a secrets manager. Do not commit credentials to source control.

## Common headers

Authentication request:

```http
Content-Type: application/json
Accept: application/json
```

Authenticated request:

```http
Authorization: Bearer YOUR_TOKEN
Content-Type: application/json
Accept: application/json
```

## 1. Authenticate

### Request

```http
POST /places/authenticate
```

```json
{
  "api_key": "YOUR_API_KEY"
}
```

### Successful response

```json
{
  "success": true,
  "message": "Autenticación exitosa",
  "place_id": 2,
  "place_name": "Catedral de Sevilla",
  "token": "TOKEN_VALUE"
}
```

Save `token` and use it as a bearer token for subsequent requests.


## 2. Pick a date and retrieve the calendar

### Request

```http
GET /visits/25/calendar?place_id=2&tour=25&month=09&year=2026
Authorization: Bearer YOUR_TOKEN
```

Replace `month` and `year` with the target date's month and year.

### Response structure used by the current scripts

```json
{
  "data": {
    "daysWithItems": [
      {
        "date": "2026-09-15",
        "day": "Tuesday",
        "timetables": [
          {
            "id": 7196,
            "start_date": "2026-09-15 07:30:00",
            "end_date": "2026-09-15 07:35:00",
            "active": true,
            "capacity": 60
          }
        ]
      }
    ],
    "closedDays": []
  }
}
```

### Date selection

1. Check whether the target date appears in `closedDays`.
2. If it is closed, stop for that batch.
3. Find the target date in `daysWithItems`.
4. Select an `active` timetable.
5. Save its `id`. This is the timetable/occupation ID used in the cart request.

## 3. Check occupation and availability for the selected date

### Request

```http
GET /visits/25/calendar/day-occupation?place_id=2&tour=25&date=2026-09-15
Authorization: Bearer YOUR_TOKEN
```

### Response

```json
{
  "data": {
    "7196": {
      "sold": 53,
      "sold_wholesale": 0,
      "pending": 0,
      "pending_wholesale": 0,
      "available_capacity": 7,
      "is_fully_booked": false,
      "availables": 7
    }
  }
}
```

### Availability decision

For a requested quantity, calculate the amount to take as:

```text
quantity_to_take = min(requested_quantity, availables)
```

If `quantity_to_take` is zero, do not create a cart. If `quantity_to_take` is between 1 and 29, take all available tickets in one item. If it is 30 or more, split it into chunks of no more than 30.

Examples:

```text
Available 68, requested 68 -> 30 + 30 + 8
Available 24, requested 68 -> 24
Available 45, requested 68 -> 30 + 15
Available 0, requested 68  -> no cart
```

Re-check only according to the provider's permitted polling frequency.

## 4. Add 30 tickets to a cart

### Request

```http
POST /cart/add
Authorization: Bearer YOUR_TOKEN
Content-Type: application/json
Accept: application/json
```

```json
{
  "visit_id": 25,
  "cart_id": null,
  "place_id": "2",
  "tour_id": 25,
  "timetables": [
    {
      "id": 7196
    }
  ],
  "tickets": [
    {
      "id": 34,
      "quantity": 30
    }
  ],
  "subject_id": null
}
```

The `id` in `timetables` must be the selected timetable/occupation ID. The ticket sample identifies ticket `34` as `Individual adultos`; confirm that this ticket type and quantity are allowed before submitting.

### Successful response

```json
{
  "success": true,
  "cart_id": "CART_UUID",
  "expires_at": "2026-09-15T07:06:59.000000Z"
}
```

Save `cart_id` and `expires_at`. A cart is temporary and must be completed before it expires.

### Possible failure handling

- `401`: refresh authentication and retry only when appropriate.
- `4xx`: validate the date, timetable ID, ticket ID, and quantity.
- `5xx`: treat as a provider error; do not blindly submit duplicate carts.
- Successful response with `success: false`: stop and log the returned message.

## 5. View and verify the cart

### Request

```http
GET /cart/show/CART_UUID
Authorization: Bearer YOUR_TOKEN
Accept: application/json
```

### Response

```json
{
  "data": {
    "cart_id": "CART_UUID",
    "status": "temporary",
    "purchase": {
      "status": "temporary",
      "channel": "online",
      "locator": "PURCHASE_LOCATOR"
    },
    "items": [
      {
        "id": 250312,
        "visit_id": 25,
        "tour_id": 25,
        "subtotal": "390.00",
        "total": "390.00",
        "extrafields": {
          "get_extra_fields": 1,
          "extra_fields_per_ticket": true,
          "field_1": "Nombre completo",
          "field_2": "Documento de identidad D.N.I o pasaporte"
        },
        "timetables": [
          {
            "id": 7196,
            "start_date": "2026-09-15 07:30:00",
            "end_date": "2026-09-15 07:35:00"
          }
        ],
        "tickets": [
          {
            "ticket_id": 34,
            "quantity": 30,
            "total": "390.00"
          }
        ]
      }
    ],
    "subtotal": "390.00",
    "total": "390.00",
    "dni_required": true
  }
}
```

The actual price, commission, tax, required fields, and ticket IDs must come from the live response. Do not calculate or assume them from this example.

Verify before proceeding:

```text
cart.status == "temporary"
cart ID is the expected cart
selected timetable ID is correct
ticket quantity == 30
required customer fields are available
cart has not expired
```

## 6. Final checkout and payment — not documented

The available API list does not provide an endpoint for:

- Submitting customer names and DNI/passport details
- Setting email and phone
- Initiating payment
- Confirming payment
- Converting the temporary cart into a completed purchase
- Retrieving or downloading issued tickets

The implementation must obtain the official checkout documentation or use an officially supported checkout integration. Do not guess endpoint names or attempt to bypass payment, bot protection, or purchase limits.

## 7. Remove a cart item if necessary

### Request

```http
POST /cart/removeitem
Authorization: Bearer YOUR_TOKEN
Content-Type: application/json
Accept: application/json
```

```json
{
  "cart_id": "CART_UUID",
  "item_id": 250312
}
```

### Response

```json
{
  "success": true,
  "error": "ITEM_REMOVED_SUCCESS",
  "message": "Item eliminado correctamente.",
  "expires_at": "2026-09-15T07:09:27.000000Z"
}
```

Use this only for the intended cart item. Do not remove items from carts that the system did not create.

## Batch workflow

```text
START
  |
  v
Authenticate -> token
  |
  v
Fetch calendar for target month/year
  |
  v
Reject closed or missing date
  |
  v
Fetch day occupation
  |
  v
Select active timetable with at least 30 available
  |
  v
POST /cart/add with quantity 30
  |
  v
GET /cart/show/{cart_id}
  |
  v
Official checkout/payment flow required
  |
  v
Wait 30 minutes after confirmed purchase
  |
  v
Repeat from calendar and availability checks
```

## Repeat-loop safeguards

- Start the 30-minute timer only after a confirmed completed purchase, not merely after cart creation.
- Create a new cart for each batch.
- Re-check availability before every batch.
- Stop if the cart expires, the date is closed, the slot has zero available tickets, or checkout fails. If 1–29 are available, take all available tickets.
- Avoid duplicate submissions after timeouts; first inspect the cart or order status if an official status endpoint exists.
- Respect the provider's terms, rate limits, purchase limits, and anti-automation requirements.
- Log request IDs, cart IDs, selected timetable IDs, and final purchase status without logging API keys, bearer tokens, payment data, or identity documents.

## API summary

| Purpose | Method | Endpoint | Documented here |
|---|---|---|---|
| Authenticate | `POST` | `/places/authenticate` | Yes |
| Monthly calendar | `GET` | `/visits/{visit_id}/calendar` | Yes |
| Day occupation | `GET` | `/visits/{visit_id}/calendar/day-occupation` | Yes |
| Add cart item | `POST` | `/cart/add` | Yes |
| View cart | `GET` | `/cart/show/{cart_id}` | Yes |
| Remove cart item | `POST` | `/cart/removeitem` | Yes |
| Checkout/payment | Unknown | Not provided | No |
| Completed order/tickets | Unknown | Not provided | No |

## Final multi-slot holding system plan

### Goal

For one or more dates and times, periodically check availability and create authorized temporary carts in chunks of no more than 30 tickets per cart item.

Example:

```text
Target: 12:10 on a selected date
Available: 68
Requested: 68
Chunks: 30 + 30 + 8
```

The system must distinguish between:

1. **A cart item limit**: maximum quantity submitted in one `tickets` item.
2. **A cart limit**: the maximum total quantity accepted in one cart.
3. **A purchase limit**: the provider's business or account-level limit.

The documented API only shows a `max_tickets` value of 30 in an example ticket response. It does not prove that 30 is the maximum for every ticket type or that multiple cart items may be appended to the same cart.

### Cart-ID policy

`POST /cart/add` creates a new cart when `cart_id` is `null`. Reusing the returned `cart_id` for a second or third add request is not documented in the available API list.

Use this safe policy:

```text
ALLOW_CART_APPEND = false by default
```

If the provider confirms that an existing cart can accept more items, the flow for 68 tickets may be:

```text
1. POST /cart/add with cart_id: null, quantity: 30
2. Save returned cart_id
3. POST /cart/add with the same cart_id, quantity: 30
4. POST /cart/add with the same cart_id, quantity: 8
5. GET /cart/show/{cart_id} and verify total quantity: 68
```

If cart appending is not officially supported, use separate carts:

```text
Cart A: 30
Cart B: 30
Cart C: 8
```

Do not assume that separate carts form one order. They may have separate expiration times, payment flows, and customer details.

### Credential/token policy

The scheduler may associate a target time slot with a provider-issued credential only if the provider authorizes those credentials.

```text
target slot -> authorized credential -> authenticated token -> cart actions
```

Store `credential_id`, not raw tokens, in the database. Refresh a token when required or after a documented expiry/`401` response. Do not rotate tokens to evade rate limits, purchase limits, anti-bot controls, or account restrictions. The current API documentation does not establish that a different token is required for each time slot.

### Multi-date and multi-time configuration

Represent every requested date/time as an independent target:

```text
2026-09-15 12:10 Europe/Madrid, requested quantity 68, every 30 minutes
2026-09-15 14:30 Europe/Madrid, requested quantity 30, every 30 minutes
2026-09-16 12:10 Europe/Madrid, requested quantity 45, every 30 minutes
```

Use `Europe/Madrid` for timetable scheduling and convert to UTC internally. This avoids errors caused by daylight-saving changes. The target's local date is sent to the API as `YYYY-MM-DD`.

Each target should contain:

```text
date
requested start time
requested quantity
repeat interval
maximum number of runs, if any
enabled/disabled status
credential assignment, if authorized
```

### Scheduler workflow

For each enabled target whose `next_run_at` is due:

1. Acquire a database lock so two workers cannot process the same target simultaneously.
2. Authenticate or reuse a valid provider-issued token.
3. Request the monthly calendar with `GET /visits/{visit_id}/calendar`.
4. Confirm that the target date is present and not closed.
5. Match the exact requested time to an active timetable.
6. Request `GET /visits/{visit_id}/calendar/day-occupation` for the target date.
7. Read the selected occupation ID and `availables` value.
8. If availability is zero or the slot is fully booked with zero availability, record the result and stop this run. If availability is below the requested amount but greater than zero, continue with the available amount.
9. Set `quantity_to_take = min(requested_quantity, availables)`. If fewer than 30 are available, take all of them. Split the resulting amount into chunks of at most 30. For 68 available/requested tickets, produce `[30, 30, 8]`; for 24 available tickets, produce `[24]`.
10. Before every chunk, re-check availability when the provider permits it. Inventory can change between API calls.
11. Add each chunk through `POST /cart/add`, using `cart_id: null` for a new cart or the existing cart ID only when cart appending is confirmed.
12. Immediately save the response, cart ID, expiration, chunk number, and quantity.
13. Call `GET /cart/show/{cart_id}` to reconcile the remote cart with the database.
14. Stop and alert on any partial failure. Do not blindly repeat a timed-out add request because it may have succeeded remotely.
15. Continue only through the official checkout/payment flow once that endpoint is available.
16. Schedule the next run 30 minutes later only after applying the configured stop rules.

### Important 30-minute limitation

The `expires_at` value returned by `/cart/add` controls how long a temporary cart is held. A 30-minute scheduler interval does not guarantee that a cart will remain valid for 30 minutes.

The system must:

- Compare the current time with `expires_at`.
- Mark a cart as `expired` when its hold ends.
- Never treat an expired temporary cart as a confirmed reservation.
- Create a new cart for a later run unless the provider documents cart extension or reuse.
- Require the official checkout or reservation mechanism to hold tickets beyond the temporary-cart lifetime.

### Recommended temporary database

Use PostgreSQL for the shared scheduler and web dashboard. It provides transactions, row locks, concurrent workers, reliable timestamps, and durable audit history.

For a single-machine prototype only, SQLite in WAL mode is acceptable. Do not use an in-memory database because restart recovery and audit history are required.

Suggested tables:

```text
credentials
  id, label, secret_reference, enabled, last_auth_at, last_error

targets
  id, local_date, local_time, timezone, timetable_id, requested_quantity,
  chunk_limit, repeat_minutes, next_run_at, enabled, status

runs
  id, target_id, run_number, credential_id, status, requested_quantity,
  available_before, started_at, finished_at, error_code, error_message

carts
  id, run_id, remote_cart_id, status, expires_at, remote_status,
  append_mode, created_at, last_checked_at

cart_items
  id, cart_id, remote_item_id, timetable_id, ticket_id, chunk_number,
  quantity, unit_price, status, created_at

availability_snapshots
  id, target_id, run_id, timetable_id, checked_at, sold, pending,
  available_capacity, availables, is_fully_booked, raw_response_reference

api_events
  id, run_id, endpoint, method, status_code, request_id, duration_ms,
  redacted_request, redacted_response, created_at

orders
  id, run_id, remote_order_id, locator, status, total, confirmed_at,
  ticket_reference
```

Never store API keys, bearer tokens, payment information, or identity documents in `api_events`. Store a secret-manager reference and redact sensitive request/response fields.

### State model

Target states:

```text
disabled -> scheduled -> running -> held/checkout_pending
                             |              |
                             v              v
                          partial       confirmed
                             |
                             v
                          failed
```

Cart states:

```text
creating -> active -> verified -> checkout_pending -> confirmed
                         |
                         v
                      expired/cancelled/failed
```

Use a unique key such as `(target_id, run_number, chunk_number)` so a worker retry cannot create duplicate chunks accidentally.

### Dashboard

The web dashboard should provide:

- Date/time targets and enable/disable controls
- Requested quantity and chunk limit
- Current timetable/occupation ID
- Latest availability and timestamp
- Run history for every date/time
- Cart IDs, chunk quantities, expiration times, and statuses
- Credential assignment labels without exposing credentials
- API status codes and redacted error messages
- Timeline of 30-minute runs
- Alerts for partial reservations, expired carts, authentication failure, and checkout failure
- Manual refresh and retry for failed runs, protected by an admin login

The dashboard should be read-only for secrets. Any retry action must use the same idempotency and locking rules as the scheduler.

### Operational safeguards

- Obtain written authorization from the ticket provider for automated reservations and multiple credentials.
- Respect provider rate limits, purchase limits, and anti-automation requirements.
- Do not use token rotation or multiple accounts to evade restrictions.
- Use bounded retries with exponential backoff for transient errors.
- Treat `401`, `403`, `429`, and `5xx` differently and record each response.
- Use a per-target lock and a global request-rate limiter.
- Reconcile the remote cart after every uncertain request.
- Start the 30-minute repeat timer only according to the configured business rule; it must not imply that a cart remains held for 30 minutes.
- Keep an audit trail for every availability check and cart mutation.

### Implementation order

1. Confirm the provider's authorization, cart-append behavior, ticket limits, and checkout API.
2. Build the PostgreSQL schema and secret handling.
3. Implement authentication and read-only calendar/occupation checks.
4. Implement chunk calculation and dry-run mode.
5. Implement one-cart creation with `quantity <= 30`.
6. Add cart verification and idempotent retry/reconciliation.
7. Add multi-date/time scheduling with locks and rate limiting.
8. Add the dashboard and alerts.
9. Integrate the official checkout/payment flow.
10. Test with a non-production or provider-approved account before enabling repeated runs.
