// The public face of TubeDesk: a separate listener (127.0.0.1:remote_port, default 4950) that Tailscale Funnel forwards
// to. It serves only what remote AI apps need — the MCP endpoint, OAuth sign-in, the OpenAPI tool spec, tool calls and
// Instagram media leases — and every tool call needs a valid OAuth token or API key. The full app (UI, settings, raw API)
// stays on the local port and is never reachable through the tunnel.
import express from 'express';
import { getSetting } from './db.js';
import * as remote from './services/remote.js';
import { servePublic } from './services/publish.js';
import { TOOLS, createToolRunner, handleMcpMessage } from '../mcp/tools.js';
import { openapi } from './services/openapi.js';

const localPort = () => Number(process.env.PORT || getSetting('port', 4949));

/** Base URL as the remote client sees it: the stored Funnel address, else the forwarded host. */
function baseUrl(req) {
  const stored = remote.publicUrl();
  if (stored) return stored;
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const proto = req.headers['x-forwarded-proto'] || (/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(String(host)) ? 'http' : 'https');
  return `${proto}://${host}`;
}

/** Tool calls go to the local API with x-tubedesk-origin: remote, which the local app treats as untrusted-for-config. */
function runnerFor(identity) {
  return createToolRunner(async (method, path, body) => {
    const res = await fetch(`http://127.0.0.1:${localPort()}${path}`, {
      method, body: body ? JSON.stringify(body) : undefined,
      headers: { ...(body ? { 'content-type': 'application/json' } : {}), 'x-tubedesk-origin': 'remote', 'x-tubedesk-client': encodeURIComponent(identity.name || 'remote') },
    });
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
    if (!res.ok) throw new Error(json?.error || `${method} ${path} → ${res.status}`);
    return json;
  });
}

// Small fixed-window limiter per client address for the unauthenticated endpoints.
const hits = new Map();
const RATE_SCALE = Number(process.env.TUBEDESK_RATE_SCALE || 1); // tests raise it
function limit(max, windowMs) {
  max = Math.round(max * RATE_SCALE);
  return (req, res, next) => {
    // Through the tunnel every request arrives from 127.0.0.1 and X-Forwarded-For can't be trusted, so the limits are
    // global per endpoint — a stranger can't multiply them by rotating headers.
    // Express matches routes case-insensitively and ignores a trailing slash: count them as one.
    const key = req.method + ' /' + req.path.toLowerCase().split('/').filter(Boolean).join('/'), t = Date.now();
    const h = hits.get(key) || { n: 0, reset: t + windowMs };
    if (h.reset < t) { h.n = 0; h.reset = t + windowMs; }
    h.n++; hits.set(key, h);
    if (h.n > max) return res.status(429).json({ error: 'too_many_requests' });
    next();
  };
}

const oauthError = (res, e) => {
  if (e.redirect) return res.redirect(302, e.redirect);
  res.status(e.status && e.status < 500 ? e.status : 400).json(e.oauth || { error: 'invalid_request', error_description: e.message });
};

export function createPublicApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', false);
  app.use(express.json({ limit: '2mb' }));
  app.use(express.urlencoded({ extended: false, limit: '64kb' }));
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    // MCP web clients (claude.ai, ChatGPT) call the metadata/token endpoints from the browser.
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Mcp-Session-Id, Mcp-Protocol-Version');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id, WWW-Authenticate');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  app.get('/', (req, res) => res.type('text/plain').send(`TubeDesk — MCP endpoint: ${baseUrl(req)}/mcp · OpenAPI: ${baseUrl(req)}/openapi.json`));

  // ---- discovery (RFC 9728 protected resource, RFC 8414 authorization server) ----
  const resourceMeta = (req, res) => res.json({ resource: `${baseUrl(req)}/mcp`, authorization_servers: [baseUrl(req)], scopes_supported: ['tubedesk'], bearer_methods_supported: ['header'], resource_name: 'TubeDesk' });
  app.get('/.well-known/oauth-protected-resource', resourceMeta);
  app.get('/.well-known/oauth-protected-resource/mcp', resourceMeta);
  const asMeta = (req, res) => {
    const b = baseUrl(req);
    res.json({
      issuer: b, authorization_endpoint: `${b}/authorize`, token_endpoint: `${b}/token`, registration_endpoint: `${b}/register`, revocation_endpoint: `${b}/revoke`,
      response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'], scopes_supported: ['tubedesk'],
    });
  };
  app.get('/.well-known/oauth-authorization-server', asMeta);
  app.get('/.well-known/oauth-authorization-server/mcp', asMeta);
  app.get('/.well-known/openid-configuration', asMeta);

  // ---- OAuth ----
  // Limits only stop floods: approval codes have their own global lock, approval texts their own cap, and /token
  // takes high-entropy inputs, so it isn't limited at all (a stranger can't starve connected apps' refreshes).
  app.post('/register', limit(60, 600e3), (req, res) => { try { res.status(201).json(remote.registerClient(req.body || {})); } catch (e) { oauthError(res, e); } });
  app.get('/authorize', limit(120, 600e3), (req, res) => {
    try { const { request } = remote.startAuthorization(req.query); res.type('html').send(approvalPage(request)); }
    catch (e) { if (e.redirect) return res.redirect(302, e.redirect); res.status(400).type('html').send(page('Can’t connect', `<p>${esc(e.message)}</p>`)); }
  });
  app.get('/authorize/status', (req, res) => { const r = remote.getRequest(req.query.request); res.json(r ? { approved: r.approved, denied: r.denied, expiresIn: r.expiresIn } : { expired: true }); });
  app.post('/authorize', limit(120, 600e3), (req, res) => {
    try {
      const url = remote.completeAuthorization(req.body.request, { code: req.body.code, deny: req.body.decision === 'deny' });
      if (req.body.json === '1') return res.json({ redirect: url });
      res.redirect(302, url);
    } catch (e) {
      if (req.body.json === '1') return res.status(400).json({ error: e.oauth?.error || 'error', message: e.message });
      const r = remote.getRequest(req.body.request);
      res.status(400).type('html').send(r ? approvalPage(r, e.message) : page('Expired', `<p>${esc(e.message)}</p>`));
    }
  });
  app.post('/token', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try { res.json(remote.token(req.body || {}, req.headers)); } catch (e) { oauthError(res, e); }
  });
  app.post('/revoke', (req, res) => { remote.revokeToken(req.body?.token); res.sendStatus(200); });

  // ---- auth for MCP + tools ----
  const requireAuth = (req, res, next) => {
    const who = remote.verifyBearer(req.headers.authorization);
    if (!who) {
      res.setHeader('WWW-Authenticate', `Bearer realm="TubeDesk", resource_metadata="${baseUrl(req)}/.well-known/oauth-protected-resource"`);
      return res.status(401).json({ error: 'unauthorized', error_description: 'Connect this app to TubeDesk first (OAuth), or send an API key as Authorization: Bearer <key>.' });
    }
    req.identity = who;
    next();
  };

  // ---- MCP, Streamable HTTP (JSON responses; no server-initiated stream) ----
  app.post('/mcp', requireAuth, async (req, res) => {
    const runTool = runnerFor(req.identity);
    const base = baseUrl(req);
    const msgs = Array.isArray(req.body) ? req.body : [req.body];
    const out = [];
    for (const m of msgs) { const r = await handleMcpMessage(m, { runTool, base }); if (r) out.push(r); }
    if (!out.length) return res.sendStatus(202);
    if (msgs.some(m => m?.method === 'initialize')) res.setHeader('Mcp-Session-Id', 'td-' + Date.now().toString(36));
    res.json(Array.isArray(req.body) ? out : out[0]);
  });
  app.get('/mcp', (req, res) => res.status(405).setHeader('Allow', 'POST').json({ error: 'TubeDesk answers MCP over POST (no server-initiated stream).' }));
  app.delete('/mcp', (req, res) => res.sendStatus(204));

  // ---- OpenAPI tools (GPT Actions, Gemini/Grok function calling, n8n, scripts) ----
  app.get('/openapi.json', (req, res) => res.json(openapi({ base: baseUrl(req), profile: req.query.for || 'all' })));
  app.post('/api/tools/:name', requireAuth, async (req, res) => {
    if (!TOOLS.some(t => t.name === req.params.name)) return res.status(404).json({ error: `unknown tool ${req.params.name}` });
    try { res.json(await runnerFor(req.identity)(req.params.name, req.body || {})); }
    catch (e) { res.status(400).json({ error: e.message }); }
  });

  // ---- Instagram media leases (unguessable, expire with the publish job) ----
  app.get('/public/media/:token', (req, res) => {
    const file = servePublic(String(req.params.token).replace(/\.[a-z0-9]+$/i, ''));
    if (!file) return res.status(404).send('expired');
    res.sendFile(file);
  });

  app.use((req, res) => res.status(404).json({ error: 'not found' }));
  app.use((err, req, res, next) => { res.status(err.status && err.status < 500 ? err.status : 500).json({ error: err.status && err.status < 500 ? err.message : 'internal error' }); });
  return app;
}

// ---------- approval page ----------
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function page(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)} · TubeDesk</title>
<style>body{font:16px/1.5 -apple-system,system-ui,sans-serif;background:#0f1115;color:#e8e9ec;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}
.card{background:#171a21;border:1px solid #262a33;border-radius:16px;padding:28px;max-width:420px;width:calc(100% - 32px)}h1{font-size:20px;margin:0 0 8px}.mini{color:#9aa0ab;font-size:14px}
input{font:600 28px/1 ui-monospace,monospace;letter-spacing:6px;text-align:center;width:100%;box-sizing:border-box;padding:12px;border-radius:10px;border:1px solid #333a46;background:#0f1115;color:#fff;margin:14px 0}
button{font:600 16px system-ui;border:0;border-radius:10px;padding:12px 16px;cursor:pointer}.go{background:#ff3b30;color:#fff;width:100%}.no{background:transparent;color:#9aa0ab;width:100%;margin-top:6px}.err{color:#ff8a80;font-size:14px}.app{font-weight:600}</style></head><body><div class="card">${body}</div></body></html>`;
}
function approvalPage(r, error = '') {
  return page('Approve', `<h1>Connect <span class="app">${esc(r.name)}</span> to TubeDesk?</h1>
<p class="mini">It will be able to read your channel data and act through TubeDesk (score, schedule, publish). Requested from <b>${esc(r.host)}</b>.</p>
<p class="mini">Enter the 8-digit code sent to your phone, or press <b>Approve</b> in TubeDesk on your Mac (Settings → Use TubeDesk from any AI).</p>
${error ? `<p class="err">${esc(error)}</p>` : ''}
<form method="post" action="/authorize" autocomplete="off"><input type="hidden" name="request" value="${esc(r.id)}">
<input name="code" inputmode="numeric" pattern="[0-9 ]*" maxlength="9" placeholder="••••••••" autofocus>
<button class="go" type="submit" name="decision" value="approve">Approve</button><button class="no" type="submit" name="decision" value="deny" formnovalidate>Deny</button></form>
<script>(function(){var id=${JSON.stringify(r.id)};function poll(){fetch('/authorize/status?request='+encodeURIComponent(id)).then(function(x){return x.json()}).then(function(s){
if(s.approved||s.denied){var f=new FormData();f.append('request',id);f.append('json','1');if(s.denied)f.append('decision','deny');fetch('/authorize',{method:'POST',body:new URLSearchParams(f)}).then(function(x){return x.json()}).then(function(j){if(j.redirect)location.href=j.redirect})}
else if(!s.expired)setTimeout(poll,2000)}).catch(function(){setTimeout(poll,4000)})}setTimeout(poll,2000)})();</script>`);
}
