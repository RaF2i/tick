// Same flow as auto-cart/add.js: date -> slots -> occupation -> qty -> chunks -> cart.
// Responsive edition: skeletons, button spinners, promise confirms, silent background polls.
const state = { config: null, slots: [], slot: null, holdings: [], scheduler: null, holding: null, booted: false, loadingHoldings: false, holdingsEverLoaded: false, holdingsFailed: false, reloadQueued: false, ui: { q: '', group: 'none' } };
const $ = (s) => document.querySelector(s);
const dateInput = $('#dateInput');
const slotGrid = $('#slotGrid'), slotState = $('#slotState');
const addDrawer = $('#addDrawer'), slotForm = $('#slotForm'), slotConfirmBlock = $('#slotConfirmBlock');
const slotQty = $('#slotQty'), slotAuto = $('#slotAuto'), slotRepeat = $('#slotRepeat');
const slotStopDate = $('#slotStopDate'), slotStopTime = $('#slotStopTime');
const slotConfirmBtn = $('#slotConfirm');
const holdingPage = $('#holdingPage'), listView = $('#listView');
const confirmDialog = $('#confirmDialog');

// ---- Drawer (ADD TO CART) open/close ----
// The drawer is the whole add-to-cart flow, so it is only ever dismissed
// through these helpers — that keeps the exit animation and the scrim/Esc
// behaviour on one path instead of three.
let drawerCloseTimer = null;
function openAddDrawer() {
  if (drawerCloseTimer) { clearTimeout(drawerCloseTimer); drawerCloseTimer = null; }
  addDrawer.classList.remove('closing');
  if (!addDrawer.open) addDrawer.showModal();
}
function closeAddDrawer() {
  if (!addDrawer.open) return;
  clearTimeout(drawerCloseTimer);
  addDrawer.classList.add('closing');
  drawerCloseTimer = setTimeout(() => {
    drawerCloseTimer = null;
    addDrawer.classList.remove('closing');
    try { if (addDrawer.open) addDrawer.close(); } catch { /* ignore */ }
  }, 180);
}
function resetSlotConfirm() {
  state.slot = null;
  slotConfirmBlock?.classList.add('hidden');
  slotConfirmBtn.disabled = true;
  $('#step3')?.classList.remove('active');
  $('#slotError')?.classList.add('hidden');
  if ($('#slotChunks')) $('#slotChunks').innerHTML = '';
}

function esc(v) { return String(v ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;'); }

// Inline stroke-icon set (no dependency, inherits text color)
const _svg = '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">';
const I = {
  plus: _svg + '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>',
  eye: _svg + '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>',
  refresh: _svg + '<polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>',
  zap: _svg + '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>',
  clock: _svg + '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>',
  ticket: _svg + '<path d="M2 9a3 3 0 0 1 0 6v2a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-2a3 3 0 0 1 0-6V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2Z"/><path d="M13 5v2"/><path d="M13 11v2"/><path d="M13 17v2"/></svg>',
  lock: _svg + '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>',
  copy: _svg + '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
  layers: _svg + '<polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/></svg>',
  activity: _svg + '<polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>',
  check: _svg + '<polyline points="20 6 9 17 4 12"/></svg>',
  x: _svg + '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
  info: _svg + '<circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>',
  play: _svg + '<polygon points="5 3 19 12 5 21 5 3"/></svg>',
  pause: _svg + '<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>',
  grid: _svg + '<rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/></svg>',
  search: _svg + '<circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>',
  calendar: _svg + '<rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>',
};

const ICONS = { info: I.info, success: I.check, error: I.x };
function showNotice(m, t = 'info') {
  const box = $('#toasts');
  while (box.children.length >= 4) box.firstChild.remove();
  const el = document.createElement('div');
  el.className = `toast toast-${t}`;
  el.innerHTML = `<span class="toast-icon">${ICONS[t] || ICONS.info}</span><span>${esc(m)}</span>`;
  el.addEventListener('click', () => el.remove());
  box.appendChild(el);
  setTimeout(() => { el.classList.add('toast-out'); setTimeout(() => el.remove(), 250); }, t === 'error' ? 7000 : 4500);
}

// fetch with timeout + offline-friendly errors
async function api(p, o = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 25000);
  try {
    const r = await fetch(p, { headers: { 'Content-Type': 'application/json' }, signal: ctrl.signal, ...o });
    const j = await r.json().catch(() => ({}));
    if (r.status === 401) handleAuthError(p);
    if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
    return j;
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('Request timed out — server may be busy. Try again.');
    if (e instanceof TypeError) throw new Error('Cannot reach the controller — is the server running?');
    throw e;
  } finally { clearTimeout(timer); }
}

// Session expired (or logged out elsewhere) → back to the login page.
function handleAuthError(p) {
  if (!String(p || '').includes('/api/login') && !location.pathname.startsWith('/login')) {
    location.href = '/login.html';
    throw new Error('Session expired — login again.');
  }
}

// Button loading helper: preserves label, shows spinner, blocks double-clicks
function setBtn(btn, loading, loadingText) {
  if (!btn) return;
  if (loading) {
    if (btn.dataset.loading === 'true') return;
    btn.dataset.loading = 'true';
    btn.dataset.label = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = `<span class="btn-spinner"></span><span>${esc(loadingText || 'Working…')}</span>`;
  } else {
    btn.dataset.loading = 'false';
    if (btn.dataset.label != null) btn.innerHTML = btn.dataset.label;
    btn.disabled = false;
  }
}

function chunksFor(q) { const c = []; let x = Math.max(0, Math.floor(Number(q) || 0)); while (x > 0) { c.push(Math.min(30, x)); x -= Math.min(30, x); } return c; }

// All times are shown in Spain (Europe/Madrid) regardless of the viewer's
// device timezone — the venue and the cutoff rules are Spanish.
const TZ = 'Europe/Madrid';
const TZ_SHORT = 'Spain';
function fmtD(d) { if (!d) return '—'; return new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short' }).format(new Date(d + 'T12:00:00')); }
function fmtDT(v) {
  if (!v) return '—';
  const d = new Date(v);
  if (isNaN(d)) return v;
  return new Intl.DateTimeFormat('en-GB', { timeZone: TZ, day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(d);
}
// ISO instant -> { date: 'YYYY-MM-DD', time: 'HH:MM' } in Spain wall clock.
function madridParts(v) {
  if (!v) return null;
  const d = new Date(v);
  if (isNaN(d)) return null;
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(d);
  const o = {};
  for (const x of p) if (x.type !== 'literal') o[x.type] = x.value;
  return { date: `${o.year}-${o.month}-${o.day}`, time: `${o.hour}:${o.minute}` };
}
function dayBeforeStr(dateStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || ''));
  if (!m) return '';
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) - 86400000).toISOString().slice(0, 10);
}
function fmtT(t) { if (!t) return '—'; return /^\d{2}:\d{2}$/.test(t) ? `${t}:00` : t; }

// Server log lines start with a UTC ISO stamp — render it in Spain time.
function localizeLogLine(line) {
  return String(line ?? '').replace(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/,
    (m) => {
      const d = new Date(m);
      if (isNaN(d)) return m;
      return new Intl.DateTimeFormat('en-GB', { timeZone: TZ, day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(d);
    },
  );
}

// Native date/time inputs render in the *browser's* locale (US 10/09/2026,
// 09:00 PM), which is ambiguous. Everything below spells the moment out in
// plain European form so the auto stop is never misread.
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function fmtDateLong(dateStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || ''));
  if (!m) return '—';
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (Number.isNaN(d.getTime())) return '—';
  return `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}
// Mirror of the server's Madrid wall-clock -> instant conversion (DST-safe).
function madridOffsetMinutes(instantMs) {
  const p = new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(instantMs));
  const o = {};
  for (const x of p) if (x.type !== 'literal') o[x.type] = x.value;
  const asUtc = Date.UTC(Number(o.year), Number(o.month) - 1, Number(o.day), Number(o.hour) % 24, Number(o.minute), Number(o.second));
  return Math.round((asUtc - instantMs) / 60000);
}
function madridWallToMs(dateStr, timeStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || ''));
  const t = /^(\d{2}):(\d{2})/.exec(String(timeStr || ''));
  if (!m || !t) return NaN;
  const wall = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(t[1]), Number(t[2]));
  if (Number.isNaN(wall)) return NaN;
  let ts = wall - madridOffsetMinutes(wall) * 60000;
  return wall - madridOffsetMinutes(ts) * 60000;
}
function relFromNow(ms) {
  if (!Number.isFinite(ms)) return '—';
  const diff = ms - Date.now();
  const past = diff <= 0;
  let s = Math.abs(diff) / 1000;
  const days = Math.floor(s / 86400); s -= days * 86400;
  const hours = Math.floor(s / 3600); s -= hours * 3600;
  const mins = Math.floor(s / 60);
  const bits = [];
  if (days) bits.push(`${days} day${days === 1 ? '' : 's'}`);
  if (hours) bits.push(`${hours} h`);
  if (!days && mins) bits.push(`${mins} min`);
  if (!bits.length) bits.push('under a minute');
  return past ? `${bits.join(' ')} ago` : `in ${bits.join(' ')}`;
}
// Single source of truth for "when does auto stop" text.
function stopWhen(dateStr, timeStr, isDefault) {
  const ms = madridWallToMs(dateStr, timeStr);
  if (!Number.isFinite(ms)) return { valid: false, when: 'Pick a date and time', rel: '—', ms: NaN, past: false };
  return {
    valid: true,
    ms,
    past: ms <= Date.now(),
    when: `${fmtDateLong(dateStr)} at ${timeStr} (Spain)`,
    rel: relFromNow(ms),
    tag: isDefault ? 'default rule' : 'custom',
  };
}

// Live countdown text for a next_run_at timestamp
function countdownText(iso) {
  if (!iso) return '—';
  const diff = new Date(iso).getTime() - Date.now();
  if (Number.isNaN(diff)) return '—';
  if (diff <= 0) return 'due now';
  const s = Math.floor(diff / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const pad = (n) => String(n).padStart(2, '0');
  if (h > 0) return `in ${h}h ${pad(m)}m`;
  return `in ${pad(m)}:${pad(sec)}`;
}
// Refresh every [data-next] countdown on the page each second (no re-render)
function tickCountdowns() {
  document.querySelectorAll('[data-next]').forEach((el) => {
    el.textContent = countdownText(el.dataset.next);
  });
  document.querySelectorAll('[data-stop-when]').forEach((el) => {
    el.textContent = relFromNow(Number(el.dataset.stopWhen));
  });
}

// Resolve qty like add.js: empty = take all, else whole number 1..avail capped.
function resolveQty(raw, avail) {
  const s = String(raw ?? '').trim();
  if (s === '') return avail;
  if (!/^\d+$/.test(s)) throw new Error(`Quantity must be a whole number or empty (got '${raw}')`);
  const n = Number(s);
  if (n < 1) throw new Error('Quantity must be 1 or more, or empty for take-all.');
  return Math.min(n, avail);
}

// ---- Skeletons ----
function skeletonSlots(n = 6) {
  slotGrid.innerHTML = Array.from({ length: n }, () => `
    <div class="slot-card skel-card">
      <div class="skel skel-line big w60"></div>
      <div class="skel skel-line w40"></div>
      <div class="skel skel-line w60"></div>
      <div class="skel skel-btn"></div>
    </div>`).join('');
}
function skeletonHoldings() {
  const body = $('#holdingsTable tbody');
  body.innerHTML = Array.from({ length: 3 }, () => `
    <tr><td><div class="skel skel-line big"></div><div class="skel skel-line w60" style="margin-top:8px"></div></td>
    <td><div class="skel skel-line" style="width:80px"></div></td>
    <td><div class="skel skel-line" style="width:60px;margin-left:auto"></div></td></tr>`).join('');
  $('#nextUp').innerHTML = `<div class="skel skel-line big"></div><div class="skel skel-line"></div>`;
}

// Past dates are locked — holdings can only start from today onwards.
function todayStr() { return new Date().toISOString().slice(0, 10); }
function lockDateInput() {
  const t = todayStr();
  dateInput.min = t;
  if (!dateInput.value || dateInput.value < t) dateInput.value = t;
}
// ---- New flow: 1 date -> 2 slots ----
async function loadAvail() {
  if (!dateInput.value) return showNotice('Pick a date first.', 'error');
  lockDateInput();
  if (dateInput.value < dateInput.min) return showNotice('Past dates are locked — pick today or a future date.', 'error');
  const b = $('#loadAvailability');
  setBtn(b, true, 'Checking…');
  dateInput.disabled = true;
  skeletonSlots();
  slotState.innerHTML = `<span class="slot-count">Checking availability for <strong>${esc(dateInput.value)}</strong>…</span>`;
  $('#step1').classList.add('active'); $('#step2').classList.add('active');
  try {
    const d = await api('/api/availability', { method: 'POST', body: JSON.stringify({ date: dateInput.value }) });
    renderSlots(d);
    showNotice(`Loaded ${d.timetables?.length || 0} slots.`, 'success');
  } catch (e) {
    slotGrid.innerHTML = '';
    slotState.innerHTML = `<div class="inline-error"><span>${esc(e.message)}</span><button class="button button-secondary button-small" id="retryAvail" type="button">Retry</button></div>`;
    $('#retryAvail')?.addEventListener('click', loadAvail);
    showNotice(e.message, 'error');
  } finally { setBtn(b, false); dateInput.disabled = false; }
}

function renderSlots(d) {
  state.slots = d.timetables || [];
  if (d.closed) { slotGrid.innerHTML = ''; slotState.textContent = `Closed: ${d.closed.description || 'closed by provider'}`; return; }
  if (d.missing) { slotGrid.innerHTML = ''; slotState.textContent = 'Date has no sales in the calendar.'; return; }
  if (!state.slots.length) { slotGrid.innerHTML = ''; slotState.textContent = 'No slots for this date.'; return; }
  const open = state.slots.filter((s) => s.active && Number(s.availables) > 0).length;
  slotState.innerHTML = `<span class="slot-count"><strong>${state.slots.length}</strong> slots · <strong>${open}</strong> open</span>`;
  slotGrid.innerHTML = state.slots.map((s) => {
    const a = Number(s.availables || 0);
    const ok = s.active && a > 0;
    const st = !s.active ? 'Off' : a === 0 || s.fullyBooked ? 'Full' : 'Open';
    return `<div class="slot-card" data-card="${s.id}">
      <strong>${esc(s.start)}</strong>
      <span class="slot-avail">${a} avail · cap ${s.capacity}</span>
      <span class="status-badge status-${st === 'Open' ? 'open' : st === 'Full' ? 'danger' : 'muted'}">${st}</span>
      <div class="slot-actions">
        <button class="button button-primary button-small" type="button" data-slot="${s.id}" ${ok ? '' : 'disabled'}>${I.plus}Add to cart</button>
      </div>
    </div>`;
  }).join('');
}

// ---- Drawer step 3: confirm (qty + auto option before Add to cart) ----
function openSlotDialog(slot) {
  state.slot = slot;
  $('#slotTitle').textContent = `${dateInput.value} ${slot.start}`;
  $('#slotMeta').textContent = `OccID ${slot.id} · sold ${slot.sold} · ${slot.availables} available`;
  $('#slotAvailHint').textContent = slot.availables;
  slotQty.value = '';
  slotQty.max = slot.availables;
  slotQty.placeholder = `empty = take all ${slot.availables}`;
  slotAuto.checked = true;
  slotRepeat.disabled = false;
  slotRepeat.value = state.config?.defaultRepeatMinutes || 30;
  // Auto stop defaults to 21:00 Spain on the day before the slot date.
  setDefaultStopInputs();
  syncStopInputs();
  $('#slotError').classList.add('hidden');
  renderSlotChunks();
  $('#step3').classList.add('active');
  slotConfirmBlock.classList.remove('hidden');
  slotConfirmBtn.disabled = false;
  openAddDrawer();
  setTimeout(() => slotQty.focus(), 60);
}

function defaultStopHour() {
  const h = Number(state.config?.autoStopHourMadrid);
  return String(Number.isInteger(h) && h >= 0 && h <= 23 ? h : 21).padStart(2, '0');
}
function setDefaultStopInputs() {
  const date = dayBeforeStr(dateInput.value);
  $('#slotStopDate').value = date;
  $('#slotStopTime').value = `${defaultStopHour()}:00`;
  updateStopHint();
}
function updateStopHint() {
  const d = $('#slotStopDate').value, t = $('#slotStopTime').value;
  const hint = $('#slotStopHint');
  const info = stopWhen(d, t, false);
  if (!info.valid) { hint.textContent = 'Pick a Spain date + time for the auto stop.'; return; }
  hint.innerHTML = info.past
    ? `<span class="error-text">${esc(info.when)} has already passed — auto will park immediately as Auto-stopped.</span>`
    : `Auto re-add stops <strong>${esc(info.when)}</strong> <span class="countdown" data-stop-when="${info.ms}">${esc(info.rel)}</span> and the holding is tagged <strong>Auto-stopped</strong>. Editable later from the holding page.`;
}
function syncStopInputs() {
  const on = slotAuto.checked;
  $('#slotStopDate').disabled = !on;
  $('#slotStopTime').disabled = !on;
  $('#slotStopDefault').disabled = !on;
  $('#slotStopDate').closest('.stop-block').classList.toggle('disabled', !on);
  updateStopHint();
}

function renderSlotChunks() {
  const err = $('#slotError');
  if (!state.slot) return 0;
  try {
    const q = resolveQty(slotQty.value, Number(state.slot.availables));
    if (!q) throw new Error('Nothing to take.');
    const c = chunksFor(q);
    $('#slotChunks').innerHTML = `<div class="chunk-line">Taking <strong>${q}</strong> in ${c.length} request(s): <strong>[${c.join(' + ')}]</strong></div>`;
    err.classList.add('hidden');
    slotConfirmBtn.disabled = false;
    return q;
  } catch (e) {
    $('#slotChunks').innerHTML = '';
    err.textContent = e.message;
    err.classList.remove('hidden');
    slotConfirmBtn.disabled = true;
    return 0;
  }
}

async function confirmSlot(e) {
  if (e.submitter?.value === 'cancel') return;
  e.preventDefault();
  lockDateInput();
  if (dateInput.value < dateInput.min) return showNotice('Past dates are locked — pick today or a future date.', 'error');
  const q = renderSlotChunks();
  if (!q) return;
  const stopDate = slotStopDate.value, stopTime = slotStopTime.value;
  if (slotAuto.checked && (!stopDate || !stopTime)) {
    const el = $('#slotError');
    el.textContent = 'Pick the Spain date + time for the auto stop (or turn auto off).';
    el.classList.remove('hidden');
    return;
  }
  const btn = $('#slotConfirm');
  setBtn(btn, true, 'Adding…');
  slotForm.dataset.busy = 'true';
  try {
    const d = await api('/api/holdings', {
      method: 'POST',
      body: JSON.stringify({
        date: dateInput.value, time: state.slot.start, timetableId: state.slot.id,
        ticketId: state.config?.defaultTicketId || 34, quantity: q,
        autoEnabled: slotAuto.checked, repeatMinutes: Number(slotRepeat.value) || 30,
        autoStopDate: slotAuto.checked ? stopDate : null,
        autoStopTime: slotAuto.checked ? stopTime : null,
      }),
    });
    addDrawer.close();
    resetSlotConfirm();
    const h = d.holding;
    const inCart = (h.cartItems || []).reduce((a, i) => a + Number(i.quantity || 0), 0);
    const stopTxt = slotAuto.checked ? ` Auto stops ${h.auto_stop_madrid}.` : '';
    showNotice(`Added ${inCart || q} tickets to cart ${h.remote_cart_id ? h.remote_cart_id.slice(0, 8) + '…' : ''}${slotAuto.checked ? ' + auto re-add ON' : ''}.${stopTxt}`, 'success');
    await loadHoldings({ silent: true });
  } catch (err) {
    const el = $('#slotError'); el.textContent = err.message; el.classList.remove('hidden');
    slotConfirmBtn.disabled = false; // the form is still valid — let the user retry
    await loadHoldings({ silent: true });
  } finally { setBtn(btn, false); slotForm.dataset.busy = 'false'; }
}

// ---- Holdings + detail dialog ----
const TERMINAL = ['stopped', 'auto_stopped', 'removed'];
const isTerminal = (h) => TERMINAL.includes(h.status);
const activeItemsOf = (h) => (h.cartItems || []).filter((i) => i.status === 'active');
// The list endpoint sends pre-aggregated active totals (it omits cartItems to
// keep the payload small); fall back to counting items for a full record.
const activeQtyOf = (h) => (h.active_quantity != null
  ? Number(h.active_quantity || 0)
  : activeItemsOf(h).reduce((a, i) => a + Number(i.quantity || 0), 0));
function badgeFor(status) {
  if (/manual_hold|running|scheduled/.test(status)) return 'open';
  if (/failed|partial|no_availability/.test(status)) return 'danger';
  if (/auto_stopped/.test(status)) return 'pending';
  if (/stopped|removed/.test(status)) return 'muted';
  return 'pending';
}

// Server status 'manual_hold' = "tickets are held upstream" — NOT manual mode.
// auto_enabled is a separate flag. Display a friendly label so AUTO holdings
// never read as "manual".
function statusLabel(status) {
  const map = {
    draft: 'Draft',
    scheduled: 'Scheduled',
    adding: 'Adding…',
    running: 'Running…',
    manual_hold: 'Holding',
    partial: 'Partial hold',
    failed: 'Failed',
    no_availability: 'No availability',
    append_unverified: 'Needs review',
    removing: 'Removing…',
    remove_failed: 'Remove failed',
    stopped: 'Stopped',
    auto_stopped: 'Auto-stopped',
    removed: 'Removed',
  };
  return map[status] || status;
}
function modeLabel(h) {
  return h.auto_enabled ? `AUTO · every ${h.repeat_minutes || 30}m` : 'Manual';
}

function renderHoldings() {
  const live = state.holdings.filter((h) => !isTerminal(h));
  $('#metricActive').textContent = live.length;
  $('#metricAdded').textContent = state.holdings
    .filter((h) => h.status !== 'removed')
    .reduce((a, h) => a + activeQtyOf(h), 0);
  const due = state.scheduler?.dueCount ?? 0;
  $('#metricDue').textContent = due;
  const tickTxt = state.scheduler ? `every ${Math.round((state.scheduler.tickIntervalMs || 15000) / 1000)}s` : '—';
  $('#tickInfo').textContent = tickTxt;
  $('#tickInfo').title = state.scheduler?.lastTickResult || '';
  $('#autoPill').textContent = `Auto: ${state.scheduler?.enabled ? 'ON' : 'OFF'}`;
  const autoBtn = $('#autoToggle');
  if (autoBtn.dataset.loading !== 'true') autoBtn.innerHTML = state.scheduler?.enabled ? `${I.pause}Stop auto` : `${I.play}Start auto`;
  const liveCount = live.length;
  const exec = state.scheduler?.runningCount ?? 0;
  $('#sideStatus').textContent = state.scheduler?.enabled
    ? `Auto ON · ${liveCount} holding${liveCount === 1 ? '' : 's'}${exec ? ` · ${exec} executing` : ''}`
    : (due > 0 ? `Auto OFF · ${due} due — start auto` : 'Manual mode');
  const sorted = [...live].sort((a, b) => String(a.next_run_at || '~').localeCompare(String(b.next_run_at || '~')));
  $('#nextUp').innerHTML = sorted.map((h) => {
    const when = h.auto_enabled ? (h.next_run_at ? `${fmtDT(h.next_run_at)} ${TZ_SHORT}` : 'scheduled') : 'manual — no runs';
    const live = h.auto_enabled && h.next_run_at && !isTerminal(h)
      ? `${I.clock}<span class="countdown" data-next="${esc(h.next_run_at)}" title="Next run ${esc(fmtDT(h.next_run_at))} ${TZ_SHORT}">${esc(countdownText(h.next_run_at))}</span>`
      : '';
    return `<div class="next-row">
      <div class="next-top"><strong>${esc(fmtD(h.local_date))} ${esc(h.local_time)}</strong><span class="next-actions"><span class="status-badge status-${badgeFor(h.status)}">${esc(statusLabel(h.status))}</span><button class="row-x" type="button" data-purge="${h.id}" title="Delete holding #${h.id}" aria-label="Delete holding #${h.id}, ${esc(fmtD(h.local_date))} ${esc(h.local_time)}">${I.x}</button></span></div>
      <span class="next-sub">OccID ${h.timetable_id} · ${esc(modeLabel(h))}</span>
      <span class="next-sub mono">${when}${live ? ` · ${live}` : ''} · stop ${esc(h.auto_stop_madrid || '—')}</span>
    </div>`;
  }).join('') || `<div class="empty-preview">${state.holdings.length ? 'No active holdings.' : 'No holdings yet — press + in the rail to start one.'}</div>`;
  const qc = $('#queueCount');
  if (qc) qc.textContent = `${liveCount} active`;
  renderHoldingsTable();
}

// Searchable haystack for one holding — date, time, status, ids, cart.
function holdingHay(h) {
  return [
    h.local_date, h.local_time, h.timetable_id, h.ticket_id, h.id,
    h.status, statusLabel(h.status), modeLabel(h),
    h.auto_stop_madrid, h.remote_cart_id, h.requested_quantity,
  ].filter((v) => v != null && v !== '').join(' ').toLowerCase();
}

function renderHoldingsTable() {
  const body = $('#holdingsTable tbody');
  if (!body) return;
  const q = String(state.ui.q || '').trim().toLowerCase();
  const all = state.holdings;
  const list = q ? all.filter((h) => holdingHay(h).includes(q)) : all;

  const clearBtn = $('#holdingsSearchClear');
  if (clearBtn) clearBtn.hidden = !q;
  const count = $('#holdingsCount');
  if (count) {
    count.innerHTML = `<span><strong>${list.length}</strong> of ${all.length} holding${all.length === 1 ? '' : 's'}</span>`
      + (q ? `<span class="filter-chip">${esc(q)}<button type="button" data-clear-filter aria-label="Clear search">${I.x}</button></span>` : '');
  }

  const emptyRow = (msg) => `<tr><td colspan="3" class="empty-cell">${esc(msg)}</td></tr>`;
  if (!list.length) {
    body.innerHTML = emptyRow(q ? `No holdings match “${q}”.` : 'No holdings yet.');
    return;
  }

  const rowFor = (h) => {
    const added = h.status === 'removed' ? 0 : activeQtyOf(h);
    const sub = isTerminal(h)
      ? `OccID ${h.timetable_id} · was ${h.requested_quantity} wanted · ${esc(statusLabel(h.status))}`
      : `OccID ${h.timetable_id} · want ${h.requested_quantity} · in cart ${added} · ${esc(modeLabel(h))}`;
    const xTitle = h.status === 'removed'
      ? 'Delete permanently'
      : `Delete this stale holding (#${h.id})`;
    return `<tr><td><strong>${fmtD(h.local_date)} ${esc(h.local_time)}</strong><span class="sub-cell">${sub}</span><span class="sub-cell">Auto stop ${esc(h.auto_stop_madrid || '—')}</span></td>
      <td><span class="status-badge status-${badgeFor(h.status)}">${esc(statusLabel(h.status))}</span></td>
      <td class="actions-cell"><button class="table-action" type="button" data-view="${h.id}">${I.eye}View</button><button class="table-action icon-only danger" data-purge="${h.id}" type="button" title="${esc(xTitle)}" aria-label="${esc(xTitle)}">${I.x}</button></td></tr>`;
  };

  if (state.ui.group !== 'date') { body.innerHTML = list.map(rowFor).join(''); return; }

  // Group by date, newest first — sticky headers anchor each cluster.
  const groups = new Map();
  for (const h of list) {
    const key = h.local_date || '—';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(h);
  }
  const keys = [...groups.keys()].sort((a, b) => String(b).localeCompare(String(a)));
  body.innerHTML = keys.map((k) => {
    const rows = groups.get(k);
    const total = rows.reduce((a, h) => a + (h.status === 'removed' ? 0 : activeQtyOf(h)), 0);
    return `<tr class="group-row"><th colspan="3">${esc(fmtD(k))}<span class="group-meta">${rows.length} holding${rows.length === 1 ? '' : 's'}${total ? ` · ${total} in cart` : ''}</span></th></tr>`
      + rows.map(rowFor).join('');
  }).join('');
}

// A failed load must never leave the skeleton on screen — say what broke and
// give a one-click way back.
function renderHoldingsError(msg, opts = {}) {
  const body = $('#holdingsTable tbody');
  const list = $('#nextUp');
  const pill = $('#queueCount');
  if (list) list.innerHTML = `<div class="empty-preview">Run queue unavailable — the controller did not answer.</div>`;
  if (pill) pill.textContent = 'offline';
  const count = $('#holdingsCount');
  if (count) count.innerHTML = '';
  const clearBtn = $('#holdingsSearchClear');
  if (clearBtn) clearBtn.hidden = true;
  const tick = $('#tickInfo');
  if (tick) tick.textContent = '—';
  if (!body) return;
  body.innerHTML = `<tr><td colspan="3"><div class="inline-error"><span>${esc(msg)}</span>${opts.retry ? '<button class="button button-secondary button-small" data-retry type="button">Retry</button>' : ''}</div></td></tr>`;
}

function setHoldingsSearch(q) {
  state.ui.q = String(q ?? '');
  renderHoldingsTable();
}
function setHoldingsGroup(mode) {
  state.ui.group = mode === 'date' ? 'date' : 'none';
  document.querySelectorAll('#holdingsGroup button').forEach((b) => {
    const on = b.dataset.group === state.ui.group;
    b.classList.toggle('is-on', on);
    b.setAttribute('aria-pressed', String(on));
  });
  renderHoldingsTable();
}

function holdingError(msg) {
  const el = $('#holdingError');
  if (!msg) { el.classList.add('hidden'); el.textContent = ''; return; }
  el.textContent = msg; el.classList.remove('hidden');
}

async function copyText(t, label = 'Copied') {
  try {
    await navigator.clipboard.writeText(String(t ?? ''));
    showNotice(`${label}.`, 'success');
  } catch {
    const ta = document.createElement('textarea');
    ta.value = String(t ?? '');
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); showNotice(`${label}.`, 'success'); }
    catch { showNotice('Copy failed — select manually.', 'error'); }
    ta.remove();
  }
}

function tokenShort(t) {
  const s = String(t || '');
  if (!s) return '—';
  if (s.length <= 24) return s;
  return `${s.slice(0, 14)}…${s.slice(-6)}`;
}

function isHoldingOpen() { return state.holding != null && !holdingPage.classList.contains('hidden'); }

// The holdings list is a lean summary (no cart items, no run history), so the
// detail page can only be rendered from GET /api/holdings/:id. Re-pull it
// instead of reusing whatever the list happened to carry.
async function syncOpenHolding(id) {
  if (!isHoldingOpen() || !state.holding || state.holding.id !== id) return null;
  try {
    const d = await api(`/api/holdings/${id}`);
    if (isHoldingOpen() && state.holding && state.holding.id === id) {
      state.holding = d.holding;
      renderHoldingInto(d.holding);
    }
    return d.holding;
  } catch { return null; }
}

function openHolding(h, opts = {}) {
  state.holding = h;
  holdingError(null);
  renderHoldingInto(h);
  listView.classList.add('hidden');
  holdingPage.classList.remove('hidden');
  if (opts.push !== false) {
    try { history.pushState({ holdingId: h.id }, '', `/h/${h.id}`); } catch { /* ignore */ }
  }
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function closeHolding(opts = {}) {
  state.holding = null;
  holdingPage.classList.add('hidden');
  listView.classList.remove('hidden');
  if (opts.push !== false) {
    try { history.pushState({}, '', '/'); } catch { /* ignore */ }
  }
}

// Deep links: /h/:id opens a holding, /:occId opens the latest holding for a timetable.
function holdingForOccId(occ) {
  const matches = (state.holdings || []).filter((h) => Number(h.timetable_id) === Number(occ));
  if (!matches.length) return null;
  const live = matches.filter((h) => h.status !== 'removed');
  return [...(live.length ? live : matches)].sort((a, b) => b.id - a.id)[0];
}
async function handleRoute() {
  const path = (location.pathname.replace(/\/$/, '') || '/');
  let m = path.match(/^\/h\/(\d+)$/);
  try {
    if (m) {
      const d = await api(`/api/holdings/${m[1]}`);
      openHolding(d.holding, { push: false });
      return;
    }
    m = path.match(/^\/(\d+)$/);
    if (m) {
      await loadHoldings({ silent: true });
      const h = holdingForOccId(m[1]);
      if (h) {
        // The list only told us which holding it is — pull the full record so
        // the detail page has its cart and run history.
        const d = await api(`/api/holdings/${h.id}`);
        openHolding(d.holding, { push: false });
        const n = (state.holdings || []).filter((x) => Number(x.timetable_id) === Number(m[1]) && x.status !== 'removed').length;
        if (n > 1) showNotice(`${n} holdings share OccID ${m[1]} — opened latest (#${h.id}). Use /h/<id> for a specific one.`, 'info');
        return;
      }
      showNotice(`No holding found for OccID ${m[1]}.`, 'error');
      try { history.replaceState({}, '', '/'); } catch { /* ignore */ }
    }
  } catch (e) { showNotice(e.message, 'error'); }
}
window.addEventListener('popstate', () => {
  const path = (location.pathname.replace(/\/$/, '') || '/');
  if (path === '/') closeHolding({ push: false });
  else handleRoute();
});

// Title + body + buttons, reused for live refresh while the dialog stays open.
function renderHoldingInto(h) {
  $('#holdingTitle').textContent = `#${h.id} · ${h.local_date} ${fmtT(h.local_time)} · OccID ${h.timetable_id}`;
  const activeItems = activeItemsOf(h);
  const historyItems = (h.cartItems || []).filter((i) => i.status !== 'active');
  const inCart = h.status === 'removed' ? 0 : activeQtyOf(h);
  const itemIds = [...new Set(activeItems.map((i) => Number(i.remote_item_id)).filter((n) => Number.isInteger(n) && n > 0))];
  const authOk = Boolean(h.auth_token);
  const chunks = (() => { try { return JSON.parse(h.chunks_json || '[]'); } catch { return h.chunks || []; } })();
  const row = (k, v) => `<div class="kv"><dt>${k}</dt><dd>${v}</dd></div>`;
  const terminalNote = h.status === 'removed'
    ? 'Tickets were removed — no further runs.'
    : h.status === 'auto_stopped'
      ? `Auto-stopped at ${h.auto_stop_madrid} — no further auto runs. Cart stays held until expiry.`
      : h.status === 'stopped'
        ? 'Holding stopped — no further runs. Cart stays held upstream until expiry.'
        : null;
  const nextRunText = isTerminal(h) ? '— (no further runs)' : (h.next_run_at ? `${fmtDT(h.next_run_at)} ${TZ_SHORT}` : (h.auto_enabled ? 'scheduled' : '— (manual, no auto runs)'));
  const nextRunLive = (!isTerminal(h) && h.auto_enabled && h.next_run_at)
    ? ` <span class="countdown" data-next="${esc(h.next_run_at)}">${esc(countdownText(h.next_run_at))}</span>`
    : '';
  const stopParts = madridParts(h.auto_stop_effective);
  const stopEditable = h.status !== 'removed';
  const stopDisabled = stopEditable ? '' : 'disabled';
  const cartNote = !h.remote_cart_id
    ? (h.status === 'removed' ? 'No cart held.' : h.status === 'stopped' ? 'No cart reference.' : 'No cart yet.')
    : (h.status === 'stopped' ? 'Cart stays held upstream until expiry.' : '');
  const itemsEmpty = h.status === 'removed'
    ? 'Tickets were removed — no active items.'
    : 'No cart items yet — cart/add has not succeeded for this holding.';

  $('#holdingBody').innerHTML = `
    ${terminalNote ? `<div class="detail-section"><span class="status-badge status-muted">${esc(terminalNote)}</span></div>` : ''}
    <div class="detail-section status-card">
      <h3 class="section-title">${I.activity}Status</h3>
      <dl class="kv-list">
        ${row('State', `<span class="status-badge status-${badgeFor(h.status)}">${esc(statusLabel(h.status))}</span>`)}
        ${row('Mode', h.auto_enabled ? `<span class="status-badge status-pending">AUTO · every ${h.repeat_minutes}m</span>` : '<span class="status-badge status-muted">Manual</span>')}
        ${row('Slot', `${esc(h.local_date)} ${esc(fmtT(h.local_time))} · OccID ${h.timetable_id} · ticket ${h.ticket_id}`)}
        ${row('Auto stop', `${esc(h.auto_stop_madrid)} <span class="sub-cell">${h.auto_stop_is_default ? 'default rule' : 'custom'}</span>`)}
        ${row('Wanted / in cart', `${h.requested_quantity} / ${inCart}${h.planned_quantity ? ` (planned ${h.planned_quantity})` : ''}`)}
        ${row('Chunks', chunks.length ? `<span class="mono">[${chunks.join(' + ')}]</span>` : '—')}
        ${row('Total', h.price_total != null ? `${h.price_total} ${esc(h.currency || 'EUR')}` : '—')}
        ${row('Next run', `${esc(nextRunText)}${nextRunLive}`)}
        ${h.last_error ? row('Error', `<span class="error-text">${esc(h.last_error)}</span>`) : ''}
      </dl>
      <div class="stop-block" id="holdingStopBlock">
        <span class="stop-label">${I.clock}Auto stop — Spain time</span>
        <div class="stop-when" id="holdStopWhen">—</div>
        <div class="stop-row">
          <input id="holdStopDate" type="date" value="${esc(stopParts?.date || '')}" ${stopDisabled} aria-label="Auto stop date (Spain)">
          <input id="holdStopTime" type="time" value="${esc(stopParts?.time || '')}" ${stopDisabled} aria-label="Auto stop time (Spain)">
          <button class="table-action" id="holdStopSave" type="button" ${stopDisabled}>Save</button>
          <button class="table-action" id="holdStopReset" type="button" ${h.auto_stop_is_default || !stopEditable ? 'disabled' : ''}>Use default</button>
        </div>
        <span class="field-hint" id="holdStopHint">Slot ${esc(fmtDateLong(h.local_date))} at ${esc(fmtT(h.local_time).slice(0, 5))} — ${esc(state.config?.autoStopDefaultRule || `auto stops at ${defaultStopHour()}:00 Spain the day before`)}.</span>
      </div>
    </div>

    <div class="detail-section">
      <h3 class="section-title">${I.lock}Authentication</h3>
      <dl class="kv-list">
        ${row('Auth', authOk ? `<span class="status-badge status-open">Authenticated</span> <span class="sub-cell">obtained ${h.auth_obtained_at ? fmtDT(h.auth_obtained_at) : '—'}</span>` : '<span class="status-badge status-muted">No token yet</span>')}
      </dl>
      <div class="copy-row">
        <code class="token-box mono" id="tokenBox" tabindex="0" role="region" aria-label="Authentication token — scroll sideways to see the full value" data-full="${esc(h.auth_token || '')}">${esc(authOk ? tokenShort(h.auth_token) : '—')}</code>
        <button class="table-action icon-only" data-copy-token type="button" title="Copy token" aria-label="Copy token" ${authOk ? '' : 'disabled'}>${I.copy}</button>
        <button class="table-action" data-toggle-token type="button" ${authOk ? '' : 'disabled'}>${I.eye}Show</button>
      </div>
    </div>

    <div class="detail-section">
      <h3 class="section-title">${I.ticket}Cart</h3>
      <dl class="kv-list">
        ${row('CART_ID', h.remote_cart_id ? `<code class="mono">${esc(h.remote_cart_id)}</code>` : esc(cartNote))}
        ${row('Expires', h.expires_at ? fmtDT(h.expires_at) : '—')}
        ${row('Verified', h.cart_verified_at ? fmtDT(h.cart_verified_at) : '—')}
      </dl>
      <div class="copy-row">
        <button class="table-action icon-only" data-copy-cart type="button" title="Copy CART_ID" aria-label="Copy CART_ID" ${h.remote_cart_id ? '' : 'disabled'}>${I.copy}</button>
        <button class="table-action icon-only" data-copy-items type="button" title="Copy ITEM_IDs" aria-label="Copy ITEM_IDs" ${itemIds.length ? '' : 'disabled'}>${I.copy}</button>
        <button class="table-action icon-only" data-copy-delete type="button" title="Copy delete.js block" aria-label="Copy delete.js block" ${h.remote_cart_id ? '' : 'disabled'}>${I.copy}</button>
        ${(h.remote_cart_id || itemIds.length) ? `<span class="mono muted-text">CART_ID${itemIds.length ? ` · ITEM_IDs [${itemIds.join(', ')}]` : ''} · delete.js</span>` : ''}
      </div>
    </div>

    <div class="detail-section span-2">
      <h3 class="section-title">${I.layers}Items · ${h.status === 'removed' ? 0 : activeItems.length} active${historyItems.length ? ` (+${historyItems.length} history)` : ''}</h3>
      ${activeItems.length && h.status !== 'removed' ? `<div class="table-wrap" tabindex="0" role="region" aria-label="Cart items — scroll for all"><table class="items-table"><thead><tr><th>Chunk</th><th>ITEM_ID</th><th>Qty</th><th>Cart</th><th>Status</th></tr></thead><tbody>${activeItems.map((i) => `
        <tr><td>#${i.chunk_number} ×${i.quantity}</td>
        <td class="mono">${i.remote_item_id ?? '?'} <button class="table-action icon-only" data-copy="${i.remote_item_id ?? ''}" type="button" title="Copy ITEM_ID" aria-label="Copy ITEM_ID">${I.copy}</button></td>
        <td>${i.quantity}</td>
        <td class="mono">${esc(String(i.remote_cart_id || '').slice(0, 8))}…</td>
        <td>${esc(i.status)}</td></tr>`).join('')}</tbody></table></div>`
        : `<div class="empty-preview">${esc(itemsEmpty)}</div>`}
      ${historyItems.length ? `<details class="history"><summary>History (${historyItems.length})</summary><div class="mono muted-text">${historyItems.map((i) => `#${i.remote_item_id ?? '?'} ×${i.quantity} · ${esc(i.status)}`).join('<br>')}</div></details>` : ''}
    </div>

    <div class="detail-section span-2">
      <h3 class="section-title">${I.clock}Run history · ${(h.runs || []).length} run(s)</h3>
      ${(h.runs || []).length ? `<div class="table-wrap" tabindex="0" role="region" aria-label="Run history — scroll for all"><table class="runs-table"><thead><tr><th>#</th><th>Started</th><th>Via</th><th>Result</th><th>Avail</th><th>Added</th><th>Cart ID</th><th>Item IDs</th><th>Total</th><th>Note</th></tr></thead><tbody>${h.runs.map((r) => `
        <tr><td>#${r.run_number}</td>
        <td class="mono">${fmtDT(r.started_at)}</td>
        <td>${esc(r.trigger)}</td>
        <td><span class="status-badge status-${r.status === 'success' ? 'open' : r.status === 'partial' ? 'pending' : 'danger'}">${esc(r.status)}</span></td>
        <td>${r.availables_seen ?? '—'}</td>
        <td>${r.added_quantity}${r.chunks?.length ? ` <span class="sub-cell">[${r.chunks.join('+')}]</span>` : ''}</td>
        <td class="mono run-id" title="${r.remote_cart_id ? esc(r.remote_cart_id) : ''}">${r.remote_cart_id ? `${esc(String(r.remote_cart_id).slice(0, 8))}… <button class="table-action icon-only" data-copy="${esc(r.remote_cart_id)}" type="button" title="Copy cart ID" aria-label="Copy cart ID">${I.copy}</button>` : '—'}</td>
        <td class="mono run-id">${r.itemIds?.length ? `[${r.itemIds.join(', ')}] <button class="table-action icon-only" data-copy="[${r.itemIds.join(', ')}]" type="button" title="Copy item IDs" aria-label="Copy item IDs">${I.copy}</button>` : '—'}</td>
        <td>${r.price_total ?? '—'}</td>
        <td class="err error-text">${r.error ? esc(r.error) : ''}</td></tr>`).join('')}</tbody></table></div>`
        : '<div class="empty-preview">No runs yet for this holding.</div>'}
    </div>`;
  syncHoldingButtons(h);
  paintStopWhen();
}

// Live readout under the date/time pickers so the moment is never ambiguous
// (native inputs follow the browser locale, not Spain).
function paintStopWhen() {
  const h = state.holding;
  const box = $('#holdStopWhen');
  if (!h || !box) return;
  const d = $('#holdStopDate')?.value, t = $('#holdStopTime')?.value;
  const info = stopWhen(d, t, h.auto_stop_is_default);
  box.classList.toggle('past', info.valid && info.past);
  if (!info.valid) { box.innerHTML = `<strong>Pick a date and time</strong><small>Spain time</small>`; return; }
  box.innerHTML = `<strong>${esc(info.when)}</strong><small>${esc(info.tag)} · <span class="countdown" data-stop-when="${info.ms}">${esc(info.rel)}</span></small>`;
}

function syncHoldingButtons(h) {
  const removed = h.status === 'removed';
  const stopped = h.status === 'stopped' || h.status === 'auto_stopped';
  const rb = $('#holdingRefresh');
  if (rb.dataset.loading !== 'true') { rb.disabled = !h.remote_cart_id; rb.innerHTML = `${I.refresh}Refresh cart`; }
  const ab = $('#holdingAuto');
  if (ab.dataset.loading !== 'true') { ab.disabled = removed; ab.innerHTML = h.auto_enabled ? `${I.zap}Auto: ON` : `${I.zap}Auto: OFF`; }
  $('#holdingStop').disabled = removed || stopped;
  $('#holdingRemove').disabled = removed;
}

async function refreshHoldingCart() {
  const h = state.holding;
  if (!h) return;
  holdingError(null);
  const btn = $('#holdingRefresh');
  setBtn(btn, true, 'Refreshing…');
  try {
    const d = await api(`/api/holdings/${h.id}/cart`);
    state.holding = d.holding;
    renderHoldingInto(d.holding);
    await loadHoldings({ silent: true });
    showNotice(`Cart verified: ${d.cart?.total ?? '?'} EUR, ${(d.cart?.items || []).length} item(s).`, 'success');
  } catch (e) { holdingError(e.message); }
  finally { setBtn(btn, false); syncHoldingButtons(state.holding || h); }
}

// Proper promise-based confirm dialog with loading state
function askConfirm({ title, text, confirmLabel = 'Confirm', danger = true }) {
  $('#confirmTitle').textContent = title;
  $('#confirmText').textContent = text;
  const yes = $('#confirmYes');
  yes.textContent = confirmLabel;
  yes.className = `button ${danger ? 'button-danger' : 'button-primary'}`;
  if (!confirmDialog.open) confirmDialog.showModal();
  return new Promise((resolve) => {
    const onSubmit = (e) => {
      const ok = e.submitter?.value === 'default';
      if (ok) e.preventDefault(); // keep open while action runs
      cleanup();
      resolve(ok);
      if (!ok) return; // cancel closes natively via method=dialog
    };
    const onClose = () => { cleanup(); resolve(false); };
    function cleanup() {
      confirmDialog.removeEventListener('submit', onSubmit);
      confirmDialog.removeEventListener('close', onClose);
    }
    confirmDialog.addEventListener('submit', onSubmit);
    confirmDialog.addEventListener('close', onClose, { once: true });
  });
}
function closeConfirm() { try { if (confirmDialog.open) confirmDialog.close(); } catch { /* ignore */ } }

// Shared by the holdings table and the run queue. Non-`removed` rows are
// stale clutter (failed / remove_failed / old manual holds) and need `force`;
// the dialog says plainly when tickets may still be held upstream so the
// consequence is never a surprise.
async function purgeHolding(id, opts = {}) {
  const h = state.holdings.find((x) => x.id === id);
  const removed = h?.status === 'removed';
  const held = h ? activeQtyOf(h) : 0;
  const ok = await askConfirm({
    title: removed ? 'Delete holding?' : 'Delete stale holding?',
    text: removed
      ? `Permanently deletes holding #${id} and its history. Its cart is already gone — this cannot be undone.`
      : `Holding #${id} · ${fmtD(h?.local_date)} ${h?.local_time || ''} · ${statusLabel(h?.status)} — is deleted from this console along with its history.`
        + (held > 0
          ? ` ${held} ticket${held === 1 ? '' : 's'} may still be held upstream; deleting the row loses the reference used to release them.`
          : ' It holds no tickets.'),
    confirmLabel: 'Delete',
    danger: true,
  });
  if (!ok) return;
  const yes = $('#confirmYes');
  setBtn(yes, true, 'Deleting…');
  try {
    const d = await api(`/api/holdings/${id}/purge`, {
      method: 'POST',
      body: JSON.stringify(removed ? {} : { force: true }),
    });
    if (state.holding && state.holding.id === id) closeHolding();
    await loadHoldings({ silent: true });
    const orphan = Number(d?.orphaned_quantity || 0);
    showNotice(orphan > 0
      ? `Holding #${id} deleted — ${orphan} ticket${orphan === 1 ? '' : 's'} may still be held upstream.`
      : `Holding #${id} deleted.`, 'success');
  } catch (e) { showNotice(e.message, 'error'); await loadHoldings({ silent: true }); }
  finally { setBtn(yes, false); }
  closeConfirm();
}

async function holdingAction(a) {
  const h = state.holding;
  if (!h) return;
  holdingError(null);
  try {
    if (a === 'auto') {
      const btn = $('#holdingAuto');
      setBtn(btn, true, h.auto_enabled ? 'Turning off…' : 'Turning on…');
      try { await api(`/api/holdings/${h.id}/${h.auto_enabled ? 'disable-auto' : 'enable-auto'}`, { method: 'POST', body: '{}' }); }
      finally { setBtn(btn, false); }
      await loadHoldings({ silent: true });
      if (isHoldingOpen() && state.holding) await syncOpenHolding(state.holding.id);
      showNotice(h.auto_enabled ? 'Auto re-add OFF.' : 'Auto re-add ON.', 'success');
    } else if (a === 'stop') {
      const ok = await askConfirm({ title: 'Stop holding?', text: 'Auto re-add turns off. Cart stays held upstream until expiry.', confirmLabel: 'Stop', danger: false });
      if (!ok) return;
      const yes = $('#confirmYes');
      setBtn(yes, true, 'Stopping…');
      try { await api(`/api/holdings/${h.id}/stop`, { method: 'POST', body: '{}' }); }
      finally { setBtn(yes, false); }
      closeConfirm();
      await loadHoldings({ silent: true });
      if (isHoldingOpen() && state.holding) await syncOpenHolding(state.holding.id);
      showNotice('Holding stopped.', 'success');
    } else if (a === 'remove') {
      const ok = await askConfirm({ title: 'Remove tickets?', text: `Removes all cart items from cart ${h.remote_cart_id ? h.remote_cart_id.slice(0, 8) + '…' : '—'}. This cannot be undone.`, confirmLabel: 'Remove', danger: true });
      if (!ok) return;
      const yes = $('#confirmYes');
      setBtn(yes, true, 'Removing…');
      try {
        if (!['stopped', 'auto_stopped', 'remove_failed'].includes(state.holding.status)) {
          await api(`/api/holdings/${state.holding.id}/stop`, { method: 'POST', body: '{}' });
        }
        const d = await api(`/api/holdings/${state.holding.id}/remove`, { method: 'POST', body: '{}' });
        state.holding = d.holding;
      } finally { setBtn(yes, false); }
      closeConfirm();
      await loadHoldings({ silent: true });
      closeHolding();
      showNotice('Tickets removed.', 'success');
    }
  } catch (e) { closeConfirm(); holdingError(e.message); await loadHoldings({ silent: true }); }
}

async function loadHoldings(opts = {}) {
  const silent = Boolean(opts.silent) || (state.booted && !opts.force);
  const refreshBtn = $('#refreshHoldings');
  if (!silent) {
    if (!state.booted && !state.holdingsEverLoaded) skeletonHoldings();
    else setBtn(refreshBtn, true, 'Refreshing…');
  }
  // A poll can land while a slow load is still in flight. Dropping it loses
  // that update entirely, so remember it and re-fetch once the current one ends.
  if (state.loadingHoldings) { state.reloadQueued = true; return; }
  state.loadingHoldings = true;
  try {
    const d = await api('/api/holdings');
    state.holdings = d.holdings || [];
    state.scheduler = d.scheduler;
    state.holdingsEverLoaded = true;
    state.holdingsFailed = false;
    renderHoldings();
    // Keep the open detail page in sync with polls + auto re-adds. It needs the
    // full record, which the lean list no longer carries.
    if (isHoldingOpen() && state.holding && refreshBtn.dataset.loading !== 'true') {
      syncOpenHolding(state.holding.id);
    }
  } catch (e) {
    // Never leave the skeleton up: say what went wrong and offer a retry.
    renderHoldingsError(e.message, { retry: true });
    state.holdingsFailed = true;
    showNotice(e.message, 'error');
    // A slow/cold server (VPS right after a restart) often fails the very first
    // request only. Retry once on its own before making the user ask for it.
    if (!state.holdingsEverLoaded && (opts.attempts || 0) < 1) {
      const again = (opts.attempts || 0) + 1;
      setTimeout(() => loadHoldings({ ...opts, attempts: again }), 1200);
    }
  } finally {
    state.loadingHoldings = false;
    if (!silent) setBtn(refreshBtn, false);
    if (refreshBtn.dataset.loading === 'false') refreshBtn.innerHTML = `${I.refresh}Refresh`;
    // Run the update we swallowed earlier, now that nothing is in flight.
    if (state.reloadQueued) { state.reloadQueued = false; loadHoldings({ silent: true }); }
  }
}
async function loadActivity() {
  const b = $('#refreshActivity');
  setBtn(b, true, 'Loading…');
  try {
    const d = await api('/api/activity?limit=60');
    $('#eventsTable tbody').innerHTML = (d.events || []).map((e) => `<tr><td class="sub-cell">${fmtDT(e.created_at)}</td><td class="mono">${esc(e.method)} ${esc(e.endpoint)}</td><td>${e.status_code ?? '—'}</td><td class="mono">${e.holding_id ?? '—'}</td></tr>`).join('') || '<tr><td colspan="4" class="empty-cell">No events yet.</td></tr>';
  } catch (e) { showNotice(e.message, 'error'); }
  finally { setBtn(b, false); }
}
async function loadLogs() {
  const b = $('#refreshLogs');
  setBtn(b, true, 'Loading…');
  try {
    const d = await api('/api/logs?limit=150');
    $('#logsPre').textContent = (d.lines || []).map(localizeLogLine).join('\n') || 'Log is empty so far.';
  } catch (e) { $('#logsPre').textContent = e.message; }
  finally { setBtn(b, false); }
}
async function toggleAuto() {
  const btn = $('#autoToggle');
  const enabling = !state.scheduler?.enabled;
  setBtn(btn, true, enabling ? 'Starting…' : 'Stopping…');
  try {
    await api(state.scheduler?.enabled ? '/api/automation/stop' : '/api/automation/start', { method: 'POST', body: '{}' });
    await boot(false);
    showNotice(enabling ? 'Automation ON.' : 'Automation OFF.', enabling ? 'success' : 'info');
  } catch (e) { showNotice(e.message, 'error'); }
  finally { setBtn(btn, false); }
}
let routeResolved = false;
async function boot(reset = true) {
  try {
    state.config = await api('/api/config');
    $('#configPre').textContent = JSON.stringify(state.config, null, 2);
    $('#tzPill').textContent = `Times: ${state.config?.timezoneLabel || 'Spain (Europe/Madrid)'}`;
    if (state.config?.passwordProtected) $('#logoutBtn')?.classList.remove('hidden');
    await loadHoldings({ force: !state.booted });
    if (!routeResolved) {
      routeResolved = true;
      if ((location.pathname.replace(/\/$/, '') || '/') !== '/') await handleRoute();
    }
    loadLogs();
    lockDateInput();
  } catch (e) { showNotice(e.message, 'error'); }
  finally {
    state.booted = true;
    $('#pageLoader')?.classList.add('hidden');
  }
}

lockDateInput();
dateInput.addEventListener('change', lockDateInput);
$('#loadAvailability').addEventListener('click', loadAvail);
// Clear the loaded slots after tickets are in cart (resets steps 2–3, keeps the date).
$('#clearSlots').addEventListener('click', () => {
  state.slots = [];
  state.slot = null;
  slotGrid.innerHTML = '';
  slotState.textContent = 'Pick a date, then check availability.';
  $('#step2').classList.remove('active');
  $('#step3').classList.remove('active');
  resetSlotConfirm();
});
dateInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); loadAvail(); } });
slotGrid.addEventListener('click', (e) => {
  const b = e.target.closest('[data-slot]');
  if (!b || b.disabled) return; const s = state.slots.find((x) => x.id === Number(b.dataset.slot)); if (s) openSlotDialog(s);
});
slotQty.addEventListener('input', renderSlotChunks);
slotAuto.addEventListener('change', syncStopInputs);
slotStopDate.addEventListener('change', updateStopHint);
slotStopTime.addEventListener('change', updateStopHint);
$('#slotStopDefault').addEventListener('click', setDefaultStopInputs);
$('#slotForm').addEventListener('submit', confirmSlot);

// ---- Drawer wiring (rail +, close button, Cancel, Esc, scrim) ----
$('#openAddDrawer').addEventListener('click', openAddDrawer);
$('#addDrawerClose').addEventListener('click', closeAddDrawer);
$('#drawerCancel').addEventListener('click', (e) => { e.preventDefault(); closeAddDrawer(); });
// Esc: cancel the native close so the exit animation can play.
addDrawer.addEventListener('cancel', (e) => { e.preventDefault(); closeAddDrawer(); });
// Scrim click (the dialog element itself is the backdrop target).
addDrawer.addEventListener('click', (e) => { if (e.target === addDrawer) closeAddDrawer(); });
addDrawer.addEventListener('close', () => {
  slotForm.dataset.busy = 'false';
  const b = slotConfirmBtn;
  if (b.dataset.loading === 'true') setBtn(b, false);
  b.innerHTML = `${I.ticket}Add to cart`;
  b.disabled = true;
  resetSlotConfirm();
});
$('#railDashboard').addEventListener('click', () => {
  if (!listView.classList.contains('hidden')) { window.scrollTo({ top: 0, behavior: 'smooth' }); return; }
  closeHolding();
});

// ---- Holdings search + group by date ----
$('#holdingsSearch').addEventListener('input', (e) => setHoldingsSearch(e.target.value));
$('#holdingsSearchClear').addEventListener('click', () => {
  const inp = $('#holdingsSearch');
  inp.value = '';
  setHoldingsSearch('');
  inp.focus();
});
$('#holdingsGroup').addEventListener('click', (e) => {
  const b = e.target.closest('[data-group]');
  if (b) setHoldingsGroup(b.dataset.group);
});
$('#holdingsCount').addEventListener('click', (e) => {
  if (!e.target.closest('[data-clear-filter]')) return;
  const inp = $('#holdingsSearch');
  inp.value = '';
  setHoldingsSearch('');
  inp.focus();
});

$('#nextUp').addEventListener('click', (e) => {
  const x = e.target.closest('[data-purge]');
  if (x) { purgeHolding(Number(x.dataset.purge)); }
});
$('#holdingsTable tbody').addEventListener('click', async (e) => {
  if (e.target.closest('[data-retry]')) { loadHoldings({ force: true }); return; }
  const p = e.target.closest('[data-purge]');
  if (p) { purgeHolding(Number(p.dataset.purge)); return; }
  const v = e.target.closest('[data-view]');
  if (!v) return;
  v.disabled = true;
  try { const d = await api(`/api/holdings/${v.dataset.view}`); openHolding(d.holding); } catch (err) { showNotice(err.message, 'error'); }
  finally { v.disabled = false; }
});
$('#holdingRefresh').addEventListener('click', refreshHoldingCart);
$('#holdingAuto').addEventListener('click', () => holdingAction('auto'));
$('#holdingBody').addEventListener('click', (e) => {
  const h = state.holding;
  if (!h) return;
  const activeItems = (h.cartItems || []).filter((i) => i.status === 'active');
  const itemIds = [...new Set(activeItems.map((i) => Number(i.remote_item_id)).filter((n) => Number.isInteger(n) && n > 0))];
  if (e.target.closest('[data-copy]')) {
    const v = e.target.closest('[data-copy]').dataset.copy;
    if (v) copyText(v, 'ITEM_ID copied');
    return;
  }
  if (e.target.closest('[data-copy-cart]')) { if (h.remote_cart_id) copyText(h.remote_cart_id, 'CART_ID copied'); return; }
  if (e.target.closest('[data-copy-token]')) { if (h.auth_token) copyText(h.auth_token, 'TOKEN copied'); return; }
  if (e.target.closest('[data-copy-items]')) { if (itemIds.length) copyText(`[${itemIds.join(', ')}]`, 'ITEM_IDs copied'); return; }
  if (e.target.closest('[data-copy-delete]')) {
    const block = `const CART_ID = '${h.remote_cart_id || ''}';\nconst ITEM_IDS = [${itemIds.join(', ')}];\nconst TOKEN = '${h.auth_token || ''}';`;
    copyText(block, 'delete.js block copied');
    return;
  }
  if (e.target.closest('[data-toggle-token]')) {
    const box = $('#tokenBox');
    const btn = e.target.closest('[data-toggle-token]');
    if (!box || !h.auth_token) return;
    const showing = btn.textContent.trim() === 'Hide';
    box.textContent = showing ? tokenShort(h.auth_token) : h.auth_token;
    btn.innerHTML = showing ? `${I.eye}Show` : `${I.eye}Hide`;
    return;
  }
  if (e.target.closest('#holdStopSave')) { saveHoldingAutoStop(false); return; }
  if (e.target.closest('#holdStopReset')) { saveHoldingAutoStop(true); return; }
});
// Keep the readout in sync while the pickers are being edited.
$('#holdingBody').addEventListener('input', paintStopWhen);
$('#holdingBody').addEventListener('change', paintStopWhen);

// Auto stop is editable at any time (running or parked). Spain wall clock in.
async function saveHoldingAutoStop(reset) {
  const h = state.holding;
  if (!h) return;
  const btn = reset ? $('#holdStopReset') : $('#holdStopSave');
  holdingError(null);
  if (!reset) {
    const d = $('#holdStopDate')?.value, t = $('#holdStopTime')?.value;
    if (!d || !t) return holdingError('Pick a Spain date + time for the auto stop.');
  }
  setBtn(btn, true, 'Saving…');
  try {
    const body = reset ? { reset: true } : { autoStopDate: $('#holdStopDate').value, autoStopTime: $('#holdStopTime').value };
    const d = await api(`/api/holdings/${h.id}/auto-stop`, { method: 'POST', body: JSON.stringify(body) });
    state.holding = d.holding;
    renderHoldingInto(d.holding);
    await loadHoldings({ silent: true });
    showNotice(`Auto stop set to ${d.holding.auto_stop_madrid}${d.holding.status === 'auto_stopped' ? ' — already past, holding parked.' : '.'}`, d.holding.status === 'auto_stopped' ? 'info' : 'success');
  } catch (e) { holdingError(e.message); }
  finally { setBtn(btn, false); }
}
$('#holdingStop').addEventListener('click', () => holdingAction('stop'));
$('#holdingRemove').addEventListener('click', () => holdingAction('remove'));
$('#holdingBack').addEventListener('click', () => { closeHolding(); loadHoldings({ silent: true }); });
$('#refreshHoldings').addEventListener('click', () => loadHoldings({ force: true }));
$('#refreshActivity').addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); loadActivity(); loadLogs(); });
$('#refreshLogs').addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); loadLogs(); });
$('#autoToggle').addEventListener('click', toggleAuto);
$('#logoutBtn').addEventListener('click', async () => {
  try { await api('/api/logout', { method: 'POST', body: '{}' }); } catch { /* ignore */ }
  location.href = '/login.html';
});
// Silent background refresh; skipped while the tab is hidden to avoid pile-ups.
// Self-rescheduling so the cadence can tighten while the console is showing an
// error — a transient VPS hiccup then clears itself, no manual reload needed.
let pollTimer = null;
function schedulePoll() {
  clearTimeout(pollTimer);
  const delay = state.holdingsFailed ? 4000 : 15000;
  pollTimer = setTimeout(async () => {
    await loadHoldings({ silent: true });
    schedulePoll();
  }, delay);
}
schedulePoll();
// Live next-run countdowns, every second
setInterval(tickCountdowns, 1000);
boot();
