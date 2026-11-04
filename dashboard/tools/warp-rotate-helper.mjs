#!/usr/bin/env node
// Host-side rotation helper for Docker deployments.
//
// The dashboard container has no warp-cli, so rotation is delegated to this
// tiny listener on the HOST: the container's EGRESS_ROTATE_COMMAND calls it,
// it performs the warp-cli rotation locally and verifies the new route the
// same way the dashboard would (trace through the privoxy bridge, warp=on).
//
// Isolation: binds to 127.0.0.1 only, so nothing outside the VPS can reach
// it. Optionally set ROTATE_TOKEN and the client must send it as
// "Authorization: Bearer <token>" — then only a caller that knows the token
// can trigger rotations.
//
// Run it under systemd (see HOSTING.md):
//   node /root/tick-docker/tools/warp-rotate-helper.mjs
//
// Env:
//   ROTATE_HELPER_PORT  listen port (default 3101)
//   ROTATE_HELPER_HOST  bind address (default 127.0.0.1; use 172.17.0.1 for
//                       Docker containers to reach it — a non-loopback bind
//                       REQUIRES ROTATE_TOKEN)
//   ROTATE_TOKEN        optional shared secret
//   WARP_PROXY_PORT     WARP SOCKS port (default 40000)
//   WARP_HTTP_PORT      privoxy HTTP bridge port (default 8118)

import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);
const PORT = Number(process.env.ROTATE_HELPER_PORT || 3101);
const HOST = (process.env.ROTATE_HELPER_HOST || '127.0.0.1').trim();
const TOKEN = (process.env.ROTATE_TOKEN || '').trim();
const WARP_PROXY_PORT = Number(process.env.WARP_PROXY_PORT || 40000);
const WARP_HTTP_PORT = Number(process.env.WARP_HTTP_PORT || 8118);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function log(line) {
  console.log(`${new Date().toISOString()} ${line}`);
}

async function wcli(args, timeoutMs = 30000) {
  return execFileP('warp-cli', ['--accept-tos', ...args], { timeout: timeoutMs, maxBuffer: 1024 * 1024 });
}

// Verify the route through the privoxy bridge: the trace must carry ip= AND
// warp=on|plus. Anything else (warp=off, no answer) is the real VPS IP.
async function verifyRoute() {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch('https://www.cloudflare.com/cdn-cgi/trace', { signal: ctrl.signal, dispatcher: undefined });
    clearTimeout(t);
    const text = await res.text();
    const ip = text.match(/^ip=(.+)$/m)?.[1]?.trim() || null;
    const warp = text.match(/^warp=(.+)$/m)?.[1]?.trim() || null;
    const ok = Boolean(ip) && (warp === 'on' || warp === 'plus');
    return { ok, ip, warp };
  } catch (e) {
    clearTimeout(t);
    return { ok: false, ip: null, warp: null, error: e.message };
  }
}

// NOTE: node fetch does not honor a proxy dispatcher without undici; use the
// ProxyAgent if undici is available next to this script, else curl.
async function verifyRouteViaBridge() {
  const proxy = `http://127.0.0.1:${WARP_HTTP_PORT}`;
  try {
    const { execFileP: ef } = { execFileP };
    const { stdout } = await ef('curl', ['-s', '-m', '15', '-x', proxy, 'https://www.cloudflare.com/cdn-cgi/trace'], { timeout: 20000 });
    const ip = stdout.match(/^ip=(.+)$/m)?.[1]?.trim() || null;
    const warp = stdout.match(/^warp=(.+)$/m)?.[1]?.trim() || null;
    return { ok: Boolean(ip) && (warp === 'on' || warp === 'plus'), ip, warp };
  } catch (e) {
    return { ok: false, ip: null, warp: null, error: e.message };
  }
}

let rotating = false;

async function rotate() {
  if (rotating) return { ok: false, error: 'rotation already in progress' };
  rotating = true;
  try {
    log('ROTATE: requested');
    try { await wcli(['mode', 'proxy']); await wcli(['proxy', 'port', String(WARP_PROXY_PORT)]); } catch { /* may already be set */ }
    try { await wcli(['registration', 'delete']); } catch { /* fine if none */ }
    await sleep(3000); // daemon teardown before "registration new"
    let registered = false;
    for (let i = 0; i < 3 && !registered; i++) {
      try { await wcli(['registration', 'new']); registered = true; }
      catch (e) { log(`ROTATE: registration new failed (${String(e.message).slice(0, 120)}), retry ${i + 1}/3`); await sleep(5000); }
    }
    if (!registered) return { ok: false, error: 'registration new failed 3 times' };
    try { await wcli(['connect']); } catch { /* may already be connecting */ }
    // Poll the trace through the bridge until the tunnel proves itself.
    const deadline = Date.now() + 60_000;
    let v = null;
    while (Date.now() < deadline) {
      v = await verifyRouteViaBridge();
      if (v.ok) break;
      await sleep(2000);
    }
    if (!v?.ok) {
      log(`ROTATE: verify failed (${v?.error || v?.warp || 'no answer'})`);
      return { ok: false, error: v?.error || `tunnel never proved itself (warp=${v?.warp})` };
    }
    log(`ROTATE: ok — new exit IP ${v.ip} (warp=${v.warp})`);
    return { ok: true, ip: v.ip, warp: v.warp };
  } catch (e) {
    log(`ROTATE: failed — ${e.message}`);
    return { ok: false, error: e.message };
  } finally {
    rotating = false;
  }
}

if (HOST !== '127.0.0.1' && HOST !== 'localhost' && !TOKEN) {
  log(`REFUSING to bind ${HOST} without ROTATE_TOKEN — the rotate endpoint would be open to the network. Set ROTATE_TOKEN or keep 127.0.0.1.`);
  process.exit(1);
}

createServer(async (req, res) => {
  if (req.method === 'POST' && req.url === '/rotate') {
    if (TOKEN) {
      const auth = String(req.headers.authorization || '');
      if (auth !== `Bearer ${TOKEN}`) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: false, error: 'bad token' }));
      }
    }
    const result = await rotate();
    res.writeHead(result.ok ? 200 : 502, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(result));
  }
  if (req.method === 'GET' && req.url === '/health') {
    const v = await verifyRouteViaBridge();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, route: v, port: PORT }));
  }
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: false, error: 'POST /rotate or GET /health' }));
}).listen(PORT, HOST, () => {
  log(`warp-rotate-helper listening on ${HOST}:${PORT} (token: ${TOKEN ? 'on' : 'off'}, bridge: 127.0.0.1:${WARP_HTTP_PORT})`);
});