// ============================================================
// ADD TO CART — FULL AUTO
// Run:  node add.js
// Does: authenticate -> calendar -> match TIME -> occupation
//       -> decide qty -> POST /cart/add in chunks of max 30
//       -> GET /cart/show -> print CART_ID + ITEM_IDs for delete.js
// ============================================================

// --- SETTINGS ---
const DATE = '2026-09-16'; // YYYY-MM-DD
const TIME = '12:40'; // HH:MM, slot start
const TICKET_COUNT = ''; // '' = all, 20 = 20, over avail = capped to avail

// --- FIXED (do not edit) ---
const API_KEY = process.env.SERVITICKETS_API_KEY || '';
const API_BASE = 'https://admin.catedraldesevilla.servitickets.es/api';
const PLACE_ID = '2';
const VISIT_ID = 25;
const TOUR_ID = 25;
const TICKET_ID = 34;
const MAX_PER_REQUEST = 30;

function timeOnly(value) {
  const m = String(value || '').match(/(\d{2}:\d{2})/);
  return m ? m[1] : String(value || '');
}

async function readJson(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    console.error(`Non-JSON response (HTTP ${res.status}):`);
    console.error(text.slice(0, 2000));
    throw new Error(`Provider returned non-JSON (HTTP ${res.status})`);
  }
}

async function callApi(step, url, options) {
  let res;
  try {
    res = await fetch(url, options);
  } catch (e) {
    throw new Error(`${step} failed: network error (${e.cause?.code || e.message})`);
  }
  const data = await readJson(res);
  return { res, data };
}

function parseWanted(raw) {
  const s = String(raw ?? '').trim();
  if (s === '') return null; // take all
  if (!/^\d+$/.test(s)) throw new Error(`TICKET_COUNT must be a whole number or '' (got '${raw}')`);
  const n = Number(s);
  if (n < 1) throw new Error(`TICKET_COUNT must be >= 1 or '' for take-all (got '${raw}')`);
  return n;
}

function splitChunks(total) {
  const chunks = [];
  let left = total;
  while (left > 0) {
    const q = Math.min(MAX_PER_REQUEST, left);
    chunks.push(q);
    left -= q;
  }
  return chunks;
}

async function main() {
  // 0. Validate settings first (fail before any network call)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(DATE)) throw new Error(`DATE must be "YYYY-MM-DD" (got '${DATE}')`);
  const [yy, mo, dd] = DATE.split('-').map(Number);
  const dCheck = new Date(Date.UTC(yy, mo - 1, dd));
  if (dCheck.getUTCFullYear() !== yy || dCheck.getUTCMonth() !== mo - 1 || dCheck.getUTCDate() !== dd) {
    throw new Error(`DATE is not a real calendar date (got '${DATE}')`);
  }
  if (!/^\d{2}:\d{2}$/.test(TIME)) throw new Error(`TIME must be "HH:MM" 24h (got '${TIME}')`);
  const [hh, mi] = TIME.split(':').map(Number);
  if (hh > 23 || mi > 59) throw new Error(`TIME is not a real time (got '${TIME}')`);
  const wanted = parseWanted(TICKET_COUNT);

  // 1. Authenticate
  console.log('[1/5] Authenticating…');
  const { res: authRes, data: auth } = await callApi('Authenticate', `${API_BASE}/places/authenticate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ api_key: API_KEY }),
  });
  if (!authRes.ok || !auth?.success || !auth?.token) {
    throw new Error(`Auth failed (HTTP ${authRes.status}): ` + JSON.stringify(auth).slice(0, 500));
  }
  let token = auth.token;
  const authHeaders = () => ({
    Accept: 'application/json',
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  });
  console.log('      OK, place:', auth.place_name || auth.place_id);

  // 2. Calendar -> find date + match time
  console.log(`[2/5] Calendar ${mo}/${yy}, looking for ${DATE} ${TIME}…`);
  const { res: calRes, data: cal } = await callApi(
    'Calendar',
    `${API_BASE}/visits/${VISIT_ID}/calendar?place_id=${encodeURIComponent(PLACE_ID)}&tour=${TOUR_ID}&month=${mo}&year=${yy}`,
    { headers: { Accept: 'application/json', Authorization: `Bearer ${token}` } }
  );
  if (!calRes.ok) throw new Error(`Calendar failed (HTTP ${calRes.status}): ` + JSON.stringify(cal).slice(0, 500));
  const data = cal?.data || {};
  const closed = (data.closedDays || []).find((d) => d.date === DATE);
  if (closed) throw new Error(`Date ${DATE} is CLOSED: ${closed.description || 'closed by provider'}`);
  const day = (data.daysWithItems || []).find((d) => d.date === DATE);
  if (!day) throw new Error(`Date ${DATE} not in calendar (no sales for this day).`);
  const slots = day.timetables || [];
  if (!slots.length) throw new Error(`Date ${DATE} has no timetables.`);
  const slot = slots.find((s) => timeOnly(s.start_date) === TIME);
  if (!slot) {
    console.error('Available times for this date:');
    for (const s of slots) console.error(`  ${timeOnly(s.start_date)}  id=${s.id}  active=${s.active}`);
    throw new Error(`Time ${TIME} not found on ${DATE}.`);
  }
  if (!slot.active) throw new Error(`Slot ${TIME} (id=${slot.id}) exists but is not active.`);
  const timetableId = Number(slot.id);
  console.log(`      OK, timetable id=${timetableId}`);

  // 3. Occupation -> availability
  console.log('[3/5] Checking availability…');
  const { res: occRes, data: occ } = await callApi(
    'Occupation',
    `${API_BASE}/visits/${VISIT_ID}/calendar/day-occupation?place_id=${encodeURIComponent(PLACE_ID)}&tour=${TOUR_ID}&date=${encodeURIComponent(DATE)}`,
    { headers: { Accept: 'application/json', Authorization: `Bearer ${token}` } }
  );
  if (!occRes.ok) throw new Error(`Occupation failed (HTTP ${occRes.status}): ` + JSON.stringify(occ).slice(0, 500));
  const occData = occ?.data || {};
  if (!(String(timetableId) in occData)) {
    throw new Error(`No occupation data for timetable ${timetableId} (slot may have been removed upstream).`);
  }
  const stats = occData[String(timetableId)] || {};
  const avail = Number(stats.availables || 0);
  console.log(`      available=${avail} sold=${stats.sold || 0} fullyBooked=${!!stats.is_fully_booked}`);
  if (stats.is_fully_booked && !avail) throw new Error(`Slot ${TIME} (id=${timetableId}) is FULLY BOOKED.`);
  if (!avail) throw new Error(`No tickets available for ${DATE} ${TIME} (timetable ${timetableId}).`);

  // 4. Decide quantity
  const take = wanted === null ? avail : Math.min(wanted, avail);
  if (wanted !== null && wanted > avail) {
    console.log(`      wanted ${wanted} but only ${avail} available -> taking ${avail}`);
  }
  if (!take) throw new Error('Nothing to take.');
  const chunks = splitChunks(take);
  console.log(`[4/5] Adding ${take} tickets in ${chunks.length} request(s): [${chunks.join(' + ')}]`);

  // 5. Add chunks — first request cart_id=null, reuse returned cart_id
  let cartId = null;
  let expiresAt = null;
  let done = 0;
  for (let i = 0; i < chunks.length; i += 1) {
    const q = chunks[i];
    const body = {
      visit_id: VISIT_ID,
      cart_id: cartId, // null on first call -> provider creates cart
      place_id: PLACE_ID,
      tour_id: TOUR_ID,
      timetables: [{ id: timetableId }],
      tickets: [{ id: TICKET_ID, quantity: q }],
      subject_id: null,
    };
    try {
      let attempt = await callApi(`cart/add chunk ${i + 1}/${chunks.length}`, `${API_BASE}/cart/add`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify(body),
      });
      // Token expired mid-run -> re-auth once and retry this chunk
      if (attempt.res.status === 401) {
        console.log('      token expired, re-authenticating…');
        const { res: r2, data: a2 } = await callApi('Re-authenticate', `${API_BASE}/places/authenticate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ api_key: API_KEY }),
        });
        if (!r2.ok || !a2?.token) throw new Error('Re-auth failed: ' + JSON.stringify(a2).slice(0, 300));
        token = a2.token;
        attempt = await callApi(`cart/add chunk ${i + 1}/${chunks.length} (retry)`, `${API_BASE}/cart/add`, {
          method: 'POST',
          headers: authHeaders(),
          body: JSON.stringify(body),
        });
      }
      const j = attempt.data;
      if (!attempt.res.ok || j?.success === false || !j?.cart_id) {
        throw new Error(`(HTTP ${attempt.res.status}): ` + JSON.stringify(j).slice(0, 800));
      }
      cartId = j.cart_id;
      expiresAt = j.expires_at || expiresAt;
      done += 1;
      console.log(`      chunk ${i + 1}/${chunks.length} qty=${q} OK -> cart ${cartId}`);
    } catch (e) {
      throw new Error(
        `cart/add FAILED at chunk ${i + 1}/${chunks.length} (qty ${q}). ` +
          `Succeeded ${done}/${chunks.length}${cartId ? `. Partial cart: ${cartId} (use delete.js to clean up)` : ' (no cart created yet)'}. ` +
          `Reason: ${e.message}`
      );
    }
  }

  // 6. Verify cart
  console.log('[5/5] Verifying cart…');
  const { res: showRes, data: show } = await callApi(
    'cart/show',
    `${API_BASE}/cart/show/${encodeURIComponent(cartId)}`,
    { headers: { Accept: 'application/json', Authorization: `Bearer ${token}` } }
  );
  if (!showRes.ok) {
    throw new Error(
      `Tickets were added but cart/show failed (HTTP ${showRes.status}). ` +
        `Cart ${cartId} may still hold ${take} tickets — check manually. ` +
        JSON.stringify(show).slice(0, 300)
    );
  }
  const items = show?.data?.items || [];
  if (!items.length) {
    throw new Error(`cart/show returned no items for cart ${cartId} — add may not have stuck. Check manually.`);
  }
  const itemIds = items.map((it) => Number(it.id)).filter((n) => Number.isInteger(n));
  if (!itemIds.length) throw new Error(`cart/show items have no usable ids for cart ${cartId}.`);
  const totalQty = items.reduce(
    (sum, it) => sum + (it?.tickets || []).reduce((s, t) => s + Number(t.quantity || 0), 0),
    0
  );

  console.log('\n================ SUCCESS ================');
  console.log(`DATE / TIME : ${DATE} ${TIME} (timetable ${timetableId})`);
  console.log(`CART_ID     : ${cartId}`);
  console.log(`TOKEN       : ${token}`);
  console.log(`EXPIRES_AT  : ${expiresAt || show?.data?.expires_at || 'see cart/show'}`);
  console.log(`ITEM_IDs    : [${itemIds.join(', ')}]`);
  console.log(`TOTAL_QTY   : ${totalQty} (requested ${take})`);
  console.log(`TOTAL_PRICE : ${show?.data?.total ?? '?'} EUR`);
  if (totalQty !== take) {
    console.log(`WARNING: quantity mismatch — cart holds ${totalQty}, requested ${take}.`);
  }
  console.log('=======================================\n');
  console.log('Paste into delete.js:');
  console.log(`  const CART_ID = '${cartId}';`);
  console.log(`  const ITEM_IDS = [${itemIds.join(', ')}];`);
  console.log(`  const TOKEN = '${token}';`);

  const { writeFileSync } = await import('node:fs');
  writeFileSync(
    new URL('./add-result.json', import.meta.url),
    JSON.stringify({ date: DATE, time: TIME, timetableId, ticketId: TICKET_ID, requested: take, chunks, cartId, token, expiresAt, itemIds, totalQty, total: show?.data?.total ?? null }, null, 2)
  );
  console.log('\nSaved to add-result.json');
}

main().catch((e) => {
  console.error('\nFAILED:', e.message);
  process.exit(1);
});
