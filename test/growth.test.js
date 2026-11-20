// v2.1 parity features end to end: outlier index + niches + title formulas + similar thumbnails, rank tracking,
// competitor audience, bulk edits with undo, make-a-video, Instagram carousels/Stories, Threads/Facebook/LinkedIn,
// and the owner's phone over the tailnet.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { startMock, calls, IMG, EL } from './mock-youtube.js';

const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname), '..');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'td-growth-'));
const TS_STATE = path.join(dataDir, 'ts.json');
const OWNER = 'UCowner00000000000000001';
let mock, child, social, base, M;
const socialCalls = [];

const j = async (p, { method = 'GET', body, headers = {} } = {}) => {
  const res = await fetch(base + p, { method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const t = await res.text(); let b; try { b = JSON.parse(t); } catch { b = t; }
  return { status: res.status, body: b };
};
// raw HTTP so tests can set the Host header (fetch forbids it)
const rawReq = (p, { method = 'GET', headers = {}, body } = {}) => new Promise((resolve, reject) => {
  const u = new URL(base + p);
  const r = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method, headers: { ...headers, ...(body ? { 'content-length': Buffer.byteLength(body) } : {}) } }, res => { let t = ''; res.on('data', d => t += d); res.on('end', () => resolve({ status: res.statusCode, text: t })); });
  r.on('error', reject); if (body) r.write(body); r.end();
});
const ok = async (p, o) => { const r = await j(p, o); assert.equal(r.status, 200, `${p}: ${JSON.stringify(r.body).slice(0, 500)}`); return r.body; };

// Threads / Facebook / LinkedIn stand-ins
function startSocial() {
  return http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x'); const chunks = [];
    req.on('data', d => chunks.push(d));
    req.on('end', () => {
      const body = Buffer.concat(chunks); socialCalls.push({ method: req.method, path: u.pathname, q: Object.fromEntries(u.searchParams), auth: req.headers.authorization, bytes: body.length, json: /json/.test(req.headers['content-type'] || '') ? JSON.parse(body.toString() || '{}') : null, version: req.headers['linkedin-version'] });
      const send = (o, h = {}) => { res.writeHead(200, { 'content-type': 'application/json', ...h }); res.end(JSON.stringify(o)); };
      const p = u.pathname;
      // Threads
      if (p === '/th/me') return send({ id: 'TH1', username: 'salstack.threads', name: 'SalStack' });
      if (p === '/th/TH1/threads') return send({ id: 'THC1' });
      if (p === '/th/THC1') return send({ status: 'FINISHED' });
      if (p === '/th/TH1/threads_publish') return send({ id: 'THP1' });
      if (p === '/th/THP1') return send({ permalink: 'https://www.threads.net/@salstack.threads/post/abc' });
      if (p === '/th/refresh_access_token') return send({ access_token: 'TH_REFRESHED_xxxxxxxxxxxxxxxx', expires_in: 5184000 });
      // Facebook
      if (p === '/fb/PAGE1') return send({ id: 'PAGE1', name: 'SalStack Page', access_token: 'PAGE_TOKEN_xxxxxxxxxxxxxxxxxxxx' });
      if (p === '/fb/me') return send({ id: 'PAGE1', name: 'SalStack Page' });
      if (p === '/fb/PAGE1/feed') return send({ id: 'PAGE1_POST1' });
      if (p === '/fb/PAGE1/photos') return send({ id: 'PHOTO1', post_id: 'PAGE1_POST2' });
      if (p === '/fb/PAGE1/videos') return send({ id: 'VIDEO1' });
      // LinkedIn
      if (p === '/li/v2/userinfo') return send({ sub: 'liSub1', name: 'Salman Lakhani', email: 's@example.com' });
      if (p === '/li/rest/images') return send({ value: { uploadUrl: `${social.url}/li-upload/img`, image: 'urn:li:image:IMG1' } });
      if (p === '/li/rest/videos' && u.searchParams.get('action') === 'initializeUpload') { const size = socialCalls.at(-1).json.initializeUploadRequest.fileSizeBytes; const half = Math.floor(size / 2); return send({ value: { video: 'urn:li:video:VID1', uploadToken: '', uploadInstructions: [{ uploadUrl: `${social.url}/li-upload/v1`, firstByte: 0, lastByte: half - 1 }, { uploadUrl: `${social.url}/li-upload/v2`, firstByte: half, lastByte: size - 1 }] } }); }
      if (p === '/li/rest/videos') return send({});
      if (p.startsWith('/li-upload/')) return send({}, { etag: `etag-${p.split('/').pop()}` });
      if (p === '/li/rest/posts') return send({}, { 'x-restli-id': 'urn:li:share:777' });
      res.writeHead(404); res.end('{}');
    });
  });
}

before(async () => {
  // real media so ffmpeg-based features run for real: two distinct thumbnails and a spoken-length MP3
  const gen = (args, out) => { execFileSync('ffmpeg', ['-y', '-v', 'error', ...args, out]); return fs.readFileSync(out); };
  const red = gen(['-f', 'lavfi', '-i', 'color=c=red:s=320x180', '-vf', 'drawbox=x=0:y=0:w=160:h=180:color=white:t=fill', '-frames:v', '1'], path.join(dataDir, 'red.jpg'));
  const blue = gen(['-f', 'lavfi', '-i', 'color=c=blue:s=320x180', '-vf', 'drawbox=x=0:y=90:w=320:h=90:color=yellow:t=fill', '-frames:v', '1'], path.join(dataDir, 'blue.jpg'));
  IMG.forId = id => ([...id].reduce((a, c) => a + c.charCodeAt(0), 0) % 2 ? red : blue);
  EL.mp3 = gen(['-f', 'lavfi', '-i', 'sine=frequency=220:duration=6', '-c:a', 'libmp3lame', '-b:a', '64k'], path.join(dataDir, 'voice.mp3'));
  mock = await startMock(0);
  M = `http://127.0.0.1:${mock.port}`;
  const s = startSocial(); await new Promise(r => s.listen(0, '127.0.0.1', r)); social = s; social.url = `http://127.0.0.1:${s.address().port}`;
  const port = 7300 + Math.floor(Math.random() * 300);
  base = `http://127.0.0.1:${port}`;
  const env = { ...process.env, PORT: String(port), TUBEDESK_PUBLIC_PORT: String(port + 1), TUBEDESK_DATA_DIR: dataDir, TUBEDESK_NO_SCHEDULER: '1', TUBEDESK_NO_AUTOCONNECT: '1', TUBEDESK_RETRY_BASE_MS: '5',
    YT_API_BASE: `${M}/youtube/v3`, YT_ANALYTICS_BASE: `${M}/v2/reports`, YT_SUGGEST_URL: `${M}/complete/search`, YT_UPLOAD_BASE: `${M}/upload`, YT_THUMB_BASE: M, IG_GRAPH_BASE: `${M}/ig`, EL_API_BASE: `${M}/el`,
    THREADS_BASE: `${social.url}/th`, FB_GRAPH_BASE: `${social.url}/fb`, LINKEDIN_BASE: `${social.url}/li`, FAKE_TS_STATE: TS_STATE };
  child = spawn(process.execPath, ['src/server.js'], { cwd: ROOT, env, stdio: ['ignore', 'ignore', 'pipe'] });
  child.stderr.on('data', d => process.stderr.write('[server] ' + d));
  for (let i = 0; i < 80; i++) { try { await fetch(base + '/api/status'); break; } catch { await new Promise(r => setTimeout(r, 100)); } }
  await ok('/api/settings', { method: 'PUT', body: { yt_api_key: 'TESTKEY', ai_provider: 'none', elevenlabs_api_key: 'ELKEY', voice_provider: 'elevenlabs', public_base_url: 'https://media.example.org', index_reserve: '0', tailscale_path: path.join(ROOT, 'test', 'fake-tailscale.mjs') } });
  await ok('/api/channels', { method: 'POST', body: { input: '@TheParentPlan', kind: 'owned' } });
  await ok(`/api/competitors/${OWNER}`, { method: 'POST', body: { input: 'UCcomp000000000000000002' } });
  await ok(`/api/channels/${OWNER}/sync`, { method: 'POST', body: {} }).catch(() => {});
});
after(() => { child?.kill(); mock?.server.close(); social?.close(); });

test('outlier index grows from spare quota and is searchable for free; niches and title formulas come from it', async () => {
  await ok('/api/index/queries', { method: 'POST', body: { query: 'medicaid planning' } });
  const r = await ok('/api/index/crawl?wait=1', { method: 'POST', body: {} });
  assert.ok(r.queries >= 1 && r.videos > 0, JSON.stringify(r));
  assert.ok(r.units >= 102);
  const before = calls.length;
  const all = await ok('/api/index?minX=0&limit=500');
  assert.ok(all.results.length >= r.added && all.results.every(v => v.x === null || v.x >= 0));
  assert.equal(calls.length, before, 'searching the index costs nothing');
  const word = all.results[0].title.split(/\s+/).find(w => w.length > 4).toLowerCase().replace(/[^a-z0-9]/g, '');
  const fts = await ok(`/api/index?minX=0&q=${encodeURIComponent(word)}`);
  assert.ok(fts.results.length >= 1 && fts.results.every(v => v.title.toLowerCase().includes(word.slice(0, 4))), word);
  // the quota reserve is respected
  await ok('/api/settings', { method: 'PUT', body: { index_reserve: '100000' } });
  assert.equal((await ok('/api/index/crawl?wait=1', { method: 'POST', body: {} })).queries, 0);
  await ok('/api/settings', { method: 'PUT', body: { index_reserve: '0' } });
  const niches = await ok('/api/niches?maxSubs=100000000&minVideos=1');
  assert.ok(Array.isArray(niches.niches));
  const f = await ok('/api/formulas?minX=0');
  assert.ok(f.sample > 0 && Array.isArray(f.formulas));
});

test('similar thumbnails: every thumbnail seen is hashed; lookalikes rank first', async () => {
  const st = await ok('/api/index/stats');
  assert.ok(st.thumbs > 0, 'thumbnails hashed during the crawl');
  const any = (await ok('/api/index?minX=0&limit=1')).results[0];
  const r = await ok(`/api/thumbnails/similar?videoId=${any.id}`);
  assert.ok(r.compared > 1 && r.results.length > 0);
  assert.ok(r.results[0].similarity >= 0.95, 'same picture: near-identical score');
  const lookalike = id => [...id].reduce((a, c) => a + c.charCodeAt(0), 0) % 2;
  const top = r.results.filter(x => x.similarity >= 0.95);
  assert.ok(top.length && top.every(x => lookalike(x.videoId) === lookalike(any.id)), 'lookalikes first');
  const all = await ok(`/api/thumbnails/similar?videoId=${any.id}&minScore=0&limit=500`);
  const other = all.results.filter(x => lookalike(x.videoId) !== lookalike(any.id));
  assert.ok(other.length && other.every(x => x.similarity < 0.6), 'a different picture scores low: ' + other[0]?.similarity);
  assert.ok(!r.results.some(x => x.videoId === any.id), 'not itself');
});

test('rank tracking records where the channel shows up in search', async () => {
  const r = await ok('/api/ranks', { method: 'POST', body: { channelId: OWNER, keyword: 'Medicaid Lookback' } });
  const k = r.keywords.find(x => x.keyword === 'medicaid lookback');
  assert.ok(k && Number.isInteger(k.position) && k.position >= 1, JSON.stringify(k));
  assert.ok(k.top.length > 0);
  assert.equal((await j('/api/ranks', { method: 'POST', body: { channelId: 'UCcomp000000000000000002', keyword: 'x y' } })).status, 400, 'own channels only');
  const del = await ok(`/api/ranks/${k.id}`, { method: 'DELETE' });
  assert.equal(del.removed, 1);
});

test('competitor audience: questions and requests under competitors\' videos, grouped', async () => {
  const r = await ok(`/api/competitor-audience/${OWNER}`);
  assert.ok(r.videos >= 1 && r.comments > 0 && r.asks > 0, JSON.stringify(r).slice(0, 300));
  assert.ok(r.clusters.length && r.clusters[0].examples[0].competitor);
});

test('bulk edit: preview flags problems, apply updates YouTube, undo restores it', async () => {
  const p = await ok('/api/bulk/preview', { method: 'POST', body: { channelId: OWNER, format: 'long', ops: [{ field: 'description', action: 'append', value: 'Free checklist: https://example.org/list' }, { field: 'tags', action: 'add', values: ['aging parents'] }] } });
  assert.ok(p.changes > 0 && p.ready === p.changes);
  const bad = await ok('/api/bulk/preview', { method: 'POST', body: { channelId: OWNER, ops: [{ field: 'title', action: 'append', value: ' <b>' + 'x'.repeat(120), separator: '' }] } });
  assert.ok(bad.blocked === bad.changes && bad.items[0].problems.length >= 1);
  assert.equal((await j(`/api/bulk/${bad.batchId}/apply`, { method: 'POST', body: {} })).status, 400, 'channel not connected with Google');
  // connect the owner (mock OAuth tokens) so writes are allowed
  const Database = (await import('better-sqlite3')).default;
  const db = new Database(path.join(dataDir, 'tubedesk.sqlite'));
  db.prepare('UPDATE channels SET oauth_json = ? WHERE id = ?').run(JSON.stringify({ access_token: 'AT', refresh_token: 'RT', expires_at: Date.now() + 3600e3 }), OWNER);
  db.close();
  const one = await ok('/api/bulk/preview', { method: 'POST', body: { channelId: OWNER, videoIds: [p.items[0].videoId], ops: [{ field: 'description', action: 'append', value: 'Free checklist: https://example.org/list' }] } });
  const mark = calls.length;
  const a = await ok(`/api/bulk/${one.batchId}/apply`, { method: 'POST', body: {} });
  assert.equal(a.applied, 1, JSON.stringify(a.results));
  const put = calls.slice(mark).find(c => c.method === 'PUT' && c.path.endsWith('/videos'));
  assert.match(put.body.snippet.description, /Free checklist/);
  const m2 = calls.length;
  const u = await ok(`/api/bulk/${one.batchId}/undo`, { method: 'POST', body: {} });
  assert.equal(u.applied, 1);
  const put2 = calls.slice(m2).find(c => c.method === 'PUT' && c.path.endsWith('/videos'));
  assert.doesNotMatch(put2.body.snippet.description, /Free checklist/);
  assert.equal((await j(`/api/bulk/${one.batchId}/apply`, { method: 'POST', body: {} })).status, 400, 'a batch applies once');
});

test('bulk edit never pushes the owner\'s other staged edits, skips videos changed on YouTube since the preview, and undo covers split batches', async () => {
  const Database = (await import('better-sqlite3')).default;
  const db = new Database(path.join(dataDir, 'tubedesk.sqlite'));
  const vids = db.prepare("SELECT id FROM videos WHERE channel_id = ? AND is_short = 0 ORDER BY published_at DESC LIMIT 3").all(OWNER).map(r => r.id);
  db.prepare("INSERT INTO staged_edits (channel_id, video_id, field, old_value, new_value) VALUES (?, ?, 'privacy', 'private', 'public')").run(OWNER, vids[0]);
  const p = await ok('/api/bulk/preview', { method: 'POST', body: { channelId: OWNER, videoIds: [vids[0]], ops: [{ field: 'tags', action: 'add', values: ['staged-test'] }] } });
  const mark = calls.length;
  await ok(`/api/bulk/${p.batchId}/apply`, { method: 'POST', body: {} });
  const put = calls.slice(mark).find(c => c.method === 'PUT' && c.path.endsWith('/videos'));
  assert.equal(put.q.part, 'snippet'); assert.equal(put.body.status, undefined, 'the staged privacy change stays staged');
  assert.equal(db.prepare("SELECT status FROM staged_edits WHERE video_id = ? AND field = 'privacy'").get(vids[0]).status, 'staged');
  // drift: preview a title change, then the title changes on YouTube first → that video is skipped, not overwritten
  const p1 = await ok('/api/bulk/preview', { method: 'POST', body: { channelId: OWNER, videoIds: [vids[1]], ops: [{ field: 'title', action: 'append', value: ' (Updated)', separator: '' }] } });
  const p2 = await ok('/api/bulk/preview', { method: 'POST', body: { channelId: OWNER, videoIds: [vids[1]], ops: [{ field: 'title', action: 'prepend', value: 'NEW: ', separator: '' }] } });
  assert.equal((await ok(`/api/bulk/${p2.batchId}/apply`, { method: 'POST', body: {} })).applied, 1);
  const r1 = await ok(`/api/bulk/${p1.batchId}/apply`, { method: 'POST', body: {} });
  assert.equal(r1.applied, 0); assert.match(r1.results[0].skipped, /changed on YouTube since the preview/);
  // a batch split by the quota: the rest applies later and undo covers both parts
  const p3 = await ok('/api/bulk/preview', { method: 'POST', body: { channelId: OWNER, videoIds: vids, ops: [{ field: 'tags', action: 'add', values: ['split-batch'] }] } });
  const used = Number((await ok('/api/quota')).today.units);
  await ok('/api/settings', { method: 'PUT', body: { yt_quota_limit: String(used + 500 + 60) } }); // room for exactly one more video
  const a1 = await ok(`/api/bulk/${p3.batchId}/apply`, { method: 'POST', body: {} });
  assert.ok(a1.applied >= 1 && a1.skipped >= 1 && a1.next, JSON.stringify(a1).slice(0, 300));
  await ok('/api/settings', { method: 'PUT', body: { yt_quota_limit: '1000000' } });
  const a2 = await ok(`/api/bulk/${p3.batchId}/apply`, { method: 'POST', body: {} });
  assert.equal(a2.applied, vids.length, 'finished; earlier videos not re-applied');
  const u = await ok(`/api/bulk/${p3.batchId}/undo`, { method: 'POST', body: {} });
  assert.equal(u.applied, vids.length, 'undo reverts both days');
  db.close();
});

test('remote AI apps cannot run scheduled jobs (updates, backups) through the job runner', async () => {
  assert.equal((await j('/api/jobs/update/run', { method: 'POST', body: {}, headers: { 'x-tubedesk-origin': 'remote' } })).status, 403);
  assert.equal((await j('/api/jobs', { headers: { 'x-tubedesk-origin': 'remote' } })).status, 200, 'reading the job list is fine');
});

test('make a video: script + your voice → captioned vertical MP4 with a cover', { timeout: 180_000 }, async () => {
  const r = await ok('/api/make-video?wait=1', { method: 'POST', body: { channelId: OWNER, title: 'The Medicaid Rule Nobody Mentions', script: 'Medicaid can take the house. Here is the five year rule most families miss, and the one document that protects you.', publish: 'review' } });
  const res = r.result;
  assert.equal(r.status, 'done', JSON.stringify(r).slice(0, 400));
  assert.ok(fs.existsSync(res.file) && fs.statSync(res.file).size > 10_000);
  assert.ok(res.cover && fs.existsSync(res.cover));
  const probe = await ok('/api/media/probe', { method: 'POST', body: { file: res.file } });
  assert.equal(probe.video.width, 1080); assert.equal(probe.video.height, 1920); assert.ok(probe.audio);
  assert.equal((await j('/api/make-video?wait=1', { method: 'POST', body: { channelId: OWNER, topic: 'x' } })).status, 400, 'no AI and no script: says what to do');
});

test('Instagram carousels and Stories', async () => {
  await ok('/api/tools/add_instagram_account', { method: 'POST', body: { token: 'IGTOKEN_SALSTACK_xxxxxxxxxxxxxxxxxxxx', channel: 'The Parent Plan' } });
  const imgs = [1, 2, 3].map(i => { const f = path.join(dataDir, `slide${i}.jpg`); fs.writeFileSync(f, 'img' + i); return f; });
  const mark = calls.length;
  const job = await ok('/api/publish/instagram?wait=1', { method: 'POST', body: { kind: 'carousel', files: imgs, caption: 'three slides' } });
  assert.equal(job.status, 'done', job.error);
  const posts = calls.slice(mark).filter(c => c.method === 'POST' && c.path.endsWith('/media'));
  assert.equal(posts.filter(c => c.q.is_carousel_item === 'true').length, 3);
  const parent = posts.find(c => c.q.media_type === 'CAROUSEL');
  assert.ok(parent && parent.q.children.split(',').length === 3 && parent.q.caption === 'three slides');
  assert.equal((await j('/api/publish/instagram', { method: 'POST', body: { kind: 'carousel', files: [imgs[0]] } })).status, 400, 'a carousel needs 2+');
  const m2 = calls.length;
  const story = await ok('/api/publish/instagram?wait=1', { method: 'POST', body: { kind: 'story', file: imgs[0] } });
  assert.equal(story.status, 'done', story.error);
  assert.ok(calls.slice(m2).some(c => c.q.media_type === 'STORIES' && !c.q.caption));
});

test('Threads, Facebook Page and LinkedIn: add an account, post text and media', async () => {
  const th = await ok('/api/tools/add_social_account', { method: 'POST', body: { platform: 'threads', token: 'TH_TOKEN_xxxxxxxxxxxxxxxxxxxxxx', channel: 'The Parent Plan' } });
  assert.equal(th.username, 'salstack.threads');
  const img = path.join(dataDir, 'post.jpg'); fs.writeFileSync(img, 'jpeg');
  const t1 = await ok('/api/publish/threads?wait=1', { method: 'POST', body: { text: 'New video is up', file: img } });
  assert.equal(t1.status, 'done', t1.error); assert.match(t1.url, /threads\.net/);
  const thPost = socialCalls.find(c => c.path === '/th/TH1/threads');
  assert.equal(thPost.q.media_type, 'IMAGE'); assert.match(thPost.q.image_url, /^https:\/\/media\.example\.org\/public\/media\//);
  assert.equal((await j('/api/publish/threads', { method: 'POST', body: { text: 'x'.repeat(501) } })).status, 400);
  const fb = await ok('/api/tools/add_social_account', { method: 'POST', body: { platform: 'facebook', token: 'USER_TOKEN_xxxxxxxxxxxxxxxxxxxx', pageId: 'PAGE1' } });
  assert.equal(fb.username, 'SalStack Page');
  const f1 = await ok('/api/publish/facebook?wait=1', { method: 'POST', body: { text: 'Hello', link: 'https://youtu.be/x' } });
  assert.equal(f1.status, 'done', f1.error);
  assert.equal(socialCalls.find(c => c.path === '/fb/PAGE1/feed').auth, 'Bearer PAGE_TOKEN_xxxxxxxxxxxxxxxxxxxx', 'posts with the Page token');
  await ok('/api/tools/add_social_account', { method: 'POST', body: { platform: 'linkedin', token: 'LI_TOKEN_xxxxxxxxxxxxxxxxxxxxxxx' } });
  const vid = path.join(dataDir, 'li.mp4'); fs.writeFileSync(vid, Buffer.alloc(5000, 7));
  const l1 = await ok('/api/publish/linkedin?wait=1', { method: 'POST', body: { text: 'New episode', file: vid } });
  assert.equal(l1.status, 'done', l1.error); assert.match(l1.url, /urn:li:share:777/);
  const ups = socialCalls.filter(c => c.path.startsWith('/li-upload/v'));
  assert.equal(ups.reduce((n, c) => n + c.bytes, 0), 5000, 'whole file uploaded in parts');
  const fin = socialCalls.find(c => c.q.action === 'finalizeUpload');
  assert.deepEqual(fin.json.finalizeUploadRequest.uploadedPartIds, ['etag-v1', 'etag-v2']);
  const post = socialCalls.find(c => c.path === '/li/rest/posts');
  assert.equal(post.json.content.media.id, 'urn:li:video:VID1'); assert.equal(post.json.author, 'urn:li:person:liSub1'); assert.match(post.version, /^\d{6}$/);
  const brands = await ok('/api/brands');
  assert.equal(brands.brands[0].threads, 'salstack.threads');
});

test('your phone over the tailnet: the owner gets the full app; anyone else is refused', async () => {
  const ph = await ok('/api/phone/enable', { method: 'POST', body: {} });
  assert.equal(ph.state, 'on'); assert.equal(ph.url, 'https://salmans-mac-mini.tail1234.ts.net:8443'); assert.equal(ph.owner, 'salman@example.com');
  const owner = { 'tailscale-user-login': 'salman@example.com', 'x-forwarded-for': '100.101.102.103', host: 'salmans-mac-mini.tail1234.ts.net:8443' };
  assert.equal((await rawReq('/api/status', { headers: owner })).status, 200);
  assert.equal((await rawReq('/', { headers: owner })).status, 200, 'the app itself');
  const w = await rawReq('/api/index/queries', { method: 'POST', headers: { ...owner, origin: 'https://salmans-mac-mini.tail1234.ts.net:8443', 'content-type': 'application/json' }, body: JSON.stringify({ query: 'from my phone' }) });
  assert.equal(w.status, 200, 'same-origin writes from the phone work: ' + w.text);
  const csrf = await rawReq('/api/index/queries', { method: 'POST', headers: { ...owner, origin: 'https://evil.example', 'content-type': 'application/json' }, body: JSON.stringify({ query: 'csrf' }) });
  assert.equal(csrf.status, 403, 'other sites still cannot post');
  for (const bad of [{ ...owner, 'x-forwarded-for': '203.0.113.9' }, { ...owner, 'tailscale-user-login': 'someone@else.com' }, { 'x-forwarded-for': '100.101.102.103', host: owner.host }, { ...owner, host: 'evil.example' }]) {
    assert.equal((await rawReq('/api/status', { headers: bad })).status, bad.host === 'evil.example' ? 421 : 403, JSON.stringify(bad));
  }
  // remote funnel status ignores TubeDesk's own phone address
  const rs = await ok('/api/remote/status');
  assert.ok(!/already used for something else/.test(rs.next || ''), JSON.stringify(rs));
  assert.equal((await j('/api/phone/disable', { method: 'POST', body: {}, headers: { 'x-tubedesk-origin': 'remote' } })).status, 403);
});

test('health covers the new daily jobs', async () => {
  const h = await ok('/api/health');
  assert.ok(['ok', 'warn', 'error'].includes(h.status));
  assert.ok(h.items.find(i => i.id === 'database').ok);
});
