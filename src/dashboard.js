// Minimal hard-locked dashboard using Node's built-in http only.
// No third-party web framework => nothing to exploit in the request path.
import http from "http";
import crypto from "crypto";
import { getDeliveries, getEvents } from "./db.js";

const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60 * 1000;
const RATE_LIMIT_MS = 60 * 1000;
const RATE_LIMIT_MAX = 30;

const escHtml = (s) => String(s ?? "")
  .replace(/&/g, "&amp;")
  .replace(/</g, "&lt;")
  .replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;")
  .replace(/'/g, "&#39;");

function securityHeaders(res) {
  res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Server", "");
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a || ""));
  const bb = Buffer.from(String(b || ""));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  securityHeaders(res);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}

function sendText(res, status, body, type = "text/plain; charset=utf-8") {
  securityHeaders(res);
  res.writeHead(status, { "Content-Type": type, "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}

export function createDashboardServer(db, runScanFn) {
  const token = process.env.ACCESS_TOKEN || "";
  const isLocalBind = true; // bind loopback upstream in index.js

  // --- state ---
  let hits = new Map();          // ip -> {t, n}
  const failState = new Map();   // ip -> {fails, lockedUntil}

  const limiter = setInterval(() => {
    const expire = Date.now() - RATE_LIMIT_MS;
    for (const [k, v] of hits) if (v.t < expire) hits.delete(k);
  }, 60 * 1000);
  limiter.unref();

  function rateLimited(ip) {
    const now = Date.now();
    const e = hits.get(ip);
    if (!e || e.t < now - RATE_LIMIT_MS) {
      hits.set(ip, { t: now, n: 1 });
      return false;
    }
    e.n++;
    return e.n > RATE_LIMIT_MAX;
  }

  function lockedOut(ip) {
    const s = failState.get(ip);
    if (!s) return false;
    if (s.lockedUntil && Date.now() < s.lockedUntil) return true;
    return false;
  }

  function registerFail(ip) {
    const s = failState.get(ip) || { fails: 0, lockedUntil: 0 };
    s.fails++;
    if (s.fails >= MAX_FAILED_ATTEMPTS) {
      s.lockedUntil = Date.now() + LOCKOUT_MS;
      s.fails = 0;
    }
    failState.set(ip, s);
  }

  function isAuthorized(req, url) {
    if (lockedOut(req.socket.remoteAddress || "")) return false;
    if (rateLimited(req.socket.remoteAddress || "")) return false;
    if (!token) return false;
    const fromQuery = url.searchParams.get("token") || "";
    const h = req.headers.authorization || "";
    const fromHeader = h.startsWith("Bearer ") ? h.slice(7).trim() : "";
    const supplied = fromQuery || fromHeader || "";
    const ok = supplied && safeEqual(supplied, token);
    if (!ok) registerFail(req.socket.remoteAddress || "");
    return ok;
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const path = url.pathname;

    // static assets (no auth needed; they contain no data)
    if (path === "/assets/style.css") return sendText(res, 200, CSS, "text/css; charset=utf-8");
    if (path === "/assets/app.js") return sendText(res, 200, JS, "text/javascript; charset=utf-8");

    if (path === "/api/health") {
      if (rateLimited(req.socket.remoteAddress || "")) return sendJson(res, 429, { error: "Too many requests" });
      return sendJson(res, 200, { ok: true, ts: new Date().toISOString() });
    }

    // everything below requires the token
    if (!isAuthorized(req, url)) {
      return sendText(res, 403, "Forbidden. This dashboard is restricted.");
    }

    if (path === "/" ) {
      return sendText(res, 200, pageHtml(), "text/html; charset=utf-8");
    }

    if (path === "/api/data") {
      return sendJson(res, 200, { deliveries: getDeliveries(db, 200), events: getEvents(db, 50) });
    }

    if (path === "/api/run-scan" && req.method === "POST") {
      try {
        const result = await runScanFn();
        return sendJson(res, 200, result);
      } catch (e) {
        return sendJson(res, 500, { ok: false, error: e.message });
      }
    }

    return sendJson(res, 404, { error: "Not found" });
  });

  return server;
}

function pageHtml() {
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sims4 Order Mailer</title>
<link rel="stylesheet" href="/assets/style.css">
</head><body>
<div class="wrap">
<h1>Sims4 Order Mailer</h1>
<p class="sub">Local dashboard - bound to 127.0.0.1 on this PC only. The cloud worker has no web interface at all.</p>

<div class="card">
  <h3>Actions</h3>
  <button class="btn" onclick="runScan()">Run a scan now</button>
  <span id="scanresult" class="ms"></span>
  <span id="health" class="ms"></span>
</div>

<div class="card"><h3>Deliveries</h3>
<table><thead><tr><th>Detected</th><th>Buyer</th><th>Amount</th><th>Status</th><th>Last error</th><th>Subject</th></tr></thead>
<tbody id="drows"><tr><td colspan=6>Loading...</td></tr></tbody></table></div>

<div class="card"><h3>Event log</h3>
<table><thead><tr><th>Time</th><th>Level</th><th>Action</th><th>Detail</th></tr></thead>
<tbody id="erows"><tr><td colspan=4>Loading...</td></tr></tbody></table></div>

</div>
<script src="/assets/app.js"></script>
</body></html>`;
}

const CSS = `
body{font-family:'Segoe UI',Arial,sans-serif;background:#EAF7FB;margin:0;padding:24px;}
.wrap{max-width:980px;margin:auto;}
h1{color:#1E9E46;} .sub{color:#5C6C78;}
.card{background:#fff;border-radius:12px;padding:18px 22px;margin:14px 0;box-shadow:0 2px 8px rgba(0,0,0,.06);}
table{width:100%;border-collapse:collapse;font-size:13px;}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid #eee;vertical-align:top;}
th{color:#25415E;}
.t-sent{color:#1E9E46;font-weight:bold;} .t-skipped{color:#8AA09A;} .t-failed{color:#d33;}
.btn{background:#1E9E46;color:#fff;border:0;padding:8px 14px;border-radius:8px;cursor:pointer;font-size:13px;}
.ms{margin-left:12px;color:#5C6C78;}
`;

const JS = `
(function(){
  const tkn=new URLSearchParams(location.search).get('token')||'';
  function esc(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');}
  function withToken(u){return u+(tkn?(u.indexOf('?')<0?'?':'&')+'token='+encodeURIComponent(tkn):'');}
  function getJSON(u){return fetch(withToken(u)).then(function(r){if(!r.ok){return r.text().then(function(t){throw new Error(t);});}return r.json();});}
  function postJSON(u){return fetch(withToken(u),{method:'POST'}).then(function(r){if(!r.ok){return r.text().then(function(t){throw new Error(t);});}return r.json();});}
  function load(){
    getJSON('/api/data').then(function(d){
      document.getElementById('drows').innerHTML=(d.deliveries&&d.deliveries.length)?
        d.deliveries.map(function(r){return '<tr><td>'+esc(r.detected_at)+'</td><td>'+esc(r.buyer_email)+'</td><td>'+esc(r.order_amount)+'</td><td class="t-'+esc(r.status)+'">'+esc(r.status)+'</td><td>'+esc(r.last_error)+'</td><td>'+esc(r.subject)+'</td></tr>';}).join(''):
        '<tr><td colspan=6>No deliveries yet.</td></tr>';
      document.getElementById('erows').innerHTML=(d.events&&d.events.length)?
        d.events.map(function(e){return '<tr><td>'+esc(e.ts)+'</td><td>'+esc(e.level)+'</td><td>'+esc(e.action)+'</td><td>'+esc(e.detail)+'</td></tr>';}).join(''):
        '<tr><td colspan=4>No events yet.</td></tr>';
    }).catch(function(e){document.getElementById('erows').innerHTML='<tr><td colspan=4>Error: '+esc(e.message)+'</td></tr>';});
  }
  function runScan(){
    const el=document.getElementById('scanresult');el.textContent='Scanning...';
    postJSON('/api/run-scan').then(function(j){el.textContent='Done - processed '+(j.processed||0)+' message(s).';load();}).catch(function(e){el.textContent='Error: '+e.message;});
  }
  getJSON('/api/health').then(function(){document.getElementById('health').textContent='Server online';}).catch(function(){document.getElementById('health').textContent='Server unreachable';});
  load();
})();
`;