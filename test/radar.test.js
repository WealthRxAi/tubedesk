// Integration: virality radar end to end — real server, mock YouTube, and a fake Claude CLI for the AI axes.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startMock } from './mock-youtube.js';

const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname), '..');
const FAKE_CLAUDE = path.join(ROOT, 'test', 'fake-claude.mjs');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'td-radar-'));
let mock, child, base;
const OWNER = 'UCowner00000000000000001', COMP = 'UCcomp000000000000000002';

async function api(p, { method = 'GET', body } = {}) {
  const res = await fetch(base + '/api' + p, { method, headers: body !== undefined ? { 'content-type': 'application/json' } : {}, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, json };
}
const ok = async (p, o) => { const r = await api(p, o); assert.equal(r.status, 200, `${p}: ${JSON.stringify(r.json).slice(0, 400)}`); return r.json; };

before(async () => {
  mock = await startMock(0);
  const port = 5100 + Math.floor(Math.random() * 300);
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ['src/server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(port), TUBEDESK_DATA_DIR: dataDir, TUBEDESK_NO_SCHEDULER: '1', YT_API_BASE: `http://127.0.0.1:${mock.port}/youtube/v3`, YT_ANALYTICS_BASE: `http://127.0.0.1:${mock.port}/v2/reports`, YT_SUGGEST_URL: `http://127.0.0.1:${mock.port}/complete/search` }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stderr.on('data', d => process.stderr.write('[server] ' + d));
  for (let i = 0; i < 50; i++) { try { await fetch(base + '/api/status'); break; } catch { await new Promise(r => setTimeout(r, 100)); } }
  await ok('/settings', { method: 'PUT', body: { yt_api_key: 'TESTKEY', ai_provider: 'none', default_country: 'US' } });
  await ok('/channels', { method: 'POST', body: { input: '@TheParentPlan', kind: 'owned', maxVideos: 100 } });
  await ok(`/competitors/${OWNER}`, { method: 'POST', body: { input: COMP } });
});
after(() => { child.kill(); mock.server.close(); });

test('axes contract', async () => {
  const a = await ok('/radar/axes');
  assert.equal(Object.keys(a.axes).length, 8);
  assert.ok(Math.abs(Object.values(a.defaultWeights).reduce((x, y) => x + y, 0) - 1) < 1e-9);
  assert.equal(a.axes.demand.backtest, false); assert.equal(a.axes.hook.backtest, false);
});

test('score variants without AI: deterministic axes, ranking, notes, saved', async () => {
  const d = await ok('/radar/score', { method: 'POST', body: { channelId: OWNER, variants: [{ title: 'The Medicaid Lookback Rule That Costs Families $80K' }, { title: 'medicaid stuff' }], keyword: 'medicaid lookback' } });
  assert.equal(d.variants.length, 2);
  assert.equal(d.aiUsed, false);
  assert.ok(d.notes.some(n => /AI is off/.test(n)) && d.notes.some(n => /Uncalibrated/.test(n)));
  assert.equal(d.model.calibrated, false);
  for (const v of d.variants) {
    assert.ok(Number.isFinite(v.axes.demand) && Number.isFinite(v.axes.titleCraft) && Number.isFinite(v.axes.freshness));
    assert.equal(v.axes.curiosity, null); assert.equal(v.axes.thumbnail, null);
    assert.ok(v.score >= 0 && v.score <= 100 && v.prediction.multiplier > 0 && v.prediction.range80.length === 2);
    assert.ok(v.coverage > 0 && v.coverage < 1, 'AI axes missing → partial coverage');
    assert.ok(v.id > 0);
  }
  assert.ok(d.variants[0].score >= d.variants[1].score, 'ranked by score');
  assert.equal(d.variants[0].rank, 1);
  assert.ok(d.variants[0].axes.patternFit !== null, 'overlapping topics in the library give pattern fit');
  assert.ok(d.variants.find(v => v.title === 'medicaid stuff').advice.some(a => a.axis === 'titleCraft'));
  const bad = await api('/radar/score', { method: 'POST', body: { channelId: OWNER, variants: [{ title: '  ' }] } });
  assert.equal(bad.status, 400);
});

test('freshness flags repeating your own recent upload', async () => {
  const lib = await ok(`/channels/${OWNER}/videos?limit=1`);
  const recent = lib.videos[0];
  const d = await ok('/radar/score', { method: 'POST', body: { channelId: OWNER, title: recent.title, save: false } });
  const v = d.variants[0];
  assert.ok(v.axes.freshness <= 25, 'own duplicate caps freshness: ' + v.axes.freshness);
  assert.equal(v.details.freshness.ownDuplicate.id, recent.id);
  assert.equal(d.batchId, null, 'save:false stores nothing');
});

test('a scored idea links to the upload once the watch sees it', async () => {
  const lib = await ok(`/channels/${OWNER}/videos?limit=3`);
  const target = lib.videos[1]; // ~18 days old: inside a 30-day watch window and old enough to have an outcome
  await ok('/radar/score', { method: 'POST', body: { channelId: OWNER, title: target.title } });
  await ok('/settings', { method: 'PUT', body: { radar_watch_days: '30', radar_watch_competitor_days: '30' } });
  const w = await ok('/radar/watch/run', { method: 'POST' });
  assert.ok(w.watched >= 6, 'own + competitor uploads inside the window: ' + w.watched);
  assert.equal(w.errors.length, 0, w.errors.join(';'));
  const hist = await ok(`/radar/history/${OWNER}`);
  const linked = hist.scores.find(s => s.videoId === target.id);
  assert.ok(linked, 'auto-linked by title');
  assert.ok(linked.actualX > 0, 'outcome available for an 18-day-old upload');
  assert.ok(linked.live && linked.live.status);
  assert.ok(hist.tracked.linked >= 1);
  // manual unlink / relink
  assert.equal((await ok(`/radar/scores/${linked.id}/link`, { method: 'POST', body: { videoId: null } })).updated, 1);
  assert.equal((await ok(`/radar/scores/${linked.id}/link`, { method: 'POST', body: { videoId: target.id } })).updated, 1);
});

test('live watch: board, pace vs baseline, alerts once, launch curve', async () => {
  const before = (await ok(`/alerts/${OWNER}`)).filter(a => a.kind.startsWith('radar'));
  const w2 = await ok('/radar/watch/run', { method: 'POST' });
  const board = await ok(`/radar/watch/${OWNER}`);
  assert.ok(board.lastRun && board.lastRun.watched === w2.watched);
  const own = board.videos.filter(v => v.kind === 'owned'), comp = board.videos.filter(v => v.kind === 'competitor');
  assert.ok(own.length >= 3 && comp.length >= 3);
  for (const v of board.videos) {
    assert.ok(v.views > 0 && v.age_hours > 0 && v.spark.length >= 2, 'two readings → sparkline');
    assert.ok(v.expected > 0 && v.idx > 0, 'baseline from history');
    assert.ok(['breakout', 'rising', 'on-track', 'lagging', 'stalled'].includes(v.status), v.status);
    assert.equal(v.confidence, 'low', 'no launch history yet → labelled estimate');
  }
  // The mock makes every 5th upload a 6× hit: the newest own upload (index 0) is one.
  const newest = own.sort((a, b) => b.published_at.localeCompare(a.published_at))[0];
  assert.ok(newest.idx > own.find(v => v !== newest).idx, 'the 6× upload paces ahead of a normal one');
  const after = (await ok(`/alerts/${OWNER}`)).filter(a => a.kind.startsWith('radar'));
  assert.equal(after.length, before.length, 'alerts fire once per video, not on every tick');
  assert.ok(after.some(a => a.kind === 'radar_breakout' || a.kind === 'radar_competitor_breakout'), 'a breakout alert was raised');
  const curve = await ok(`/radar/curve/${newest.video_id}`);
  assert.equal(curve.expected.length, 24);
  assert.ok(curve.ticks.length >= 2);
  assert.equal((await api('/radar/curve/doesnotexist')).status, 404);
});

test('calibration without AI: backtest, holdout, stored model, used by scoring', async () => {
  const job = await ok(`/radar/calibrate/${OWNER}?wait=1`, { method: 'POST', body: { ai: false } });
  assert.equal(job.status, 'done', job.error);
  const m = job.result;
  assert.ok(m.calibrated && m.id > 0);
  assert.ok(m.metrics.sample.labelled >= 60 && m.metrics.sample.own >= 20 && m.metrics.sample.withAI === 0);
  assert.ok(m.metrics.holdout.available && m.metrics.holdout.test >= 8);
  assert.ok(['useful', 'weak', 'not predictive yet'].includes(m.metrics.holdout.verdict));
  assert.ok(Math.abs(Object.values(m.weights).reduce((a, b) => a + b, 0) - 1) < 1e-3);
  assert.ok(m.axes.patternFit.n >= 30 && m.axes.curiosity.n === 0);
  assert.ok(m.metrics.points.length === m.metrics.sample.labelled);
  const model = await ok(`/radar/model/${OWNER}`);
  assert.equal(model.current.id, m.id);
  assert.ok(model.history.length >= 1 && model.history[0].metrics.points === undefined, 'history list stays light');
  const d = await ok('/radar/score', { method: 'POST', body: { channelId: OWNER, title: 'Why Estate Recovery Takes the Family House', save: false } });
  assert.equal(d.model.id, m.id); assert.ok(d.model.calibrated);
  assert.ok(!d.notes.some(n => /Uncalibrated/.test(n)));
  const ex = await ok(`/radar/video/${(await ok(`/channels/${OWNER}/videos?limit=5`)).videos[4].id}`);
  assert.ok(ex.actualX > 0 && ex.score !== null && ex.modelId === m.id);
  assert.equal((await api('/radar/calibrate/UCnope000000000000000000x', { method: 'POST', body: {} })).status, 404);
});

test('AI axes via the Claude CLI: package scoring with thumbnails + hook, cached calibration features', async () => {
  await ok('/settings', { method: 'PUT', body: { ai_provider: 'claude-cli', claude_cli_path: FAKE_CLAUDE } });
  try {
    const up = await ok('/packaging/thumbnail/upload', { method: 'POST', body: { dataUrl: 'data:image/jpeg;base64,' + Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64'), name: 'a.jpg' } });
    const d = await ok('/radar/score', { method: 'POST', body: { channelId: OWNER, hook: 'Medicaid can take your mom\'s house after she dies. Here is the rule and the two ways families stop it.',
      variants: [{ title: 'Nobody Warns You About Estate Recovery', thumbnailUrl: up.url }, { title: 'Estate Recovery Overview', thumbnailPath: up.path }, { title: 'Estate recovery basics' }] } });
    assert.equal(d.aiUsed, true, d.notes.join(';'));
    const [a, b, c] = ['Nobody Warns You About Estate Recovery', 'Estate Recovery Overview', 'Estate recovery basics'].map(t => d.variants.find(v => v.title === t));
    assert.ok(a.axes.curiosity > 0 && a.axes.emotion === 82 && a.axes.thumbnail === 61 && a.axes.hook === 72);
    assert.ok(b.axes.thumbnail === 61, 'thumbnailPath works');
    assert.equal(c.axes.thumbnail, null, 'no image → no thumbnail rating');
    assert.ok(a.ai.why && a.coverage === 1, 'all 8 axes scored');
    assert.ok(a.advice.every(x => typeof x.text === 'string'));
    // Calibration rates library packages (with their thumbnails) in batches and caches them.
    const j1 = await ok(`/radar/calibrate/${OWNER}?wait=1`, { method: 'POST', body: { aiLimit: 14 } });
    assert.equal(j1.status, 'done', j1.error);
    assert.equal(j1.result.metrics.ai.used, true);
    assert.equal(j1.result.metrics.ai.done, 14, JSON.stringify(j1.result.metrics.ai));
    assert.ok(j1.result.metrics.sample.withAI >= 14);
    assert.ok(j1.result.axes.curiosity.n >= 14 && j1.result.axes.thumbnail.n >= 14);
    const j2 = await ok(`/radar/calibrate/${OWNER}?wait=1`, { method: 'POST', body: { aiLimit: 14 } });
    assert.equal(j2.result.metrics.ai.cached, 14); assert.equal(j2.result.metrics.ai.done, 0, 'second run costs no AI calls');
    const vids = (await ok(`/channels/${OWNER}/videos?limit=3`)).videos;
    const mature = await ok(`/radar/video/${vids[2].id}`); // 27 days old → labelled → AI-rated by calibration
    assert.ok(Number.isFinite(mature.axes.curiosity) && Number.isFinite(mature.axes.thumbnail), 'featurized videos show AI axes in the drawer');
    const young = await ok(`/radar/video/${vids[0].id}`); // 9 days old → not yet judged, not rated
    assert.equal(young.actualX, null); assert.equal(young.axes.curiosity, null);
  } finally {
    await ok('/settings', { method: 'PUT', body: { ai_provider: 'none' } });
  }
});

test('MCP server exposes the radar tools', async () => {
  const mcp = spawn(process.execPath, ['mcp/server.js'], { cwd: ROOT, env: { ...process.env, TUBEDESK_URL: base }, stdio: ['pipe', 'pipe', 'pipe'] });
  const lines = [];
  mcp.stdout.on('data', d => lines.push(...String(d).split('\n').filter(Boolean)));
  const send = o => mcp.stdin.write(JSON.stringify(o) + '\n');
  send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'radar_score', arguments: { variants: [{ title: 'Medicaid Pays For This (Not That)' }] } } });
  send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'radar_watch', arguments: {} } });
  for (let i = 0; i < 100 && lines.length < 3; i++) await new Promise(r => setTimeout(r, 50));
  mcp.stdin.end();
  const byId = Object.fromEntries(lines.map(l => JSON.parse(l)).map(m => [m.id, m]));
  const names = byId[1].result.tools.map(t => t.name);
  for (const n of ['radar_score', 'radar_watch', 'radar_calibrate']) assert.ok(names.includes(n), n);
  assert.equal(byId[2].result.isError, false, byId[2].result.content[0].text);
  const scored = JSON.parse(byId[2].result.content[0].text);
  assert.equal(scored.channelId, OWNER, 'defaults to the first owned channel');
  assert.ok(JSON.parse(byId[3].result.content[0].text).videos.length > 0);
});
