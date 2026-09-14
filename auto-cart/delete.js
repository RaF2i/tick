// ============================================================
// REMOVE FROM CART
// Run:  node delete.js
// Does: reuse saved TOKEN (or fresh auth) -> POST /cart/removeitem
//       for each ITEM_ID -> GET /cart/show to confirm empty
// Values come from the output of:  node add.js
// ============================================================

// --- SETTINGS (paste from add.js output) ---
const CART_ID = '40fb5848-abb9-443c-8e2c-01f9e014dc6b';
const ITEM_IDS = [682258, 682259, 682260];
const TOKEN = '1284570|VEJuarXa5mky9lZh0UsWFDeCCkV2dfkpUoQKuZYkeef260cc';

// --- FIXED (do not edit) ---
const API_KEY = process.env.SERVITICKETS_API_KEY || '';
const API_BASE = 'https://admin.catedraldesevilla.servitickets.es/api';

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

async function main() {
  if (!String(CART_ID || '').trim() || CART_ID === 'PASTE_CART_ID_HERE') {
    throw new Error('CART_ID is not set — paste the CART_ID printed by add.js.');
  }
  if (!Array.isArray(ITEM_IDS) || !ITEM_IDS.length) {
    throw new Error('ITEM_IDS is empty — paste the ITEM_IDS array printed by add.js.');
  }
  const bad = ITEM_IDS.filter((v) => !/^\d+$/.test(String(v)) || Number(v) < 1);
  if (bad.length) throw new Error(`ITEM_IDS has invalid ids: [${bad.join(', ')}] (must be positive integers)`);
  const ids = [...new Set(ITEM_IDS.map(Number))];
  if (ids.length !== ITEM_IDS.length) console.log(`Note: ${ITEM_IDS.length - ids.length} duplicate id(s) ignored.`);

  let token = String(TOKEN || '').trim();
  async function freshAuth(label) {
    const { res: authRes, data: auth } = await callApi(label, `${API_BASE}/places/authenticate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ api_key: API_KEY }),
    });
    if (!authRes.ok || !auth?.success || !auth?.token) {
      throw new Error(`Auth failed (HTTP ${authRes.status}): ` + JSON.stringify(auth).slice(0, 500));
    }
    return auth.token;
  }
  if (token) {
    console.log('[1/3] Reusing saved TOKEN from add.js…');
  } else {
    console.log('[1/3] No TOKEN set — authenticating fresh…');
    token = await freshAuth('Authenticate');
    console.log('      OK (fresh token)');
  }
  const H = () => ({
    Accept: 'application/json',
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  });

  console.log(`[2/3] Removing ${ids.length} item(s) from cart ${CART_ID}…`);
  const ok = [];
  const failed = [];
  for (let i = 0; i < ids.length; i += 1) {
    const itemId = ids[i];
    try {
      let attempt = await callApi(`removeitem ${itemId}`, `${API_BASE}/cart/removeitem`, {
        method: 'POST',
        headers: H(),
        body: JSON.stringify({ cart_id: CART_ID, item_id: itemId }),
      });
      if (attempt.res.status === 401 && String(TOKEN || '').trim()) {
        console.log('      saved TOKEN expired, re-authenticating…');
        token = await freshAuth('Re-authenticate');
        attempt = await callApi(`removeitem ${itemId} (retry)`, `${API_BASE}/cart/removeitem`, {
          method: 'POST',
          headers: H(),
          body: JSON.stringify({ cart_id: CART_ID, item_id: itemId }),
        });
      }
      const { res: r, data: j } = attempt;
      if (!r.ok || j?.success === false) {
        failed.push({ itemId, reason: `(HTTP ${r.status}) ` + JSON.stringify(j).slice(0, 300) });
        console.log(`      (${i + 1}/${ids.length}) item ${itemId} FAILED — continuing`);
      } else {
        ok.push(itemId);
        console.log(`      (${i + 1}/${ids.length}) item ${itemId} removed: ${j.message || j.error || 'OK'}`);
      }
    } catch (e) {
      failed.push({ itemId, reason: e.message });
      console.log(`      (${i + 1}/${ids.length}) item ${itemId} FAILED — continuing`);
    }
  }

  console.log('[3/3] Verifying cart…');
  const { res: showRes, data: show } = await callApi(
    'cart/show',
    `${API_BASE}/cart/show/${encodeURIComponent(CART_ID)}`,
    { headers: { Accept: 'application/json', Authorization: `Bearer ${token}` } }
  );
  if (!showRes.ok) {
    console.log(`Verify skipped: cart/show HTTP ${showRes.status} — cart may be expired or deleted.`);
  } else {
    const left = show?.data?.items || [];
    if (left.length) console.log(`Cart still has ${left.length} item(s): [${left.map((x) => x.id).join(', ')}]`);
    else console.log('Cart is empty / cleared.');
  }

  console.log(`\nResult: removed ${ok.length}/${ids.length}${failed.length ? `, FAILED ${failed.length}` : ''}.`);
  if (failed.length) {
    for (const f of failed) console.log(`  item ${f.itemId}: ${f.reason}`);
    throw new Error(`${failed.length} item(s) could not be removed — re-run delete.js for the remaining ids.`);
  }
  console.log('DONE.');
}

main().catch((e) => {
  console.error('\nFAILED:', e.message);
  process.exit(1);
});
