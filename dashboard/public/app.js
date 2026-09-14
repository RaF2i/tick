// Same flow as auto-cart/add.js: date -> slots -> occupation -> qty -> chunks -> cart.
// Responsive edition: skeletons, button spinners, promise confirms, silent background polls.
const state = { config: null, slots: [], slot: null, holdings: [], scheduler: null, holding: null, booted: false, loadingHoldings: false };
const $ = (s) => document.querySelector(s);
const dateInput = $('#dateInput');
const slotGrid = $('#slotGrid'), slotState = $('#slotState');
const slotDialog = $('#slotDialog'), slotQty = $('#slotQty'), slotAuto = $('#slotAuto'), slotRepeat = $('#slotRepeat');
const holdingPage = $('#holdingPage'), listView = $('#listView');
const confirmDialog = $('#confirmDialog');

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
function fmtD(d) { if (!d) return '—'; return new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short' }).format(new Date(d + 'T12:00:00')); }
function fmtDT(v) { if (!v) return '—'; const d = new Date(v); return isNaN(d) ? v : new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }).format(d); }

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

// ---- New flow: 1 date -> 2 slots ----
async function loadAvail() {
  if (!dateInput.value) return showNotice('Pick a date first.', 'error');
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
        <button class="button button-primary button-small" data-slot="${s.id}" ${ok ? '' : 'disabled'}>${I.plus}Add to cart</button>
      </div>
    </div>`;
  }).join('');
}

// ---- Dialog 3: confirm (qty + auto option before Add to cart) ----
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
  $('#slotError').classList.add('hidden');
  renderSlotChunks();
  $('#step3').classList.add('active');
  if (!slotDialog.open) slotDialog.showModal();
  setTimeout(() => slotQty.focus(), 50);
}

function renderSlotChunks() {
  const err = $('#slotError');
  try {
    const q = resolveQty(slotQty.value, Number(state.slot.availables));
    if (!q) throw new Error('Nothing to take.');
    const c = chunksFor(q);
    $('#slotChunks').innerHTML = `<div class="chunk-line">Taking <strong>${q}</strong> in ${c.length} request(s): <strong>[${c.join(' + ')}]</strong></div>`;
    err.classList.add('hidden');
    return q;
  } catch (e) {
    $('#slotChunks').innerHTML = '';
    err.textContent = e.message;
    err.classList.remove('hidden');
    return 0;
  }
}

async function confirmSlot(e) {
  if (e.submitter?.value === 'cancel') return;
  e.preventDefault();
  const q = renderSlotChunks();
  if (!q) return;
  const btn = $('#slotConfirm');
  const card = $('#slotForm');
  setBtn(btn, true, 'Adding…');
  card.dataset.busy = 'true';
  try {
    const d = await api('/api/holdings', {
      method: 'POST',
      body: JSON.stringify({
        date: dateInput.value, time: state.slot.start, timetableId: state.slot.id,
        ticketId: state.config?.defaultTicketId || 34, quantity: q,
        autoEnabled: slotAuto.checked, repeatMinutes: Number(slotRepeat.value) || 30,
      }),
    });
    slotDialog.close();
    const h = d.holding;
    const inCart = (h.cartItems || []).reduce((a, i) => a + Number(i.quantity || 0), 0);
    showNotice(`Added ${inCart || q} tickets to cart ${h.remote_cart_id ? h.remote_cart_id.slice(0, 8) + '…' : ''}${slotAuto.checked ? ' + auto re-add ON' : ''}.`, 'success');
    await loadHoldings({ silent: true });
  } catch (err) {
    const el = $('#slotError'); el.textContent = err.message; el.classList.remove('hidden');
    await loadHoldings({ silent: true });
  } finally { setBtn(btn, false); card.dataset.busy = 'false'; }
}

// ---- Holdings + detail dialog ----
const TERMINAL = ['stopped', 'removed'];
const isTerminal = (h) => TERMINAL.includes(h.status);
const activeItemsOf = (h) => (h.cartItems || []).filter((i) => i.status === 'active');
const activeQtyOf = (h) => activeItemsOf(h).reduce((a, i) => a + Number(i.quantity || 0), 0);
function badgeFor(status) {
  if (/manual_hold|running|scheduled/.test(status)) return 'open';
  if (/failed|partial|no_availability/.test(status)) return 'danger';
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
  $('#tickInfo').textContent = `tick ${state.scheduler ? Math.round((state.scheduler.tickIntervalMs || 15000) / 1000) + 's' : '—'} · ${state.scheduler?.lastTickResult || ''}`.slice(0, 80);
  $('#autoPill').textContent = `Auto: ${state.scheduler?.enabled ? 'ON' : 'OFF'}`;
  const autoBtn = $('#autoToggle');
  if (autoBtn.dataset.loading !== 'true') autoBtn.innerHTML = state.scheduler?.enabled ? `${I.pause}Stop auto` : `${I.play}Start auto`;
  const liveCount = live.length;
  const exec = state.scheduler?.runningCount ?? 0;
  $('#sideStatus').textContent = state.scheduler?.enabled
    ? `Auto ON · ${liveCount} holding${liveCount === 1 ? '' : 's'}${exec ? ` · ${exec} executing` : ''}`
    : (due > 0 ? `Auto OFF · ${due} due — start auto` : 'Manual mode');
  const sorted = [...live].sort((a, b) => String(a.next_run_at || '~').localeCompare(String(b.next_run_at || '~')));
  $('#nextUp').innerHTML = sorted.slice(0, 5).map((h) => {
    const when = h.auto_enabled ? (h.next_run_at ? fmtDT(h.next_run_at) : 'scheduled') : 'manual — no runs';
    const live = h.auto_enabled && h.next_run_at && !isTerminal(h)
      ? `${I.clock}<span class="countdown" data-next="${esc(h.next_run_at)}" title="Next run ${esc(fmtDT(h.next_run_at))}">${esc(countdownText(h.next_run_at))}</span>`
      : '';
    return `<div class="next-row"><strong>${esc(h.local_date)} ${esc(h.local_time)}</strong><span>OccID ${h.timetable_id} · ${esc(statusLabel(h.status))} · ${esc(modeLabel(h))}</span><span class="mono">${when}${live ? ` · ${live}` : ''}</span></div>`;
  }).join('') || `<div class="empty-preview">${state.holdings.length ? 'No active holdings.' : 'No holdings yet — pick a date above to start.'}</div>`;
  const body = $('#holdingsTable tbody');
  body.innerHTML = state.holdings.length ? state.holdings.map((h) => {
    const added = h.status === 'removed' ? 0 : activeQtyOf(h);
    const sub = isTerminal(h)
      ? `OccID ${h.timetable_id} · was ${h.requested_quantity} wanted · ${esc(statusLabel(h.status))}`
      : `OccID ${h.timetable_id} · want ${h.requested_quantity} · in cart ${added} · ${esc(modeLabel(h))}`;
    return `<tr><td><strong>${fmtD(h.local_date)} ${esc(h.local_time)}</strong><span class="sub-cell">${sub}</span></td>
      <td><span class="status-badge status-${badgeFor(h.status)}">${esc(statusLabel(h.status))}</span></td>
      <td class="actions-cell"><button class="table-action" data-view="${h.id}">${I.eye}View</button></td></tr>`;
  }).join('') : '<tr><td colspan="3" class="empty-cell">No holdings yet.</td></tr>';
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
        openHolding(h, { push: false });
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
  $('#holdingTitle').textContent = `#${h.id} · ${h.local_date} ${h.local_time} · OccID ${h.timetable_id}`;
  const activeItems = activeItemsOf(h);
  const historyItems = (h.cartItems || []).filter((i) => i.status !== 'active');
  const inCart = h.status === 'removed' ? 0 : activeQtyOf(h);
  const itemIds = [...new Set(activeItems.map((i) => Number(i.remote_item_id)).filter((n) => Number.isInteger(n) && n > 0))];
  const authOk = Boolean(h.auth_token);
  const chunks = (() => { try { return JSON.parse(h.chunks_json || '[]'); } catch { return h.chunks || []; } })();
  const row = (k, v) => `<div class="kv"><dt>${k}</dt><dd>${v}</dd></div>`;
  const terminalNote = h.status === 'removed'
    ? 'Tickets were removed — no further runs.'
    : h.status === 'stopped'
      ? 'Holding stopped — no further runs. Cart stays held upstream until expiry.'
      : null;
  const nextRunText = isTerminal(h) ? '— (no further runs)' : (h.next_run_at ? fmtDT(h.next_run_at) : (h.auto_enabled ? 'scheduled' : '— (manual, no auto runs)'));
  const nextRunLive = (!isTerminal(h) && h.auto_enabled && h.next_run_at)
    ? ` <span class="countdown" data-next="${esc(h.next_run_at)}">${esc(countdownText(h.next_run_at))}</span>`
    : '';
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
        ${row('Slot', `${esc(h.local_date)} ${esc(h.local_time)} · OccID ${h.timetable_id} · ticket ${h.ticket_id}`)}
        ${row('Wanted / in cart', `${h.requested_quantity} / ${inCart}${h.planned_quantity ? ` (planned ${h.planned_quantity})` : ''}`)}
        ${row('Chunks', chunks.length ? `<span class="mono">[${chunks.join(' + ')}]</span>` : '—')}
        ${row('Total', h.price_total != null ? `${h.price_total} ${esc(h.currency || 'EUR')}` : '—')}
        ${row('Next run', `${esc(nextRunText)}${nextRunLive}`)}
        ${h.last_error ? row('Error', `<span class="error-text">${esc(h.last_error)}</span>`) : ''}
      </dl>
    </div>

    <div class="detail-section">
      <h3 class="section-title">${I.lock}Authentication</h3>
      <dl class="kv-list">
        ${row('Auth', authOk ? `<span class="status-badge status-open">Authenticated</span> <span class="sub-cell">obtained ${h.auth_obtained_at ? fmtDT(h.auth_obtained_at) : '—'}</span>` : '<span class="status-badge status-muted">No token yet</span>')}
      </dl>
      <div class="copy-row">
        <code class="token-box mono" id="tokenBox" data-full="${esc(h.auth_token || '')}">${esc(authOk ? tokenShort(h.auth_token) : '—')}</code>
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
      ${activeItems.length && h.status !== 'removed' ? `<div class="table-wrap"><table class="items-table"><thead><tr><th>Chunk</th><th>ITEM_ID</th><th>Qty</th><th>Cart</th><th>Status</th></tr></thead><tbody>${activeItems.map((i) => `
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
      ${(h.runs || []).length ? `<div class="table-wrap"><table class="runs-table"><thead><tr><th>#</th><th>Started</th><th>Via</th><th>Result</th><th>Avail</th><th>Added</th><th>Cart ID</th><th>Item IDs</th><th>Total</th><th>Note</th></tr></thead><tbody>${h.runs.map((r) => `
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
}

function syncHoldingButtons(h) {
  const removed = h.status === 'removed';
  const stopped = h.status === 'stopped';
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
      if (isHoldingOpen() && state.holding) {
        const fresh = state.holdings.find((x) => x.id === state.holding.id);
        if (fresh) { state.holding = fresh; renderHoldingInto(fresh); }
      }
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
      if (isHoldingOpen() && state.holding) {
        const fresh = state.holdings.find((x) => x.id === state.holding.id);
        if (fresh) { state.holding = fresh; renderHoldingInto(fresh); }
      }
      showNotice('Holding stopped.', 'success');
    } else if (a === 'remove') {
      const ok = await askConfirm({ title: 'Remove tickets?', text: `Removes all cart items from cart ${h.remote_cart_id ? h.remote_cart_id.slice(0, 8) + '…' : '—'}. This cannot be undone.`, confirmLabel: 'Remove', danger: true });
      if (!ok) return;
      const yes = $('#confirmYes');
      setBtn(yes, true, 'Removing…');
      try {
        if (!['stopped', 'remove_failed'].includes(state.holding.status)) {
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
    if (!state.booted) skeletonHoldings();
    else setBtn(refreshBtn, true, 'Refreshing…');
  }
  if (state.loadingHoldings) return;
  state.loadingHoldings = true;
  try {
    const d = await api('/api/holdings');
    state.holdings = d.holdings || [];
    state.scheduler = d.scheduler;
    renderHoldings();
    // Keep the open detail page in sync with polls + auto re-adds.
    if (isHoldingOpen() && state.holding) {
      const fresh = state.holdings.find((x) => x.id === state.holding.id);
      if (fresh && refreshBtn.dataset.loading !== 'true') { state.holding = fresh; renderHoldingInto(fresh); }
    }
  } catch (e) {
    if (!state.booted) $('#nextUp').innerHTML = `<div class="inline-error"><span>${esc(e.message)}</span></div>`;
    showNotice(e.message, 'error');
  } finally {
    state.loadingHoldings = false;
    if (!silent) setBtn(refreshBtn, false);
    if (refreshBtn.dataset.loading === 'false') refreshBtn.innerHTML = `${I.refresh}Refresh`;
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
    $('#logsPre').textContent = (d.lines || []).join('\n') || 'Log is empty so far.';
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
    if (state.config?.passwordProtected) $('#logoutBtn')?.classList.remove('hidden');
    await loadHoldings({ force: !state.booted });
    if (!routeResolved) {
      routeResolved = true;
      if ((location.pathname.replace(/\/$/, '') || '/') !== '/') await handleRoute();
    }
    loadLogs();
    if (reset) dateInput.value = new Date().toISOString().slice(0, 10);
  } catch (e) { showNotice(e.message, 'error'); }
  finally {
    state.booted = true;
    $('#pageLoader')?.classList.add('hidden');
  }
}

dateInput.value = new Date().toISOString().slice(0, 10);
$('#loadAvailability').addEventListener('click', loadAvail);
// Clear the loaded slots after tickets are in cart (resets steps 2–3, keeps the date).
$('#clearSlots').addEventListener('click', () => {
  state.slots = [];
  state.slot = null;
  slotGrid.innerHTML = '';
  slotState.textContent = 'Pick a date, then check availability.';
  $('#step2').classList.remove('active');
  $('#step3').classList.remove('active');
});
dateInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); loadAvail(); } });
slotGrid.addEventListener('click', (e) => {
  const b = e.target.closest('[data-slot]');
  if (!b || b.disabled) return; const s = state.slots.find((x) => x.id === Number(b.dataset.slot)); if (s) openSlotDialog(s);
});
slotQty.addEventListener('input', renderSlotChunks);
slotAuto.addEventListener('change', () => { slotRepeat.disabled = !slotAuto.checked; });
$('#slotForm').addEventListener('submit', confirmSlot);
slotDialog.addEventListener('close', () => { $('#slotForm').dataset.busy = 'false'; const b = $('#slotConfirm'); if (b.dataset.loading === 'true') setBtn(b, false); b.innerHTML = `${I.ticket}Add to cart`; });
$('#holdingsTable tbody').addEventListener('click', async (e) => {
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
  }
});
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
// Silent background refresh; skip when tab hidden to avoid pile-ups
setInterval(() => { if (!document.hidden) loadHoldings({ silent: true }); }, 15000);
// Live next-run countdowns, every second
setInterval(tickCountdowns, 1000);
boot();
