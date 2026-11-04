#!/usr/bin/env node
// Container-side client for the host rotation helper. The dashboard's
// EGRESS_ROTATE_COMMAND runs this inside the Docker container:
//
//   EGRESS_ROTATE_COMMAND=node /app/tools/host-rotate-client.mjs
//
// It POSTs to the helper on the host (reachable because the container runs
// with --network host, or via the docker bridge IP) and exits 0 only when the
// helper reports a verified new exit IP. The dashboard treats a non-zero exit
// as a failed rotation and keeps its breaker up.

const URL = (process.env.ROTATE_HELPER_URL || 'http://127.0.0.1:3101/rotate').trim();
const TOKEN = (process.env.ROTATE_TOKEN || '').trim();
const TIMEOUT_MS = Number(process.env.ROTATE_CLIENT_TIMEOUT_MS || 150000);

const ctrl = new AbortController();
const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
try {
  const res = await fetch(URL, {
    method: 'POST',
    signal: ctrl.signal,
    headers: TOKEN ? { Authorization: `Bearer ${TOKEN}` } : undefined,
  });
  const body = await res.text();
  console.log(body.trim().slice(0, 400));
  let parsed = null;
  try { parsed = JSON.parse(body); } catch { /* non-JSON */ }
  process.exit(res.ok && parsed?.ok ? 0 : 1);
} catch (e) {
  console.error(`rotate client failed: ${e.message}`);
  process.exit(1);
} finally {
  clearTimeout(timer);
}