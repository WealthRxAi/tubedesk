// Research that competitors sell from their own databases, built locally and for free:
//  - Outlier index: every day TubeDesk spends spare YouTube quota searching your niches and keeps every video it sees
//    (views vs that channel's average). Over weeks it becomes your own searchable outlier database + niche finder.
//  - Title formulas mined from those outliers ("I Tried [X] for [N] Days" with how often and how well it works).
//  - Similar thumbnails: a perceptual hash + colour layout of every thumbnail seen, searchable by picture.
//  - Rank tracking: where your videos appear in YouTube search for your keywords, every day.
//  - Competitor audience: questions and requests in your competitors' comment sections, as idea input.
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { db, getSetting, setSetting } from '../db.js';
import { ytGet, quotaToday } from '../youtube/client.js';
import { fetchVideosByIds, fetchChannelsByIds, listChannels, getChannel } from './channels.js';
import { titleSeed } from './packaging.js';
import { fetchThreads, clusterQuestions } from './comments.js';
import { toolStatus } from './render.js';
import { fetchRetry } from '../lib/http.js';

db.exec(`
CREATE TABLE IF NOT EXISTS index_videos (
  id TEXT PRIMARY KEY,
  channel_id TEXT, channel_title TEXT, channel_subs INTEGER, channel_avg REAL, channel_published TEXT,
  title TEXT, published_at TEXT, duration_sec INTEGER, is_short INTEGER,
  views INTEGER, likes INTEGER, comments INTEGER, x REAL, vpd REAL,
  query TEXT, seen_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_index_x ON index_videos(x DESC);
CREATE INDEX IF NOT EXISTS idx_index_channel ON index_videos(channel_id);
CREATE VIRTUAL TABLE IF NOT EXISTS index_fts USING fts5(title, id UNINDEXED, tokenize = 'porter unicode61');
CREATE TABLE IF NOT EXISTS index_queries (
  query TEXT PRIMARY KEY, source TEXT, last_run TEXT, runs INTEGER NOT NULL DEFAULT 0, last_results INTEGER, added_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS thumb_index (
  video_id TEXT PRIMARY KEY, dhash TEXT NOT NULL, colors TEXT NOT NULL, source TEXT, hashed_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS rank_keywords (
  id INTEGER PRIMARY KEY AUTOINCREMENT, channel_id TEXT NOT NULL, keyword TEXT NOT NULL, country TEXT NOT NULL DEFAULT 'US',
  created_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE(channel_id, keyword, country)
);
CREATE TABLE IF NOT EXISTS rank_history (
  keyword_id INTEGER NOT NULL, day TEXT NOT NULL, position INTEGER, video_id TEXT, video_title TEXT, top_json TEXT,
  checked_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY (keyword_id, day)
);
`);

const median = a => { const s = [...a].filter(Number.isFinite).sort((x, y) => x - y); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : 0; };
const ageDays = iso => Math.max(1, (Date.now() - Date.parse(iso)) / 86400000);
const err = (m, status = 400) => Object.assign(new Error(m), { status });

// ======================= outlier index =======================

/** Queries worth crawling: your best topics, your tracked keywords and rank keywords, your competitors' best topics. */
export function seedQueries() {
  const seeds = new Map();
  const add = (q, source) => { q = String(q || '').trim().toLowerCase(); if (q.length >= 3 && q.split(/\s+/).length <= 6 && !seeds.has(q)) seeds.set(q, source); };
  for (const q of String(getSetting('index_seeds', '')).split(',')) add(q, 'settings');
  for (const ch of listChannels('owned')) {
    for (const v of db.prepare('SELECT title FROM videos WHERE channel_id = ? AND is_live = 0 ORDER BY view_count DESC LIMIT 6').all(ch.id)) add(titleSeed(v.title), `${ch.title}: top video`);
    for (const k of db.prepare('SELECT keyword FROM rank_keywords WHERE channel_id = ?').all(ch.id)) add(k.keyword, `${ch.title}: rank keyword`);
    const comps = db.prepare('SELECT competitor_channel_id id FROM competitor_links WHERE owned_channel_id = ?').all(ch.id).map(r => r.id);
    for (const cid of comps.slice(0, 8)) for (const v of db.prepare('SELECT title FROM videos WHERE channel_id = ? ORDER BY view_count DESC LIMIT 2').all(cid)) add(titleSeed(v.title), `${ch.title}: competitor`);
  }
  try { for (const k of db.prepare('SELECT DISTINCT keyword FROM keyword_history ORDER BY rowid DESC LIMIT 20').all()) add(k.keyword, 'keyword research'); } catch { /* */ }
  const ins = db.prepare('INSERT OR IGNORE INTO index_queries (query, source) VALUES (?, ?)');
  for (const [q, s] of seeds) ins.run(q, s);
  return [...seeds.keys()];
}

function upsertIndexed(rows, query) {
  const up = db.prepare(`INSERT INTO index_videos (id, channel_id, channel_title, channel_subs, channel_avg, channel_published, title, published_at, duration_sec, is_short, views, likes, comments, x, vpd, query)
    VALUES (@id, @channel_id, @channel_title, @channel_subs, @channel_avg, @channel_published, @title, @published_at, @duration_sec, @is_short, @views, @likes, @comments, @x, @vpd, @query)
    ON CONFLICT(id) DO UPDATE SET views = excluded.views, likes = excluded.likes, comments = excluded.comments, x = excluded.x, vpd = excluded.vpd,
      channel_subs = excluded.channel_subs, channel_avg = excluded.channel_avg, title = excluded.title, updated_at = datetime('now')`);
  const isNew = db.prepare('SELECT 1 FROM index_videos WHERE id = ?');
  const fts = db.prepare('INSERT INTO index_fts (title, id) VALUES (?, ?)');
  let added = 0;
  db.transaction(() => {
    for (const r of rows) {
      const fresh = !isNew.get(r.id);
      up.run({ ...r, query });
      if (fresh) { fts.run(r.title, r.id); added++; }
    }
  })();
  return added;
}

/** Index one query: a search (100 units) + stats for the videos and their channels (2 units). */
export async function indexQuery(query, { days = Number(getSetting('index_window_days', 180)), country = getSetting('default_country', 'US') } = {}) {
  const out = { query, videos: 0, added: 0 };
  for (const duration of ['any']) {
    const sr = await ytGet('search.list', { part: 'snippet', q: query, type: 'video', regionCode: country, order: 'viewCount', publishedAfter: new Date(Date.now() - days * 86400000).toISOString(), maxResults: 50, videoDuration: duration === 'any' ? undefined : duration }, { ttl: 20 * 3600 });
    const ids = (sr.items || []).map(i => i.id?.videoId).filter(Boolean);
    if (!ids.length) continue;
    const vids = (await fetchVideosByIds(ids)).filter(v => !v.is_live);
    const chans = Object.fromEntries((await fetchChannelsByIds([...new Set(vids.map(v => v.channel_id))])).map(c => [c.id, c]));
    const rows = vids.map(v => {
      const c = chans[v.channel_id] || {};
      const avg = c.video_count ? (c.view_count || 0) / c.video_count : 0; // the channel's lifetime average per video
      return { id: v.id, channel_id: v.channel_id, channel_title: v.channel_title, channel_subs: c.subscriber_count || 0, channel_avg: avg, channel_published: c.published_at || null,
        title: v.title, published_at: v.published_at, duration_sec: v.duration_sec, is_short: v.is_short ? 1 : 0, views: v.view_count, likes: v.like_count, comments: v.comment_count,
        x: avg > 0 ? v.view_count / avg : null, vpd: v.view_count / ageDays(v.published_at) };
    });
    out.videos += rows.length; out.added += upsertIndexed(rows, query);
  }
  db.prepare("UPDATE index_queries SET last_run = datetime('now'), runs = runs + 1, last_results = ? WHERE query = ?").run(out.videos, query);
  return out;
}

/**
 * Daily crawl within a unit budget, never touching the quota other features need (keeps `index_reserve` free).
 * Least-recently crawled queries go first, so every seed comes round again.
 */
export async function crawl({ budget = Number(getSetting('index_daily_units', 1500)), log = () => {} } = {}) {
  if (getSetting('index_enabled', '1') !== '1') return { skipped: 'off' };
  seedQueries();
  const reserve = Number(getSetting('index_reserve', 3000));
  const queue = db.prepare("SELECT query FROM index_queries WHERE last_run IS NULL OR last_run < datetime('now', '-6 days') ORDER BY last_run IS NOT NULL, last_run LIMIT 100").all().map(r => r.query);
  const done = []; let spent = 0;
  for (const q of queue) {
    const left = quotaToday().remaining;
    if (spent + 102 > budget || left - 102 < reserve) break;
    try { const r = await indexQuery(q); done.push(r); spent += 102; log(`[index] ${q}: ${r.videos} videos (${r.added} new)`); }
    catch (e) { if (/quota/i.test(e.message)) break; log(`[index] ${q}: ${e.message}`); }
  }
  const hashed = await hashPending({ limit: Number(getSetting('thumbs_daily', 600)) }).catch(e => ({ error: e.message }));
  const r = { queries: done.length, videos: done.reduce((a, d) => a + d.videos, 0), added: done.reduce((a, d) => a + d.added, 0), units: spent, total: indexStats().videos, thumbs: hashed };
  setSetting('index_last', JSON.stringify({ at: new Date().toISOString(), ...r }));
  return r;
}

export function indexStats() {
  const s = db.prepare('SELECT COUNT(*) videos, COUNT(DISTINCT channel_id) channels, SUM(x >= 3) outliers FROM index_videos').get();
  return { ...s, queries: db.prepare('SELECT COUNT(*) n FROM index_queries').get().n, thumbs: db.prepare('SELECT COUNT(*) n FROM thumb_index').get().n, last: JSON.parse(getSetting('index_last', 'null') || 'null') };
}

const ftsQuery = q => String(q || '').toLowerCase().match(/[\p{L}\p{N}]+/gu)?.slice(0, 8).map(w => `"${w}"`).join(' ') || '';
/** Search the index: outliers for a topic (or overall), with filters. Free — no quota. */
export function searchIndex({ q = '', minX = 3, format = 'all', days = 365, maxSubs = null, limit = 50, sort = 'x' } = {}) {
  const where = ['v.published_at >= ?'], args = [new Date(Date.now() - days * 86400000).toISOString()];
  if (minX) { where.push('v.x >= ?'); args.push(Number(minX)); }
  if (format === 'shorts') where.push('v.is_short = 1'); else if (format === 'long') where.push('v.is_short = 0');
  if (maxSubs) { where.push('v.channel_subs <= ?'); args.push(Number(maxSubs)); }
  const m = ftsQuery(q);
  if (m) { where.push('v.id IN (SELECT id FROM index_fts WHERE index_fts MATCH ?)'); args.push(m); }
  const order = sort === 'views' ? 'v.views DESC' : sort === 'recent' ? 'v.published_at DESC' : sort === 'vpd' ? 'v.vpd DESC' : 'v.x DESC';
  const rows = db.prepare(`SELECT v.*, t.dhash IS NOT NULL AS hashed FROM index_videos v LEFT JOIN thumb_index t ON t.video_id = v.id WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT ?`).all(...args, Math.min(500, Number(limit) || 50));
  return { q, count: rows.length, indexed: indexStats().videos, results: rows.map(r => ({ ...r, is_short: !!r.is_short, thumbnail: `https://i.ytimg.com/vi/${r.id}/mqdefault.jpg`, x: r.x && Math.round(r.x * 10) / 10 })), note: 'x = views ÷ that channel\'s lifetime average views per video. Your index grows every day from spare quota.' };
}

/** Niche finder: small or young channels in your index pulling outsized views — topics with room for a newcomer. */
export function niches({ q = '', maxSubs = 100000, minVideos = 2, limit = 30 } = {}) {
  const m = ftsQuery(q);
  const rows = db.prepare(`SELECT channel_id, channel_title, MAX(channel_subs) subs, MAX(channel_published) created, COUNT(*) n, MAX(views) top_views, AVG(x) avg_x, MAX(x) max_x,
      GROUP_CONCAT(title, ' ‖ ') titles FROM index_videos v WHERE channel_subs <= ? ${m ? 'AND id IN (SELECT id FROM index_fts WHERE index_fts MATCH ?)' : ''}
      GROUP BY channel_id HAVING n >= ? ORDER BY avg_x DESC LIMIT ?`).all(...[maxSubs, ...(m ? [m] : []), minVideos, limit]);
  return rows.map(r => ({ channelId: r.channel_id, channel: r.channel_title, subscribers: r.subs, channelAgeDays: r.created ? Math.round(ageDays(r.created)) : null, videosSeen: r.n, topViews: r.top_views, avgX: Math.round(r.avg_x * 10) / 10, maxX: Math.round(r.max_x * 10) / 10, sampleTitles: r.titles.split(' ‖ ').slice(0, 3) }));
}

// ======================= title formulas =======================
const FRAME = new Set(`a an the i i'm i've im ive my me we our you your you're youre he she they it its it's this that these those
is are was were be been being am do does did don't dont doesn't didn't can can't cant could should would will won't wont
how why what when where who which whats what's there here
to of in on at for from with without by about into over under after before vs versus or and but if than then so not no never
every all any some most more less only just still even really very too much many
best worst top new old first last ultimate perfect easiest hardest fastest cheapest biggest smallest secret secrets truth hidden real
tried tested built made spent quit bought sold lived ate became found got went tried learned asked
day days week weeks month months year years hour hours minute minutes second seconds times time
ways way reasons reason things thing mistakes mistake tips tricks rules signs habits steps lessons
should shouldn't stop start why nobody everyone everybody anyone someone actually finally literally
guide explained explain review reviewed reaction challenge tutorial beginner beginners complete full
make get go use buy try learn know need want see watch let's lets like look`.split(/\s+/));
function templateOf(title) {
  const toks = String(title || '').replace(/[“”"]/g, '').split(/\s+/).filter(Boolean);
  const out = []; let frames = 0;
  for (const raw of toks) {
    const t = raw.toLowerCase().replace(/^[^\p{L}\p{N}$]+|[^\p{L}\p{N}%']+$/gu, '');
    const punct = raw.match(/[!?:|()\-–—]+$/)?.[0] || '';
    let tok;
    if (/^(19|20)\d\d$/.test(t)) tok = '[Year]';
    else if (/^\$[\d,.]+[kmb]?$/i.test(t)) tok = '[$Amount]';
    else if (/^\d+(\.\d+)?%$/.test(t)) tok = '[N%]';
    else if (/^\d[\d,.]*[kmb]?$/i.test(t) || /^#\d+$/.test(t)) tok = '[N]';
    else if (FRAME.has(t)) { tok = t; frames++; }
    else tok = '[X]';
    if (tok === '[X]' && out[out.length - 1] === '[X]') { if (punct) out[out.length - 1] += punct; continue; }
    out.push(tok + (tok.startsWith('[') ? punct : punct));
  }
  return { template: out.join(' ').replace(/\s+/g, ' ').trim(), frames };
}
const pretty = t => t.split(' ').map(w => w.startsWith('[') ? w : w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
/**
 * Title formulas from outliers: in the index (and your tracked channels' library outliers), group titles by their
 * structure, keep structures that recur, rank by how many outliers use them and how big those outliers are.
 */
export function titleFormulas({ q = '', minX = 3, format = 'all', limit = 25 } = {}) {
  const pool = searchIndex({ q, minX, format, days: 730, limit: 500 }).results.map(r => ({ title: r.title, x: r.x, id: r.id, channel: r.channel_title }));
  try {
    const m = ftsQuery(q);
    const lib = db.prepare(`SELECT v.id, v.title, v.view_count, v.channel_id, c.title channel FROM videos v JOIN channels c ON c.id = v.channel_id WHERE v.is_live = 0 ${format === 'shorts' ? 'AND v.is_short = 1' : format === 'long' ? 'AND v.is_short = 0' : ''}`).all();
    const byCh = {}; for (const v of lib) (byCh[v.channel_id] ||= []).push(v.view_count);
    const med = Object.fromEntries(Object.entries(byCh).map(([k, a]) => [k, median(a) || 1]));
    const words = m ? m.replace(/"/g, '').split(' ') : [];
    for (const v of lib) { const x = v.view_count / med[v.channel_id]; if (x >= minX && (!words.length || words.some(w => v.title.toLowerCase().includes(w)))) pool.push({ title: v.title, x: Math.round(x * 10) / 10, id: v.id, channel: v.channel }); }
  } catch { /* */ }
  const groups = new Map();
  for (const p of pool) {
    const { template, frames } = templateOf(p.title);
    if (frames < 2 || !/\[/.test(template) || template.split(' ').length < 3) continue;
    const g = groups.get(template) || { template: pretty(template), uses: 0, xs: [], examples: [] };
    g.uses++; g.xs.push(p.x || 0); g.examples.push(p);
    groups.set(template, g);
  }
  const out = [...groups.values()].filter(g => g.uses >= 2).map(g => ({ formula: g.template, uses: g.uses, medianX: Math.round(median(g.xs) * 10) / 10, score: Math.round(Math.log2(1 + g.uses) * median(g.xs) * 10) / 10, examples: g.examples.sort((a, b) => b.x - a.x).slice(0, 3) }));
  return { q, sample: pool.length, formulas: out.sort((a, b) => b.score - a.score).slice(0, limit), note: pool.length < 100 ? 'Few outliers indexed yet for this topic — the formula list sharpens as the daily index grows.' : null };
}
export { templateOf };

// ======================= similar thumbnails =======================
function ffmpegBin() { return toolStatus().ffmpeg; }
/** 16×16 RGB pixels of an image (buffer or file) through ffmpeg. */
function pixels(input) {
  return new Promise((resolve, reject) => {
    const bin = ffmpegBin(); if (!bin) return reject(err('ffmpeg is needed for thumbnail search (brew install ffmpeg).'));
    const p = spawn(bin, ['-v', 'error', '-i', Buffer.isBuffer(input) ? 'pipe:0' : input, '-vf', 'scale=16:16:flags=area,format=rgb24', '-frames:v', '1', '-f', 'rawvideo', 'pipe:1'], { stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks = []; let e = '';
    p.stdout.on('data', d => chunks.push(d)); p.stderr.on('data', d => e += d);
    p.on('error', reject);
    p.on('close', code => { const b = Buffer.concat(chunks); code === 0 && b.length === 768 ? resolve(b) : reject(err(`could not read image: ${e.slice(-200) || code}`)); });
    if (Buffer.isBuffer(input)) p.stdin.end(input); else p.stdin.end();
  });
}
/** dHash (64 bits, structure) + 4×4 average colours (layout/palette). */
export function signature(px) {
  const gray = (x, y) => { const i = (y * 16 + x) * 3; return 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2]; };
  const g9 = []; // 9×8 grid by area-averaging the 16×16 image
  for (let y = 0; y < 8; y++) for (let x = 0; x < 9; x++) {
    const x0 = x * 16 / 9, x1 = (x + 1) * 16 / 9; let s = 0, n = 0;
    for (let yy = y * 2; yy < y * 2 + 2; yy++) for (let xx = Math.floor(x0); xx < Math.ceil(x1); xx++) { s += gray(Math.min(15, xx), yy); n++; }
    g9.push(s / n);
  }
  let bits = '';
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) bits += g9[y * 9 + x] > g9[y * 9 + x + 1] ? '1' : '0';
  const dhash = BigInt('0b' + bits).toString(16).padStart(16, '0');
  const cols = [];
  for (let by = 0; by < 4; by++) for (let bx = 0; bx < 4; bx++) for (let c = 0; c < 3; c++) {
    let s = 0; for (let y = by * 4; y < by * 4 + 4; y++) for (let x = bx * 4; x < bx * 4 + 4; x++) s += px[(y * 16 + x) * 3 + c];
    cols.push(Math.round(s / 16));
  }
  return { dhash, colors: Buffer.from(cols).toString('hex') };
}
const popcount = n => { let c = 0n; while (n) { n &= n - 1n; c++; } return Number(c); };
export function similarity(a, b) {
  const ham = popcount(BigInt('0x' + a.dhash) ^ BigInt('0x' + b.dhash));
  const ca = Buffer.from(a.colors, 'hex'), cb = Buffer.from(b.colors, 'hex');
  let d = 0; for (let i = 0; i < ca.length; i++) d += (ca[i] - cb[i]) ** 2;
  const colorDist = Math.sqrt(d / ca.length) / 255; // 0..1
  return Math.max(0, 1 - (0.55 * ham / 32 + 0.45 * colorDist * 2.2));
}
async function thumbBuffer(videoId) {
  const r = await fetchRetry(`${process.env.YT_THUMB_BASE || 'https://i.ytimg.com'}/vi/${videoId}/mqdefault.jpg`, {}, { retries: 2, timeoutMs: 15_000 });
  if (!r.ok) throw err(`thumbnail ${videoId}: HTTP ${r.status}`, 404);
  return Buffer.from(await r.arrayBuffer());
}
export async function hashVideo(videoId, source = 'index') {
  const sig = signature(await pixels(await thumbBuffer(videoId)));
  db.prepare('INSERT INTO thumb_index (video_id, dhash, colors, source) VALUES (?, ?, ?, ?) ON CONFLICT(video_id) DO UPDATE SET dhash = excluded.dhash, colors = excluded.colors, hashed_at = datetime(\'now\')').run(videoId, sig.dhash, sig.colors, source);
  return sig;
}
/** Hash thumbnails not seen yet: your library and competitors first, then the index (free: thumbnails cost no quota). */
export async function hashPending({ limit = 600 } = {}) {
  if (!ffmpegBin()) return { skipped: 'ffmpeg not installed' };
  const ids = db.prepare(`SELECT id, 'library' src FROM videos WHERE id NOT IN (SELECT video_id FROM thumb_index) AND is_live = 0
    UNION ALL SELECT id, 'index' FROM index_videos WHERE id NOT IN (SELECT video_id FROM thumb_index) LIMIT ?`).all(limit);
  let ok = 0, failed = 0;
  for (const r of ids) { try { await hashVideo(r.id, r.src); ok++; } catch { failed++; } }
  return { hashed: ok, failed, remaining: Math.max(0, db.prepare('SELECT (SELECT COUNT(*) FROM videos) + (SELECT COUNT(*) FROM index_videos) - (SELECT COUNT(*) FROM thumb_index) n').get().n) };
}
/** Thumbnails that look like this one (a YouTube video, or a local image such as a thumbnail you're making). */
export async function similarThumbnails({ videoId = null, file = null, limit = 24, minScore = 0.55 } = {}) {
  let sig;
  if (videoId) sig = db.prepare('SELECT dhash, colors FROM thumb_index WHERE video_id = ?').get(videoId) || await hashVideo(videoId, 'query');
  else if (file) { if (!fs.existsSync(file)) throw err('image not found', 404); sig = signature(await pixels(file)); }
  else throw err('give a videoId or an image file');
  const meta = db.prepare(`SELECT t.video_id, t.dhash, t.colors, t.source, COALESCE(i.title, v.title) title, COALESCE(i.channel_title, c.title) channel, COALESCE(i.views, v.view_count) views, i.x
    FROM thumb_index t LEFT JOIN index_videos i ON i.id = t.video_id LEFT JOIN videos v ON v.id = t.video_id LEFT JOIN channels c ON c.id = v.channel_id`).all();
  const scored = meta.filter(m => m.video_id !== videoId).map(m => ({ videoId: m.video_id, title: m.title, channel: m.channel, views: m.views, x: m.x && Math.round(m.x * 10) / 10, similarity: Math.round(similarity(sig, m) * 100) / 100, thumbnail: `https://i.ytimg.com/vi/${m.video_id}/mqdefault.jpg` }))
    .filter(m => m.similarity >= minScore).sort((a, b) => b.similarity - a.similarity).slice(0, limit);
  return { compared: meta.length, results: scored, note: meta.length < 500 ? 'The thumbnail library grows every day with the index.' : null };
}

// ======================= rank tracking =======================
export function addRankKeyword(channelId, keyword, country = getSetting('default_country', 'US')) {
  const ch = getChannel(channelId); if (!ch || ch.kind !== 'owned') throw err('Rank tracking is for your own channels.');
  keyword = String(keyword || '').trim().toLowerCase(); if (keyword.length < 2) throw err('keyword is too short');
  const max = Number(getSetting('rank_max_keywords', 15));
  if (db.prepare('SELECT COUNT(*) n FROM rank_keywords').get().n >= max) throw err(`Tracking is capped at ${max} keywords (each check costs 100 quota units a day; raise rank_max_keywords in Settings).`);
  db.prepare('INSERT OR IGNORE INTO rank_keywords (channel_id, keyword, country) VALUES (?, ?, ?)').run(channelId, keyword, country);
  return listRanks(channelId);
}
export function removeRankKeyword(id) { db.prepare('DELETE FROM rank_history WHERE keyword_id = ?').run(id); return db.prepare('DELETE FROM rank_keywords WHERE id = ?').run(id).changes; }
export async function checkRank(k) {
  const sr = await ytGet('search.list', { part: 'snippet', q: k.keyword, type: 'video', regionCode: k.country, maxResults: 50, order: 'relevance' }, { ttl: 20 * 3600 });
  const items = sr.items || [];
  const idx = items.findIndex(i => i.snippet?.channelId === k.channel_id);
  const top = items.slice(0, 5).map(i => ({ id: i.id?.videoId, title: i.snippet?.title, channel: i.snippet?.channelTitle }));
  const day = new Date().toISOString().slice(0, 10);
  db.prepare('INSERT INTO rank_history (keyword_id, day, position, video_id, video_title, top_json) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(keyword_id, day) DO UPDATE SET position = excluded.position, video_id = excluded.video_id, video_title = excluded.video_title, top_json = excluded.top_json, checked_at = datetime(\'now\')')
    .run(k.id, day, idx >= 0 ? idx + 1 : null, idx >= 0 ? items[idx].id?.videoId : null, idx >= 0 ? items[idx].snippet?.title : null, JSON.stringify(top));
  return { keyword: k.keyword, position: idx >= 0 ? idx + 1 : null };
}
export async function checkAllRanks() {
  const out = [];
  for (const k of db.prepare('SELECT * FROM rank_keywords').all()) {
    if (quotaToday().remaining < 100 + Number(getSetting('yt_quota_reserve', 500))) { out.push({ keyword: k.keyword, skipped: 'quota' }); continue; }
    try { out.push(await checkRank(k)); } catch (e) { out.push({ keyword: k.keyword, error: e.message }); if (/quota/i.test(e.message)) break; }
  }
  return out;
}
export function listRanks(channelId = null) {
  const ks = db.prepare(`SELECT * FROM rank_keywords ${channelId ? 'WHERE channel_id = ?' : ''} ORDER BY keyword`).all(...(channelId ? [channelId] : []));
  return ks.map(k => {
    const h = db.prepare('SELECT day, position, video_id, video_title, top_json FROM rank_history WHERE keyword_id = ? ORDER BY day DESC LIMIT 30').all(k.id);
    const now = h[0]?.position ?? null, week = h.find(r => Date.now() - Date.parse(r.day) >= 6.5 * 86400000)?.position ?? null;
    return { id: k.id, channelId: k.channel_id, keyword: k.keyword, country: k.country, position: now, change7d: now && week ? week - now : null, bestVideo: h[0]?.video_title || null, top: h[0]?.top_json ? JSON.parse(h[0].top_json) : [], history: h.reverse().map(r => ({ day: r.day, position: r.position })), note: 'Position in YouTube\'s non-personalised API search (top 50; empty = not in the top 50).' };
  });
}

// ======================= competitor audience =======================
const REQUEST = /\b(please|pls|can you|could you|make a video|do a video|next video|part 2|tutorial on|how do (i|you)|what about|wish|hate|annoying|confus|struggl|help me|anyone know)\b/i;
/** What your competitors' viewers ask for and complain about (top recent videos, ~1 quota unit each). Cached 24 h. */
export async function competitorAudience(channelId, { videosPerCompetitor = 3, maxCompetitors = 6, days = 45 } = {}) {
  const key = `comp_audience_${channelId}`;
  try { const c = JSON.parse(getSetting(key, '') || 'null'); if (c && Date.now() - Date.parse(c.at) < 20 * 3600e3) return c; } catch { /* */ }
  const comps = db.prepare('SELECT c.id, c.title FROM competitor_links l JOIN channels c ON c.id = l.competitor_channel_id WHERE l.owned_channel_id = ? LIMIT ?').all(channelId, maxCompetitors);
  const vids = [];
  for (const c of comps) vids.push(...db.prepare("SELECT id, title, channel_id FROM videos WHERE channel_id = ? AND is_live = 0 AND published_at >= date('now', ?) ORDER BY view_count DESC LIMIT ?").all(c.id, `-${days} days`, videosPerCompetitor).map(v => ({ ...v, channel: c.title })));
  const threads = [];
  for (const v of vids) {
    try { (await fetchThreads({ videoId: v.id, maxPages: 1, order: 'relevance' })).forEach(t => threads.push({ ...t, videoId: v.id, videoTitle: v.title, competitor: v.channel })); }
    catch { /* comments disabled */ }
  }
  const asks = threads.filter(t => !t.isOwner && (t.isQuestion || REQUEST.test(t.text || ''))).map(t => ({ ...t, isQuestion: true }));
  const byVideo = Object.fromEntries(vids.map(v => [v.id, v]));
  const clusters = clusterQuestions(asks).slice(0, 12).map(c => ({ topic: c.topic, count: c.count, likes: c.likes, examples: c.examples.sort((a, b) => b.likes - a.likes).slice(0, 3).map(e => ({ text: String(e.text).replace(/\s+/g, ' ').slice(0, 220), likes: e.likes, video: byVideo[e.videoId]?.title, competitor: byVideo[e.videoId]?.channel })) }));
  const out = { at: new Date().toISOString(), videos: vids.length, comments: threads.length, asks: asks.length, clusters };
  setSetting(key, JSON.stringify(out));
  return out;
}
