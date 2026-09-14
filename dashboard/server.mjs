import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { appendFileSync, mkdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';
import { randomBytes, timingSafeEqual, createHash } from 'node:crypto';

const ROOT = dirname(fileURLToPath(import.meta.url));

// Load dashboard/.env (no dependency). Real environment variables win.
try {
  const envPath = join(ROOT, '.env');
  if (existsSync(envPath)) {
    for (const rawLine of readFileSync(envPath, 'utf8').split('\n')) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq < 1) continue;
      const key = line.slice(0, eq).trim();
      let val = line.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (!(key in process.env)) process.env[key] = val;
    }
  }
} catch { /* ignore — defaults + real env still apply */ }
const LOG_DIR = process.env.DASHBOARD_LOG_DIR || join(ROOT, 'logs');
try { mkdirSync(LOG_DIR, { recursive: true }); } catch { /* ignore */ }
function logLine(msg) {
  const line = `${new Date().toISOString()} ${msg}`;
  try { appendFileSync(join(LOG_DIR, `dashboard-${line.slice(0, 10)}.log`), `${line}\n`); } catch { /* ignore */ }
  console.log(line);
}
const PUBLIC_DIR = join(ROOT, 'public');
const PORT = Number(process.env.PORT || 3100);
const API_BASE = (process.env.SERVITICKETS_API_BASE || 'https://admin.catedraldesevilla.servitickets.es/api').replace(/\/$/, '');
const PLACE_ID = String(process.env.PLACE_ID || '2');
const VISIT_ID = Number(process.env.VISIT_ID || 25);
const TOUR_ID = Number(process.env.TOUR_ID || 25);
const DEFAULT_TICKET_ID = Number(process.env.TICKET_ID || 34);
const API_KEY = process.env.SERVITICKETS_API_KEY || '';
const ALLOW_CART_APPEND = process.env.ALLOW_CART_APPEND !== 'false';
// ON unless explicitly disabled — `npm start` must behave like start-dashboard.bat.
let AUTOMATION_ENABLED = process.env.AUTOMATION_ENABLED !== 'false';
const TICK_INTERVAL_MS = Math.max(5000, Number(process.env.TICK_INTERVAL_MS || 15000));
const REBUY_LEAD_SEC = Number(process.env.REBUY_LEAD_SEC || 10);
const RETRY_FAILED_SEC = Number(process.env.RETRY_FAILED_SEC || 120);
const RETRY_BOOKED_SEC = Number(process.env.RETRY_BOOKED_SEC || 600);
const RETRY_API_SEC = Number(process.env.RETRY_API_SEC || 30);
// Release-race tight loop: on 403 NO_CAPACITY while our own previous cart just
// expired (provider releases lazily), retry cart/add every few seconds instead
// of waiting for the next scheduler tick. Only this error class loops —
// genuine sellouts and API errors keep the normal backoff above.
const RACE_RETRY_EVERY_SEC = Math.max(1, Number(process.env.RACE_RETRY_EVERY_SEC || 3));
const RACE_WINDOW_SEC = Math.max(30, Number(process.env.RACE_WINDOW_SEC || 360));
// Only loop when the previous cart expired recently — otherwise a 403 means
// truly sold out and hammering would be pointless.
const RACE_AFTER_EXPIRY_SEC = Math.max(60, Number(process.env.RACE_AFTER_EXPIRY_SEC || 600));
// Retention for audit tables (runs capped per holding instead of by age).
const LOG_RETENTION_DAYS = Math.max(1, Number(process.env.LOG_RETENTION_DAYS || 7));
const RUNS_PER_HOLDING = Math.max(50, Number(process.env.RUNS_PER_HOLDING || 500));
const DEFAULT_REPEAT_MINUTES = Number(process.env.REPEAT_MINUTES || 30);
const DEFAULT_REPEAT_OFFSET_SEC = Number(process.env.REPEAT_OFFSET_SEC || 5);
const DB_PATH = process.env.DASHBOARD_DB || join(ROOT, 'dashboard.sqlite');

// Web login gate. Empty = open (backwards compatible); set DASHBOARD_PASSWORD
// in .env to require it. Sessions live in memory — a restart asks to log in again.
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || '';
const sessions = new Set();
function checkPassword(guess) {
  if (!DASHBOARD_PASSWORD) return true;
  const a = createHash('sha256').update(String(guess || '')).digest();
  const b = createHash('sha256').update(DASHBOARD_PASSWORD).digest();
  return timingSafeEqual(a, b);
}
function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
const webAuthed = (req) => {
  const token = parseCookies(req).dash_session;
  return Boolean(token) && sessions.has(token);
};

const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  PRAGMA busy_timeout = 5000;
  PRAGMA synchronous = NORMAL;

  CREATE TABLE IF NOT EXISTS holdings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    local_date TEXT NOT NULL,
    local_time TEXT NOT NULL,
    timezone TEXT NOT NULL DEFAULT 'Europe/Madrid',
    timetable_id INTEGER NOT NULL,
    ticket_id INTEGER NOT NULL,
    requested_quantity INTEGER NOT NULL CHECK (requested_quantity > 0),
    planned_quantity INTEGER,
    chunks_json TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'draft',
    remote_cart_id TEXT,
    expires_at TEXT,
    last_added_at TEXT,
    next_run_at TEXT,
    price_total REAL,
    currency TEXT NOT NULL DEFAULT 'EUR',
    last_error TEXT,
    stopped_at TEXT,
    removed_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS availability_checks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    holding_id INTEGER,
    local_date TEXT NOT NULL,
    timetable_id INTEGER NOT NULL,
    sold INTEGER,
    pending INTEGER,
    available_capacity INTEGER,
    availables INTEGER,
    is_fully_booked INTEGER,
    checked_at TEXT NOT NULL,
    response_json TEXT,
    FOREIGN KEY (holding_id) REFERENCES holdings(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS cart_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    holding_id INTEGER NOT NULL,
    remote_cart_id TEXT NOT NULL,
    remote_item_id INTEGER,
    chunk_number INTEGER NOT NULL,
    timetable_id INTEGER NOT NULL,
    ticket_id INTEGER NOT NULL,
    quantity INTEGER NOT NULL,
    price_total REAL,
    status TEXT NOT NULL DEFAULT 'active',
    added_at TEXT NOT NULL,
    FOREIGN KEY (holding_id) REFERENCES holdings(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS api_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    holding_id INTEGER,
    endpoint TEXT NOT NULL,
    method TEXT NOT NULL,
    status_code INTEGER,
    request_json TEXT,
    response_json TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (holding_id) REFERENCES holdings(id) ON DELETE SET NULL
  );
  CREATE TABLE IF NOT EXISTS scheduler_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    holding_id INTEGER NOT NULL,
    run_number INTEGER NOT NULL,
    trigger TEXT NOT NULL DEFAULT 'manual',
    status TEXT NOT NULL DEFAULT 'failed',
    requested_quantity INTEGER,
    availables_seen INTEGER,
    added_quantity INTEGER NOT NULL DEFAULT 0,
    chunks_json TEXT NOT NULL DEFAULT '[]',
    remote_cart_id TEXT,
    remote_item_ids_json TEXT NOT NULL DEFAULT '[]',
    price_total REAL,
    expires_at TEXT,
    error TEXT,
    started_at TEXT NOT NULL,
    finished_at TEXT NOT NULL,
    FOREIGN KEY (holding_id) REFERENCES holdings(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_runs_holding ON runs (holding_id, run_number DESC);
`);

function ensureColumn(table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
}
ensureColumn('holdings', 'auto_enabled', 'auto_enabled INTEGER NOT NULL DEFAULT 0');
ensureColumn('holdings', 'repeat_minutes', 'repeat_minutes REAL NOT NULL DEFAULT 30');
ensureColumn('holdings', 'repeat_offset_sec', 'repeat_offset_sec INTEGER NOT NULL DEFAULT 5');
ensureColumn('holdings', 'run_count', 'run_count INTEGER NOT NULL DEFAULT 0');
ensureColumn('holdings', 'auth_token', 'auth_token TEXT');
ensureColumn('holdings', 'auth_obtained_at', 'auth_obtained_at TEXT');
ensureColumn('holdings', 'cart_verified_at', 'cart_verified_at TEXT');

// Indexes depending on migrated columns must come after ensureColumn.
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_holdings_schedule ON holdings (auto_enabled, status, next_run_at);
  CREATE INDEX IF NOT EXISTS idx_events_time ON api_events (created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_events_holding ON api_events (holding_id);
  CREATE INDEX IF NOT EXISTS idx_checks_holding ON availability_checks (holding_id, checked_at DESC);
`);

const nowIso = () => new Date().toISOString();
const toInt = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : fallback;
};

function chunksFor(quantity, max = 30) {
  const chunks = [];
  let remaining = Math.max(0, toInt(quantity));
  while (remaining > 0) {
    const chunk = Math.min(max, remaining);
    chunks.push(chunk);
    remaining -= chunk;
  }
  return chunks;
}

function safeJson(value, maxLength = 12000) {
  try {
    const text = JSON.stringify(value ?? null);
    return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
  } catch {
    return JSON.stringify({ error: 'unserializable' });
  }
}

function recordEvent({ holdingId = null, endpoint, method, statusCode = null, request = null, response = null }) {
  db.prepare(`
    INSERT INTO api_events (holding_id, endpoint, method, status_code, request_json, response_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(holdingId, endpoint, method, statusCode, safeJson(request), safeJson(response), nowIso());
}

function redactForLog(path, value) {
  if (path === '/places/authenticate') {
    if (value && typeof value === 'object' && 'api_key' in value) return { ...value, api_key: '[redacted]' };
    if (value && typeof value === 'object' && 'token' in value) {
      const { token, ...safe } = value;
      return { ...safe, token: token ? '[redacted]' : null };
    }
  }
  return value;
}

function errorWithStatus(message, status = 400, details = null) {
  const error = new Error(message);
  error.status = status;
  error.details = details;
  return error;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// True when a cart/add failure looks like our own just-expired cart still
// locking capacity (provider releases lazily after expires_at), as opposed
// to a genuine sellout. Only this case may enter the tight retry loop.
function isReleaseRace(error, prevExpiresAt) {
  if (Number(error?.status) !== 403) return false;
  if (!/NO_CAPACITY|capacidad/i.test(error?.message || '')) return false;
  if (!prevExpiresAt) return false;
  const expiredMs = Date.now() - Date.parse(prevExpiresAt);
  return expiredMs >= 0 && expiredMs <= RACE_AFTER_EXPIRY_SEC * 1000;
}

async function readResponse(res) {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text.slice(0, 4000) };
  }
}

async function apiRequest({ method, path, token = null, body = undefined, holdingId = null }) {
  const endpoint = `${API_BASE}${path}`;
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;

  let response;
  try {
    response = await fetch(endpoint, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'manual',
    });
  } catch (cause) {
    recordEvent({ holdingId, endpoint: path, method, request: redactForLog(path, body), response: { network_error: cause.message } });
    throw errorWithStatus(`Provider request failed: ${cause.message}`, 502);
  }

  const payload = await readResponse(response);
  recordEvent({
    holdingId,
    endpoint: path,
    method,
    statusCode: response.status,
    request: redactForLog(path, body),
    response: redactForLog(path, payload),
  });

  if (!response.ok) {
    const bits = [];
    if (payload && typeof payload === 'object') {
      if (payload.error) bits.push(String(payload.error));
      if (payload.message && payload.message !== payload.error) bits.push(String(payload.message));
    }
    const suffix = bits.length ? ` (${bits.join(' — ').slice(0, 220)})` : '';
    throw errorWithStatus(`Provider returned HTTP ${response.status}${suffix}`, response.status, payload);
  }
  return payload;
}

async function authenticate() {
  if (!API_KEY) {
    logLine('AUTH fail: no API key configured');
    throw errorWithStatus('SERVITICKETS_API_KEY is not configured on the server.', 500);
  }
  const payload = await apiRequest({
    method: 'POST',
    path: '/places/authenticate',
    body: { api_key: API_KEY },
  });
  if (!payload?.success || !payload.token) {
    logLine('AUTH fail: provider rejected credentials');
    throw errorWithStatus('Provider authentication failed.', 502, payload);
  }
  logLine(`AUTH ok: place ${payload.place_name || payload.place_id || '?'}`);
  return payload.token;
}

function dateParts(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw errorWithStatus('Date must use YYYY-MM-DD format.', 400);
  }
  const [year, month, day] = date.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) {
    throw errorWithStatus('Date is invalid.', 400);
  }
  return { year, month, day };
}

function timeOnly(value) {
  if (!value) return '';
  const match = String(value).match(/(\d{2}:\d{2})/);
  return match ? match[1] : String(value);
}

async function fetchAvailability(date, holdingId = null, token = null) {
  const { year, month } = dateParts(date);
  // Reuse the caller's token when provided — one login per run, not two.
  token = token || await authenticate();
  const calendar = await apiRequest({
    method: 'GET',
    path: `/visits/${VISIT_ID}/calendar?place_id=${encodeURIComponent(PLACE_ID)}&tour=${TOUR_ID}&month=${month}&year=${year}`,
    token,
    holdingId,
  });
  const calendarData = calendar?.data || {};
  const closedDays = Array.isArray(calendarData.closedDays) ? calendarData.closedDays : [];
  const closed = closedDays.find((item) => item.date === date) || null;
  if (closed) {
    return { date, closed, timetables: [], tokenUsed: true };
  }

  const dayInfo = (calendarData.daysWithItems || []).find((item) => item.date === date);
  if (!dayInfo) return { date, closed: null, missing: true, timetables: [], tokenUsed: true };

  const occupationResponse = await apiRequest({
    method: 'GET',
    path: `/visits/${VISIT_ID}/calendar/day-occupation?place_id=${encodeURIComponent(PLACE_ID)}&tour=${TOUR_ID}&date=${encodeURIComponent(date)}`,
    token,
    holdingId,
  });
  const occupation = occupationResponse?.data || {};
  const timetables = (dayInfo.timetables || []).map((slot) => {
    const stats = occupation[String(slot.id)] || {};
    const result = {
      id: Number(slot.id),
      start: timeOnly(slot.start_date),
      end: timeOnly(slot.end_date),
      startDate: slot.start_date || null,
      endDate: slot.end_date || null,
      active: Boolean(slot.active),
      capacity: Number(slot.capacity || 0),
      sold: Number(stats.sold || 0),
      pending: Number(stats.pending || 0),
      availableCapacity: Number(stats.available_capacity ?? stats.availables ?? 0),
      availables: Number(stats.availables || 0),
      fullyBooked: Boolean(stats.is_fully_booked),
    };
    db.prepare(`
      INSERT INTO availability_checks
        (holding_id, local_date, timetable_id, sold, pending, available_capacity, availables, is_fully_booked, checked_at, response_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(holdingId, date, result.id, result.sold, result.pending, result.availableCapacity, result.availables, result.fullyBooked ? 1 : 0, nowIso(), safeJson(result));
    return result;
  });
  return { date, closed: null, missing: false, day: dayInfo.day || null, timetables, tokenUsed: true };
}

function getHolding(id) {
  const row = db.prepare('SELECT * FROM holdings WHERE id = ?').get(id);
  if (!row) throw errorWithStatus('Holding was not found.', 404);
  return {
    ...row,
    chunks: JSON.parse(row.chunks_json || '[]'),
    cartItems: db.prepare('SELECT * FROM cart_items WHERE holding_id = ? ORDER BY chunk_number, id').all(id),
    runs: db.prepare('SELECT * FROM runs WHERE holding_id = ? ORDER BY run_number DESC, id DESC LIMIT 100').all(id).map((r) => ({
      ...r,
      chunks: JSON.parse(r.chunks_json || '[]'),
      itemIds: JSON.parse(r.remote_item_ids_json || '[]'),
    })),
  };
}

function listHoldings() {
  return db.prepare('SELECT * FROM holdings ORDER BY created_at DESC, id DESC').all().map((row) => ({
    ...row,
    chunks: JSON.parse(row.chunks_json || '[]'),
    cartItems: db.prepare('SELECT * FROM cart_items WHERE holding_id = ? ORDER BY chunk_number, id').all(row.id),
    runs: db.prepare('SELECT * FROM runs WHERE holding_id = ? ORDER BY run_number DESC, id DESC LIMIT 100').all(row.id).map((r) => ({
      ...r,
      chunks: JSON.parse(r.chunks_json || '[]'),
      itemIds: JSON.parse(r.remote_item_ids_json || '[]'),
    })),
  }));
}

// Every add attempt (success or fail) gets its own history row — the dialog
// shows ALL runs, not just the latest holding state.
function finishRun(holdingId, info) {
  const prev = db.prepare('SELECT COALESCE(MAX(run_number), 0) AS m FROM runs WHERE holding_id = ?').get(holdingId);
  const runNumber = Number(prev?.m || 0) + 1;
  db.prepare(`
    INSERT INTO runs
      (holding_id, run_number, trigger, status, requested_quantity, availables_seen,
       added_quantity, chunks_json, remote_cart_id, remote_item_ids_json,
       price_total, expires_at, error, started_at, finished_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    holdingId, runNumber,
    info.trigger || 'manual', info.status || 'failed',
    info.requested ?? null, info.availables ?? null,
    info.added ?? 0, JSON.stringify(info.chunks || []),
    info.cartId || null, JSON.stringify(info.itemIds || []),
    info.total ?? null, info.expires || null, info.error || null,
    info.started, nowIso()
  );
  return runNumber;
}

function updateHolding(id, patch) {
  const allowed = Object.keys(patch);
  if (!allowed.length) return;
  const values = allowed.map((key) => patch[key]);
  const assignments = allowed.map((key) => `${key} = ?`).join(', ');
  db.prepare(`UPDATE holdings SET ${assignments}, updated_at = ? WHERE id = ?`).run(...values, nowIso(), id);
}

function parseId(pathPart) {
  const id = Number(pathPart);
  if (!Number.isInteger(id) || id < 1) throw errorWithStatus('Invalid holding ID.', 400);
  return id;
}

async function showCart(cartId, token, holdingId) {
  return apiRequest({ method: 'GET', path: `/cart/show/${encodeURIComponent(cartId)}`, token, holdingId });
}

function extractCart(payload) {
  return payload?.data || {};
}

function cartItemIds(payload) {
  const items = Array.isArray(extractCart(payload).items) ? extractCart(payload).items : [];
  return [...new Set(items.map((item) => Number(item.id)).filter((id) => Number.isInteger(id) && id > 0))];
}

async function createHolding(body) {
  const date = String(body.date || '');
  const time = String(body.time || '');
  dateParts(date);
  if (!/^\d{2}:\d{2}$/.test(time)) throw errorWithStatus('Time must use HH:MM format.', 400);
  const timetableId = toInt(body.timetableId);
  const ticketId = toInt(body.ticketId, DEFAULT_TICKET_ID);
  const quantity = toInt(body.quantity);
  if (!timetableId || !ticketId || quantity < 1) throw errorWithStatus('A timetable, ticket type, and positive quantity are required.', 400);

  const timestamp = nowIso();
  const chunks = chunksFor(quantity);
  const result = db.prepare(`
    INSERT INTO holdings
      (local_date, local_time, timetable_id, ticket_id, requested_quantity, chunks_json, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, ?)
  `).run(date, time, timetableId, ticketId, quantity, JSON.stringify(chunks), timestamp, timestamp);
  return getHolding(Number(result.lastInsertRowid));
}

async function addInitialCart(id, source = 'manual') {
  const holding = getHolding(id);
  if (['stopped', 'removed', 'remove_requested'].includes(holding.status)) {
    throw errorWithStatus(`Holding is ${holding.status} and cannot be added.`, 409);
  }
  const startedAt = nowIso();
  const requested = Number(holding.requested_quantity);
  logLine(`ADD #${id} start trigger=${source} want=${requested} slot=${holding.local_date} ${holding.local_time} occ=${holding.timetable_id}`);

  // Single login per run: this token serves availability + all cart calls.
  let token = await authenticate();
  updateHolding(id, { auth_token: token, auth_obtained_at: nowIso() });
  const availability = await fetchAvailability(holding.local_date, id, token);
  const slot = availability.timetables.find((item) => item.id === Number(holding.timetable_id));
  if (!slot) {
    const msg = 'The selected timetable is no longer available for this date.';
    logLine(`ADD #${id} fail: ${msg}`);
    finishRun(id, { trigger: source, status: 'failed', requested, availables: null, added: 0, chunks: [], error: msg, started: startedAt });
    throw errorWithStatus(msg, 409, availability);
  }
  const availables = Math.max(0, Number(slot.availables));
  const quantityToTake = Math.min(requested, availables);
  if (!quantityToTake) {
    updateHolding(id, { status: 'no_availability', planned_quantity: 0, chunks_json: '[]', last_error: 'No tickets available.' });
    logLine(`ADD #${id} fail: no availability (avail=${availables})`);
    finishRun(id, { trigger: source, status: 'failed', requested, availables, added: 0, chunks: [], error: 'No tickets available.', started: startedAt });
    throw errorWithStatus('No tickets are available for the selected time.', 409, slot);
  }

  const chunks = chunksFor(quantityToTake);
  if (chunks.length > 1 && !ALLOW_CART_APPEND) {
    updateHolding(id, { status: 'append_unverified', planned_quantity: quantityToTake, chunks_json: JSON.stringify(chunks), last_error: 'Cart append is disabled until provider behavior is confirmed.' });
    finishRun(id, { trigger: source, status: 'failed', requested, availables, added: 0, chunks, error: 'Cart append disabled.', started: startedAt });
    throw errorWithStatus('This request needs multiple cart items, but cart append is disabled. Set ALLOW_CART_APPEND=true only after the provider confirms it.', 409, { quantityToTake, chunks });
  }

  // Previous cart (if any) stays valid upstream until its own expiry — never
  // clobber its pointers on a failed re-add, or the UI + provider drift apart.
  const prevCartId = holding.remote_cart_id || null;
  const prevExpiresAt = holding.expires_at || null;
  const prevAddedAt = holding.last_added_at || null;
  let cartId = null;
  let expiresAt = null;
  let priceTotal = null;
  let lastAddedAt = null;
  const createdItems = [];
  const newRowIds = [];
  // IDs of the previous cart's rows — only marked superseded once the new cart exists,
  // so a failed run never orphans the still-valid previous cart.
  const prevActiveIds = db.prepare(`SELECT id FROM cart_items WHERE holding_id = ? AND status = 'active'`).all(id).map((r) => r.id);
  updateHolding(id, { status: 'adding', planned_quantity: quantityToTake, chunks_json: JSON.stringify(chunks), last_error: null });

  // Release-race tight retry: shared deadline across chunks. While our own
  // previous cart is freshly expired, the provider may still lock capacity —
  // retry cart/add every RACE_RETRY_EVERY_SEC up to RACE_WINDOW_SEC instead
  // of failing into the minute-scale backoff. runningJobs already guards
  // overlaps; other holdings in the same tick simply wait for this run.
  let raceStart = null;
  let raceRetries = 0;
  let reauthed = false;

  try {
    for (let index = 0; index < chunks.length; index += 1) {
      const quantity = chunks[index];
      let response;
      for (;;) {
        try {
          response = await apiRequest({
            method: 'POST',
            path: '/cart/add',
            token,
            holdingId: id,
            body: {
              visit_id: VISIT_ID,
              cart_id: cartId,
              place_id: PLACE_ID,
              tour_id: TOUR_ID,
              timetables: [{ id: Number(holding.timetable_id) }],
              tickets: [{ id: Number(holding.ticket_id), quantity }],
              subject_id: null,
            },
          });
          break;
        } catch (addError) {
          if (Number(addError?.status) === 401 && !reauthed) {
            reauthed = true;
            token = await authenticate();
            updateHolding(id, { auth_token: token, auth_obtained_at: nowIso() });
            continue;
          }
          if (!isReleaseRace(addError, prevExpiresAt)) throw addError;
          if (raceStart === null) raceStart = Date.now();
          if (Date.now() - raceStart > RACE_WINDOW_SEC * 1000) throw addError;
          raceRetries += 1;
          if (raceRetries === 1 || raceRetries % 20 === 0) {
            logLine(`ADD #${id} race: ${addError.message} — retry ${raceRetries} in ${RACE_RETRY_EVERY_SEC}s`);
          }
          await sleep(RACE_RETRY_EVERY_SEC * 1000);
        }
      }
      cartId = response?.cart_id || cartId;
      if (!cartId) throw errorWithStatus('Cart response did not include cart_id.', 502, response);
      expiresAt = response?.expires_at || expiresAt;
      lastAddedAt = nowIso();
      const ins = db.prepare(`
        INSERT INTO cart_items
          (holding_id, remote_cart_id, chunk_number, timetable_id, ticket_id, quantity, added_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(id, cartId, index + 1, Number(holding.timetable_id), Number(holding.ticket_id), quantity, lastAddedAt);
      newRowIds.push(Number(ins.lastInsertRowid));
      createdItems.push(quantity);
      updateHolding(id, { remote_cart_id: cartId, expires_at: expiresAt, last_added_at: lastAddedAt, next_run_at: new Date(Date.now() + 30 * 60 * 1000 + 5000).toISOString() });
    }

    const cartResponse = await showCart(cartId, token, id);
    const cart = extractCart(cartResponse);
    priceTotal = Number.isFinite(Number(cart.total)) ? Number(cart.total) : null;
    const itemIds = cartItemIds(cartResponse);
    // Map provider ITEM_IDs onto just the rows created in this run (like add-result.json).
    newRowIds.forEach((rowId, index) => {
      const remoteItemId = itemIds[index] ?? itemIds[itemIds.length - 1] ?? null;
      db.prepare('UPDATE cart_items SET remote_item_id = ?, price_total = ? WHERE id = ?').run(remoteItemId, priceTotal, rowId);
    });
    if (prevActiveIds.length) {
      // Previous cart abandoned — keep rows as history so old ITEM_IDs stay auditable.
      db.prepare(`UPDATE cart_items SET status = 'superseded' WHERE holding_id = ? AND status = 'active' AND remote_cart_id != ?`).run(id, cartId);
    }
    updateHolding(id, { status: 'manual_hold', price_total: priceTotal, cart_verified_at: nowIso(), last_error: null });
    const addedTotal = createdItems.reduce((a, q) => a + q, 0);
    logLine(`ADD #${id} success: +${addedTotal} [${chunks.join('+')}] cart=${cartId} items=[${itemIds.join(',')}] total=${priceTotal}${raceRetries ? ` after ${raceRetries} race retries` : ''}`);
    finishRun(id, { trigger: source, status: 'success', requested, availables, added: addedTotal, chunks, cartId, itemIds, total: priceTotal, expires: expiresAt, started: startedAt });
    return getHolding(id);
  } catch (error) {
    // Release-race loop exhausted: NO_CAPACITY for the full window means the
    // slot is truly stocked out, not just slow to release — park the holding
    // (auto off, no next run) instead of retrying every 10 min forever.
    // User re-enables manually via Auto when ready.
    const raceExhausted = raceStart !== null && raceRetries > 0
      && (Date.now() - raceStart) >= RACE_WINDOW_SEC * 1000;
    const stopPatch = raceExhausted ? { auto_enabled: 0, next_run_at: null, stopped_at: nowIso() } : {};
    const stopNote = raceExhausted ? ' Auto-stopped after 6 min of continuous NO_CAPACITY — likely stocked out. Re-enable manually to try again.' : '';
    if (createdItems.length) {
      // Partial new cart: it supersedes the old one — point at what actually holds tickets.
      const addedTotal = createdItems.reduce((a, q) => a + q, 0);
      updateHolding(id, { status: 'partial', remote_cart_id: cartId, expires_at: expiresAt, last_added_at: lastAddedAt, last_error: `${error.message}.${stopNote}`, ...stopPatch });
      logLine(`${raceExhausted ? 'AUTO-STOP' : 'ADD'} #${id} partial: +${addedTotal} cart=${cartId} err=${error.message}.${stopNote}`);
      finishRun(id, { trigger: source, status: 'partial', requested, availables, added: addedTotal, chunks, cartId, itemIds: [], error: `${error.message}.${stopNote}`, expires: expiresAt, started: startedAt });
    } else if (prevCartId) {
      // Nothing new was added: the previous cart is still the live one upstream.
      // On race exhaustion the holding parks as stopped (auto off) — the cart
      // stays held until its own expiry and the user can Remove or re-enable.
      const raceNote = raceRetries ? ` (after ${raceRetries} race retries over ${Math.round((Date.now() - (raceStart || Date.now())) / 1000)}s)` : '';
      const status = raceExhausted ? 'stopped' : 'manual_hold';
      updateHolding(id, { status, remote_cart_id: prevCartId, expires_at: prevExpiresAt, last_added_at: prevAddedAt, last_error: `Re-add failed (${error.message})${raceNote}.${stopNote} — previous cart ${String(prevCartId).slice(0, 8)}… still held.`, ...stopPatch });
      logLine(`${raceExhausted ? 'AUTO-STOP' : 'ADD'} #${id} fail: ${error.message}${raceNote}.${stopNote} (kept previous cart ${String(prevCartId).slice(0, 8)}…)`);
      finishRun(id, { trigger: source, status: 'failed', requested, availables, added: 0, chunks, cartId: prevCartId, error: `${error.message}${raceNote}.${stopNote}`, expires: prevExpiresAt, started: startedAt });
    } else {
      updateHolding(id, { status: 'failed', remote_cart_id: null, expires_at: null, last_added_at: null, last_error: error.message });
      logLine(`ADD #${id} fail: ${error.message}`);
      finishRun(id, { trigger: source, status: 'failed', requested, availables, added: 0, chunks, error: error.message, started: startedAt });
    }
    throw error;
  }
}

async function removeHolding(id) {
  const holding = getHolding(id);
  logLine(`REMOVE #${id} start cart=${holding.remote_cart_id ? String(holding.remote_cart_id).slice(0, 8) + '…' : 'none'}`);
  if (!['stopped', 'remove_failed'].includes(holding.status)) {
    throw errorWithStatus('Stop the holding before removing its tickets.', 409);
  }
  if (!holding.remote_cart_id) {
    db.prepare('UPDATE cart_items SET status = \'removed\' WHERE holding_id = ? AND status = \'active\'').run(id);
    updateHolding(id, { status: 'removed', auto_enabled: 0, next_run_at: null, price_total: null, expires_at: null, last_added_at: null, cart_verified_at: null, removed_at: nowIso(), last_error: 'No live cart reference — nothing held upstream.' });
    logLine(`REMOVE #${id} done: no live cart, marked removed`);
    return getHolding(id);
  }

  const token = await authenticate();
  updateHolding(id, { auth_token: token, auth_obtained_at: nowIso() });
  let cartResponse = null;
  try {
    cartResponse = await showCart(holding.remote_cart_id, token, id);
  } catch (error) {
    if (error.status === 404) {
      db.prepare('UPDATE cart_items SET status = \'removed\' WHERE holding_id = ?').run(id);
      updateHolding(id, { status: 'removed', auto_enabled: 0, next_run_at: null, price_total: null, remote_cart_id: null, expires_at: null, last_added_at: null, cart_verified_at: null, removed_at: nowIso(), last_error: 'Cart already gone upstream (expired or deleted).' });
      logLine(`REMOVE #${id} done: cart already gone upstream`);
      return getHolding(id);
    }
    throw error;
  }
  const itemIds = cartItemIds(cartResponse);
  if (!itemIds.length) {
    db.prepare('UPDATE cart_items SET status = \'removed\' WHERE holding_id = ?').run(id);
    updateHolding(id, { status: 'removed', auto_enabled: 0, next_run_at: null, price_total: null, remote_cart_id: null, expires_at: null, last_added_at: null, cart_verified_at: null, removed_at: nowIso(), last_error: null });
    logLine(`REMOVE #${id} done: cart already empty upstream`);
    return getHolding(id);
  }

  updateHolding(id, { status: 'removing', last_error: null });
  try {
    for (const itemId of itemIds) {
      await apiRequest({
        method: 'POST',
        path: '/cart/removeitem',
        token,
        holdingId: id,
        body: { cart_id: holding.remote_cart_id, item_id: itemId },
      });
    }
    db.prepare('UPDATE cart_items SET status = \'removed\' WHERE holding_id = ?').run(id);
    updateHolding(id, { status: 'removed', auto_enabled: 0, next_run_at: null, price_total: null, remote_cart_id: null, expires_at: null, last_added_at: null, cart_verified_at: null, removed_at: nowIso(), last_error: null });
    logLine(`REMOVE #${id} done: removed ${itemIds.length} item(s) upstream`);
    return getHolding(id);
  } catch (error) {
    updateHolding(id, { status: 'remove_failed', next_run_at: null, last_error: error.message });
    logLine(`REMOVE #${id} fail: ${error.message}`);
    throw error;
  }
}

async function refreshCartState(id) {
  const holding = getHolding(id);
  if (!holding.remote_cart_id) throw errorWithStatus('Holding has no cart yet.', 409);
  const token = await authenticate();
  updateHolding(id, { auth_token: token, auth_obtained_at: nowIso() });
  let cartResponse;
  try {
    cartResponse = await showCart(holding.remote_cart_id, token, id);
  } catch (error) {
    if (error.status === 404) {
      updateHolding(id, { last_error: 'Cart gone upstream (expired or deleted).', cart_verified_at: nowIso() });
      throw errorWithStatus('Cart gone upstream (expired or deleted).', 404, error.details);
    }
    throw error;
  }
  const cart = extractCart(cartResponse);
  const itemIds = cartItemIds(cartResponse);
  const priceTotal = Number.isFinite(Number(cart.total)) ? Number(cart.total) : null;
  const activeRows = db.prepare(`SELECT id FROM cart_items WHERE holding_id = ? AND status = 'active' ORDER BY chunk_number, id`).all(id);
  activeRows.forEach((row, index) => {
    const remoteItemId = itemIds[index] ?? itemIds[itemIds.length - 1] ?? row.remote_item_id ?? null;
    db.prepare(`UPDATE cart_items SET remote_item_id = ?, price_total = ? WHERE id = ?`).run(remoteItemId, priceTotal, row.id);
  });
  updateHolding(id, {
    price_total: priceTotal,
    expires_at: cart.expires_at || holding.expires_at,
    cart_verified_at: nowIso(),
    last_error: null,
  });
  logLine(`VERIFY #${id}: cart ok total=${priceTotal} items=${itemIds.length}`);
  return { holding: getHolding(id), cart };
}

async function readJsonBody(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > 1024 * 1024) throw errorWithStatus('Request body is too large.', 413);
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw errorWithStatus('Request body must be valid JSON.', 400);
  }
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function getSchedulerStatus() {
  const due = db.prepare(`
    SELECT COUNT(*) AS c FROM holdings
    WHERE auto_enabled = 1 AND status NOT IN ('stopped','removed','removing')
    AND (next_run_at IS NULL OR next_run_at <= ?)
  `).get(nowIso());
  return {
    enabled: AUTOMATION_ENABLED,
    tickIntervalMs: TICK_INTERVAL_MS,
    dueCount: due?.c || 0,
    runningCount: runningJobs.size,
    lastTickAt: lastTickAt,
    lastTickResult: lastTickResult,
  };
}

async function handleApi(req, res, url) {
  const segments = url.pathname.split('/').filter(Boolean);
  if (req.method === 'GET' && url.pathname === '/api/config') {
    return sendJson(res, 200, {
      automationEnabled: AUTOMATION_ENABLED,
      cartAppendEnabled: ALLOW_CART_APPEND,
      placeId: PLACE_ID,
      visitId: VISIT_ID,
      tourId: TOUR_ID,
      defaultTicketId: DEFAULT_TICKET_ID,
      timezone: 'Europe/Madrid',
      tickIntervalMs: TICK_INTERVAL_MS,
      rebuyLeadSec: REBUY_LEAD_SEC,
      defaultRepeatMinutes: DEFAULT_REPEAT_MINUTES,
      defaultRepeatOffsetSec: DEFAULT_REPEAT_OFFSET_SEC,
      retentionDays: LOG_RETENTION_DAYS,
      runsPerHolding: RUNS_PER_HOLDING,
      passwordProtected: Boolean(DASHBOARD_PASSWORD),
    });
  }
  if (req.method === 'GET' && url.pathname === '/api/health') {
    return sendJson(res, 200, { ok: true, automationEnabled: AUTOMATION_ENABLED, database: 'sqlite', scheduler: getSchedulerStatus() });
  }
  if (req.method === 'GET' && url.pathname === '/api/holdings') {
    return sendJson(res, 200, { holdings: listHoldings(), scheduler: getSchedulerStatus() });
  }
  if (req.method === 'GET' && url.pathname === '/api/activity') {
    const limit = Math.min(200, Math.max(10, toInt(url.searchParams.get('limit'), 80)));
    const events = db.prepare('SELECT * FROM api_events ORDER BY id DESC LIMIT ?').all(limit);
    const checks = db.prepare('SELECT * FROM availability_checks ORDER BY id DESC LIMIT ?').all(limit);
    return sendJson(res, 200, { events, checks, scheduler: getSchedulerStatus() });
  }
  if (req.method === 'GET' && url.pathname === '/api/logs') {
    const limit = Math.min(500, Math.max(20, toInt(url.searchParams.get('limit'), 150)));
    let lines = [];
    try {
      const { readFileSync, existsSync } = await import('node:fs');
      const file = join(LOG_DIR, `dashboard-${new Date().toISOString().slice(0, 10)}.log`);
      if (existsSync(file)) lines = readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(-limit);
    } catch { /* ignore */ }
    return sendJson(res, 200, { lines });
  }
  if (req.method === 'POST' && url.pathname === '/api/availability') {
    const body = await readJsonBody(req);
    return sendJson(res, 200, await fetchAvailability(String(body.date || '')));
  }
  if (req.method === 'POST' && url.pathname === '/api/holdings') {
    const body = await readJsonBody(req);
    const holding = await createHolding(body);
    logLine(`CREATE #${holding.id}: ${body.date} ${body.time} occ=${body.timetableId} qty=${body.quantity} auto=${Boolean(body.autoEnabled)}`);
    // Like auto-cart/add.js: creating a holding must immediately try cart/add,
    // not stay as a draft waiting for a manual "Add now" click.
    const wantAuto = Boolean(body.autoEnabled);
    const repeatMinutes = Number(body.repeatMinutes || DEFAULT_REPEAT_MINUTES) || DEFAULT_REPEAT_MINUTES;
    const repeatOffsetSec = toInt(body.repeatOffsetSec, DEFAULT_REPEAT_OFFSET_SEC);
    if (wantAuto) {
      updateHolding(holding.id, {
        auto_enabled: 1,
        repeat_minutes: repeatMinutes,
        repeat_offset_sec: repeatOffsetSec,
        status: 'scheduled',
        next_run_at: nowIso(),
        stopped_at: null,
        last_error: null,
      });
    }
    try {
      const added = await addInitialCart(holding.id, 'initial');
      // addInitialCart sets status manual_hold + next_run_at +30m; if auto, use repeat interval instead.
      if (wantAuto) {
        const nextRun = new Date(Date.now() + repeatMinutes * 60 * 1000 + repeatOffsetSec * 1000).toISOString();
        updateHolding(holding.id, { next_run_at: nextRun });
        return sendJson(res, 201, { holding: getHolding(holding.id) });
      }
      return sendJson(res, 201, { holding: added });
    } catch (error) {
      // addInitialCart already stored status (no_availability/failed/partial) + last_error.
      // For auto holdings, schedule a retry instead of leaving next_run_at in the past.
      if (wantAuto) {
        const delaySec = /NO_CAPACITY|FULLY|already_booked|closed|time_not_found|date_not_found|HTTP 40[39]|No tickets/i.test(error.message || '')
          ? RETRY_BOOKED_SEC
          : RETRY_FAILED_SEC;
        try {
          updateHolding(holding.id, {
            next_run_at: new Date(Date.now() + delaySec * 1000).toISOString(),
            last_error: error.message,
          });
        } catch { /* ignore */ }
      }
      const status = Number.isInteger(error.status) ? error.status : 409;
      return sendJson(res, status, { error: error.message || 'Add to cart failed.', holding: getHolding(holding.id), details: error.details || undefined });
    }
  }
  if (req.method === 'POST' && url.pathname === '/api/automation/start') {
    AUTOMATION_ENABLED = true;
    logLine('SCHEDULER: automation enabled via UI');
    return sendJson(res, 200, { scheduler: getSchedulerStatus() });
  }
  if (req.method === 'POST' && url.pathname === '/api/automation/stop') {
    AUTOMATION_ENABLED = false;
    logLine('SCHEDULER: automation disabled via UI');
    return sendJson(res, 200, { scheduler: getSchedulerStatus() });
  }
  if (segments[0] === 'api' && segments[1] === 'holdings' && segments[2]) {
    const id = parseId(segments[2]);
    if (req.method === 'GET' && segments.length === 3) return sendJson(res, 200, { holding: getHolding(id) });
    if (req.method === 'GET' && segments[3] === 'cart') {
      const result = await refreshCartState(id);
      return sendJson(res, 200, result);
    }
    if (req.method === 'POST' && segments[3] === 'add') return sendJson(res, 200, { holding: await addInitialCart(id, 'manual') });
    if (req.method === 'POST' && segments[3] === 'enable-auto') {
      const h = getHolding(id);
      if (h.status === 'removed') throw errorWithStatus('Removed holdings cannot be re-enabled.', 409);
      const body = await readJsonBody(req);
      updateHolding(id, {
        auto_enabled: 1,
        repeat_minutes: Number(body.repeatMinutes || DEFAULT_REPEAT_MINUTES),
        repeat_offset_sec: toInt(body.repeatOffsetSec, DEFAULT_REPEAT_OFFSET_SEC),
        status: 'scheduled',
        next_run_at: nowIso(),
        stopped_at: null,
        last_error: null,
      });
      logLine(`HOLDING #${id}: auto enabled`);
      return sendJson(res, 200, { holding: getHolding(id) });
    }
    if (req.method === 'POST' && segments[3] === 'disable-auto') {
      updateHolding(id, { auto_enabled: 0, next_run_at: null });
      logLine(`HOLDING #${id}: auto disabled`);
      return sendJson(res, 200, { holding: getHolding(id) });
    }
    if (req.method === 'POST' && segments[3] === 'stop') {
      const holding = getHolding(id);
      if (holding.status === 'removed') throw errorWithStatus('Removed holdings cannot be stopped.', 409);
      updateHolding(id, { status: 'stopped', auto_enabled: 0, next_run_at: null, stopped_at: nowIso(), last_error: null });
      logLine(`HOLDING #${id}: stopped`);
      return sendJson(res, 200, { holding: getHolding(id) });
    }
    if (req.method === 'POST' && segments[3] === 'remove') {
      const out = await removeHolding(id);
      logLine(`HOLDING #${id}: remove endpoint done -> ${out.status}`);
      return sendJson(res, 200, { holding: out });
    }
  }
  return sendJson(res, 404, { error: 'Route not found.' });
}

const runningJobs = new Set();
let lastTickAt = null;
let lastTickResult = 'never ran';

function retryDelayFor(status, message) {
  const msg = `${status} ${message || ''}`;
  if (/NO_CAPACITY|FULLY|already_booked|closed|time_not_found|date_not_found|HTTP 40[39]/i.test(msg)) return RETRY_BOOKED_SEC;
  if (/429|5\d\d|api_error|network|fetch|502|503/i.test(msg)) return RETRY_API_SEC;
  return RETRY_FAILED_SEC;
}

// Daily retention sweep for audit tables (at most once per 24h, tracked in
// scheduler_state). Timestamps are ISO (YYYY-MM-DDTHH:MM:SS...), so compare
// on the first 19 chars with T normalized to a space.
function maybePrune() {
  try {
    const last = db.prepare(`SELECT value FROM scheduler_state WHERE key = 'last_prune'`).get();
    if (last && Date.now() - Date.parse(last.value) < 24 * 60 * 60 * 1000) return;
    const cutoff = `-${LOG_RETENTION_DAYS} days`;
    const events = db.prepare(`DELETE FROM api_events WHERE replace(substr(created_at, 1, 19), 'T', ' ') < datetime('now', ?)`).run(cutoff);
    const checks = db.prepare(`DELETE FROM availability_checks WHERE replace(substr(checked_at, 1, 19), 'T', ' ') < datetime('now', ?)`).run(cutoff);
    const runs = db.prepare(`DELETE FROM runs WHERE id IN (
      SELECT id FROM (SELECT id, ROW_NUMBER() OVER (PARTITION BY holding_id ORDER BY id DESC) AS rn FROM runs)
      WHERE rn > ?
    )`).run(RUNS_PER_HOLDING);
    db.prepare(`INSERT INTO scheduler_state (key, value, updated_at) VALUES ('last_prune', ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run(nowIso(), nowIso());
    if ((events.changes || 0) + (checks.changes || 0) + (runs.changes || 0) > 0) {
      logLine(`PRUNE: events -${events.changes}, checks -${checks.changes}, runs -${runs.changes} (older than ${LOG_RETENTION_DAYS}d / cap ${RUNS_PER_HOLDING}/holding)`);
    }
  } catch (e) {
    logLine(`PRUNE fail: ${e.message}`);
  }
}

async function schedulerTick() {
  lastTickAt = nowIso();
  maybePrune();
  if (!AUTOMATION_ENABLED) {
    lastTickResult = 'automation disabled - skipping';
    return;
  }
  let due = [];
  try {
    due = db.prepare(`
      SELECT * FROM holdings
      WHERE auto_enabled = 1 AND status NOT IN ('stopped','removed','removing')
      AND (next_run_at IS NULL OR next_run_at <= ?)
      ORDER BY next_run_at ASC LIMIT 5
    `).all(nowIso());
  } catch (e) {
    lastTickResult = `db error: ${e.message}`;
    return;
  }
  if (!due.length) {
    // also re-queue expired carts slightly before expiry
    try {
      const expiring = db.prepare(`
        SELECT * FROM holdings WHERE auto_enabled = 1 AND status = 'manual_hold'
        AND expires_at IS NOT NULL AND datetime(expires_at) <= datetime('now', ?)
        LIMIT 5
      `).all(`+${REBUY_LEAD_SEC} seconds`);
      due = expiring;
    } catch { /* ignore */ }
  }
  if (!due.length) {
    lastTickResult = 'no due holdings';
    return;
  }
  for (const h of due) {
    if (runningJobs.has(h.id)) continue;
    runningJobs.add(h.id);
    try {
      const fresh = getHolding(h.id);
      const repeatMin = Number(fresh.repeat_minutes || DEFAULT_REPEAT_MINUTES);
      const offsetSec = toInt(fresh.repeat_offset_sec, DEFAULT_REPEAT_OFFSET_SEC);
      db.prepare('UPDATE holdings SET status=?, run_count=run_count+1, updated_at=? WHERE id=?').run('running', nowIso(), h.id);
      const result = await addInitialCart(h.id, 'auto');
      const nextRun = new Date(Date.now() + repeatMin * 60 * 1000 + offsetSec * 1000).toISOString();
      updateHolding(h.id, { next_run_at: nextRun });
      lastTickResult = `holding #${h.id} ok -> next ${nextRun}`;
      logLine(`TICK holding #${h.id} ok -> next ${nextRun}`);
      recordEvent({ holdingId: h.id, endpoint: '/scheduler/tick', method: 'TICK', statusCode: 200, request: { repeatMin }, response: { cart: result.remote_cart_id, nextRun } });
    } catch (e) {
      const status = e.status === 409 ? 'booked' : 'failed';
      const delaySec = retryDelayFor(status, e.message);
      const nextRun = new Date(Date.now() + delaySec * 1000).toISOString();
      try { updateHolding(h.id, { next_run_at: nextRun, last_error: e.message }); } catch { /* ignore */ }
      lastTickResult = `holding #${h.id} ${status}: ${e.message} -> retry ${delaySec}s`;
      logLine(`TICK holding #${h.id} ${status}: ${e.message} -> retry ${delaySec}s`);
    } finally {
      runningJobs.delete(h.id);
    }
  }
}

setInterval(() => { schedulerTick().catch((e) => { lastTickResult = `tick fatal: ${e.message}`; }); }, TICK_INTERVAL_MS);

const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

async function serveStatic(req, res, url) {
  const requested = url.pathname === '/' ? '/index.html' : url.pathname;
  const filePath = resolve(PUBLIC_DIR, `.${normalize(requested)}`);
  const publicRoot = resolve(PUBLIC_DIR);
  if (filePath !== publicRoot && !filePath.startsWith(`${publicRoot}/`) && !filePath.startsWith(`${publicRoot}\\`)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  // SPA deep links for holdings: /h/:id (holding) and /:occId (latest holding
  // for a timetable). Real URLs — refreshable, shareable — client resolves them.
  if (/^\/(h\/)?\d+\/?$/.test(url.pathname)) {
    try {
      const body = await readFile(join(PUBLIC_DIR, 'index.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      return res.end(body);
    } catch { /* fall through to 404 */ }
  }
  try {
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) throw new Error('Not a file');
    const body = await readFile(filePath);
    res.writeHead(200, {
      'Content-Type': contentTypes[extname(filePath)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    return res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Not found');
  }
}

// Returns true to continue to the app, false when it already responded.
async function guardAuth(req, res, url) {
  if (url.pathname === '/api/login' && req.method === 'POST') {
    const body = await readJsonBody(req);
    if (!checkPassword(body.password)) {
      logLine('AUTH web login failed');
      return (sendJson(res, 401, { error: 'Wrong password.' }), false);
    }
    if (sessions.size > 500) sessions.clear();
    const token = randomBytes(32).toString('hex');
    sessions.add(token);
    logLine('AUTH web login ok');
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Set-Cookie': `dash_session=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=2592000`,
    });
    res.end(JSON.stringify({ ok: true }));
    return false;
  }
  if (url.pathname === '/api/logout' && req.method === 'POST') {
    sessions.delete(parseCookies(req).dash_session);
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Set-Cookie': 'dash_session=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0',
    });
    res.end(JSON.stringify({ ok: true }));
    return false;
  }
  if (webAuthed(req)) {
    if (url.pathname === '/login.html') {
      res.writeHead(302, { Location: '/' });
      res.end();
      return false;
    }
    return true;
  }
  if (url.pathname.startsWith('/api/')) {
    sendJson(res, 401, { error: 'Login required.' });
    return false;
  }
  // Public assets (css/js/images/fonts) must load without a session,
  // otherwise the login page itself renders unstyled.
  if (['.css', '.js', '.svg', '.ico', '.png', '.jpg', '.webp', '.woff', '.woff2', '.ttf', '.map'].includes(extname(url.pathname))) {
    return true;
  }
  if (url.pathname !== '/login.html') {
    res.writeHead(302, { Location: '/login.html' });
    res.end();
    return false;
  }
  return true;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  try {
    if (DASHBOARD_PASSWORD && !(await guardAuth(req, res, url))) return;
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    return await serveStatic(req, res, url);
  } catch (error) {
    console.error(error);
    logLine(`API ${req.method} ${url.pathname} -> ${Number.isInteger(error.status) ? error.status : 500}: ${error.message || 'error'}`);
    const status = Number.isInteger(error.status) ? error.status : 500;
    return sendJson(res, status, { error: error.message || 'Internal server error.', details: error.details || undefined });
  }
});

server.listen(PORT, () => {
  logLine(`START port=${PORT} db=${DB_PATH}`);
  logLine(`START automation=${AUTOMATION_ENABLED} tick=${TICK_INTERVAL_MS}ms append=${ALLOW_CART_APPEND} repeat=${DEFAULT_REPEAT_MINUTES}m+${DEFAULT_REPEAT_OFFSET_SEC}s rebuyLead=${REBUY_LEAD_SEC}s`);
  if (!API_KEY) logLine('WARN: SERVITICKETS_API_KEY is missing — set it in dashboard/.env');
  logLine(`START web password=${DASHBOARD_PASSWORD ? 'ON' : 'OFF'}`);
  console.log(`Ticket dashboard: http://localhost:${PORT}`);
  console.log(`SQLite database: ${DB_PATH}`);
  console.log(`Automation enabled: ${AUTOMATION_ENABLED} (tick ${TICK_INTERVAL_MS}ms)`);
  console.log(`Cart append enabled: ${ALLOW_CART_APPEND}`);
  console.log(`Repeat default: ${DEFAULT_REPEAT_MINUTES}m + ${DEFAULT_REPEAT_OFFSET_SEC}s | rebuy lead ${REBUY_LEAD_SEC}s`);
  console.log(`Log file: ${LOG_DIR}`);
});

function shutdown() {
  server.close(() => {
    db.close();
    process.exit(0);
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
