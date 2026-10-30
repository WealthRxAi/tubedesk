// Integration: real server + mock YouTube. Exercises every route family end to end.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startMock, calls } from './mock-youtube.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'td-api-'));
let mock, child, base;
const OWNER = 'UCowner00000000000000001', COMP = 'UCcomp000000000000000002';

async function api(p, { method = 'GET', body } = {}) {
  const res = await fetch(base + '/api' + p, { method, headers: body !== undefined ? { 'content-type': 'application/json' } : {}, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, json };
}
const ok = async (p, o) => { const r = await api(p, o); assert.equal(r.status, 200, `${p}: ${JSON.stringify(r.json).slice(0, 300)}`); return r.json; };

before(async () => {
  mock = await startMock(0);
  const port = 4900 + Math.floor(Math.random() * 90);
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ['src/server.js'], { cwd: path.join(path.dirname(new URL(import.meta.url).pathname), '..'), env: { ...process.env, PORT: String(port), TUBEDESK_DATA_DIR: dataDir, TUBEDESK_NO_SCHEDULER: '1', YT_API_BASE: `http://127.0.0.1:${mock.port}/youtube/v3`, YT_ANALYTICS_BASE: `http://127.0.0.1:${mock.port}/v2/reports`, YT_SUGGEST_URL: `http://127.0.0.1:${mock.port}/complete/search` }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stderr.on('data', d => process.stderr.write('[server] ' + d));
  for (let i = 0; i < 50; i++) { try { await fetch(base + '/api/status'); break; } catch { await new Promise(r => setTimeout(r, 100)); } }
});
after(() => { child.kill(); mock.server.close(); });

test('status & settings & key test', async () => {
  const s = await ok('/status');
  assert.equal(s.configured.apiKey, false);
  await ok('/settings', { method: 'PUT', body: { yt_api_key: 'TESTKEY', google_client_id: 'cid', google_client_secret: 'sec', ai_provider: 'none', default_country: 'US' } });
  const st = await ok('/settings');
  assert.equal(st.yt_api_key, '••••TKEY', 'secrets are masked');
  await ok('/settings', { method: 'PUT', body: { yt_api_key: st.yt_api_key } }); // masked value must not overwrite
  assert.equal((await ok('/settings/test-key', { method: 'POST' })).categories, 2);
  const url = (await ok('/oauth/url')).url;
  assert.ok(url.includes('accounts.google.com') && url.includes('yt-analytics'));
});

test('add owned channel by handle, by URL, by video; sync; isolation', async () => {
  const c = await ok('/channels', { method: 'POST', body: { input: '@TheParentPlan', kind: 'owned', maxVideos: 100 } });
  assert.equal(c.id, OWNER); assert.equal(c.kind, 'owned'); assert.equal(c.authorized, false);
  const c2 = await ok('/channels', { method: 'POST', body: { input: `https://www.youtube.com/channel/${COMP}`, kind: 'competitor' } });
  assert.equal(c2.id, COMP);
  const c3 = await ok('/channels', { method: 'POST', body: { input: 'https://youtu.be/comp0000002', kind: 'competitor' } });
  assert.equal(c3.id, COMP, 'video URL resolves to its channel');
  const lib = await ok(`/channels/${OWNER}/videos?limit=50`);
  assert.equal(lib.total, 24); assert.ok(lib.videos.every(v => v.channel_id === OWNER), 'channel isolation');
  const shorts = await ok(`/channels/${OWNER}/videos?format=shorts`);
  assert.ok(shorts.total > 0 && shorts.videos.every(v => v.is_short));
  const sorted = await ok(`/channels/${OWNER}/videos?sort=view_count&dir=desc&limit=3`);
  assert.ok(sorted.videos[0].view_count >= sorted.videos[1].view_count);
  const q = await ok('/quota');
  assert.ok(q.today.units > 0 && q.today.units < 200, 'sync is cheap: ' + q.today.units);
  const miss = await api('/channels/UCdoesnotexist0000000000x');
  assert.equal(miss.status, 404);
});

test('video detail, checklist, age comparison, history, health, segments, slots, backup, csv', async () => {
  const lib = await ok(`/channels/${OWNER}/videos?limit=5`);
  const vid = lib.videos[0].id;
  const v = await ok(`/videos/${vid}`);
  assert.equal(v.tags.length, 3); assert.ok(v.format);
  const chk = await ok(`/videos/${vid}/checklist`);
  assert.ok(chk.score >= 0 && chk.items.length >= 6);
  const age = await ok(`/videos/${vid}/age-comparison`);
  assert.ok(age.ageDays >= 1 && Array.isArray(age.peers));
  const h = await ok(`/channels/${OWNER}/health`);
  assert.equal(h.total, 24);
  const seg = await ok(`/channels/${OWNER}/segments`);
  assert.ok(seg.long.median > 0 && seg.long.breakout.length >= 1, 'every 5th mock video is a 6x breakout');
  const slots = await ok(`/channels/${OWNER}/publish-slots`);
  assert.equal(slots.sampleSize, 24);
  const hist = await ok(`/channels/${OWNER}/history`);
  assert.equal(hist.length, 1, 'one snapshot per day');
  const rc = await ok(`/channels/${OWNER}/report-card`);
  assert.equal(rc.grades.length, 3);
  const fc = await ok(`/channels/${OWNER}/forecast`);
  assert.equal(fc.available, false);
  const bk = await ok(`/channels/${OWNER}/backup`);
  assert.equal(bk.videos.length, 24);
  const csv = await fetch(base + `/api/channels/${OWNER}/export/videos.csv`);
  assert.ok((await csv.text()).startsWith('id,title,'));
});

test('discovery: keywords, competition, rising, outliers (local + search), trending, niche, patterns', async () => {
  const kw = await ok('/keywords/explore?q=medicaid');
  assert.ok(kw.autocomplete.length >= 3 && kw.questions.length >= 1);
  const comp = await ok('/keywords/competition?q=medicaid');
  assert.ok(comp.opportunityScore >= 0 && comp.opportunityScore <= 100 && comp.results.length > 0 && comp.formula);
  const comp2 = await ok('/keywords/competition?q=medicaid');
  assert.equal(comp2.sampleSize, comp.sampleSize);
  const q = await ok('/quota');
  assert.ok(q.today.cached > 0, 'second competition call served from cache');
  const hist = await ok('/keywords/history?q=medicaid');
  assert.equal(hist.length, 1);
  const rising = await ok('/keywords/rising?q=medicaid');
  assert.equal(rising.current.length, 5);
  const lo = await ok(`/outliers/local?channels=${OWNER},${COMP}&format=long&minX=2`);
  assert.ok(lo.length > 0 && lo[0].outlier_x >= 2 && lo[0].channel_title);
  const so = await ok('/outliers/search?q=medicaid&days=365&format=all');
  assert.ok(so.results.length > 0 && 'breakout_score' in so.results[0]);
  const tr = await ok('/trending?country=US');
  assert.equal(tr.length, 20);
  const cats = await ok('/categories');
  assert.equal(cats.length, 2);
  const niche = await ok('/niche/channels?q=caregiving');
  assert.equal(niche.length, 3);
  const pat = await ok('/titles/patterns', { method: 'POST', body: { titles: ['7 things', 'How to x'] } });
  assert.equal(pat.sample, 2);
  const sim = await ok(`/videos/${(await ok(`/channels/${OWNER}/videos?limit=1`)).videos[0].id}/similar`);
  assert.ok(Array.isArray(sim.results));
});

test('competitors: link, compare, feed, refresh → alerts, report card, remove', async () => {
  const c = await ok(`/competitors/${OWNER}`, { method: 'POST', body: { input: '@ElderLawExplained', note: 'legal angle' } });
  assert.equal(c.id, 'UCcomp000000000000000003');
  await ok(`/competitors/${OWNER}`, { method: 'POST', body: { input: COMP } });
  const list = await ok(`/competitors/${OWNER}`);
  assert.equal(list.length, 2);
  const cmp = await ok(`/competitors/${OWNER}/compare`);
  assert.equal(cmp.channels.length, 3); assert.equal(cmp.channels[0].kind, 'owned');
  const feed = await ok(`/competitors/${OWNER}/feed?days=60`);
  assert.ok(feed.length > 0 && feed.every(v => v.channel_id !== OWNER));
  const r = await ok(`/competitors/${OWNER}/refresh`, { method: 'POST' });
  assert.equal(r.refreshed, 2);
  const alerts = await ok(`/alerts/${OWNER}`);
  assert.ok(Array.isArray(alerts));
  if (alerts.length) { await ok(`/alerts/read/${alerts[0].id}`, { method: 'POST' }); }
  await ok(`/alerts/${OWNER}/read-all`, { method: 'POST' });
  assert.equal((await ok(`/alerts/${OWNER}?unread=1`)).length, 0);
  const rc = await ok(`/channels/${COMP}/report-card`);
  assert.equal(rc.title, 'Caregiver Money');
  await ok(`/competitors/${OWNER}/UCcomp000000000000000003`, { method: 'DELETE' });
  assert.equal((await ok(`/competitors/${OWNER}`)).length, 1);
  assert.equal((await api('/channels/UCcomp000000000000000003')).status, 404, 'unlinked competitor is cleaned up');
});

test('packaging: analyzers, chapters, tags, staged edits lifecycle, playlists', async () => {
  const t = await ok('/packaging/title/analyze', { method: 'POST', body: { title: 'How to Protect a Parent\'s House From Medicaid in 2026', keyword: 'medicaid' } });
  assert.ok(t.score > 60);
  const d = await ok('/packaging/description/analyze', { method: 'POST', body: { description: 'x' } });
  assert.ok(d.score < 50);
  const ch = await ok('/packaging/chapters/validate', { method: 'POST', body: { text: '0:00 a\n0:20 b\n0:40 c' } });
  assert.equal(ch.valid, true);
  const tags = await ok('/packaging/tags', { method: 'POST', body: { title: 'Medicaid lookback rule explained', keyword: 'medicaid lookback' } });
  assert.ok(tags.tags.length > 3 && tags.charactersUsed <= 500);
  const vid = (await ok(`/channels/${OWNER}/videos?limit=1`)).videos[0];
  const st = await ok('/packaging/staged', { method: 'POST', body: { channelId: OWNER, videoId: vid.id, field: 'title', newValue: 'New title' } });
  assert.equal(st.old_value, vid.title);
  await ok('/packaging/staged', { method: 'POST', body: { channelId: OWNER, videoId: vid.id, field: 'tags', newValue: ['a', 'b'] } });
  assert.equal((await ok(`/packaging/staged/${OWNER}`)).length, 2);
  const fail = await api(`/packaging/apply/${OWNER}/${vid.id}`, { method: 'POST' });
  assert.equal(fail.status, 500); assert.ok(/not authorized/i.test(fail.json.error), 'apply refused without OAuth: ' + fail.json.error);
  // Inject owner tokens directly (what the OAuth callback does) and apply for real against the mock.
  const Database = (await import('better-sqlite3')).default;
  const db = new Database(path.join(dataDir, 'tubedesk.sqlite'));
  db.prepare('UPDATE channels SET oauth_json = ? WHERE id = ?').run(JSON.stringify({ access_token: 'tok', refresh_token: 'rt', expires_at: Date.now() + 3600e3 }), OWNER);
  db.prepare("UPDATE staged_edits SET status = 'staged', error = NULL WHERE channel_id = ?").run(OWNER);
  db.close();
  const applied = await ok(`/packaging/apply/${OWNER}/${vid.id}`, { method: 'POST' });
  assert.equal(applied.applied, 2);
  const put = calls.find(c => c.method === 'PUT' && c.path.endsWith('/videos'));
  assert.ok(put && put.auth === 'Bearer tok' && put.q.part === 'snippet');
  assert.equal((await ok(`/videos/${vid.id}`)).title, 'New title');
  assert.ok((await ok(`/videos/${vid.id}`)).metadataHistory.some(m => m.field === 'title'));
  assert.equal((await ok(`/packaging/staged/${OWNER}?status=applied`)).length, 2);
  const pls = await ok(`/channels/${OWNER}/playlists?owned=1`);
  assert.equal(pls[0].id, 'PL1');
  const created = await ok(`/channels/${OWNER}/playlists`, { method: 'POST', body: { title: 'New list' } });
  assert.equal(created.id, 'PLnew');
});

test('owner analytics (all reports) once authorized', async () => {
  const ov = await ok(`/analytics/${OWNER}/overview?days=28`);
  assert.equal(ov.totals.views, 52000); assert.equal(ov.daily.length, 28); assert.ok('views' in ov.delta);
  const top = await ok(`/analytics/${OWNER}/top`);
  assert.equal(top.length, 10); assert.ok(top[0].title, 'joined with local titles');
  const vid = top[0].video;
  const ret = await ok(`/analytics/${OWNER}/retention/${vid}`);
  assert.equal(ret.curve.length, 51); assert.ok(ret.biggestDrops.length >= 1 && ret.checkpoints.p50 < ret.checkpoints.p10);
  const tr = await ok(`/analytics/${OWNER}/traffic`);
  assert.equal(tr.types.length, 5); assert.equal(tr.searchTerms.length, 3); assert.ok(Math.abs(tr.types.reduce((a, x) => a + x.share, 0) - 1) < 1e-6);
  assert.equal((await ok(`/analytics/${OWNER}/geo`)).rows.length, 4);
  assert.equal((await ok(`/analytics/${OWNER}/demographics`)).rows.length, 8);
  assert.equal((await ok(`/analytics/${OWNER}/devices`)).length, 3);
  const subs = await ok(`/analytics/${OWNER}/subscribers?days=30`);
  assert.equal(subs.daily.length, 30); assert.ok(subs.byVideo[0].net > 0);
  const wh = await ok(`/analytics/${OWNER}/watch-hours`);
  assert.ok(wh.publicWatchHours > 0 && wh.ypp.watchHoursPct <= 1);
  const ct = await ok(`/analytics/${OWNER}/content-types`);
  assert.equal(ct.analytics.length, 2); assert.ok(ct.library.length >= 2);
  const rev = await ok(`/analytics/${OWNER}/revenue`);
  assert.equal(rev.available, true); assert.ok(rev.totals.rpm > 0);
  const imp = await ok(`/analytics/${OWNER}/studio-import`, { method: 'POST', body: { csv: 'Content,Video title,Impressions,Impressions click-through rate (%),Average view duration,Average percentage viewed (%),Views\nTotal,,5000,4.1,0:03:00,40,2000\n' + vid + ',Top video,4000,3.0,0:04:00,41,1500\nother000000,Other,1000,8.0,0:02:00,30,500\n', period: 'test' } });
  assert.equal(imp.imported, 2);
  const sd = await ok(`/analytics/${OWNER}/studio`);
  assert.equal(sd.rows.length, 2); assert.ok(sd.impressionWeightedCtr > 3 && sd.impressionWeightedCtr < 5); assert.equal(sd.lowCtrHighImpressions.length, 1);
  const tx = await ok(`/transcript/${OWNER}/${vid}`);
  assert.equal(tx.segments.length, 3); assert.ok(/lookback/.test(tx.text));
});

test('comments: read, filters, clusters, templates, reply, giveaway', async () => {
  const c = await ok(`/comments?channel=${OWNER}&owner=${OWNER}&filter=unanswered&pages=1`);
  assert.equal(c.total, 40); assert.ok(c.shown < c.total, 'owner-replied threads filtered out'); assert.ok(c.terms.length > 5 && c.questionClusters.length >= 1);
  const qs = await ok(`/comments?channel=${OWNER}&owner=${OWNER}&filter=questions&pages=1`);
  assert.ok(qs.threads.every(t => t.isQuestion && !t.ownerReplied));
  const men = await ok(`/comments?channel=${OWNER}&owner=${OWNER}&filter=mentions&pages=1`);
  assert.ok(men.threads.every(t => /@/.test(t.text)));
  const vidc = await ok(`/comments?video=${c.threads[0].videoId}&owner=${OWNER}&filter=all&pages=1`);
  assert.equal(vidc.total, 40);
  const tid = (await ok('/comments/templates', { method: 'POST', body: { name: 'Thanks', body: 'Thanks {{name}}!' } })).id;
  assert.equal((await ok('/comments/templates')).length, 1);
  await ok(`/comments/templates/${tid}`, { method: 'PUT', body: { name: 'Thanks', body: 'Cheers {{name}}' } });
  const rep = await ok('/comments/reply', { method: 'POST', body: { channelId: OWNER, parentId: c.threads[0].id, text: 'Appreciate it' } });
  assert.equal(rep.id, 'newreply');
  await ok(`/comments/templates/${tid}`, { method: 'DELETE' });
  const win = await ok('/comments/giveaway', { method: 'POST', body: { threads: c.threads, keyword: '', ownerChannelId: OWNER } });
  assert.equal(win.winners.length, 1); assert.ok(win.seed);
});

test('boards, blueprints, saved, calculators, export, snapshot run, quota guard', async () => {
  const bid = (await ok(`/boards/${OWNER}`, { method: 'POST', body: { name: 'Inspo' } })).id;
  const iid = (await ok(`/boards/id/${bid}/items`, { method: 'POST', body: { kind: 'video', ref: { id: 'x', title: 'y' }, note: 'n' } })).id;
  assert.equal((await ok(`/boards/id/${bid}/items`))[0].ref.title, 'y');
  await ok(`/boards/items/${iid}`, { method: 'PUT', body: { note: 'updated' } });
  assert.equal((await ok(`/boards/${OWNER}`))[0].items, 1);
  await ok(`/boards/items/${iid}`, { method: 'DELETE' });
  await ok(`/boards/id/${bid}`, { method: 'DELETE' });
  const bp = (await ok(`/blueprints/${OWNER}`, { method: 'POST', body: { title: 'Idea', titles: ['A', 'B'] } })).id;
  await ok(`/blueprints/id/${bp}`, { method: 'PUT', body: { status: 'scripted' } });
  const bps = await ok(`/blueprints/${OWNER}`);
  assert.equal(bps[0].status, 'scripted'); assert.deepEqual(bps[0].titles, ['A', 'B']);
  await ok(`/blueprints/id/${bp}`, { method: 'DELETE' });
  const sid = (await ok(`/saved/${OWNER}`, { method: 'POST', body: { kind: 'script', title: 't', body: 'b' } })).id;
  assert.equal((await ok(`/saved/${OWNER}?kind=script`)).length, 1);
  await ok(`/saved/id/${sid}`, { method: 'DELETE' });
  const e = await ok('/calc/earnings', { method: 'POST', body: { views: 50000, niche: 'Education & science', sponsorPerVideo: 100, videosPerMonth: 4 } });
  assert.equal(e.sponsorships, 400);
  assert.ok((await ok('/calc/valuation', { method: 'POST', body: { monthlyRevenue: 100 } })).high === 4800);
  const csv = await fetch(base + '/api/export/csv', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'x', rows: [{ a: 1 }] }) });
  assert.equal(await csv.text(), 'a\n1');
  assert.deepEqual((await ok('/safety-checklist')).length, 9);
  assert.ok((await ok('/coach/lessons')).length === 6);
  const ctx = await ok(`/coach/${OWNER}/context`);
  assert.ok(/CHANNEL: The Parent Plan/.test(ctx.context) && /COMPETITORS TRACKED/.test(ctx.context));
  const ai = await api(`/coach/${OWNER}/ask`, { method: 'POST', body: { question: 'x' } });
  assert.equal(ai.status, 500); assert.ok(/disabled/.test(ai.json.error));
  const snap = await ok('/snapshot/run', { method: 'POST' });
  assert.ok(snap.channels >= 1 && snap.errors.length === 0, JSON.stringify(snap));
  await ok('/settings', { method: 'PUT', body: { yt_quota_limit: 1, yt_quota_reserve: 0 } });
  await ok('/cache/clear', { method: 'POST', body: {} });
  const guard = await api('/trending?country=GB');
  assert.equal(guard.status, 429); assert.equal(guard.json.reason, 'quotaGuard');
  await ok('/settings', { method: 'PUT', body: { yt_quota_limit: 10000, yt_quota_reserve: 500 } });
  const lan = await fetch(base + '/', { headers: {} });
  assert.equal(lan.status, 200);
});

test('scores, demand index, and extension endpoints', async () => {
  const cs = await ok(`/scores/channel/${OWNER}`);
  assert.ok(cs.score >= 0 && cs.score <= 100 && cs.grade && cs.advice && cs.components.hitRate !== undefined);
  const vs = await ok(`/scores/channel/${OWNER}/videos`);
  const ids = Object.keys(vs); assert.ok(ids.length >= 20);
  const one = await ok(`/scores/video/${ids[0]}`);
  assert.ok(one.components.packaging >= 0 && one.components.performance !== undefined && /packaging/.test(one.formula));
  const dm = await ok('/keywords/demand?q=medicaid');
  assert.ok(dm.demandIndex >= 0 && dm.demandIndex <= 100 && dm.regionsPresent.length === 5 && dm.components.questions >= 0 && /not a monthly search volume/.test(dm.note));
  const ev = await ok(`/ext/video/${ids[0]}`);
  assert.ok(ev.video.id === ids[0] && ev.channel && ev.baseline.sample > 0 && ev.outlierX !== null && ev.isOwned === true && ev.ownedChannels.length >= 1);
  assert.ok(ev.est && ev.est.high >= ev.est.low && ev.est.niche && ev.vph >= 0 && ev.seoScore >= 0 && ev.seoScore <= 100 && ev.likeRate >= 0);
  assert.ok(ev.channelSummary && ev.channelSummary.monthly.high >= ev.channelSummary.monthly.low && ev.channelSummary.recent.length > 0 && ev.channelSummary.uploadsPerWeek > 0);
  const ec = await ok('/ext/channel?ref=@CaregiverMoney');
  assert.ok(ec.channel.id === 'UCcomp000000000000000002' && ec.summary.monthly.monthlyViews > 0 && ec.summary.recent.length > 0 && ec.isOwned === false && /Scenario/.test(ec.summary.monthly.note));
  const eb = await ok(`/ext/videos?ids=${ids.slice(0, 5).join(',')},notavalidid`);
  assert.equal(Object.keys(eb.videos).length, 5);
  const first = eb.videos[ids[0]]; assert.ok(first.views >= 0 && first.est.niche && first.vpd >= 0 && first.subs > 0 && first.vsChannelAvg > 0);
  const ek = await ok('/ext/keyword?q=medicaid');
  assert.ok(ek.demand.demandIndex >= 0 && ek.competition && /keywords\?q=medicaid/.test(ek.openUrl));
  const es = await ok('/ext/summary');
  assert.ok(es.channels.length >= 1 && es.channels[0].score !== null && es.quota.limit);
  const sv = await ok('/ext/save', { method: 'POST', body: { ref: { id: 'x', title: 'from yt' } } });
  assert.ok(sv.id && sv.board);
  const cors = await fetch(base + '/api/status', { method: 'OPTIONS', headers: { Origin: 'chrome-extension://abcdef' } });
  assert.equal(cors.status, 204); assert.equal(cors.headers.get('access-control-allow-origin'), 'chrome-extension://abcdef');
  const noCors = await fetch(base + '/api/status', { headers: { Origin: 'https://evil.example' } });
  assert.equal(noCors.headers.get('access-control-allow-origin'), null);
});
