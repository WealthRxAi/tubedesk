// Any AI can use and configure TubeDesk: the public listener (MCP over HTTP + OAuth with phone approval codes + API
// keys + OpenAPI tools), the configuration tools, the remote-caller restrictions, and Tailscale Funnel setup.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startMock, calls } from './mock-youtube.js';

const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname), '..');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'td-remote-'));
const TS_STATE = path.join(dataDir, 'ts.json');
let mock, child, hook, local, pub;
const texts = [];

const j = async (url, opts = {}) => {
  const res = await fetch(url, { redirect: 'manual', ...opts });
  const text = await res.text();
  let body; try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body, headers: res.headers };
};
const form = o => ({ method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(o).toString() });
const json = (o, token) => ({ method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(o) });
const waitFor = async (fn, ms = 4000) => { for (let t = 0; t < ms; t += 50) { const v = await fn(); if (v) return v; await new Promise(r => setTimeout(r, 50)); } return fn(); };
const pkce = () => { const verifier = crypto.randomBytes(32).toString('base64url'); return { verifier, challenge: crypto.createHash('sha256').update(verifier).digest('base64url') }; };
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';

async function register(name = 'Claude') {
  const r = await j(pub + '/register', json({ client_name: name, redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'] }));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.client_id;
}
async function authorize(clientId, { approveLocally = false } = {}) {
  const { verifier, challenge } = pkce();
  const before = texts.length;
  const page = await j(`${pub}/authorize?` + new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256', state: 'st8', resource: pub + '/mcp' }));
  assert.equal(page.status, 200, String(page.body).slice(0, 300));
  const requestId = /name="request" value="([^"]+)"/.exec(page.body)[1];
  const msg = await waitFor(() => texts.slice(before).find(m => /approval code/.test(m.title)));
  const code = /(\d{8})/.exec(msg.title)[1];
  return { verifier, requestId, code, page: page.body };
}
async function connect(name = 'Claude') {
  const clientId = await register(name);
  const a = await authorize(clientId);
  const r = await j(pub + '/authorize', form({ request: a.requestId, code: a.code, decision: 'approve' }));
  assert.equal(r.status, 302);
  const loc = new URL(r.headers.get('location'));
  const t = await j(pub + '/token', form({ grant_type: 'authorization_code', code: loc.searchParams.get('code'), redirect_uri: REDIRECT, client_id: clientId, code_verifier: a.verifier }));
  assert.equal(t.status, 200, JSON.stringify(t.body));
  return { clientId, ...t.body };
}
const rpc = (token, body) => j(pub + '/mcp', json(body, token));
const tool = async (token, name, args = {}) => {
  const r = await rpc(token, { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name, arguments: args } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return { isError: r.body.result.isError, text: r.body.result.content[0].text, data: (() => { try { return JSON.parse(r.body.result.content[0].text); } catch { return null; } })() };
};

before(async () => {
  mock = await startMock(0);
  hook = http.createServer((req, res) => { let b = ''; req.on('data', d => b += d); req.on('end', () => { try { texts.push(JSON.parse(b)); } catch { /* ignore */ } res.end('ok'); }); });
  await new Promise(r => hook.listen(0, '127.0.0.1', r));
  const port = 6500 + Math.floor(Math.random() * 400), pport = port + 1;
  local = `http://127.0.0.1:${port}`; pub = `http://127.0.0.1:${pport}`;
  const M = `http://127.0.0.1:${mock.port}`;
  child = spawn(process.execPath, ['src/server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(port), TUBEDESK_PUBLIC_PORT: String(pport), TUBEDESK_DATA_DIR: dataDir, TUBEDESK_NO_SCHEDULER: '1', TUBEDESK_NO_AUTOCONNECT: '1',
    YT_API_BASE: `${M}/youtube/v3`, YT_ANALYTICS_BASE: `${M}/v2/reports`, YT_SUGGEST_URL: `${M}/complete/search`, YT_UPLOAD_BASE: `${M}/upload`, FAKE_TS_STATE: TS_STATE, FAKE_TS_MODE: 'needs-approval', TUBEDESK_MAX_APPROVAL_TEXTS: '1000', TUBEDESK_RATE_SCALE: '50' }, stdio: ['ignore', 'ignore', 'pipe'] });
  child.stderr.on('data', d => process.stderr.write('[server] ' + d));
  for (let i = 0; i < 80; i++) { try { await fetch(pub + '/'); await fetch(local + '/api/status'); break; } catch { await new Promise(r => setTimeout(r, 100)); } }
  const r = await j(local + '/api/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ notify_webhook_url: `http://127.0.0.1:${hook.address().port}/hook`, notify_quiet: 'off', tailscale_path: path.join(ROOT, 'test', 'fake-tailscale.mjs'), ai_provider: 'none' }) });
  assert.equal(r.status, 200);
});
after(() => { child?.kill(); mock?.server.close(); hook?.close(); });

test('the public listener exposes only the AI endpoints — never the app, settings or raw API', async () => {
  assert.equal((await j(pub + '/')).status, 200);
  for (const p of ['/api/settings', '/api/channels', '/index.html', '/settings', '/data/clips/x.mp4', '/oauth/callback?code=x', '/api/agent']) assert.equal((await j(pub + p)).status, 404, p);
  assert.equal((await j(pub + '/api/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{"allow_lan":"1"}' })).status, 404);
  const meta = await j(pub + '/.well-known/oauth-authorization-server');
  assert.deepEqual(meta.body.code_challenge_methods_supported, ['S256']);
  assert.equal(meta.body.registration_endpoint, pub.replace('127.0.0.1', '127.0.0.1') + '/register');
  const pr = await j(pub + '/.well-known/oauth-protected-resource/mcp');
  assert.equal(pr.body.resource, pub + '/mcp');
  const un = await j(pub + '/mcp', json({ jsonrpc: '2.0', id: 1, method: 'tools/list' }));
  assert.equal(un.status, 401);
  assert.match(un.headers.get('www-authenticate'), /resource_metadata="http:\/\/127\.0\.0\.1:\d+\/\.well-known\/oauth-protected-resource"/);
  assert.equal((await j(pub + '/mcp', json({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, 'tdat_forged'))).status, 401);
  assert.equal((await j(pub + '/api/tools/list_channels', json({}))).status, 401);
});

test('OAuth: registration rules, PKCE required, approval by phone code, single-use codes', async () => {
  assert.equal((await j(pub + '/register', json({ client_name: 'x', redirect_uris: ['http://evil.example/cb'] }))).status, 400, 'plain http redirect refused');
  assert.equal((await j(pub + '/register', json({ client_name: 'x', redirect_uris: ['javascript:alert(1)'] }))).status, 400);
  const clientId = await register('<script>alert(1)</script>Claude');
  // no PKCE → error back to the client
  const noPkce = await j(`${pub}/authorize?` + new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, state: 's' }));
  assert.equal(noPkce.status, 400, 'an unapproved app gets the error on the page — never an open redirect'); assert.match(noPkce.body, /PKCE/);
  // wrong redirect → shown, not redirected
  assert.equal((await j(`${pub}/authorize?` + new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: 'https://evil.example/cb', code_challenge: 'x', code_challenge_method: 'S256' }))).status, 400);
  const a = await authorize(clientId);
  assert.ok(!a.page.includes('<script>alert(1)</script>') && a.page.includes('scriptalert(1)/scriptClaude'), 'markup stripped from the app name');
  assert.ok(texts.at(-1).message.includes('claude.ai'), 'phone text names where the request came from');
  const wrong = await j(pub + '/authorize', form({ request: a.requestId, code: '00000000' === a.code ? '11111111' : '00000000', decision: 'approve' }));
  assert.equal(wrong.status, 400); assert.match(wrong.body, /Wrong code \(4 tries left\)/);
  const ok = await j(pub + '/authorize', form({ request: a.requestId, code: a.code, decision: 'approve' }));
  assert.equal(ok.status, 302);
  const loc = new URL(ok.headers.get('location'));
  assert.equal(loc.origin + loc.pathname, REDIRECT); assert.equal(loc.searchParams.get('state'), 'st8');
  const code = loc.searchParams.get('code');
  const bad = await j(pub + '/token', form({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: 'wrong-verifier-wrong-verifier-wrong-verifier' }));
  assert.equal(bad.status, 400); assert.equal(bad.body.error, 'invalid_grant');
  const again = await j(pub + '/token', form({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: a.verifier }));
  assert.equal(again.status, 400, 'a code is single-use, even after a failed attempt');
});

test('five wrong codes kill the request; Deny sends access_denied back', async () => {
  const clientId = await register('Guesser');
  const a = await authorize(clientId);
  let last;
  for (let i = 0; i < 5; i++) last = await j(pub + '/authorize', form({ request: a.requestId, code: String((Number(a.code) + 1 + i) % 1e8).padStart(8, '0'), decision: 'approve' }));
  assert.match(last.body, /Too many wrong codes|Expired/);
  assert.equal((await j(pub + '/authorize', form({ request: a.requestId, code: a.code, decision: 'approve' }))).status, 400, 'the right code no longer works');
  const b = await authorize(clientId);
  const d = await j(pub + '/authorize', form({ request: b.requestId, decision: 'deny' }));
  assert.equal(d.status, 302); assert.match(d.headers.get('location'), /error=access_denied/);
});

test('approve from the Mac with one click: the waiting page completes on its own', async () => {
  const clientId = await register('ChatGPT');
  const a = await authorize(clientId);
  const pending = await j(local + '/api/remote/status');
  assert.ok(pending.body.pending.some(p => p.id === a.requestId && p.name === 'ChatGPT' && p.host === 'claude.ai'));
  assert.equal((await j(pub + '/authorize/status?request=' + a.requestId)).body.approved, false);
  assert.equal((await j(local + `/api/remote/requests/${a.requestId}/approve`, { method: 'POST' })).status, 200);
  assert.equal((await j(pub + '/authorize/status?request=' + a.requestId)).body.approved, true);
  const done = await j(pub + '/authorize', form({ request: a.requestId, json: '1' }));
  assert.match(done.body.redirect, /^https:\/\/claude\.ai\/api\/mcp\/auth_callback\?code=/);
});

test('MCP over HTTPS: initialize, list, call, batch, notifications', async () => {
  const t = await connect();
  const init = await rpc(t.access_token, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-ai', version: '1' } } });
  assert.equal(init.body.result.protocolVersion, '2025-06-18');
  assert.equal(init.body.result.serverInfo.name, 'tubedesk');
  assert.match(init.body.result.instructions, /setup_status/);
  assert.equal((await rpc(t.access_token, { jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202);
  const list = await rpc(t.access_token, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const names = list.body.result.tools.map(x => x.name);
  for (const n of ['setup_status', 'get_settings', 'update_settings', 'add_channel', 'connect_account', 'test_notification', 'remote_access', 'radar_score', 'publish_youtube', 'tubedesk_api']) assert.ok(names.includes(n), n);
  const batch = await rpc(t.access_token, [{ jsonrpc: '2.0', id: 3, method: 'ping' }, { jsonrpc: '2.0', id: 4, method: 'tools/list' }]);
  assert.equal(batch.body.length, 2);
  const s = await tool(t.access_token, 'setup_status');
  assert.equal(s.isError, false); assert.equal(s.data.next.id, 'youtube_api_key');
});

test('an AI configures TubeDesk end to end through the tools', async () => {
  const t = await connect('Gemini');
  const g = await tool(t.access_token, 'get_settings', { group: 'youtube' });
  assert.ok(g.data.settings.some(x => x.key === 'yt_api_key' && x.type === 'secret'));
  const bad = await tool(t.access_token, 'update_settings', { settings: { timezone: 'Mars/Base', autopilot_mode: 'yolo', nope: 1 } });
  assert.equal(bad.isError, true);
  assert.match(bad.text, /IANA time zone.*autopilot_mode must be one of: auto, suggest, off.*unknown setting "nope"/);
  const good = await tool(t.access_token, 'update_settings', { settings: { yt_api_key: 'TESTKEY', timezone: 'America/New_York', autopilot_mode: 'suggest', clips_platforms: ['youtube'], notify_quiet: '23-6', radar_breakout_x: '2.5' } });
  assert.equal(good.isError, false, good.text);
  assert.equal(good.data.yt_api_key, 'works', 'key tested against YouTube');
  assert.ok(good.data.changed.find(c => c.key === 'yt_api_key').value.startsWith('••••'), 'secret masked in the reply');
  const after = await tool(t.access_token, 'get_settings', {});
  const v = k => after.data.settings.find(x => x.key === k).value;
  assert.equal(v('autopilot_mode'), 'suggest'); assert.equal(v('clips_platforms'), 'youtube'); assert.equal(v('radar_breakout_x'), '2.5');
  assert.equal(v('yt_api_key'), '••••TKEY');
  const ch = await tool(t.access_token, 'add_channel', { input: '@TheParentPlan', kind: 'owned' });
  assert.equal(ch.isError, false, ch.text); assert.equal(ch.data.kind, 'owned');
  const comp = await tool(t.access_token, 'add_channel', { input: 'UCcomp000000000000000002', kind: 'competitor' });
  assert.equal(comp.isError, false, comp.text);
  const list = await tool(t.access_token, 'list_channels', {});
  assert.ok(list.data.some(c => c.kind === 'owned'));
  const con = await tool(t.access_token, 'connect_account', { service: 'google' });
  assert.match(con.text, /google_client_id/, 'tells the AI what to set first');
  await tool(t.access_token, 'update_settings', { settings: { google_client_id: 'cid.apps.googleusercontent.com', google_client_secret: 'sec' } });
  const con2 = await tool(t.access_token, 'connect_account', { service: 'google' });
  assert.match(con2.data.url, /^https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?client_id=cid/);
  const ig = await tool(t.access_token, 'connect_account', { service: 'instagram' });
  assert.ok(ig.data.steps.length >= 3);
  const before = texts.length;
  const n = await tool(t.access_token, 'test_notification', {});
  assert.equal(n.isError, false);
  assert.ok(await waitFor(() => texts.length > before));
  const st = await tool(t.access_token, 'setup_status', {});
  assert.ok(st.data.items.find(i => i.id === 'youtube_api_key').ok && st.data.items.find(i => i.id === 'owned_channel').ok && st.data.items.find(i => i.id === 'competitors').ok);
});

test('remote callers cannot reach program paths, raw settings, access management or arbitrary files', async () => {
  const t = await connect('Prompt-injected app');
  const paths = await tool(t.access_token, 'update_settings', { settings: { ffmpeg_path: '/bin/sh', claude_cli_path: '/tmp/evil', allow_lan: '1' } });
  assert.equal(paths.isError, true); assert.match(paths.text, /ffmpeg_path can only be changed on the Mac/);
  for (const [method, p, body] of [['PUT', '/api/settings', { claude_cli_path: '/tmp/evil' }], ['POST', '/api/remote/keys', { name: 'x' }], ['POST', '/api/Remote/Keys/', { name: 'x' }], ['POST', '/api/remote/enable', {}], ['GET', '/api/remote/pending', null], ['GET', '/api/plugin/download', null]]) {
    const r = await tool(t.access_token, 'tubedesk_api', { method, path: p, body });
    assert.equal(r.isError, true, `${method} ${p} must be refused`);
  }
  const rs = await tool(t.access_token, 'remote_access', {});
  assert.equal(rs.isError, false); assert.equal(rs.data.clients, undefined, 'remote callers do not see other connected apps');
  const out = await tool(t.access_token, 'extract_frame', { file: '/tmp/x.mp4', output: path.join(os.homedir(), '.zshrc') });
  assert.equal(out.isError, true); assert.match(out.text, /can only write media files/);
  const out2 = await tool(t.access_token, 'render_video', { tracks: [], output: '/etc/cron.d/x.mp4' });
  assert.match(out2.text, /can only write media files/);
  // the same calls are allowed from the Mac
  const loc = await j(local + '/api/config', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ whisper_threads: 4, ffmpeg_path: '' }) });
  assert.equal(loc.status, 200, JSON.stringify(loc.body));
});

test('refresh tokens rotate; replaying an old one revokes the app', async () => {
  const t = await connect('Rotator');
  const r1 = await j(pub + '/token', form({ grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: t.clientId }));
  assert.equal(r1.status, 200); assert.notEqual(r1.body.refresh_token, t.refresh_token);
  assert.equal((await rpc(r1.body.access_token, { jsonrpc: '2.0', id: 1, method: 'ping' })).status, 200);
  const replay = await j(pub + '/token', form({ grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: t.clientId }));
  assert.equal(replay.status, 400);
  assert.equal((await rpc(r1.body.access_token, { jsonrpc: '2.0', id: 1, method: 'ping' })).status, 401, 'stolen-token replay revokes everything for that app');
  const other = await register('Other');
  assert.equal((await j(pub + '/token', form({ grant_type: 'refresh_token', refresh_token: r1.body.refresh_token, client_id: other }))).status, 400, 'tokens are bound to their client');
});

test('disconnecting an app from the Mac cuts it off', async () => {
  const t = await connect('ToRevoke');
  const st = await j(local + '/api/remote/status');
  assert.ok(st.body.clients.some(c => c.client_id === t.clientId && c.name === 'ToRevoke'));
  await j(local + `/api/remote/clients/${t.clientId}/revoke`, { method: 'POST' });
  assert.equal((await rpc(t.access_token, { jsonrpc: '2.0', id: 1, method: 'ping' })).status, 401);
  assert.equal((await j(pub + '/token', form({ grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: t.clientId }))).status, 401);
});

test('API keys + OpenAPI for GPT Actions, Gemini, Grok and scripts', async () => {
  const k = (await j(local + '/api/remote/keys', json({ name: 'My GPT' }))).body;
  assert.match(k.key, /^tdk_/);
  const spec = (await j(pub + '/openapi.json?for=gpt')).body;
  assert.equal(spec.openapi, '3.1.0');
  assert.equal(Object.keys(spec.paths).length, 30, 'GPT Actions allow 30 operations');
  assert.equal(spec.servers[0].url, pub);
  for (const [p, op] of Object.entries(spec.paths)) { assert.ok(op.post.operationId && op.post.requestBody.content['application/json'].schema.type === 'object', p); assert.ok(op.post.summary.length <= 120); }
  assert.ok(Object.keys((await j(pub + '/openapi.json')).body.paths).length >= 43);
  const r = await j(pub + '/api/tools/list_channels', json({}, k.key));
  assert.equal(r.status, 200); assert.ok(Array.isArray(r.body));
  assert.equal((await j(pub + '/api/tools/not_a_tool', json({}, k.key))).status, 404);
  const ks = (await j(local + '/api/remote/status')).body.apiKeys;
  assert.ok(ks.some(x => x.name === 'My GPT' && x.last_used_at), 'last use recorded');
  await j(local + `/api/remote/keys/${k.id}`, { method: 'DELETE' });
  assert.equal((await j(pub + '/api/tools/list_channels', json({}, k.key))).status, 401);
  // the same tools work over plain HTTP on the Mac without a key
  assert.equal((await j(local + '/api/tools/setup_status', json({}))).status, 200);
  assert.equal(Object.keys((await j(local + '/api/openapi.json')).body.paths).length >= 43, true);
});

test('Tailscale Funnel: guided setup, then one permanent address', async () => {
  const s0 = await j(local + '/api/remote/status');
  assert.equal(s0.body.tunnel.state, 'off');
  const first = await j(local + '/api/remote/enable', { method: 'POST' });
  assert.equal(first.body.state, 'needs-approval');
  assert.equal(first.body.approveUrl, 'https://login.tailscale.com/f/funnel?node=abc123');
  const on = await j(local + '/api/remote/enable', { method: 'POST' });
  assert.equal(on.body.state, 'on', JSON.stringify(on.body));
  assert.equal(on.body.publicUrl, 'https://salmans-mac-mini.tail1234.ts.net');
  const st = (await j(local + '/api/remote/status')).body;
  assert.equal(st.mcpUrl, 'https://salmans-mac-mini.tail1234.ts.net/mcp');
  assert.equal(JSON.parse(fs.readFileSync(TS_STATE, 'utf8')).funnel, Number(new URL(pub).port), 'funnel points at the public listener, not the app');
  const meta = await j(pub + '/.well-known/oauth-authorization-server');
  assert.equal(meta.body.issuer, 'https://salmans-mac-mini.tail1234.ts.net', 'OAuth metadata uses the permanent address');
  const setup = (await j(local + '/api/setup')).body;
  assert.equal(setup.items.find(i => i.id === 'remote_access').ok, true);
  const off = await j(local + '/api/remote/disable', { method: 'POST' });
  assert.equal(off.body.state, 'off');
});

test('the agent guide lists every route the server actually has', async () => {
  const guide = (await j(local + '/api/agent')).body;
  for (const r of ['GET    /api/setup', 'PUT    /api/config', 'POST   /api/tools/:name', 'GET    /api/remote/status', 'POST   /api/shorts/clip/:id/cancel', 'POST   /api/publish/youtube']) assert.ok(guide.includes(r), r);
});

test('approved apps get OAuth errors as redirects (spec), unapproved ones never do', async () => {
  const t = await connect('Approved');
  const r = await j(`${pub}/authorize?` + new URLSearchParams({ response_type: 'token', client_id: t.clientId, redirect_uri: REDIRECT, state: 'z' }));
  assert.equal(r.status, 302); assert.match(r.headers.get('location'), /^https:\/\/claude\.ai\/.*error=unsupported_response_type.*state=z/);
});

test('approval codes are never stored, and remote apps cannot redirect or read alerts', async () => {
  const clientId = await register('Logger');
  const a = await authorize(clientId);
  const log = (await j(local + '/api/notify/log')).body;
  const row = log.find(x => x.kind === 'remote_access');
  assert.ok(row && !row.title.includes(a.code) && !row.body.includes(a.code) && row.title.includes('••••••'), 'code redacted in the log');
  const t = await connect('Snoop');
  for (const k of ['notify_webhook_url', 'notify_ntfy_server', 'notify_ntfy_topic', 'notify_imessage_to']) {
    const r = await tool(t.access_token, 'update_settings', { settings: { [k]: k === 'notify_imessage_to' ? '+15550000000' : 'https://attacker.example/x' } });
    assert.equal(r.isError, true, k); assert.match(r.text, /only be changed on the Mac/);
  }
  for (const p of ['/api/notify/log', '/api/system/restart', '/api/../index.html', '/api/%2e%2e/settings', '/api\\..\\settings', 'http://evil.example/api/x']) {
    const r = await tool(t.access_token, 'tubedesk_api', { method: p.includes('restart') ? 'POST' : 'GET', path: p });
    assert.equal(r.isError, true, p);
  }
});

test('timelines cannot smuggle ffmpeg filters (file writes/reads through the filtergraph)', async () => {
  const t = await connect('Renderer');
  const STILL = path.join(os.homedir(), 'Pictures', 'td-test-still.png');
  fs.mkdirSync(path.dirname(STILL), { recursive: true }); fs.writeFileSync(STILL, 'not really a png');
  const evil = [
    { type: 'box', start: 0, end: 1, color: 'black@0.5:t=fill[q1];[q1]metadata=mode=print:file=/tmp/td-pwned.txt,drawbox=color=black' },
    { type: 'text', text: 'hi', start: 0, end: 1, x: '10:enable=1,drawtext=textfile=/etc/passwd' },
    { type: 'image', src: STILL, start: 0, end: 1, crop: ['0:0,metadata=mode=print:file=/tmp/td-pwned.txt', 0, 10, 10] },
    { type: 'image', src: STILL, start: 0, end: 1, focus: ['0.5,metadata=mode=print:file=/tmp/td-pwned.txt', 0.5] },
    { type: 'captions', start: 0, end: 1, groups: [{ text: 'a', start: 0, end: 1 }], yWhen: [{ from: 0, to: 1, y: '1;evil' }] },
    { type: 'tone', start: 0, kind: "x'];evil" },
  ];
  for (const tr of evil) {
    const r = await tool(t.access_token, 'render_video', { width: 320, height: 240, duration: 1, tracks: [tr] });
    assert.equal(r.isError, true, JSON.stringify(tr)); assert.match(r.text, /invalid|must be/i);
  }
  assert.equal(fs.existsSync('/tmp/td-pwned.txt'), false);
  fs.rmSync(STILL, { force: true });
});

test('the Mac\'s own port refuses other websites (CSRF) and rebinding hostnames', async () => {
  const clientId = await register('CSRF target');
  const a = await authorize(clientId);
  const csrf = await j(local + `/api/remote/requests/${a.requestId}/approve`, { method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'text/plain', 'sec-fetch-site': 'cross-site' } });
  assert.equal(csrf.status, 403);
  assert.equal((await j(pub + '/authorize/status?request=' + a.requestId)).body.approved, false, 'not approved by a foreign page');
  const rebound = await new Promise(resolve => {
    const u = new URL(local);
    const rq = http.request({ host: u.hostname, port: u.port, path: '/api/remote/keys', method: 'POST', headers: { host: 'evil.example:' + u.port, 'content-type': 'application/json' } }, res => { res.resume(); resolve(res.statusCode); });
    rq.end('{"name":"x"}');
  });
  assert.equal(rebound, 421, 'DNS rebinding refused');
  // TubeDesk's own pages and local tools still work
  assert.equal((await j(local + `/api/remote/requests/${a.requestId}/approve`, { method: 'POST', headers: { origin: local, 'sec-fetch-site': 'same-origin' } })).status, 200);
  assert.equal((await j(local + '/api/config', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{"whisper_threads":5}' })).status, 200);
});

let spare;
test('the other ffmpeg tools reject smuggled filters too', async () => {
  const t = await connect('Media');
  spare = t;
  const VID = path.join(os.homedir(), 'Movies', 'td-test-clip.mp4');
  fs.mkdirSync(path.dirname(VID), { recursive: true }); fs.writeFileSync(VID, 'not really a video');
  const inj = '0.5,metadata=mode=print:file=/tmp/td-pwned2.txt';
  for (const [name, args] of [['media_transcode', { file: VID, focus: [0.5, inj] }], ['media_transcode', { file: VID, fps: '30,' + inj }], ['speech_segments', { file: VID, minPause: inj }], ['speech_segments', { file: VID, noiseDb: '-35:x' }], ['extract_frame', { file: VID, width: '320:-1,' + inj }]]) {
    const r = await tool(t.access_token, name, args);
    assert.equal(r.isError, true, name + JSON.stringify(args)); assert.match(r.text, /invalid/i, name);
  }
  assert.equal(fs.existsSync('/tmp/td-pwned2.txt'), false);
  fs.rmSync(VID, { force: true });
});

test('too many wrong codes overall lock code entry until the owner approves on the Mac', async () => {
  const clientId = await register('Brute');
  for (let i = 0; i < 4; i++) {
    const a = await authorize(clientId);
    for (let k = 0; k < 5; k++) await j(pub + '/authorize', form({ request: a.requestId, code: String((Number(a.code) + 1 + k) % 1e8).padStart(8, '0'), decision: 'approve' }));
  }
  const b = await authorize(clientId);
  const r = await j(pub + '/authorize', form({ request: b.requestId, code: b.code, decision: 'approve' }));
  assert.equal(r.status, 400); assert.match(r.body, /approve this app in TubeDesk on your Mac/);
  await j(local + `/api/remote/requests/${b.requestId}/approve`, { method: 'POST' });
  const done = await j(pub + '/authorize', form({ request: b.requestId, json: '1' }));
  assert.match(done.body.redirect, /code=/, 'the Mac can still approve');
});

test('unauthenticated endpoints are rate limited globally (header or case tricks do not help); /token never is', async () => {
  const before = spare;
  let limited = false;
  for (let i = 0; i < 3100 && !limited; i++) {
    const r = await j(pub + '/register', { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': `10.0.${i >> 8}.${i & 255}` }, body: JSON.stringify({ client_name: 'r', redirect_uris: [REDIRECT] }) });
    if (r.status === 429) limited = true;
  }
  assert.ok(limited);
  for (const p of ['/REGISTER', '/register/', '/Register']) assert.equal((await j(pub + p, json({ client_name: 'r', redirect_uris: [REDIRECT] }))).status, 429, p + ' shares the limit');
  for (let i = 0; i < 80; i++) await j(pub + '/token', form({ grant_type: 'refresh_token', refresh_token: 'junk' + i, client_id: 'nope' }));
  const r = await j(pub + '/token', form({ grant_type: 'refresh_token', refresh_token: before.refresh_token, client_id: before.clientId }));
  assert.equal(r.status, 200, 'connected apps can still refresh after a flood');
});
