// Zero-config TubeDesk: it connects itself to every AI app on the Mac (fake home folder), every AI is told all the
// user's brands, several Instagram/TikTok accounts each post for their own brand, and remote access turns itself on.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startMock, calls } from './mock-youtube.js';

const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname), '..');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'td-zero-'));
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'td-home-'));
const TS_STATE = path.join(dataDir, 'ts.json');
const OWNER = 'UCowner00000000000000001', BOO = 'UCboo' + '0'.repeat(18) + '4';
let mock, child, hook, base;
const texts = [];

const j = async (p, { method = 'GET', body } = {}) => {
  const res = await fetch(base + p, { method, headers: body !== undefined ? { 'content-type': 'application/json' } : {}, body: body !== undefined ? JSON.stringify(body) : undefined });
  const t = await res.text(); let b; try { b = JSON.parse(t); } catch { b = t; }
  return { status: res.status, body: b };
};
const ok = async (p, o) => { const r = await j(p, o); assert.equal(r.status, 200, `${p}: ${JSON.stringify(r.body).slice(0, 400)}`); return r.body; };
const waitFor = async (fn, ms = 8000) => { for (let t = 0; t < ms; t += 100) { const v = await fn(); if (v) return v; await new Promise(r => setTimeout(r, 100)); } return fn(); };
const read = (...p) => fs.readFileSync(path.join(HOME, ...p), 'utf8');
const exists = (...p) => fs.existsSync(path.join(HOME, ...p));

// A fake Mac home with AI apps installed: Claude desktop, Claude Code (fake CLI), Codex (existing config),
// Cursor (a server the user added themselves), Gemini (a broken settings file), Copilot, LM Studio.
function seedHome() {
  fs.mkdirSync(path.join(HOME, 'Library', 'Application Support', 'Claude'), { recursive: true });
  fs.writeFileSync(path.join(HOME, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'), JSON.stringify({ mcpServers: { github: { command: 'npx', args: ['gh-mcp'] } }, globalShortcut: 'Cmd+Space' }, null, 2));
  fs.mkdirSync(path.join(HOME, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(HOME, '.claude', 'CLAUDE.md'), '# My rules\n\nAlways be brief.\n');
  fs.mkdirSync(path.join(HOME, '.codex'), { recursive: true });
  fs.writeFileSync(path.join(HOME, '.codex', 'config.toml'), 'model = "gpt-5"\n\n[mcp_servers.context7]\ncommand = "npx"\nargs = ["-y", "@upstash/context7-mcp"]\n');
  fs.mkdirSync(path.join(HOME, '.cursor'), { recursive: true });
  fs.writeFileSync(path.join(HOME, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { tubedesk: { url: 'https://my-own-tunnel.example/mcp' } } }));
  fs.mkdirSync(path.join(HOME, '.gemini'), { recursive: true });
  fs.writeFileSync(path.join(HOME, '.gemini', 'settings.json'), '{ "theme": "dark", // comment breaks JSON\n}');
  fs.mkdirSync(path.join(HOME, '.copilot'), { recursive: true });
  fs.mkdirSync(path.join(HOME, '.lmstudio'), { recursive: true });
  // fake `claude` CLI: records plugin commands in a log, lists what was installed
  const cli = path.join(HOME, 'fake-claude-cli.mjs');
  fs.writeFileSync(cli, `#!/usr/bin/env node
import fs from 'node:fs';
const log = ${JSON.stringify(path.join(HOME, 'claude-cli.log'))};
const a = process.argv.slice(2); fs.appendFileSync(log, a.join(' ') + '\\n');
if (a[0] === 'plugin' && a[1] === 'list') { const l = fs.readFileSync(log, 'utf8'); console.log(/plugin install tubedesk@tubedesk/.test(l) && !/plugin uninstall/.test(l) ? 'tubedesk@tubedesk (user) enabled' : 'No plugins installed'); }
`);
  fs.chmodSync(cli, 0o755);
  return cli;
}

before(async () => {
  const cli = seedHome();
  mock = await startMock(0);
  hook = http.createServer((req, res) => { let b = ''; req.on('data', d => b += d); req.on('end', () => { try { texts.push(JSON.parse(b)); } catch { /* */ } res.end('ok'); }); });
  await new Promise(r => hook.listen(0, '127.0.0.1', r));
  // settings that must exist before the first start (auto-connect runs at startup)
  const port = 7000 + Math.floor(Math.random() * 300);
  base = `http://127.0.0.1:${port}`;
  const M = `http://127.0.0.1:${mock.port}`;
  const env = { ...process.env, PORT: String(port), TUBEDESK_PUBLIC_PORT: String(port + 1), TUBEDESK_DATA_DIR: dataDir, TUBEDESK_NO_SCHEDULER: '1', TUBEDESK_HOME: HOME,
    YT_API_BASE: `${M}/youtube/v3`, YT_ANALYTICS_BASE: `${M}/v2/reports`, YT_SUGGEST_URL: `${M}/complete/search`, YT_UPLOAD_BASE: `${M}/upload`, IG_GRAPH_BASE: `${M}/ig`, TT_API_BASE: `${M}/tt`,
    FAKE_TS_STATE: TS_STATE, FAKE_TS_MODE: 'needs-approval' };
  // first boot only to write settings, then a real boot with auto-connect
  const pre = spawn(process.execPath, ['src/server.js'], { cwd: ROOT, env: { ...env, TUBEDESK_NO_AUTOCONNECT: '1' }, stdio: 'ignore' });
  for (let i = 0; i < 80; i++) { try { await fetch(base + '/api/status'); break; } catch { await new Promise(r => setTimeout(r, 100)); } }
  await ok('/api/settings', { method: 'PUT', body: { claude_cli_path: cli, tailscale_path: path.join(ROOT, 'test', 'fake-tailscale.mjs'), notify_webhook_url: `http://127.0.0.1:${hook.address().port}/hook`, notify_quiet: 'off', yt_api_key: 'TESTKEY', ai_provider: 'none', tt_client_key: 'ck', tt_client_secret: 'cs', tt_redirect_uri: 'https://example.github.io/tiktok-callback.html', public_base_url: 'https://media.example.org' } });
  pre.kill(); await new Promise(r => pre.once('exit', r));
  child = spawn(process.execPath, ['src/server.js'], { cwd: ROOT, env, stdio: ['ignore', 'ignore', 'pipe'] });
  child.stderr.on('data', d => process.stderr.write('[server] ' + d));
  for (let i = 0; i < 80; i++) { try { await fetch(base + '/api/status'); break; } catch { await new Promise(r => setTimeout(r, 100)); } }
});
after(() => { child?.kill(); mock?.server.close(); hook?.close(); });

test('on start, TubeDesk connects itself to every AI app on the Mac — and never breaks the user\'s own setup', async () => {
  const st = await waitFor(async () => { const r = (await j('/api/ai-clients')).body; return r.lastRun ? r : null; });
  const by = id => st.clients.find(c => c.id === id);
  // Claude desktop: server added next to the user's own, other keys untouched, backup made
  const cd = JSON.parse(read('Library', 'Application Support', 'Claude', 'claude_desktop_config.json'));
  assert.deepEqual(cd.mcpServers.github, { command: 'npx', args: ['gh-mcp'] });
  assert.equal(cd.globalShortcut, 'Cmd+Space');
  assert.deepEqual(cd.mcpServers.tubedesk.args, [path.join(ROOT, 'mcp', 'server.js')]);
  assert.equal(cd.mcpServers.tubedesk.command, process.execPath, 'absolute node, so GUI apps find it');
  assert.ok(exists('Library', 'Application Support', 'Claude', 'claude_desktop_config.json.tubedesk-backup'));
  // Claude Code: plugin installed from the repo's marketplace + a standing rule, user's rules kept
  const cliLog = read('claude-cli.log');
  assert.match(cliLog, new RegExp(`plugin marketplace add ${ROOT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.match(cliLog, /plugin install tubedesk@tubedesk --scope user/);
  const cm = read('.claude', 'CLAUDE.md');
  assert.ok(cm.startsWith('# My rules\n\nAlways be brief.') && /never use vidIQ/i.test(cm) && /`brands`/.test(cm));
  // Codex: TOML table appended (valid TOML, other servers kept) + AGENTS.md rule
  const toml = read('.codex', 'config.toml');
  const parsed = JSON.parse(execFileSync('python3', ['-c', 'import tomllib,sys,json; print(json.dumps(tomllib.load(open(sys.argv[1],"rb"))))', path.join(HOME, '.codex', 'config.toml')]).toString());
  assert.equal(parsed.model, 'gpt-5'); assert.ok(parsed.mcp_servers.context7);
  assert.deepEqual(parsed.mcp_servers.tubedesk.args, [path.join(ROOT, 'mcp', 'server.js')]);
  assert.equal(parsed.mcp_servers.tubedesk.env.TUBEDESK_MANAGED, '1');
  assert.match(read('.codex', 'AGENTS.md'), /tubedesk:start[\s\S]*brands[\s\S]*tubedesk:end/);
  // Cursor: the user's own tubedesk entry is left alone
  assert.deepEqual(JSON.parse(read('.cursor', 'mcp.json')).mcpServers.tubedesk, { url: 'https://my-own-tunnel.example/mcp' });
  assert.equal(by('cursor').status, 'user-managed');
  // Gemini: unreadable settings are not touched (rules file still written)
  assert.equal(read('.gemini', 'settings.json'), '{ "theme": "dark", // comment breaks JSON\n}');
  assert.equal(by('gemini').status, 'error');
  assert.match(read('.gemini', 'GEMINI.md'), /tubedesk:start/);
  // Copilot (CLI + VS Code) and LM Studio
  const cp = JSON.parse(read('.copilot', 'mcp-config.json')).mcpServers.tubedesk;
  assert.equal(cp.type, 'local'); assert.deepEqual(cp.tools, ['*']);
  assert.ok(JSON.parse(read('.lmstudio', 'mcp.json')).mcpServers.tubedesk);
  // not installed → not touched
  assert.equal(by('windsurf').installed, false); assert.equal(exists('.codeium'), false);
  for (const id of ['claude-desktop', 'claude-code', 'codex', 'copilot', 'lmstudio']) assert.ok(['connected', 'connected-now'].includes(by(id).status), `${id}: ${by(id).status}`);
});

test('reconnecting is idempotent; disconnecting removes only what TubeDesk added', async () => {
  const f = path.join(HOME, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  const before = fs.readFileSync(f, 'utf8'), m0 = fs.statSync(f).mtimeMs;
  const r = await ok('/api/ai-clients/connect', { method: 'POST', body: {} });
  assert.ok(r.filter(x => x.installed && !['cursor', 'gemini'].includes(x.id)).every(x => x.status === 'connected'), JSON.stringify(r.map(x => [x.id, x.status])));
  assert.equal(fs.readFileSync(f, 'utf8'), before); assert.equal(fs.statSync(f).mtimeMs, m0, 'no rewrite when nothing changed');
  assert.equal((read('.codex', 'config.toml').match(/\[mcp_servers\.tubedesk\]/g) || []).length, 1, 'no duplicate table');
  const off = await ok('/api/ai-clients/connect', { method: 'POST', body: { remove: true } });
  assert.ok(off.length);
  assert.equal(JSON.parse(read('Library', 'Application Support', 'Claude', 'claude_desktop_config.json')).mcpServers.tubedesk, undefined);
  assert.ok(JSON.parse(read('Library', 'Application Support', 'Claude', 'claude_desktop_config.json')).mcpServers.github);
  assert.equal(read('.claude', 'CLAUDE.md').trim(), '# My rules\n\nAlways be brief.');
  assert.ok(!/mcp_servers\.tubedesk/.test(read('.codex', 'config.toml')) && /context7/.test(read('.codex', 'config.toml')));
  assert.ok(JSON.parse(read('.cursor', 'mcp.json')).mcpServers.tubedesk, "the user's own entry survives");
  await ok('/api/ai-clients/connect', { method: 'POST', body: {} });
});

test('Instagram and TikTok: one account per brand, linked to its YouTube channel', async () => {
  await ok('/api/channels', { method: 'POST', body: { input: '@TheParentPlan', kind: 'owned' } });
  await ok('/api/channels', { method: 'POST', body: { input: '@BooCrew', kind: 'owned' } });
  const a1 = await ok('/api/tools/add_instagram_account', { method: 'POST', body: { token: 'IGTOKEN_SALSTACK_xxxxxxxxxxxxxxxxxxxx', channel: 'The Parent Plan' } });
  assert.equal(a1.username, 'salstack.ai'); assert.equal(a1.channelId, OWNER); assert.equal(a1.isDefault, true);
  const a2 = await ok('/api/tools/add_instagram_account', { method: 'POST', body: { token: 'IGTOKEN_BOO_xxxxxxxxxxxxxxxxxxxxxxxx', channel: '@BooCrew' } });
  assert.equal(a2.username, 'boocrew'); assert.equal(a2.channelId, BOO); assert.equal(a2.isDefault, false);
  assert.equal((await j('/api/tools/add_instagram_account', { method: 'POST', body: { token: 'BAD_TOKEN_xxxxxxxxxxxxxxxxxxxxxxxxxx' } })).status, 400);
  // TikTok: two sign-ins, one per brand
  const c1 = await ok('/api/tools/connect_account', { method: 'POST', body: { service: 'tiktok', channel: 'The Parent Plan' } });
  assert.match(c1.url, /tiktok\.com/); assert.match(c1.next, /The Parent Plan/);
  const t1 = await ok('/api/social/tiktok/connect', { method: 'POST', body: { code: 'CODE_MAIN' } });
  assert.equal(t1.username, 'salstack'); assert.equal(t1.channelId, OWNER, 'linked to the brand named when the link was made');
  await ok('/api/tools/connect_account', { method: 'POST', body: { service: 'tiktok', channel: 'BooCrew' } });
  const t2 = await ok('/api/social/tiktok/connect', { method: 'POST', body: { code: 'CODE_BOO' } });
  assert.equal(t2.username, 'boocrew.tt'); assert.equal(t2.channelId, BOO);
  const brands = await ok('/api/tools/brands', { method: 'POST', body: {} });
  const pp = brands.brands.find(b => b.channelId === OWNER), bc = brands.brands.find(b => b.channelId === BOO);
  assert.deepEqual([pp.instagram, pp.tiktok, bc.instagram, bc.tiktok], ['salstack.ai', 'salstack', 'boocrew', 'boocrew.tt']);
  // legacy settings mirror the default account
  const s = await ok('/api/settings');
  assert.equal(s.ig_user_id, '17841400000000001'); assert.equal(s.tt_open_id, 'open123');
});

test('every AI is told all the brands up front (MCP instructions), without being asked', async () => {
  const mcp = spawn(process.execPath, [path.join(ROOT, 'mcp', 'server.js')], { env: { ...process.env, TUBEDESK_URL: base }, stdio: ['pipe', 'pipe', 'inherit'] });
  const line = await new Promise(resolve => { let buf = ''; mcp.stdout.on('data', d => { buf += d; if (buf.includes('\n')) resolve(buf.split('\n')[0]); }); mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }) + '\n'); });
  mcp.kill();
  const ins = JSON.parse(line).result.instructions;
  assert.match(ins, /never vidIQ/);
  assert.match(ins, /The Parent Plan \(@TheParentPlan\) — YouTube UCowner00000000000000001.*Instagram @salstack\.ai, TikTok @salstack/);
  assert.match(ins, /BooCrew \(@BooCrew\) — YouTube UCboo0+4.*Instagram @boocrew, TikTok @boocrew\.tt/);
});

test('publishing picks the brand\'s account; tokens never cross brands', async () => {
  const file = path.join(dataDir, 'reel.mp4'); fs.writeFileSync(file, 'x'.repeat(2048));
  const mark = calls.length;
  const job = await ok('/api/publish/instagram?wait=1', { method: 'POST', body: { file, caption: 'boo', account: 'BooCrew' } });
  assert.equal(job.status, 'done', job.error);
  const igCalls = calls.slice(mark).filter(c => c.path.includes('/ig/'));
  assert.ok(igCalls.length && igCalls.every(c => /^IGTOKEN_BOO/.test(c.q.access_token || '')), 'only the BooCrew token was used');
  assert.ok(igCalls.some(c => c.path.endsWith('/ig/17841400000000002/media')), 'posted to the BooCrew account');
  assert.match(job.log.join('\n'), /account @boocrew/);
  const def = await ok('/api/publish/instagram?wait=1', { method: 'POST', body: { file, caption: 'main' } });
  assert.match(def.log.join('\n'), /account @salstack\.ai/, 'no account → default');
  const bad = await j('/api/publish/instagram', { method: 'POST', body: { file, caption: 'x', account: '@nobody' } });
  assert.equal(bad.status, 400); assert.match(bad.body.error, /No instagram account "@nobody".*@salstack\.ai, @boocrew/);
  // TikTok
  const vid = path.join(dataDir, 'tt.mp4'); fs.writeFileSync(vid, 'y'.repeat(4096));
  const m2 = calls.length;
  const tj = await ok('/api/publish/tiktok?wait=1', { method: 'POST', body: { file: vid, title: 'boo tt', account: 'BooCrew' } });
  assert.equal(tj.status, 'done', tj.error);
  assert.ok(calls.slice(m2).filter(c => c.ttAccount).every(c => c.ttAccount === 'openBoo'), 'only the BooCrew TikTok token');
  // scheduled Instagram post for a brand uses that brand's best slot + account
  const q = await ok('/api/publish/instagram', { method: 'POST', body: { file, caption: 'later', account: 'boocrew', publishAt: 'best' } });
  assert.equal(q.queued.channel_id, BOO); assert.equal(q.queued.params.account, '17841400000000002');
});

test('Shorts go to the brand\'s own accounts; a brand without one is skipped, not sent to another brand', async () => {
  const Database = (await import('better-sqlite3')).default;
  const db = new Database(path.join(dataDir, 'tubedesk.sqlite'));
  const ins = db.prepare("INSERT INTO clips (video_id, channel_id, rank, start, end, title, hook_text, description, file, score, status, trigger) VALUES (?, ?, 1, 0, 10, ?, 'HOOK', 'desc', ?, 70, 'ready', 'manual')");
  const f = path.join(dataDir, 'clip.mp4'); fs.writeFileSync(f, 'z');
  const a = ins.run('vidPP0000001', OWNER, 'PP short', f).lastInsertRowid;
  const b = ins.run('vidBC0000001', BOO, 'Boo short', f).lastInsertRowid;
  const ra = (await ok(`/api/shorts/clip/${a}/schedule`, { method: 'POST' }))[0];
  const rb = (await ok(`/api/shorts/clip/${b}/schedule`, { method: 'POST' }))[0];
  assert.equal(ra.instagram, '@salstack.ai'); assert.equal(ra.tiktok, '@salstack');
  assert.equal(rb.instagram, '@boocrew'); assert.equal(rb.tiktok, '@boocrew.tt');
  const rows = db.prepare('SELECT platform, params_json FROM publish_queue WHERE clip_id = ?').all(b).map(r => [r.platform, JSON.parse(r.params_json).account]);
  assert.deepEqual(rows.filter(r => r[0] !== 'youtube').sort(), [['instagram', '17841400000000002'], ['tiktok', 'openBoo']]);
  // unlink BooCrew's Instagram: its Shorts now skip Instagram instead of using The Parent Plan's account
  await ok('/api/tools/link_social_account', { method: 'POST', body: { platform: 'instagram', account: 'boocrew', channel: '' } });
  const c = ins.run('vidBC0000002', BOO, 'Boo short 2', f).lastInsertRowid;
  const rc = (await ok(`/api/shorts/clip/${c}/schedule`, { method: 'POST' }))[0];
  assert.equal(rc.instagram, false); assert.equal(rc.tiktok, '@boocrew.tt');
  await ok('/api/tools/link_social_account', { method: 'POST', body: { platform: 'instagram', account: 'boocrew', channel: 'BooCrew' } });
  db.close();
});

test('reels radar and the weekly board cover every account, each against its own baseline', async () => {
  await ok('/api/radar/watch/run', { method: 'POST' });
  const board = await ok('/api/portfolio');
  const socials = board.social.map(s => `${s.platform}:${s.username}`).sort();
  assert.deepEqual(socials, ['instagram:boocrew', 'instagram:salstack.ai', 'tiktok:boocrew.tt', 'tiktok:salstack']);
  const boo = (await ok(`/api/radar/watch/${BOO}`)).videos.find(v => v.video_id === 'ig:BOOREEL1');
  assert.ok(boo, 'BooCrew reel watched under the BooCrew brand');
  assert.equal(boo.channel_id, 'ig:17841400000000002');
  const sum = await ok('/api/portfolio/weekly-summary', { method: 'POST', body: { send: false } });
  assert.match(sum.text, /Instagram @boocrew/); assert.match(sum.text, /TikTok @boocrew\.tt/);
});

test('remote access turns itself on once Tailscale is signed in; the one-time approval link arrives by phone once', async () => {
  // The startup check already found Tailscale signed in and asked to allow Funnel: the owner got the link by phone.
  const msg = await waitFor(() => texts.find(m => /one tap to finish remote access/.test(m.title)));
  assert.ok(msg, 'approval link texted at startup');
  assert.match(JSON.stringify(msg), /login\.tailscale\.com\/f\/funnel/);
  const next = await ok('/api/remote/auto', { method: 'POST' });
  assert.equal(next.state, 'on', 'next check: allowed → on, no button pressed');
  const again = await ok('/api/remote/auto', { method: 'POST' });
  assert.equal(again.state, 'on');
  assert.equal(texts.filter(m => /one tap/.test(m.title)).length, 1, 'texted once');
  const st = await ok('/api/remote/status');
  assert.equal(st.mcpUrl, 'https://salmans-mac-mini.tail1234.ts.net/mcp');
  await ok('/api/remote/disable', { method: 'POST' });
  assert.deepEqual(await ok('/api/remote/auto', { method: 'POST' }), { skipped: 'off' }, 'an explicit off is respected');
});

test('setup checklist covers every brand\'s accounts', async () => {
  const s = await ok('/api/setup');
  const ig = s.items.find(i => i.id === 'instagram'), tt = s.items.find(i => i.id === 'tiktok');
  assert.ok(ig.ok && /@salstack\.ai → The Parent Plan/.test(ig.detail) && /@boocrew → BooCrew/.test(ig.detail));
  assert.ok(tt.ok && /@boocrew\.tt → BooCrew/.test(tt.detail));
  assert.ok(!s.items.some(i => i.id.startsWith('brand_')), 'every brand has its accounts');
});

// ---------- review findings ----------
const R = { 'x-tubedesk-origin': 'remote' };
const jr = async (p, { method = 'GET', body } = {}) => { const res = await fetch(base + p, { method, headers: { ...R, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined }); return { status: res.status, body: await res.json().catch(() => null) }; };

test('remote AI apps can add a brand\'s first account but cannot re-point, remove or demote accounts', async () => {
  assert.equal((await jr('/api/social-accounts/instagram/boocrew', { method: 'DELETE' })).status, 403);
  assert.equal((await jr('/api/social-accounts/instagram/boocrew/default', { method: 'POST', body: {} })).status, 403);
  assert.equal((await jr('/api/social/tiktok/disconnect', { method: 'POST', body: {} })).status, 403);
  assert.equal((await jr('/api/social-accounts/instagram/boocrew/link', { method: 'POST', body: { channel: 'The Parent Plan' } })).status, 403, 'already-linked account cannot be moved remotely');
  const viaTool = await jr('/api/tools/link_social_account', { method: 'POST', body: { platform: 'instagram', account: 'boocrew', remove: true } });
  assert.ok(viaTool.status >= 400 && /on the Mac/.test(viaTool.body.error), JSON.stringify(viaTool.body));
  assert.ok((await ok('/api/social-accounts?platform=instagram')).some(a => a.username === 'boocrew'), 'still there');
  const cfg = await jr('/api/config', { method: 'PUT', body: { ig_access_token: 'IGTOKEN_EVIL_xxxxxxxxxxxxxxxxxxxxxxx', ig_user_id: '999' } });
  assert.ok(cfg.status >= 400 || (cfg.body?.rejected || []).length, 'token settings are Mac-only: ' + JSON.stringify(cfg.body));
  assert.equal((await ok('/api/settings')).ig_user_id, '17841400000000001');
  // re-adding an existing account remotely with another brand's name keeps its link (warning instead)
  const again = await jr('/api/social-accounts/instagram', { method: 'POST', body: { token: 'IGTOKEN_BOO_xxxxxxxxxxxxxxxxxxxxxxxx', channel: 'The Parent Plan' } });
  assert.equal(again.status, 200); assert.equal(again.body.channelId, BOO); assert.match(again.body.warning, /only be done on the Mac/);
});

test('a brand has one account per platform; settings edits stick; removed accounts stay removed', async () => {
  await ok('/api/social-accounts/instagram/salstack.ai/link', { method: 'POST', body: { channel: 'BooCrew' } });
  let b = (await ok('/api/brands')).brands;
  assert.equal(b.find(x => x.channelId === BOO).instagram, 'salstack.ai'); assert.equal(b.find(x => x.channelId === OWNER).instagram, null);
  assert.equal((await ok('/api/social-accounts?platform=instagram')).find(a => a.username === 'boocrew').channelId, null, 'previous account unlinked');
  await ok('/api/social-accounts/instagram/salstack.ai/link', { method: 'POST', body: { channel: 'The Parent Plan' } });
  await ok('/api/social-accounts/instagram/boocrew/link', { method: 'POST', body: { channel: 'BooCrew' } });
  // pointing the old single-account settings at another account makes it the default — and it stays
  await ok('/api/settings', { method: 'PUT', body: { ig_user_id: '17841400000000002', ig_access_token: 'IGTOKEN_BOO_xxxxxxxxxxxxxxxxxxxxxxxx' } });
  assert.equal((await ok('/api/social-accounts?platform=instagram'))[0].username, 'boocrew');
  await ok('/api/publish/instagram/refresh-token', { method: 'POST' });
  assert.equal((await ok('/api/settings')).ig_user_id, '17841400000000002', 'not reverted by a token refresh');
  await ok('/api/social-accounts/instagram/salstack.ai/default', { method: 'POST', body: {} });
  assert.equal((await ok('/api/settings')).ig_user_id, '17841400000000001');
  // remove BooCrew's account: gone for good (even though it was in the settings a moment ago)
  assert.equal((await ok('/api/social-accounts/instagram/boocrew', { method: 'DELETE' })).removed, true);
  assert.ok(!(await ok('/api/social-accounts?platform=instagram')).some(a => a.username === 'boocrew'));
  assert.ok(!(await ok('/api/social-accounts?platform=instagram')).some(a => a.username === 'boocrew'), 'still gone');
  await ok('/api/tools/add_instagram_account', { method: 'POST', body: { token: 'IGTOKEN_BOO_xxxxxxxxxxxxxxxxxxxxxxxx', channel: 'BooCrew' } });
});

test('TikTok sign-ins for two brands at once land on the right brand', async () => {
  const a = await ok('/api/tools/connect_account', { method: 'POST', body: { service: 'tiktok', channel: 'The Parent Plan' } });
  const b = await ok('/api/tools/connect_account', { method: 'POST', body: { service: 'tiktok', channel: 'BooCrew' } });
  const stateB = new URL(b.url).searchParams.get('state'), stateA = new URL(a.url).searchParams.get('state');
  const amb = await j('/api/social/tiktok/connect', { method: 'POST', body: { code: 'CODE_BOO' } });
  assert.equal(amb.status, 400); assert.match(amb.body.error, /Say which brand/);
  const rb = await ok('/api/social/tiktok/connect', { method: 'POST', body: { code: `https://example.github.io/tiktok-callback.html?code=CODE_BOO&state=${stateB}` } });
  assert.equal(rb.channelId, BOO);
  // signing in with the wrong account (already linked elsewhere) on a brand's link does not move it
  const wrong = await ok('/api/social/tiktok/connect', { method: 'POST', body: { code: 'CODE_BOO', state: stateA } });
  assert.equal(wrong.channelId, BOO); assert.match(wrong.warning, /already linked to another brand/);
  const vids = await ok('/api/social/tiktok/videos?account=boocrew.tt'); assert.ok(Array.isArray(vids));
});

test('remote access never takes over a Tailscale setup the owner uses for something else, and respects an off in Tailscale', async () => {
  await ok('/api/settings', { method: 'PUT', body: { remote_off_by_user: '0' } });
  const port = Number(new URL(base).port) + 1;
  fs.writeFileSync(TS_STATE, JSON.stringify({ funnel: Number(`${port}0`), asked: true })); // e.g. 71010: not ours (exact port)
  const r = await ok('/api/remote/auto', { method: 'POST' });
  assert.equal(r.skipped, 'tailscale-in-use');
  assert.equal(JSON.parse(fs.readFileSync(TS_STATE, 'utf8')).funnel, Number(`${port}0`), 'owner\'s setup untouched');
  assert.equal((await j('/api/remote/enable', { method: 'POST', body: {} })).status, 409);
  assert.equal((await ok('/api/remote/enable', { method: 'POST', body: { replace: true } })).state, 'on');
  assert.equal((await ok('/api/remote/auto', { method: 'POST' })).state, 'on');
  fs.writeFileSync(TS_STATE, JSON.stringify({ funnel: null, asked: true })); // owner switched Funnel off in the Tailscale app
  assert.deepEqual(await ok('/api/remote/auto', { method: 'POST' }), { skipped: 'off', reason: 'turned off in Tailscale' });
  assert.equal(JSON.parse(fs.readFileSync(TS_STATE, 'utf8')).funnel, null);
});
