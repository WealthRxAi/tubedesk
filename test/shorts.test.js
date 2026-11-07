// Integration: local transcription (fake whisper.cpp), Shorts cut from a long upload (AI moments → radar-scored →
// 9:16 render with captions → best slots → publish queue → YouTube + Instagram), best publish times, Instagram
// reels on the radar, the all-channels board + weekly summary, and transcript-based hook backtesting.
// Real server, mock YouTube/Instagram, fake Claude + fake whisper CLIs, real ffmpeg.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startMock, calls, IG, UPLOADED } from './mock-youtube.js';

const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname), '..');
const FAKE_CLAUDE = path.join(ROOT, 'test', 'fake-claude.mjs');
const FAKE_WHISPER = path.join(ROOT, 'test', 'fake-whisper.mjs');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'td-shorts-'));
const OWNER = 'UCowner00000000000000001', COMP = 'UCcomp000000000000000002';
const FFMPEG = ['/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg', '/opt/homebrew/bin/ffmpeg'].find(f => fs.existsSync(f));
const FFPROBE = ['/usr/local/bin/ffprobe', '/usr/bin/ffprobe', '/opt/homebrew/bin/ffprobe'].find(f => fs.existsSync(f));
let mock, child, base, hook, db;
const received = [];

async function api(p, { method = 'GET', body } = {}, retry = true) {
  let res;
  // A keep-alive socket can be closed by the server while the test was busy (e.g. generating the source video).
  try { res = await fetch(base + '/api' + p, { method, headers: body !== undefined ? { 'content-type': 'application/json' } : {}, body: body !== undefined ? JSON.stringify(body) : undefined }); }
  catch (e) { if (retry && e.cause?.code === 'UND_ERR_SOCKET') return api(p, { method, body }, false); throw e; }
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, json };
}
const ok = async (p, o) => { const r = await api(p, o); assert.equal(r.status, 200, `${p}: ${JSON.stringify(r.json).slice(0, 600)}`); return r.json; };
const waitFor = async (fn, ms = 3000) => { for (let t = 0; t < ms; t += 50) { if (await fn()) return true; await new Promise(r => setTimeout(r, 50)); } return fn(); };
const vidId = i => ('owne' + String(i).padStart(7, '0')).slice(0, 11);
const probe = f => JSON.parse(execFileSync(FFPROBE, ['-v', 'error', '-show_entries', 'stream=codec_type,width,height:format=duration', '-of', 'json', f]).toString());
const SRC = path.join(dataDir, 'episode-2.mp4');

let port;
async function startServer() {
  port ??= 5700 + Math.floor(Math.random() * 250);
  base = `http://127.0.0.1:${port}`;
  const M = `http://127.0.0.1:${mock.port}`;
  child = spawn(process.execPath, ['src/server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(port), TUBEDESK_DATA_DIR: dataDir, TUBEDESK_NO_SCHEDULER: '1', TZ: 'America/New_York',
    YT_API_BASE: `${M}/youtube/v3`, YT_ANALYTICS_BASE: `${M}/v2/reports`, YT_SUGGEST_URL: `${M}/complete/search`, YT_UPLOAD_BASE: `${M}/upload`, YT_REPORTING_BASE: `${M}/reporting/v1`, IG_GRAPH_BASE: `${M}/ig` }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stderr.on('data', d => process.stderr.write('[server] ' + d));
  for (let i = 0; i < 80; i++) { try { await fetch(base + '/api/status'); break; } catch { await new Promise(r => setTimeout(r, 100)); } }
}
before(async () => {
  mock = await startMock(0);
  hook = http.createServer((req, res) => { let b = ''; req.on('data', d => b += d); req.on('end', () => { received.push(JSON.parse(b)); res.end('ok'); }); });
  await new Promise(r => hook.listen(0, '127.0.0.1', r));
  await startServer();
  const model = path.join(dataDir, 'ggml-test.bin'); fs.writeFileSync(model, 'not a real model');
  await ok('/settings', { method: 'PUT', body: { yt_api_key: 'TESTKEY', ai_provider: 'claude-cli', claude_cli_path: FAKE_CLAUDE, default_country: 'US', timezone: 'America/New_York',
    notify_webhook_url: `http://127.0.0.1:${hook.address().port}/hook`, notify_quiet: '', radar_watch_days: '30', radar_watch_competitor_days: '30',
    whisper_path: FAKE_WHISPER, whisper_model: model, clips_min_seconds: '8', clips_max_seconds: '12', clips_count: '2', clips_publish: 'review',
    ig_access_token: 'IGTOKEN', ig_user_id: '17841400000000001', public_base_url: 'https://tubedesk.example.org', autopilot_mode: 'off' } });
  await ok('/channels', { method: 'POST', body: { input: '@TheParentPlan', kind: 'owned', maxVideos: 100 } });
  await ok(`/competitors/${OWNER}`, { method: 'POST', body: { input: COMP } });
  const Database = (await import('better-sqlite3')).default;
  db = new Database(path.join(dataDir, 'tubedesk.sqlite'));
  db.prepare('UPDATE channels SET oauth_json = ? WHERE id = ?').run(JSON.stringify({ access_token: 'tok', refresh_token: 'rt', expires_at: Date.now() + 3600e3 }), OWNER);
  if (FFMPEG) execFileSync(FFMPEG, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=1280x720:rate=30:duration=60', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=60', '-shortest', '-pix_fmt', 'yuv420p', '-c:a', 'aac', SRC]);
});
after(() => { child.kill(); mock.server.close(); hook.close(); db?.close(); });

test('engine status reports the local transcriber', async () => {
  const s = await ok('/shorts/status');
  assert.equal(s.engine.whisper, FAKE_WHISPER);
  assert.equal(s.engine.modelReady, true);
  assert.equal(s.engine.ready, !!FFMPEG);
  assert.equal(s.instagram, true);
  assert.deepEqual(s.settings.platforms, ['youtube', 'instagram']);
});

test('local transcription: ffmpeg → whisper word timings, cached, used as a source file lookup', { skip: !FFMPEG }, async () => {
  assert.equal((await api(`/transcripts/${vidId(2)}`)).status, 404);
  assert.equal((await api(`/transcripts/${vidId(2)}`, { method: 'POST', body: {} })).status, 404, 'no source file and captions not allowed');
  await ok('/autopilot/assets', { method: 'POST', body: { videoId: vidId(2), kind: 'source', path: SRC } });
  const t = await ok(`/transcripts/${vidId(2)}`, { method: 'POST', body: {} });
  assert.equal(t.source, 'whisper');
  assert.ok(t.words.length > 80, 'word-level timings: ' + t.words.length);
  assert.ok(t.words.every((w, i) => w.end > w.start && (i === 0 || w.start >= t.words[i - 1].start)));
  assert.ok(Math.abs(t.words.at(-1).end - 60) < 1, 'covers the whole file');
  assert.equal(t.words[0].text, 'Medicaid');
  assert.deepEqual((await ok(`/transcripts/${vidId(2)}`)).words.length, t.words.length, 'cached');
});

test('Shorts: AI moments → snapped → radar-scored → rendered 9:16 with captions → review mode waits', { skip: !FFMPEG }, async () => {
  assert.equal((await api(`/shorts/make/${vidId(4)}?wait=1`, { method: 'POST', body: {} })).status, 400, 'no source file → clear error');
  const r = await ok(`/shorts/make/${vidId(2)}?wait=1`, { method: 'POST', body: {} });
  assert.equal(r.transcript.source, 'whisper');
  assert.ok(r.candidates >= 3, 'the too-short candidate is dropped, valid ones kept: ' + r.candidates);
  assert.equal(r.clips.length, 2, 'clips_count respected');
  assert.deepEqual(r.scheduled, [], 'review mode: nothing scheduled');
  for (const c of r.clips) {
    assert.equal(c.status, 'ready', c.error);
    assert.ok(Number.isFinite(c.score) && c.prediction, 'radar score + prediction');
    const len = c.end - c.start;
    assert.ok(len >= 8 && len <= 12.5, 'length within bounds: ' + len);
    assert.ok(c.title && c.hook_text);
    assert.ok(c.url.startsWith('/data/clips/') && c.coverUrl.startsWith('/data/clips/'));
    const p = probe(c.file);
    const v = p.streams.find(s => s.codec_type === 'video');
    assert.equal(v.width, 1080); assert.equal(v.height, 1920);
    assert.ok(p.streams.some(s => s.codec_type === 'audio'), 'audio kept');
    assert.ok(Math.abs(Number(p.format.duration) - len) < 0.6, 'duration matches the window');
    const served = await fetch(base + c.url);
    assert.equal(served.status, 200, 'clip served to the UI');
  }
  assert.ok(r.clips[0].score >= r.clips[1].score, 'best-scoring first');
  assert.ok(r.clips[0].end <= r.clips[1].start || r.clips[1].end <= r.clips[0].start, 'no overlap');
  assert.ok(await waitFor(() => received.some(m => /Shorts? cut from/.test(m.title) && /Review and schedule/.test(m.message))), 'phone told');
  const list = await ok(`/shorts/${OWNER}`);
  assert.equal(list.length, 2);
  assert.equal((await api(`/shorts/make/${vidId(6)}?wait=1`, { method: 'POST', body: {} })).status, 400, 'a Short cannot be cut into Shorts');
});

test('best publish times: learned from history, spaced, daytime, avoid taken slots; publishAt "best"', { skip: !FFMPEG }, async () => {
  const s = await ok(`/slots/${OWNER}?format=long&count=3`);
  assert.equal(s.next.length, 3);
  const at = s.next.map(x => Date.parse(x.at));
  assert.ok(at.every(t => t > Date.now() + 110 * 60000), 'at least 2 h out');
  for (let i = 1; i < at.length; i++) assert.ok(at[i] - at[i - 1] >= 20 * 3600e3, 'spaced ≥ 20 h');
  assert.ok(s.next.every(x => { const h = Number(new Date(x.at).toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false })); return h >= 6; }), 'never midnight–6 am local');
  assert.ok(s.grid.blocks.length && s.grid.weekdays.length);
  const job = await ok('/publish/youtube?wait=1', { method: 'POST', body: { file: SRC, title: 'Scheduled for the best slot', publishAt: 'best', format: 'long', channelId: OWNER } });
  assert.equal(job.status, 'done', job.error);
  assert.equal(job.slot.at, s.next[0].at, 'used the next best slot');
  assert.equal(job.params.privacy, 'private'); assert.equal(job.params.publishAt, s.next[0].at);
  const ins = calls.filter(c => c.path.endsWith('/upload/youtube/v3/videos') || (c.method === 'POST' && /\/upload\/.*videos/.test(c.path) && c.body)).at(-1);
  assert.equal(ins.body.status.publishAt, s.next[0].at, 'YouTube told to publish at the slot');
  const s2 = await ok(`/slots/${OWNER}?format=long&count=1`);
  assert.notEqual(s2.next[0].at, s.next[0].at, 'a scheduled upload holds its slot');
});

test('schedule clips into the best Shorts slots, then publish now to YouTube + Instagram', { skip: !FFMPEG }, async () => {
  const [c1, c2] = await ok(`/shorts/${OWNER}`);
  const s1 = await ok(`/shorts/clip/${c1.id}/schedule`, { method: 'POST' });
  const s2 = await ok(`/shorts/clip/${c2.id}/schedule`, { method: 'POST' });
  assert.equal(s1.length, 1); assert.ok(s1[0].youtube && s1[0].instagram);
  assert.ok(Math.abs(Date.parse(s2[0].publishAt) - Date.parse(s1[0].publishAt)) >= 20 * 3600e3, 'one Short per slot');
  const q = await ok(`/publish-queue?channel=${OWNER}`);
  const yt = q.find(x => x.clip_id === c1.id && x.platform === 'youtube'), ig = q.find(x => x.clip_id === c1.id && x.platform === 'instagram');
  assert.equal(Date.parse(yt.publish_at) - Date.parse(yt.run_at), 90 * 60000, 'YouTube uploads 90 min early as private + publishAt');
  assert.equal(ig.run_at, ig.publish_at, 'Instagram posts at the slot (no scheduling API)');
  assert.equal(yt.params.title, c1.title); assert.ok(/#Shorts/.test(yt.params.description) && yt.params.description.includes(`youtu.be/${vidId(2)}`));
  assert.equal(ig.params.kind, 'reel');
  assert.deepEqual(await ok('/publish-queue/run', { method: 'POST' }), [], 'nothing due yet');
  // taken slots are skipped by later picks
  const next = await ok(`/slots/${OWNER}?format=short&count=1`);
  assert.ok(![s1[0].publishAt, s2[0].publishAt].includes(next.next[0].at));
  const mark = calls.length;
  const done = await ok(`/shorts/clip/${c1.id}/publish-now`, { method: 'POST' });
  assert.equal(done.status, 'published', JSON.stringify(done.queue));
  assert.ok(done.queue.every(x => x.status === 'done'));
  assert.ok(done.yt_video_id && done.ig_media_id);
  const up = calls.slice(mark).find(c => c.method === 'POST' && c.body?.snippet?.title === c1.title);
  assert.equal(up.body.status.privacyStatus, 'public', 'publish now → public immediately');
  assert.ok(calls.slice(mark).some(c => c.igMedia?.media_type === 'REELS' && /^https:\/\/tubedesk\.example\.org\//.test(c.igMedia.video_url)), 'reel container from a public URL');
  const cancelled = await ok(`/shorts/clip/${c2.id}/cancel`, { method: 'POST' });
  assert.equal(cancelled.status, 'cancelled'); assert.ok(cancelled.queue.every(x => x.status === 'cancelled'));
});

test('a long-form breakout cuts Shorts automatically from the watch', { skip: !FFMPEG }, async () => {
  await ok('/settings', { method: 'PUT', body: { clips_publish: 'auto' } });
  // vidId(0) earns 6× the channel's usual views → breakout on the live watch.
  await ok('/autopilot/assets', { method: 'POST', body: { videoId: vidId(0), kind: 'source', path: SRC } });
  const w = await ok('/radar/watch/run', { method: 'POST' });
  assert.equal(w.errors.length, 0, w.errors.join(' | '));
  const board = await ok(`/radar/watch/${OWNER}`);
  assert.equal(board.videos.find(v => v.video_id === vidId(0))?.status, 'breakout', 'fixture is a breakout');
  assert.deepEqual(w.shortsStarted, [vidId(0)], 'Shorts started for the breakout only');
  const cut = await waitFor(async () => (await ok(`/shorts/${OWNER}`)).filter(c => c.video_id === vidId(0) && c.status === 'queued').length === 2, 60000);
  assert.ok(cut, 'cut and scheduled: ' + JSON.stringify((await ok(`/shorts/${OWNER}`)).filter(c => c.video_id === vidId(0)).map(c => [c.status, c.error])) + ' ' + JSON.stringify(received.filter(m => /Shorts/.test(m.title))));
  const auto = (await ok(`/shorts/${OWNER}`)).filter(c => c.video_id === vidId(0));
  assert.ok(auto.every(c => c.trigger === 'breakout' && c.publish_at));
  const w2 = await ok('/radar/watch/run', { method: 'POST' });
  assert.deepEqual(w2.shortsStarted, [], 'once per video');
});

test('cutting the same video again never re-cuts moments that are already Shorts', { skip: !FFMPEG }, async () => {
  const before = (await ok(`/shorts/${OWNER}`)).filter(c => c.video_id === vidId(0) && !['failed', 'cancelled'].includes(c.status));
  const r = await ok(`/shorts/make/${vidId(0)}?wait=1`, { method: 'POST', body: { autoPublish: false } });
  for (const c of r.clips) assert.ok(before.every(b => c.end <= b.start || b.end <= c.start), 'no overlap with existing clips');
  assert.ok(r.clips.length >= 1 && r.clips.every(c => c.status === 'ready'), 'autoPublish:false leaves them for review');
  for (const c of r.clips) await ok(`/shorts/clip/${c.id}/schedule`, { method: 'POST' });
  const nf = await api(`/shorts/make/${vidId(9)}`, { method: 'POST', body: {} });
  assert.equal(nf.status, 400, 'no source file → error even without wait'); assert.ok(/No source file/.test(nf.json.error));
});

test('a YouTube Short uploaded early as scheduled-private is kept private when cancelled', { skip: !FFMPEG }, async () => {
  const c = (await ok(`/shorts/${OWNER}`)).find(x => x.video_id === vidId(0) && x.status === 'queued');
  const yt = c.queue.find(q => q.platform === 'youtube');
  db.prepare('UPDATE publish_queue SET run_at = ? WHERE id = ?').run(new Date(Date.now() - 1000).toISOString(), yt.id);
  const ran = await ok('/publish-queue/run', { method: 'POST' });
  assert.ok(ran.some(r => r.id === yt.id && r.result?.id), JSON.stringify(ran));
  const vid = ran.find(r => r.id === yt.id).result.id;
  assert.equal(UPLOADED[vid].privacyStatus, 'private'); assert.equal(UPLOADED[vid].publishAt, yt.publish_at, 'uploaded private with publishAt');
  const mid = await ok(`/shorts/${OWNER}`);
  assert.equal(mid.find(x => x.id === c.id).status, 'queued', 'Instagram still waiting');
  const cancelled = await ok(`/shorts/clip/${c.id}/cancel`, { method: 'POST' });
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(UPLOADED[vid].privacyStatus, 'private'); assert.equal(UPLOADED[vid].publishAt, undefined, 'scheduled publish removed on YouTube');
  assert.ok(cancelled.notes.some(n => /kept private/.test(n)));
  assert.ok(cancelled.queue.every(q => q.status === 'cancelled'));
});

test('a missed slot moves to the next best slot instead of posting late; quota shortfalls move a day, then fail', { skip: !FFMPEG }, async () => {
  const c = (await ok(`/shorts/${OWNER}`)).find(x => x.video_id === vidId(0) && x.status === 'queued');
  const past = new Date(Date.now() - 3 * 3600e3).toISOString();
  db.prepare('UPDATE publish_queue SET run_at = ?, publish_at = ? WHERE clip_id = ?').run(past, past, c.id);
  const mark = calls.length;
  const ran = await ok('/publish-queue/run', { method: 'POST' });
  assert.ok(ran.some(r => r.moved), JSON.stringify(ran));
  assert.ok(!calls.slice(mark).some(x => /upload|\/ig\/.*media$/.test(x.path) && x.method === 'POST'), 'nothing posted late');
  const moved = (await ok(`/shorts/${OWNER}`)).find(x => x.id === c.id);
  assert.equal(moved.status, 'queued');
  assert.ok(Date.parse(moved.publish_at) > Date.now() + 3600e3, 'new slot in the future');
  assert.ok(moved.queue.every(q => q.publish_at === moved.publish_at), 'both platforms moved together');
  assert.ok(await waitFor(() => received.some(m => /missed its slot/.test(m.title))));
  // quota
  await ok('/settings', { method: 'PUT', body: { yt_quota_limit: '1000' } });
  const yt = moved.queue.find(q => q.platform === 'youtube');
  for (let i = 1; i <= 3; i++) {
    db.prepare('UPDATE publish_queue SET run_at = ?, publish_at = ? WHERE id = ?').run(new Date(Date.now() - 1000).toISOString(), new Date(Date.now() + 3600e3).toISOString(), yt.id);
    const r = await ok('/publish-queue/run', { method: 'POST' });
    assert.equal(r.find(x => x.id === yt.id).shifted, i);
  }
  db.prepare('UPDATE publish_queue SET run_at = ? WHERE id = ?').run(new Date(Date.now() - 1000).toISOString(), yt.id);
  const r4 = await ok('/publish-queue/run', { method: 'POST' });
  assert.ok(/quota left on 3 days/.test(r4.find(x => x.id === yt.id).error));
  assert.ok(await waitFor(() => received.some(m => /YouTube Short moved one day/.test(m.title))));
  await ok('/settings', { method: 'PUT', body: { yt_quota_limit: '10000' } });
  const failed = (await ok(`/shorts/${OWNER}`)).find(x => x.id === c.id);
  assert.equal(failed.status, 'queued', 'Instagram row still waiting keeps it queued');
  await ok(`/shorts/clip/${c.id}/cancel`, { method: 'POST' });
});

test('Instagram reels on the radar: synced with insights, paced vs your usual reel, breakout alert', async () => {
  IG.media.unshift({ id: 'IGNEW001', caption: 'The Medicaid rule nobody explains\n#caregiving', ageH: 6, views: 30000 });
  const w = await ok('/radar/watch/run', { method: 'POST' });
  assert.equal(w.errors.length, 0, w.errors.join(' | '));
  const reel = (await ok(`/radar/watch/${OWNER}`)).videos.find(v => v.video_id === 'ig:IGNEW001');
  assert.ok(reel, 'reel on the watch board');
  assert.equal(reel.kind, 'instagram');
  assert.equal(reel.title, 'The Medicaid rule nobody explains');
  assert.equal(reel.status, 'breakout');
  assert.ok(reel.idx >= 2, 'pace vs usual: ' + reel.idx);
  assert.ok(await waitFor(() => received.some(m => /^Instagram: "The Medicaid rule/.test(m.message || m.text || ''))), 'phone told: ' + JSON.stringify(received.map(m => m.title).slice(-4)));
  const sync = await ok('/instagram/sync', { method: 'POST', body: { limit: 5 } });
  assert.ok(sync.find(r => r.id === 'IGNEW001').views === 30000 && sync.find(r => r.id === 'IGNEW001').reach > 0, 'views from the current "views" metric');
  assert.ok(calls.some(c => /\/insights$/.test(c.path) && c.q.metric.split(',').includes('views') && !c.q.metric.includes('plays')));
  const w2 = await ok('/radar/watch/run', { method: 'POST' });
  assert.ok(!w2.alerts.some(a => /Instagram: "The Medicaid rule/.test(a.message || '')), 'alert fires once');
});

test('all channels on one board + weekly summary to the phone', async () => {
  const today = new Date(), day = d => new Date(today - d * 86400000).toISOString().slice(0, 10);
  const ins = db.prepare('INSERT INTO snapshots (entity_type, entity_id, taken_at, day, views, subs) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(entity_type, entity_id, day) DO UPDATE SET views = excluded.views, subs = excluded.subs');
  ins.run('channel', OWNER, new Date().toISOString(), day(14), 170000, 1100);
  ins.run('channel', OWNER, new Date().toISOString(), day(7), 176000, 1180);
  ins.run('channel', OWNER, new Date().toISOString(), day(0), 184000, 1240);
  const o = await ok('/portfolio');
  assert.equal(o.channels.length, 1);
  const c = o.channels[0];
  assert.equal(c.views7, 8000); assert.equal(c.views7Prev, 6000); assert.ok(Math.abs(c.views7Change - 1 / 3) < 1e-9);
  assert.equal(c.subs7, 60);
  assert.ok(c.latest && c.latest.title);
  assert.ok(c.ypp && c.ypp.watchHoursPct >= 0, 'monetization progress for a connected channel');
  assert.ok(c.shorts.queued >= 1 && c.shorts.published7 === 1, JSON.stringify(c.shorts));
  assert.ok(o.instagram && o.instagram.reels7 >= 1 && o.instagram.best.views === 30000);
  const r = await ok('/portfolio/weekly-summary', { method: 'POST', body: { send: true } });
  assert.ok(/The Parent Plan: 8,000 views \(\+33% vs last week\), \+60 subs/.test(r.text), r.text);
  assert.ok(/Instagram: \d+ reels/.test(r.text));
  assert.deepEqual(r.sent.sent, ['webhook']);
  assert.ok(await waitFor(() => received.some(m => m.title === 'TubeDesk weekly summary')));
});

test('hook backtest: calibration rates opening lines from local transcripts', { skip: !FFMPEG }, async () => {
  const job = await ok(`/radar/calibrate/${OWNER}?wait=1`, { method: 'POST', body: { ai: true, minAgeDays: 1 } });
  assert.equal(job.status, 'done', job.error);
  const metrics = job.result.metrics;
  assert.ok(metrics.hooks, 'hook stage ran: ' + JSON.stringify(Object.keys(metrics)));
  assert.ok(metrics.hooks.used && metrics.hooks.rated >= 1, JSON.stringify(metrics.hooks));
  assert.ok(metrics.hooks.captionsUsed <= 10, 'caption downloads stay within the budget');
  assert.ok(metrics.sample.withHook >= 1, 'labelled uploads carry a hook rating');
});

test('MCP exposes Shorts, best times and the all-channels board', async () => {
  const src = fs.readFileSync(path.join(ROOT, 'mcp', 'server.js'), 'utf8');
  for (const t of ['make_shorts', 'portfolio', 'best_publish_time']) assert.ok(src.includes(`'${t}'`) || src.includes(`"${t}"`) || src.includes(`name: '${t}'`), t);
  const guide = await (await fetch(base + '/api/agent')).text();
  assert.ok(/SHORTS, SLOTS, ALL CHANNELS/.test(guide));
});

test('restart recovery: an upload left mid-flight is marked failed, never re-sent', { skip: !FFMPEG }, async () => {
  const c = (await ok(`/shorts/${OWNER}`)).find(x => x.status === 'queued');
  assert.ok(c, 'a queued clip exists');
  const row = c.queue.find(q => q.status === 'waiting');
  db.prepare("UPDATE publish_queue SET status = 'running' WHERE id = ?").run(row.id);
  child.kill(); await new Promise(r => child.once('exit', r));
  await startServer();
  const after = (await ok(`/shorts/${OWNER}`)).find(x => x.id === c.id);
  const q = after.queue.find(x => x.id === row.id);
  assert.equal(q.status, 'failed'); assert.ok(/Interrupted by a restart/.test(q.error));
  assert.equal(after.status, 'queued', 'other platform still waiting');
  const mark = calls.length;
  await ok('/publish-queue/run', { method: 'POST' });
  assert.ok(!calls.slice(mark).some(x => x.method === 'POST' && /upload/.test(x.path)), 'not re-uploaded automatically');
});
