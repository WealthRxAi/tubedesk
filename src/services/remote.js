// Remote access for AI apps that don't run on this Mac (ChatGPT, Claude web/phone, Gemini, Grok, n8n…).
//  - OAuth 2.1 authorization server for MCP connectors: dynamic client registration, PKCE (S256 only), the owner approves
//    each new app with a 8-digit code sent to their phone (or one click in TubeDesk on the Mac), rotating refresh tokens.
//  - API keys for clients that take a bearer header (OpenAPI/GPT Actions, Gemini CLI, scripts).
//  - Tailscale Funnel: one permanent https address (https://<mac>.<tailnet>.ts.net) forwarding to the public listener.
// Tokens and keys are stored only as SHA-256 hashes.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { db, getSetting, setSetting } from '../db.js';
import { notify } from './notify.js';

db.exec(`
CREATE TABLE IF NOT EXISTS remote_clients (
  client_id TEXT PRIMARY KEY,
  secret_hash TEXT,
  name TEXT NOT NULL,
  redirect_uris TEXT NOT NULL,
  auth_method TEXT NOT NULL DEFAULT 'none',
  approved INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at TEXT
);
CREATE TABLE IF NOT EXISTS remote_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,               -- access | refresh | api_key
  hash TEXT NOT NULL UNIQUE,
  client_id TEXT,                   -- OAuth client (null for API keys)
  name TEXT,                        -- API key label
  prefix TEXT,                      -- first characters, to recognise a key
  scope TEXT NOT NULL DEFAULT 'tubedesk',
  expires_at INTEGER,               -- ms epoch; null = no expiry (API keys)
  revoked INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_remote_tokens_client ON remote_tokens(client_id);
`);

export const ACCESS_TTL = 24 * 3600e3;
export const REFRESH_TTL = 180 * 24 * 3600e3;
const CODE_TTL = 60e3;
const REQUEST_TTL = 10 * 60e3;
const MAX_ATTEMPTS = 5;
const MAX_FAILED_PER_HOUR = 20; // across all requests: beyond this, codes stop working until the owner approves on the Mac
const failed = [];
const codeLocked = () => { while (failed.length && failed[0] < Date.now() - 3600e3) failed.shift(); return failed.length >= MAX_FAILED_PER_HOUR; };

const sha = s => crypto.createHash('sha256').update(String(s)).digest('hex');
const rand = (n = 32) => crypto.randomBytes(n).toString('base64url');
const b64urlSha = s => crypto.createHash('sha256').update(String(s)).digest('base64url');
const nowIso = () => new Date().toISOString();
const httpErr = (status, error, description) => Object.assign(new Error(description || error), { status, oauth: { error, error_description: description } });

export const remotePort = () => Number(process.env.TUBEDESK_PUBLIC_PORT || getSetting('remote_port', 4950));
export const publicUrl = () => (getSetting('remote_public_url', '') || '').replace(/\/$/, '');

// ---------- clients (RFC 7591 dynamic registration) ----------
function validRedirect(u) {
  try {
    const x = new URL(u);
    if (x.hash) return false;
    if (x.protocol === 'https:') return true;
    if (x.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(x.hostname)) return true; // native/CLI loopback
    return /^[a-z][a-z0-9+.-]*:$/.test(x.protocol) && !['javascript:', 'data:', 'file:', 'http:'].includes(x.protocol); // custom app schemes (e.g. cursor://)
  } catch { return false; }
}

export function registerClient(body = {}) {
  const uris = Array.isArray(body.redirect_uris) ? body.redirect_uris.map(String) : [];
  if (!uris.length || uris.length > 10 || !uris.every(validRedirect)) throw httpErr(400, 'invalid_redirect_uri', 'redirect_uris must be https URLs (or http://localhost for local apps)');
  const name = String(body.client_name || 'AI app').replace(/[\u0000-\u001f<>]/g, '').slice(0, 80) || 'AI app';
  const method = ['client_secret_post', 'client_secret_basic'].includes(body.token_endpoint_auth_method) ? body.token_endpoint_auth_method : 'none';
  // Unapproved registrations are capped: the oldest beyond 500 are dropped (approved apps are never touched).
  db.prepare("DELETE FROM remote_clients WHERE approved = 0 AND client_id NOT IN (SELECT client_id FROM remote_clients WHERE approved = 0 ORDER BY created_at DESC, rowid DESC LIMIT 499)").run();
  const client_id = 'td_' + rand(18);
  const secret = method === 'none' ? null : rand(32);
  db.prepare('INSERT INTO remote_clients (client_id, secret_hash, name, redirect_uris, auth_method) VALUES (?, ?, ?, ?, ?)')
    .run(client_id, secret ? sha(secret) : null, name, JSON.stringify(uris), method);
  return {
    client_id, ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}), client_id_issued_at: Math.floor(Date.now() / 1000),
    client_name: name, redirect_uris: uris, token_endpoint_auth_method: method,
    grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], scope: 'tubedesk',
  };
}
const getClient = id => {
  const c = db.prepare('SELECT * FROM remote_clients WHERE client_id = ?').get(String(id || ''));
  return c ? { ...c, redirect_uris: JSON.parse(c.redirect_uris) } : null;
};

// ---------- authorization requests: the owner approves with a code or one click ----------
const requests = new Map(); // id → request
const codes = new Map();    // sha(code) → grant
const notifyTimes = [];
const MAX_TEXTS_PER_HOUR = Number(process.env.TUBEDESK_MAX_APPROVAL_TEXTS || 10);
function sweep() {
  const t = Date.now();
  for (const [k, r] of requests) if (r.expires < t) requests.delete(k);
  for (const [k, c] of codes) if (c.expires < t) codes.delete(k);
}

/** Validate an /authorize request and create a pending approval. Throws {redirect} errors where OAuth says to redirect. */
export function startAuthorization(q) {
  sweep();
  const client = getClient(q.client_id);
  if (!client) throw httpErr(400, 'invalid_client', 'Unknown app. Remove the connector in your AI app and add it again.');
  const redirect = String(q.redirect_uri || (client.redirect_uris.length === 1 ? client.redirect_uris[0] : ''));
  if (!client.redirect_uris.includes(redirect)) throw httpErr(400, 'invalid_request', 'redirect_uri does not match the registered one');
  // Error redirects only go to apps the owner already approved — otherwise anyone could register a redirect and use the
  // owner's address as an open redirector. Unapproved apps get the error on the page instead.
  const back = (error, error_description) => client.approved
    ? Object.assign(new Error(error_description), { status: 302, redirect: withParams(redirect, { error, error_description, state: q.state }) })
    : httpErr(400, error, error_description);
  if (q.response_type !== 'code') throw back('unsupported_response_type', 'only response_type=code is supported');
  if (!q.code_challenge || q.code_challenge_method !== 'S256') throw back('invalid_request', 'PKCE with code_challenge_method=S256 is required');
  // A flood of requests can't block a real one: the oldest pending request makes room.
  while (requests.size >= 50) requests.delete(requests.keys().next().value);
  const id = rand(18);
  const code = String(crypto.randomInt(0, 1e8)).padStart(8, '0');
  const r = { id, client_id: client.client_id, name: client.name, redirect, state: q.state ?? null, challenge: String(q.code_challenge), scope: 'tubedesk', resource: q.resource || null, code_hash: sha(code), attempts: 0, approved: false, denied: false, expires: Date.now() + REQUEST_TTL, created: nowIso(), host: safeHost(redirect) };
  requests.set(id, r);
  // At most 10 approval texts per hour (by default), so a stranger hammering /authorize can't flood the owner's phone.
  notifyTimes.push(Date.now()); while (notifyTimes.length && notifyTimes[0] < Date.now() - 3600e3) notifyTimes.shift();
  if (notifyTimes.length <= MAX_TEXTS_PER_HOUR) notify({ kind: 'remote_access', force: true, secret: code, title: `TubeDesk approval code: ${code}`, body: `${r.host} ("${client.name}") wants to use TubeDesk. Enter ${code} on the approval page, or press Approve in TubeDesk → Settings → Use TubeDesk from any AI. Expires in 10 minutes. If this wasn't you, ignore it.` }).catch(() => {});
  return { request: publicRequest(r) };
}
const safeHost = u => { try { return new URL(u).host || new URL(u).protocol; } catch { return '?'; } };
const publicRequest = r => ({ id: r.id, client_id: r.client_id, name: r.name, host: r.host, created: r.created, expiresIn: Math.max(0, Math.round((r.expires - Date.now()) / 1000)), approved: r.approved, denied: r.denied });
export function pendingRequests() { sweep(); return [...requests.values()].filter(r => !r.approved && !r.denied).map(publicRequest); }
export function getRequest(id) { sweep(); const r = requests.get(String(id)); return r ? publicRequest(r) : null; }

/** Owner decision from the Mac (no code needed). */
export function decideLocally(id, approve) {
  const r = requests.get(String(id));
  if (!r || r.expires < Date.now()) throw httpErr(404, 'not_found', 'This approval request expired — start the connection again in the AI app.');
  if (approve) r.approved = true; else r.denied = true;
  return publicRequest(r);
}

/** Approval page submit: check the code (or a local approval), then mint the authorization code. Returns the redirect URL. */
export function completeAuthorization(id, { code = null, deny = false } = {}) {
  sweep();
  const r = requests.get(String(id));
  if (!r) throw httpErr(400, 'expired', 'This approval request expired — start the connection again in the AI app.');
  if (deny || r.denied) { requests.delete(r.id); return withParams(r.redirect, { error: 'access_denied', error_description: 'The owner declined', state: r.state }); }
  if (!r.approved) {
    if (code === null || code === undefined || code === '') throw httpErr(400, 'code_required', 'Enter the 8-digit code.');
    if (codeLocked()) throw httpErr(400, 'locked', 'Too many wrong codes recently — approve this app in TubeDesk on your Mac instead (Settings → Use TubeDesk from any AI).');
    r.attempts++;
    if (sha(String(code).replace(/\D/g, '')) !== r.code_hash) {
      failed.push(Date.now());
      if (r.attempts >= MAX_ATTEMPTS) { requests.delete(r.id); throw httpErr(400, 'too_many_attempts', 'Too many wrong codes. Start the connection again in the AI app.'); }
      throw httpErr(400, 'wrong_code', `Wrong code (${MAX_ATTEMPTS - r.attempts} tries left).`);
    }
  }
  requests.delete(r.id);
  db.prepare('UPDATE remote_clients SET approved = 1 WHERE client_id = ?').run(r.client_id);
  const authCode = rand(32);
  codes.set(sha(authCode), { client_id: r.client_id, redirect: r.redirect, challenge: r.challenge, scope: r.scope, expires: Date.now() + CODE_TTL });
  return withParams(r.redirect, { code: authCode, state: r.state, iss: publicUrl() || undefined });
}

function withParams(u, params) {
  const x = new URL(u);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') x.searchParams.set(k, String(v));
  return x.toString();
}

// ---------- token endpoint ----------
function authenticateClient(body, headers) {
  let id = body.client_id, secret = body.client_secret;
  const basic = /^Basic\s+(.+)$/i.exec(headers.authorization || '');
  if (basic) { const [u, p] = Buffer.from(basic[1], 'base64').toString().split(':'); id = decodeURIComponent(u || ''); secret = decodeURIComponent(p || ''); }
  const c = getClient(id);
  if (!c) throw httpErr(401, 'invalid_client', 'unknown client');
  if (c.auth_method !== 'none' && (!secret || sha(secret) !== c.secret_hash)) throw httpErr(401, 'invalid_client', 'client authentication failed');
  return c;
}

function issue(client_id) {
  const access = 'tdat_' + rand(32), refresh = 'tdrt_' + rand(32);
  const ins = db.prepare('INSERT INTO remote_tokens (kind, hash, client_id, prefix, expires_at) VALUES (?, ?, ?, ?, ?)');
  ins.run('access', sha(access), client_id, access.slice(0, 9), Date.now() + ACCESS_TTL);
  ins.run('refresh', sha(refresh), client_id, refresh.slice(0, 9), Date.now() + REFRESH_TTL);
  db.prepare("DELETE FROM remote_tokens WHERE kind = 'access' AND expires_at < ?").run(Date.now() - 7 * 24 * 3600e3);
  return { access_token: access, token_type: 'Bearer', expires_in: Math.round(ACCESS_TTL / 1000), refresh_token: refresh, scope: 'tubedesk' };
}

export function token(body = {}, headers = {}) {
  const client = authenticateClient(body, headers);
  if (body.grant_type === 'authorization_code') {
    const g = codes.get(sha(body.code || ''));
    codes.delete(sha(body.code || '')); // single use
    if (!g || g.expires < Date.now() || g.client_id !== client.client_id) throw httpErr(400, 'invalid_grant', 'authorization code is invalid or expired');
    if (body.redirect_uri && body.redirect_uri !== g.redirect) throw httpErr(400, 'invalid_grant', 'redirect_uri mismatch');
    if (!body.code_verifier || b64urlSha(body.code_verifier) !== g.challenge) throw httpErr(400, 'invalid_grant', 'PKCE verification failed');
    return issue(client.client_id);
  }
  if (body.grant_type === 'refresh_token') {
    const row = db.prepare("SELECT * FROM remote_tokens WHERE hash = ? AND kind = 'refresh'").get(sha(body.refresh_token || ''));
    if (!row || row.client_id !== client.client_id || row.expires_at < Date.now()) throw httpErr(400, 'invalid_grant', 'refresh token is invalid or expired');
    if (row.revoked) { revokeClient(client.client_id, { keepClient: true }); throw httpErr(400, 'invalid_grant', 'refresh token was already used — all tokens for this app were revoked'); }
    db.prepare('UPDATE remote_tokens SET revoked = 1 WHERE id = ?').run(row.id); // rotation
    return issue(client.client_id);
  }
  throw httpErr(400, 'unsupported_grant_type', 'grant_type must be authorization_code or refresh_token');
}

/** RFC 7009: revoke a token the client holds (always 200). */
export function revokeToken(tok) {
  db.prepare("UPDATE remote_tokens SET revoked = 1 WHERE hash = ? AND kind != 'api_key'").run(sha(tok || ''));
}

// ---------- bearer verification ----------
export function verifyBearer(header) {
  const m = /^Bearer\s+(\S+)$/i.exec(header || '');
  if (!m) return null;
  const row = db.prepare("SELECT * FROM remote_tokens WHERE hash = ? AND kind IN ('access', 'api_key')").get(sha(m[1]));
  if (!row || row.revoked || (row.expires_at && row.expires_at < Date.now())) return null;
  db.prepare('UPDATE remote_tokens SET last_used_at = ? WHERE id = ?').run(nowIso(), row.id);
  let name = row.name;
  if (row.client_id) { db.prepare('UPDATE remote_clients SET last_used_at = ? WHERE client_id = ?').run(nowIso(), row.client_id); name = getClient(row.client_id)?.name || 'AI app'; }
  return { kind: row.kind, client_id: row.client_id, name: name || 'API key', tokenId: row.id };
}

// ---------- API keys ----------
export function createApiKey(name) {
  const label = String(name || 'API key').replace(/[\u0000-\u001f<>]/g, '').slice(0, 60) || 'API key';
  const key = 'tdk_' + rand(32);
  const r = db.prepare("INSERT INTO remote_tokens (kind, hash, name, prefix) VALUES ('api_key', ?, ?, ?)").run(sha(key), label, key.slice(0, 8));
  return { id: r.lastInsertRowid, name: label, key, note: 'Shown once. Send it as the header  Authorization: Bearer <key>.' };
}
export function revokeApiKey(id) { return db.prepare("UPDATE remote_tokens SET revoked = 1 WHERE id = ? AND kind = 'api_key'").run(Number(id)).changes > 0; }
export function revokeClient(clientId, { keepClient = false } = {}) {
  const n = db.prepare('UPDATE remote_tokens SET revoked = 1 WHERE client_id = ?').run(String(clientId)).changes;
  if (!keepClient) db.prepare('DELETE FROM remote_clients WHERE client_id = ?').run(String(clientId));
  return n;
}

export function connections() {
  const clients = db.prepare(`SELECT c.client_id, c.name, c.created_at, c.last_used_at,
      (SELECT COUNT(*) FROM remote_tokens t WHERE t.client_id = c.client_id AND t.revoked = 0 AND t.kind = 'refresh' AND t.expires_at > ?) AS active
    FROM remote_clients c WHERE c.approved = 1 ORDER BY COALESCE(c.last_used_at, c.created_at) DESC`).all(Date.now())
    .map(c => ({ ...c, redirectHost: (getClient(c.client_id)?.redirect_uris || []).map(safeHost).join(', ') }));
  const keys = db.prepare("SELECT id, name, prefix, created_at, last_used_at FROM remote_tokens WHERE kind = 'api_key' AND revoked = 0 ORDER BY id DESC").all();
  return { clients, apiKeys: keys };
}

// ---------- Tailscale Funnel ----------
const TS_CANDIDATES = ['tailscale', '/opt/homebrew/bin/tailscale', '/usr/local/bin/tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale'];
export function tailscaleBinary() {
  const set = getSetting('tailscale_path', '');
  if (set) return set;
  for (const c of TS_CANDIDATES) {
    if (c.includes('/')) { if (fs.existsSync(c)) return c; continue; }
    for (const dir of (process.env.PATH || '').split(':')) if (dir && fs.existsSync(`${dir}/${c}`)) return `${dir}/${c}`;
  }
  return null;
}
const run = (bin, args, timeout = 20000) => new Promise(resolve => {
  execFile(bin, args, { timeout }, (err, stdout, stderr) => resolve({ code: err ? (err.code ?? 1) : 0, out: String(stdout || ''), err: String(stderr || ''), timedOut: !!err?.killed }));
});

export async function tunnelStatus() {
  const bin = tailscaleBinary();
  const port = remotePort();
  const base = { port, publicUrl: publicUrl() || null, installed: !!bin };
  if (!bin) return { ...base, state: 'not-installed', next: 'Install Tailscale (free): brew install --cask tailscale, open it once and sign in. Then turn on remote access.' };
  const st = await run(bin, ['status', '--json'], 8000);
  let s = null; try { s = JSON.parse(st.out); } catch { /* not running */ }
  if (!s || s.BackendState !== 'Running') return { ...base, state: 'signed-out', next: 'Open the Tailscale app and sign in (free), then turn on remote access.' };
  const dns = String(s.Self?.DNSName || '').replace(/\.$/, '');
  const url = dns ? `https://${dns}` : null;
  const fs_ = await run(bin, ['funnel', 'status', '--json'], 8000);
  let f = null; try { f = JSON.parse(fs_.out || '{}'); } catch { f = null; }
  const funnelOn = !!(f && f.AllowFunnel && Object.values(f.AllowFunnel).some(Boolean));
  const target = JSON.stringify(f?.Web || {});
  const pointsHere = target.includes(`127.0.0.1:${port}`) || target.includes(`localhost:${port}`);
  if (url && funnelOn && pointsHere && publicUrl() !== url) setSetting('remote_public_url', url);
  return { ...base, publicUrl: url, state: funnelOn && pointsHere ? 'on' : 'off', next: funnelOn && pointsHere ? null : 'Turn on remote access.' };
}

/** Point Tailscale Funnel (https 443) at the public listener. */
export async function enableFunnel() {
  const bin = tailscaleBinary();
  if (!bin) throw httpErr(400, 'not_installed', 'Tailscale is not installed. Run: brew install --cask tailscale — open the app, sign in (free), then try again.');
  const r = await run(bin, ['funnel', '--bg', '--yes', String(remotePort())], 30000);
  const text = r.out + r.err;
  const enableUrl = (text.match(/https:\/\/login\.tailscale\.com\/[^\s]+/) || [])[0];
  if (enableUrl && r.code !== 0) return { state: 'needs-approval', approveUrl: enableUrl, next: 'Open this link once to allow Funnel on your tailnet (Tailscale asks every new device), then turn remote access on again.' };
  if (r.code !== 0) throw httpErr(400, 'tailscale_error', (text.trim().split('\n').pop() || 'tailscale funnel failed').slice(0, 300));
  const st = await tunnelStatus();
  if (st.publicUrl) setSetting('remote_public_url', st.publicUrl);
  return st;
}
export async function disableFunnel() {
  const bin = tailscaleBinary();
  if (bin) await run(bin, ['funnel', '--https=443', 'off'], 15000);
  setSetting('remote_public_url', '');
  return tunnelStatus();
}
