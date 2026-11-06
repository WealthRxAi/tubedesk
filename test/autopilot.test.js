// Integration: impressions/CTR feed (Reporting API), phone alerts (webhook), radar autopilot (diagnose → generate →
// score → swap → grade → revert) and the daily idea list. Real server, mock YouTube, fake Claude CLI, real ffmpeg.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startMock, calls, REPORTING } from './mock-youtube.js';

const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname), '..');
const FAKE_CLAUDE = path.join(ROOT, 'test', 'fake-claude.mjs');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'td-autopilot-'));
const OWNER = 'UCowner00000000000000001', COMP = 'UCcomp000000000000000002';
const FFMPEG = ['/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg', '/opt/homebrew/bin/ffmpeg'].find(f => fs.existsSync(f));
let mock, child, base, hook, hookPort, db;
const received = [];

async function api(p, { method = 'GET', body } = {}) {
  const res = await fetch(base + '/api' + p, { method, headers: body !== undefined ? { 'content-type': 'application/json' } : {}, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, json };
}
const ok = async (p, o) => { const r = await api(p, o); assert.equal(r.status, 200, `${p}: ${JSON.stringify(r.json).slice(0, 500)}`); return r.json; };
const waitFor = async (fn, ms = 3000) => { for (let t = 0; t < ms; t += 50) { if (fn()) return true; await new Promise(r => setTimeout(r, 50)); } return fn(); };
const vidId = i => ('owne' + String(i).padStart(7, '0')).slice(0, 11);

before(async () => {
  mock = await startMock(0);
  hook = http.createServer((req, res) => { let b = ''; req.on('data', d => b += d); req.on('end', () => { received.push(JSON.parse(b)); res.end('ok'); }); });
  await new Promise(r => hook.listen(0, '127.0.0.1', r));
  hookPort = hook.address().port;
  const port = 5400 + Math.floor(Math.random() * 300);
  base = `http://127.0.0.1:${port}`;
  const M = `http://127.0.0.1:${mock.port}`;
  child = spawn(process.execPath, ['src/server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(port), TUBEDESK_DATA_DIR: dataDir, TUBEDESK_NO_SCHEDULER: '1', YT_API_BASE: `${M}/youtube/v3`, YT_ANALYTICS_BASE: `${M}/v2/reports`, YT_SUGGEST_URL: `${M}/complete/search`, YT_UPLOAD_BASE: `${M}/upload`, YT_REPORTING_BASE: `${M}/reporting/v1` }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stderr.on('data', d => process.stderr.write('[server] ' + d));
  for (let i = 0; i < 50; i++) { try { await fetch(base + '/api/status'); break; } catch { await new Promise(r => setTimeout(r, 100)); } }
  await ok('/settings', { method: 'PUT', body: { yt_api_key: 'TESTKEY', ai_provider: 'claude-cli', claude_cli_path: FAKE_CLAUDE, default_country: 'US',
    notify_webhook_url: `http://127.0.0.1:${hookPort}/hook`, notify_quiet: '', radar_watch_days: '30', radar_watch_competitor_days: '30', autopilot_max_days: '30', autopilot_min_gain: '1' } });
  await ok('/channels', { method: 'POST', body: { input: '@TheParentPlan', kind: 'owned', maxVideos: 100 } });
  await ok(`/competitors/${OWNER}`, { method: 'POST', body: { input: COMP } });
  const Database = (await import('better-sqlite3')).default;
  db = new Database(path.join(dataDir, 'tubedesk.sqlite'));
  db.prepare('UPDATE channels SET oauth_json = ? WHERE id = ?').run(JSON.stringify({ access_token: 'tok', refresh_token: 'rt', expires_at: Date.now() + 3600e3 }), OWNER);
});
after(() => { child.kill(); mock.server.close(); hook.close(); db?.close(); });

test('phone alerts: config, test message via webhook', async () => {
  const c = await ok('/notify/config');
  assert.deepEqual(c.channels, ['webhook']);
  assert.ok(c.webhookUrl.startsWith('••••'), 'webhook URL is masked');
  const s = await ok('/settings');
  assert.ok(s.notify_webhook_url.startsWith('••••'), 'webhook URL is a secret in /settings');
  const r = await ok('/notify/test', { method: 'POST' });
  assert.deepEqual(r.sent, ['webhook']);
  assert.ok(received.some(m => /phone alerts are working/.test(m.text) && m.content && m.source === 'tubedesk'));
});

test('impressions + CTR from the Reporting API: job, pagination, ingest, idempotent, summary', async () => {
  const before = (await ok(`/reach/${OWNER}`)).status;
  assert.equal(before, 'not-started');
  const r1 = await ok(`/reach/${OWNER}/sync`, { method: 'POST' });
  assert.equal(r1.error, undefined, r1.error);
  assert.equal(r1.newReports, 40, 'both pages ingested');
  assert.ok(r1.rows > 100);
  assert.equal(REPORTING.jobs.length, 1, 'reach job scheduled once');
  assert.ok(calls.filter(c => c.path.startsWith('/reporting/')).every(c => c.auth === 'Bearer tok'), 'owner token on every call');
  const r2 = await ok(`/reach/${OWNER}/sync`, { method: 'POST' });
  assert.equal(r2.newReports, 0, 'already-ingested reports are skipped');
  assert.equal(REPORTING.jobs.length, 1);
  const s = await ok(`/reach/${OWNER}?days=28`);
  assert.equal(s.status, 'ok');
  assert.equal(s.daily.length, 28);
  assert.ok(s.totals.impressions > 0 && s.totals.ctr > 1 && s.totals.ctr < 10, 'CTR stored as percent: ' + s.totals.ctr);
  assert.ok(Math.abs(s.baseline.ctr - 4.2) < 0.01, 'usual first-3-day CTR: ' + JSON.stringify(s.baseline));
  assert.ok(s.lowCtrHighImpressions.some(v => v.video_id === vidId(1)), 'the 1.6% video is flagged');
  const v1 = await ok(`/reach/video/${vidId(1)}`);
  assert.ok(Math.abs(v1.ctr - 1.6) < 1e-6 && v1.impressions > 0);
});

test('autopilot diagnosis uses real CTR', async () => {
  const d1 = await ok(`/autopilot/diagnose/${vidId(1)}`);
  assert.equal(d1.kind, 'packaging'); assert.ok(d1.ctrRatio < 0.5 && /people see it but don't click/.test(d1.text));
  const d2 = await ok(`/autopilot/diagnose/${vidId(2)}`);
  assert.notEqual(d2.kind, 'packaging');
  const none = await ok(`/autopilot/diagnose/${(await ok(`/channels/${COMP}/videos?limit=1`)).videos[0].id}`);
  assert.equal(none.kind, 'unknown', 'no reach data → unknown');
});

test('watch triggers autopilot on the low-CTR upload: new title + generated thumbnail applied, logged, phoned', { skip: !FFMPEG }, async () => {
  const src = path.join(dataDir, 'episode-1.mp4');
  execFileSync(FFMPEG, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=1280x720:rate=30:duration=4', '-pix_fmt', 'yuv420p', src]);
  await ok('/autopilot/assets', { method: 'POST', body: { videoId: vidId(1), kind: 'source', path: src } });
  assert.equal((await api('/autopilot/assets', { method: 'POST', body: { videoId: vidId(1), kind: 'source', path: '/nope.mp4' } })).status, 400);
  const before = (await ok(`/channels/${OWNER}/videos?limit=5`)).videos.find(v => v.id === vidId(1)).title;
  const mark = calls.length;
  const w = await ok('/radar/watch/run', { method: 'POST' });
  assert.equal(w.errors.length, 0, w.errors.join(' | '));
  assert.deepEqual(w.autopilot.map(a => a.videoId), [vidId(1)], 'only the low-CTR upload is touched');
  const { actions, settings } = await ok(`/autopilot/${OWNER}`);
  assert.equal(settings.mode, 'auto');
  const a = actions[0];
  assert.equal(a.status, 'applied', a.message);
  assert.equal(a.changed, 'title,thumbnail');
  assert.equal(a.before_title, before);
  assert.ok(a.after_title && a.after_title !== before);
  assert.ok(a.candidates.titles.length === 3, 'duplicate of the current title dropped');
  assert.equal(a.candidates.thumbnails.length, 3, 'three frames cut from the source file');
  assert.ok(a.after_thumb.startsWith('/data/thumbs/autopilot-'));
  assert.ok(fs.existsSync(path.join(dataDir, 'thumbs', path.basename(a.after_thumb))));
  assert.equal(a.diagnosis.kind, 'packaging');
  const newCalls = calls.slice(mark);
  const put = newCalls.find(c => c.method === 'PUT' && c.path.endsWith('/videos'));
  assert.ok(put && put.auth === 'Bearer tok', 'videos.update with the owner token');
  assert.ok(newCalls.some(c => c.path.endsWith('/upload/thumbnails/set') && c.q.videoId === vidId(1)), 'thumbnails.set');
  assert.equal((await ok(`/channels/${OWNER}/videos?limit=5`)).videos.find(v => v.id === vidId(1)).title, a.after_title, 'local library updated');
  assert.ok(await waitFor(() => received.some(m => /^Autopilot updated/.test(m.title))), 'phone told');
  const board = await ok(`/radar/watch/${OWNER}`);
  assert.ok(/^applied/.test(board.videos.find(v => v.video_id === vidId(1)).autopilot_note));
  assert.ok(board.videos.find(v => v.video_id === vidId(1)).ctr < 2, 'CTR on the watch board');
  const w2 = await ok('/radar/watch/run', { method: 'POST' });
  assert.equal(w2.autopilot.length, 0, 'one swap per video');
});

test('a swap that lowers CTR is graded after 48 h and reverted automatically', { skip: !FFMPEG }, async () => {
  const a = (await ok(`/autopilot/${OWNER}`)).actions[0];
  const swapDay = new Date(Date.now() - 6 * 86400000).toISOString();
  db.prepare('UPDATE autopilot_actions SET applied_at = ? WHERE id = ?').run(swapDay, a.id);
  db.prepare('UPDATE reach_daily SET ctr = CASE WHEN day > ? THEN 1.0 ELSE 3.0 END WHERE video_id = ?').run(swapDay.slice(0, 10), vidId(1));
  const mark = calls.length;
  const graded = await ok('/autopilot/evaluate', { method: 'POST' });
  assert.equal(graded.length, 1); assert.equal(graded[0].reverted, true);
  const r = (await ok(`/autopilot/${OWNER}`)).actions.find(x => x.id === a.id);
  assert.equal(r.status, 'reverted');
  assert.ok(r.ctr_before > r.ctr_after && /Auto-reverted/.test(r.outcome));
  const put = calls.slice(mark).filter(c => c.method === 'PUT' && c.path.endsWith('/videos'));
  assert.equal(put.length, 1, 'title restored');
  assert.ok(calls.slice(mark).some(c => c.path.endsWith('/upload/thumbnails/set')), 'original thumbnail restored');
  assert.equal((await ok(`/channels/${OWNER}/videos?limit=5`)).videos.find(v => v.id === vidId(1)).title, a.before_title);
  assert.ok(await waitFor(() => received.some(m => /^Autopilot reverted/.test(m.title))));
});

test('auto-revert leaves the title alone when the owner edited it after the swap', async () => {
  await ok('/settings', { method: 'PUT', body: { autopilot_mode: 'auto' } });
  const a = await ok(`/autopilot/run/${vidId(4)}`, { method: 'POST', body: { force: true } });
  assert.equal(a.status, 'applied', a.message);
  const again = await ok(`/autopilot/run/${vidId(4)}`, { method: 'POST', body: { force: true } });
  assert.equal(again.id, a.id, 'an open change blocks a second run on the same video');
  db.prepare('UPDATE videos SET title = ? WHERE id = ?').run('My own newer title', vidId(4));
  const swapDay = new Date(Date.now() - 6 * 86400000).toISOString();
  db.prepare('UPDATE autopilot_actions SET applied_at = ? WHERE id = ?').run(swapDay, a.id);
  db.prepare('UPDATE reach_daily SET ctr = CASE WHEN day > ? THEN 1.0 ELSE 3.0 END WHERE video_id = ?').run(swapDay.slice(0, 10), vidId(4));
  const mark = calls.length;
  const graded = await ok('/autopilot/evaluate', { method: 'POST' });
  assert.equal(graded.find(g => g.id === a.id).reverted, false);
  assert.ok(!calls.slice(mark).some(c => c.method === 'PUT'), 'nothing written to YouTube');
  const r = (await ok(`/autopilot/${OWNER}`)).actions.find(x => x.id === a.id);
  assert.ok(/you have edited the title since/.test(r.message));
});

test('suggest mode stages instead of applying; approve then undo', async () => {
  await ok('/settings', { method: 'PUT', body: { autopilot_mode: 'suggest' } });
  const mark = calls.length;
  const a = await ok(`/autopilot/run/${vidId(2)}`, { method: 'POST', body: { force: true } });
  assert.equal(a.status, 'suggested', a.message);
  assert.ok(/suggest mode/.test(a.message));
  assert.ok(!calls.slice(mark).some(c => c.method === 'PUT'), 'nothing written to YouTube');
  const staged = await ok(`/packaging/staged/${OWNER}`);
  assert.ok(staged.some(s => s.video_id === vidId(2) && s.new_value === a.after_title));
  const ap = await ok(`/autopilot/actions/${a.id}/approve`, { method: 'POST' });
  assert.equal(ap.status, 'applied');
  assert.ok(calls.slice(mark).some(c => c.method === 'PUT' && c.path.endsWith('/videos')));
  const rv = await ok(`/autopilot/actions/${a.id}/revert`, { method: 'POST' });
  assert.equal(rv.status, 'reverted');
  assert.equal((await api(`/autopilot/actions/${a.id}/revert`, { method: 'POST' })).status, 400, 'cannot revert twice');
  await ok('/settings', { method: 'PUT', body: { autopilot_mode: 'auto' } });
});

test('no clear winner → left unchanged; Shorts and off-mode respected', async () => {
  await ok('/settings', { method: 'PUT', body: { autopilot_min_gain: '99' } });
  const [a, twin] = await Promise.all([1, 2].map(() => ok(`/autopilot/run/${vidId(3)}`, { method: 'POST', body: { force: true } })));
  assert.equal(a.id, twin.id, 'concurrent runs on one video share one action');
  assert.equal(a.status, 'skipped'); assert.ok(/No candidate beat the current package by 99/.test(a.message));
  await ok('/settings', { method: 'PUT', body: { autopilot_min_gain: '1', autopilot_mode: 'off' } });
  const w = await ok('/radar/watch/run', { method: 'POST' });
  assert.equal(w.autopilot.length, 0);
  await ok('/settings', { method: 'PUT', body: { autopilot_mode: 'auto' } });
});

test('daily ideas: signals → AI ideas → every title radar-scored → stored, phoned, filterable', async () => {
  const r = await ok(`/ideas/${OWNER}/run`, { method: 'POST', body: {} });
  assert.ok(r.signals >= 3, 'signals gathered: ' + r.signals);
  assert.equal(r.ideas.length, 3);
  for (const i of r.ideas) {
    assert.equal(i.titles.length, 3);
    assert.ok(i.titles.every(t => Number.isFinite(t.score)), 'every title scored');
    assert.equal(i.best_title, i.titles[0].title, 'best title = highest radar score');
    assert.ok(i.titles[0].score >= i.titles[2].score);
    assert.ok(i.sources.length >= 1 && i.sources[0].type && i.sources[0].text, 'cites evidence');
    assert.ok(i.hook && i.thumb_text);
  }
  assert.ok(r.ideas.some(i => i.sources.some(s => s.type === 'search term bringing you viewers')), 'owner search terms used');
  assert.ok(r.ideas.some(i => i.sources.some(s => s.type === 'competitor breakout')), 'competitor breakouts used');
  assert.equal(r.ideas.find(i => i.format === 'short').format, 'short');
  assert.deepEqual(r.ideas.map(i => i.rank), [1, 2, 3]);
  assert.ok(await waitFor(() => received.some(m => /^Today's top ideas/.test(m.title) && /1\. /.test(m.message))), 'top 3 sent to the phone');
  const again = await ok(`/ideas/${OWNER}/run`, { method: 'POST', body: { notify: false } });
  assert.equal(again.ideas.length, 0, 'near-repeats of the last 14 days are dropped');
  const list = await ok(`/ideas/${OWNER}`);
  assert.equal(list.length, 3);
  await ok(`/ideas/item/${list[0].id}/status`, { method: 'POST', body: { status: 'dismissed' } });
  assert.equal((await ok(`/ideas/${OWNER}`)).length, 2, 'dismissed ideas are hidden');
  assert.equal((await api(`/ideas/item/${list[0].id}/status`, { method: 'POST', body: { status: 'bogus' } })).status, 400);
});

test('quiet hours hold phone messages, then send them as one digest', async () => {
  const h = new Date().getHours();
  await ok('/settings', { method: 'PUT', body: { notify_quiet: `${h}-${(h + 2) % 24}` } });
  db.prepare("DELETE FROM radar_ideas").run();
  await waitFor(() => false, 300); // let earlier fire-and-forget deliveries land
  const n1 = received.length;
  await ok(`/ideas/${OWNER}/run`, { method: 'POST', body: {} });
  await ok(`/ideas/${OWNER}/run`, { method: 'POST', body: {} }); // dropped as repeats → no message
  db.prepare("INSERT INTO notify_log (kind, title, status) VALUES ('radar_breakout', 'held breakout', 'held')").run();
  await new Promise(r => setTimeout(r, 300));
  assert.equal(received.length, n1, 'nothing sent during quiet hours');
  assert.ok((await ok('/notify/log')).filter(l => l.status === 'held').length >= 2);
  await ok('/settings', { method: 'PUT', body: { notify_quiet: '' } });
  await ok('/radar/watch/run', { method: 'POST' });
  assert.ok(await waitFor(() => received.length === n1 + 1), 'one digest');
  assert.ok(/alerts overnight/.test(received.at(-1).title));
  assert.equal((await ok('/notify/log')).filter(l => l.status === 'held').length, 0);
});

test('MCP exposes ideas, autopilot and CTR tools', async () => {
  const mcp = spawn(process.execPath, ['mcp/server.js'], { cwd: ROOT, env: { ...process.env, TUBEDESK_URL: base }, stdio: ['pipe', 'pipe', 'pipe'] });
  const lines = [];
  mcp.stdout.on('data', d => lines.push(...String(d).split('\n').filter(Boolean)));
  const send = o => mcp.stdin.write(JSON.stringify(o) + '\n');
  send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'daily_ideas', arguments: {} } });
  send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'autopilot', arguments: {} } });
  send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'ctr_report', arguments: { days: 7 } } });
  send({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'autopilot', arguments: { action: 'run' } } });
  for (let i = 0; i < 100 && lines.length < 5; i++) await new Promise(r => setTimeout(r, 50));
  mcp.stdin.end();
  const byId = Object.fromEntries(lines.map(l => JSON.parse(l)).map(m => [m.id, m]));
  const names = byId[1].result.tools.map(t => t.name);
  for (const n of ['daily_ideas', 'autopilot', 'ctr_report']) assert.ok(names.includes(n), n);
  assert.ok(Array.isArray(JSON.parse(byId[2].result.content[0].text)));
  assert.ok(JSON.parse(byId[3].result.content[0].text).actions.length >= 3);
  assert.equal(JSON.parse(byId[4].result.content[0].text).daily.length, 7);
  assert.equal(byId[5].result.isError, true, 'run without videoId is an error');
});
