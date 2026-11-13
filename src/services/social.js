// Social research + TikTok: what vidIQ does for Instagram/TikTok, on official APIs only.
//  - Instagram: Business Discovery (any professional account's public profile + recent posts by username) and
//    hashtag top/recent media, through the same token used for publishing. Tracked accounts get synced, posts kept
//    locally, and outliers computed against each account's own median (likes + comments; views are not public).
//  - TikTok: Login Kit OAuth (paste-the-code flow), Display API (your profile + videos with views/likes/shares),
//    Content Posting API (upload + publish). Third-party TikTok data has no official API, so none is pretended here.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { db, getSetting, setSetting } from '../db.js';
import { ig } from './publish.js';
import { logApi } from '../youtube/client.js';

const TT = process.env.TT_API_BASE || 'https://open.tiktokapis.com/v2';
const TT_AUTH = process.env.TT_AUTH_BASE || 'https://www.tiktok.com/v2/auth/authorize/';

db.exec(`
CREATE TABLE IF NOT EXISTS ig_accounts (
  username TEXT PRIMARY KEY,
  ig_id TEXT, name TEXT, biography TEXT, website TEXT, profile_picture TEXT,
  followers INTEGER, follows INTEGER, media_count INTEGER,
  note TEXT, added_at TEXT NOT NULL DEFAULT (datetime('now')), synced_at TEXT, error TEXT
);
CREATE TABLE IF NOT EXISTS ig_account_media (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  caption TEXT, media_type TEXT, product_type TEXT, published_at TEXT, permalink TEXT, thumbnail TEXT,
  likes INTEGER, comments INTEGER, views INTEGER,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_igam_user ON ig_account_media(username, published_at);
CREATE TABLE IF NOT EXISTS ig_account_snapshots (
  username TEXT NOT NULL, day TEXT NOT NULL, followers INTEGER, media_count INTEGER,
  PRIMARY KEY (username, day)
);
CREATE TABLE IF NOT EXISTS ig_hashtag_cache (
  tag TEXT NOT NULL, kind TEXT NOT NULL, fetched_at TEXT NOT NULL, json TEXT NOT NULL,
  PRIMARY KEY (tag, kind)
);
CREATE TABLE IF NOT EXISTS tiktok_videos (
  id TEXT PRIMARY KEY,
  title TEXT, description TEXT, published_at TEXT, duration INTEGER, cover TEXT, share_url TEXT, embed_link TEXT,
  views INTEGER, likes INTEGER, comments INTEGER, shares INTEGER,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

// ---------- helpers ----------
const iso = t => t ? new Date(String(t).replace(/([+-]\d{2})(\d{2})$/, '$1:$2')).toISOString() : null;
const median = a => { const s = a.filter(x => Number.isFinite(x)).sort((x, y) => x - y); if (!s.length) return null; const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const clean = u => String(u || '').trim().replace(/^@/, '').replace(/^https?:\/\/(www\.)?instagram\.com\//i, '').replace(/[/?].*$/, '').toLowerCase();
const MEDIA_FIELDS = 'id,caption,media_type,media_product_type,timestamp,permalink,thumbnail_url,media_url,like_count,comments_count';

// ---------- Instagram: Business Discovery ----------
/** Public profile + recent media of any professional Instagram account, by username. */
export async function igDiscover(username, { limit = 50 } = {}) {
  const u = clean(username); if (!u) throw new Error('username is required');
  const me = getSetting('ig_user_id'); if (!me) throw new Error('Instagram is not configured (Settings → Instagram).');
  const fields = `business_discovery.username(${u}){id,username,name,biography,website,profile_picture_url,followers_count,follows_count,media_count,media.limit(${limit}){${MEDIA_FIELDS}}}`;
  let r;
  try { r = await ig(me, { params: { fields } }); }
  catch (e) {
    if (/\(#110\)|does not exist|cannot be found|not a business|not a professional|business_discovery/i.test(e.message)) throw new Error(`@${u} is not a professional (Creator/Business) account or does not exist — Instagram only exposes professional accounts.`);
    throw e;
  }
  const b = r.business_discovery; if (!b) throw new Error(`no data for @${u}`);
  return {
    username: b.username, igId: b.id, name: b.name || null, biography: b.biography || null, website: b.website || null, profilePicture: b.profile_picture_url || null,
    followers: b.followers_count ?? null, follows: b.follows_count ?? null, mediaCount: b.media_count ?? null,
    media: (b.media?.data || []).map(m => ({ id: m.id, caption: m.caption || '', mediaType: m.media_type, productType: m.media_product_type || null, publishedAt: iso(m.timestamp), permalink: m.permalink || null, thumbnail: m.thumbnail_url || m.media_url || null, likes: m.like_count ?? null, comments: m.comments_count ?? null })),
  };
}

export function listAccounts() {
  const rows = db.prepare('SELECT * FROM ig_accounts ORDER BY followers DESC NULLS LAST, username').all();
  return rows.map(a => ({ ...a, stats: accountStats(a.username) }));
}
export async function trackAccount(username, { note = '' } = {}) {
  const u = clean(username); if (!u) throw new Error('username is required');
  const existed = !!accountRow(u);
  db.prepare('INSERT INTO ig_accounts (username, note) VALUES (?, ?) ON CONFLICT(username) DO UPDATE SET note = COALESCE(NULLIF(excluded.note, \'\'), ig_accounts.note)').run(u, note);
  try { return await syncAccount(u); }
  catch (e) { if (!existed) db.prepare('DELETE FROM ig_accounts WHERE username = ?').run(u); throw e; }
}
export function untrackAccount(username) {
  const u = clean(username);
  db.prepare('DELETE FROM ig_account_media WHERE username = ?').run(u); db.prepare('DELETE FROM ig_account_snapshots WHERE username = ?').run(u);
  return db.prepare('DELETE FROM ig_accounts WHERE username = ?').run(u).changes > 0;
}
export async function syncAccount(username, { limit = 50 } = {}) {
  const u = clean(username);
  try {
    const d = await igDiscover(u, { limit });
    db.prepare(`INSERT INTO ig_accounts (username, ig_id, name, biography, website, profile_picture, followers, follows, media_count, synced_at, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), NULL)
      ON CONFLICT(username) DO UPDATE SET ig_id = excluded.ig_id, name = excluded.name, biography = excluded.biography, website = excluded.website, profile_picture = excluded.profile_picture, followers = excluded.followers, follows = excluded.follows, media_count = excluded.media_count, synced_at = excluded.synced_at, error = NULL`)
      .run(d.username, d.igId, d.name, d.biography, d.website, d.profilePicture, d.followers, d.follows, d.mediaCount);
    db.prepare('INSERT INTO ig_account_snapshots (username, day, followers, media_count) VALUES (?, date(\'now\'), ?, ?) ON CONFLICT(username, day) DO UPDATE SET followers = excluded.followers, media_count = excluded.media_count').run(d.username, d.followers, d.mediaCount);
    const up = db.prepare(`INSERT INTO ig_account_media (id, username, caption, media_type, product_type, published_at, permalink, thumbnail, likes, comments) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET caption = excluded.caption, thumbnail = excluded.thumbnail, likes = excluded.likes, comments = excluded.comments, permalink = excluded.permalink, updated_at = datetime('now')`);
    const tx = db.transaction(ms => { for (const m of ms) up.run(m.id, d.username, m.caption, m.mediaType, m.productType, m.publishedAt, m.permalink, m.thumbnail, m.likes, m.comments); });
    tx(d.media);
    return { ...accountRow(d.username), stats: accountStats(d.username), synced: d.media.length };
  } catch (e) {
    db.prepare('UPDATE ig_accounts SET error = ?, synced_at = datetime(\'now\') WHERE username = ?').run(e.message, u);
    throw e;
  }
}
export async function syncAllAccounts() {
  const out = { synced: 0, failed: [] };
  for (const a of db.prepare('SELECT username FROM ig_accounts').all()) { try { await syncAccount(a.username); out.synced++; } catch (e) { out.failed.push({ username: a.username, error: e.message }); } }
  return out;
}
const accountRow = u => db.prepare('SELECT * FROM ig_accounts WHERE username = ?').get(u);
export function accountStats(username) {
  const ms = db.prepare('SELECT * FROM ig_account_media WHERE username = ? ORDER BY published_at DESC LIMIT 50').all(username);
  const a = accountRow(username) || {};
  const reels = ms.filter(m => m.product_type === 'REELS' || m.media_type === 'VIDEO');
  const eng = m => (m.likes || 0) + (m.comments || 0);
  const medEng = median(ms.map(eng)), medReelEng = median(reels.map(eng));
  const last30 = ms.filter(m => Date.now() - Date.parse(m.published_at) < 30 * 86400e3);
  const prev = db.prepare('SELECT followers FROM ig_account_snapshots WHERE username = ? AND day <= date(\'now\', \'-7 days\') ORDER BY day DESC LIMIT 1').get(username);
  return {
    posts: ms.length, reels: reels.length, medianEngagement: medEng, medianReelEngagement: medReelEng,
    engagementRate: a.followers && medEng != null ? +(medEng / a.followers * 100).toFixed(2) : null,
    postsPerWeek30d: +(last30.length / (30 / 7)).toFixed(1), reelShare: ms.length ? +(reels.length / ms.length).toFixed(2) : null,
    followersGained7d: prev && a.followers != null ? a.followers - prev.followers : null,
  };
}
/** Posts across tracked accounts ranked by engagement vs their own account's median (the vidIQ outlier idea, on Instagram). */
export function igOutliers({ days = 90, minX = 1.5, limit = 50, username = null, reelsOnly = false } = {}) {
  const since = new Date(Date.now() - days * 86400e3).toISOString();
  const rows = db.prepare(`SELECT m.*, a.followers FROM ig_account_media m JOIN ig_accounts a ON a.username = m.username WHERE m.published_at >= ? ${username ? 'AND m.username = ?' : ''} ORDER BY m.published_at DESC`).all(...(username ? [since, clean(username)] : [since]));
  const med = {}; for (const r of rows) (med[r.username] ||= []).push((r.likes || 0) + (r.comments || 0));
  for (const k of Object.keys(med)) med[k] = median(med[k]) || 1;
  return rows.filter(r => !reelsOnly || r.product_type === 'REELS' || r.media_type === 'VIDEO')
    .map(r => { const e = (r.likes || 0) + (r.comments || 0); return { ...r, engagement: e, median: med[r.username], x: +(e / med[r.username]).toFixed(2), perFollower: r.followers ? +(e / r.followers * 100).toFixed(2) : null, ageDays: Math.round((Date.now() - Date.parse(r.published_at)) / 86400e3) }; })
    .filter(r => r.x >= minX).sort((a, b) => b.x - a.x).slice(0, limit);
}

// ---------- Instagram: hashtags (30 unique tags per 7 days per account — cached locally) ----------
export async function igHashtag(tag, { kind = 'top', limit = 50, maxAgeHours = 24 } = {}) {
  const t = String(tag || '').trim().replace(/^#/, '').toLowerCase(); if (!t) throw new Error('tag is required');
  const me = getSetting('ig_user_id'); if (!me) throw new Error('Instagram is not configured (Settings → Instagram).');
  const cached = db.prepare('SELECT * FROM ig_hashtag_cache WHERE tag = ? AND kind = ?').get(t, kind);
  if (cached && Date.now() - Date.parse(cached.fetched_at) < maxAgeHours * 3600e3) return { ...JSON.parse(cached.json), cached: true };
  const s = await ig('ig_hashtag_search', { params: { user_id: me, q: t } });
  const id = s.data?.[0]?.id; if (!id) throw new Error(`hashtag #${t} not found`);
  const r = await ig(`${id}/${kind === 'recent' ? 'recent_media' : 'top_media'}`, { params: { user_id: me, fields: 'id,caption,media_type,media_product_type,permalink,timestamp,like_count,comments_count', limit } });
  const media = (r.data || []).map(m => ({ id: m.id, caption: m.caption || '', mediaType: m.media_type, productType: m.media_product_type || null, publishedAt: iso(m.timestamp), permalink: m.permalink, likes: m.like_count ?? null, comments: m.comments_count ?? null, engagement: (m.like_count || 0) + (m.comments_count || 0) }));
  const out = { tag: t, hashtagId: id, kind, count: media.length, medianEngagement: median(media.map(m => m.engagement)), reelShare: media.length ? +(media.filter(m => m.productType === 'REELS' || m.mediaType === 'VIDEO').length / media.length).toFixed(2) : null, media: media.sort((a, b) => b.engagement - a.engagement), fetchedAt: new Date().toISOString() };
  db.prepare('INSERT INTO ig_hashtag_cache (tag, kind, fetched_at, json) VALUES (?, ?, ?, ?) ON CONFLICT(tag, kind) DO UPDATE SET fetched_at = excluded.fetched_at, json = excluded.json').run(t, kind, out.fetchedAt, JSON.stringify(out));
  return out;
}

// ---------- TikTok ----------
export const TT_SCOPES = ['user.info.basic', 'user.info.profile', 'user.info.stats', 'video.list', 'video.publish', 'video.upload'];
export function tiktokStatus() {
  const configured = !!(getSetting('tt_client_key') && getSetting('tt_client_secret'));
  const connected = !!getSetting('tt_refresh_token');
  return { configured, connected, openId: getSetting('tt_open_id') || null, username: getSetting('tt_username') || null, displayName: getSetting('tt_display_name') || null, redirectUri: getSetting('tt_redirect_uri') || null, tokenExpiresAt: getSetting('tt_access_expires_at') || null, audited: getSetting('tt_audited', '0') === '1' };
}
/** Step 1 of the paste-the-code flow: open this URL, approve, copy the `code` from the page you land on. */
export function tiktokAuthUrl() {
  const key = getSetting('tt_client_key'), redirect = getSetting('tt_redirect_uri');
  if (!key || !redirect) throw new Error('TikTok app not configured: client key and redirect URI in Settings → TikTok.');
  const state = crypto.randomBytes(8).toString('hex'); setSetting('tt_oauth_state', state);
  const u = new URL(TT_AUTH);
  u.search = new URLSearchParams({ client_key: key, response_type: 'code', scope: TT_SCOPES.join(','), redirect_uri: redirect, state }).toString();
  return { url: u.toString(), state };
}
async function ttToken(body) {
  const t0 = Date.now();
  const res = await fetch(`${TT}/oauth/token/`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) });
  const j = await res.json().catch(() => ({}));
  logApi({ api: 'tiktok', endpoint: 'oauth/token', units: 0, cached: 0, ms: Date.now() - t0, ok: res.ok && !j.error ? 1 : 0 });
  if (!res.ok || j.error) throw new Error(`TikTok auth: ${j.error_description || j.error || res.status}`);
  setSetting('tt_access_token', j.access_token); setSetting('tt_refresh_token', j.refresh_token); setSetting('tt_open_id', j.open_id);
  setSetting('tt_access_expires_at', new Date(Date.now() + (j.expires_in || 86400) * 1000).toISOString()); setSetting('tt_scope', j.scope || '');
  return j;
}
/** Step 2: exchange the pasted code (or a full redirect URL) for tokens. */
export async function tiktokConnect(codeOrUrl) {
  let code = String(codeOrUrl || '').trim();
  if (/^https?:\/\//.test(code)) { const u = new URL(code); code = u.searchParams.get('code') || ''; const st = u.searchParams.get('state'); if (st && st !== getSetting('tt_oauth_state')) throw new Error('state mismatch — start the connection again from TubeDesk'); }
  if (!code) throw new Error('paste the code (or the full URL you were redirected to)');
  await ttToken({ client_key: getSetting('tt_client_key'), client_secret: getSetting('tt_client_secret'), code, grant_type: 'authorization_code', redirect_uri: getSetting('tt_redirect_uri') });
  const me = await tiktokMe();
  return { connected: true, ...me };
}
async function ttAccess() {
  if (!getSetting('tt_refresh_token')) throw new Error('TikTok is not connected (Settings → TikTok → Connect).');
  if (Date.parse(getSetting('tt_access_expires_at') || 0) - Date.now() < 5 * 60e3) await ttToken({ client_key: getSetting('tt_client_key'), client_secret: getSetting('tt_client_secret'), grant_type: 'refresh_token', refresh_token: getSetting('tt_refresh_token') });
  return getSetting('tt_access_token');
}
export async function tt(pathname, { method = 'POST', params = {}, json = undefined } = {}) {
  const token = await ttAccess();
  const u = new URL(`${TT}/${pathname}`); for (const [k, v] of Object.entries(params)) if (v != null) u.searchParams.set(k, String(v));
  const t0 = Date.now();
  const res = await fetch(u, { method, headers: { Authorization: `Bearer ${token}`, ...(json !== undefined ? { 'Content-Type': 'application/json; charset=UTF-8' } : {}) }, body: json !== undefined ? JSON.stringify(json) : undefined });
  const j = await res.json().catch(() => ({}));
  logApi({ api: 'tiktok', endpoint: pathname, units: 0, cached: 0, ms: Date.now() - t0, ok: res.ok && (!j.error || j.error.code === 'ok') ? 1 : 0 });
  if (!res.ok || (j.error && j.error.code !== 'ok')) throw new Error(`TikTok API: ${j.error?.message || j.error?.code || res.status}`);
  return j.data ?? j;
}
export async function tiktokMe() {
  const d = await tt('user/info/', { method: 'GET', params: { fields: 'open_id,union_id,avatar_url,display_name,username,profile_deep_link,is_verified,follower_count,following_count,likes_count,video_count' } });
  const u = d.user || {};
  setSetting('tt_username', u.username || ''); setSetting('tt_display_name', u.display_name || '');
  return { openId: u.open_id, username: u.username, displayName: u.display_name, avatar: u.avatar_url, link: u.profile_deep_link, verified: !!u.is_verified, followers: u.follower_count, following: u.following_count, likes: u.likes_count, videos: u.video_count };
}
export async function tiktokSyncVideos({ max = 100 } = {}) {
  const up = db.prepare(`INSERT INTO tiktok_videos (id, title, description, published_at, duration, cover, share_url, embed_link, views, likes, comments, shares) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET title = excluded.title, views = excluded.views, likes = excluded.likes, comments = excluded.comments, shares = excluded.shares, cover = excluded.cover, updated_at = datetime('now')`);
  let cursor, n = 0, hasMore = true;
  while (hasMore && n < max) {
    const d = await tt('video/list/', { params: { fields: 'id,title,video_description,create_time,duration,cover_image_url,share_url,embed_link,view_count,like_count,comment_count,share_count' }, json: { max_count: Math.min(20, max - n), ...(cursor ? { cursor } : {}) } });
    for (const v of d.videos || []) { up.run(v.id, v.title || '', v.video_description || '', new Date((v.create_time || 0) * 1000).toISOString(), v.duration ?? null, v.cover_image_url || null, v.share_url || null, v.embed_link || null, v.view_count ?? null, v.like_count ?? null, v.comment_count ?? null, v.share_count ?? null); n++; }
    cursor = d.cursor; hasMore = !!d.has_more && (d.videos || []).length > 0;
  }
  return { synced: n };
}
export function tiktokVideos({ limit = 50 } = {}) {
  const rows = db.prepare('SELECT * FROM tiktok_videos ORDER BY published_at DESC LIMIT ?').all(limit);
  const med = median(rows.map(r => r.views || 0)) || 1;
  return rows.map(r => ({ ...r, x: +((r.views || 0) / med).toFixed(2), viewsPerDay: r.published_at ? Math.round((r.views || 0) / Math.max(1, (Date.now() - Date.parse(r.published_at)) / 86400e3)) : null, engagement: r.views ? +(((r.likes || 0) + (r.comments || 0) + (r.shares || 0)) / r.views * 100).toFixed(2) : null }));
}
/** Upload + publish a video to the connected TikTok account (FILE_UPLOAD, chunked). Unaudited apps: TikTok keeps it private ("Only me") until the app passes review. */
export async function tiktokPublish({ file, title = '', privacy, allowComment = true, allowDuet = false, allowStitch = false, disclose = false, brandContent = false, brandOrganic = false, log = () => {} }) {
  const abs = path.resolve(String(file || '')); if (!fs.existsSync(abs)) throw new Error(`file not found: ${abs}`);
  if (!['.mp4', '.mov', '.webm'].includes(path.extname(abs).toLowerCase())) throw new Error('TikTok accepts MP4, MOV or WebM');
  const size = fs.statSync(abs).size; if (size > 4 * 1024 ** 3) throw new Error('file is larger than 4 GB');
  const info = await tt('post/publish/creator_info/query/', { json: {} });
  const allowed = info.privacy_level_options || [];
  const level = privacy || (allowed.includes('PUBLIC_TO_EVERYONE') ? 'PUBLIC_TO_EVERYONE' : allowed[0] || 'SELF_ONLY');
  if (allowed.length && !allowed.includes(level)) throw new Error(`privacy '${level}' not allowed for this account; options: ${allowed.join(', ')}`);
  if (info.max_video_post_duration_sec) log(`creator: @${info.creator_username || '?'}, max ${info.max_video_post_duration_sec}s, privacy ${level}`);
  const chunk = Math.min(64 * 1024 * 1024, Math.max(5 * 1024 * 1024, size)); const total = Math.ceil(size / chunk);
  const init = await tt('post/publish/video/init/', { json: {
    post_info: { title: String(title).slice(0, 2200), privacy_level: level, disable_comment: !allowComment, disable_duet: !allowDuet, disable_stitch: !allowStitch, brand_content_toggle: !!brandContent, brand_organic_toggle: !!brandOrganic, is_aigc: !!disclose },
    source_info: { source: 'FILE_UPLOAD', video_size: size, chunk_size: chunk, total_chunk_count: total },
  } });
  log(`publish ${init.publish_id}: uploading ${(size / 1048576).toFixed(1)} MB in ${total} chunk(s)`);
  const fd = fs.openSync(abs, 'r');
  try {
    for (let i = 0; i < total; i++) {
      const start = i * chunk, end = Math.min(size, start + chunk) - 1; const buf = Buffer.alloc(end - start + 1); fs.readSync(fd, buf, 0, buf.length, start);
      const r = await fetch(init.upload_url, { method: 'PUT', headers: { 'Content-Type': 'video/mp4', 'Content-Length': String(buf.length), 'Content-Range': `bytes ${start}-${end}/${size}` }, body: buf });
      if (!(r.status === 206 || r.status === 201 || r.ok)) throw new Error(`chunk ${i + 1}/${total} upload failed: HTTP ${r.status}`);
    }
  } finally { fs.closeSync(fd); }
  const deadline = Date.now() + 10 * 60e3; let st = {};
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 5000));
    st = await tt('post/publish/status/fetch/', { json: { publish_id: init.publish_id } });
    if (st.status === 'PUBLISH_COMPLETE') break;
    if (st.status === 'FAILED') throw new Error(`TikTok rejected the post: ${st.fail_reason || 'unknown'}`);
  }
  if (st.status !== 'PUBLISH_COMPLETE') throw new Error(`TikTok processing timed out (last status ${st.status || '?'})`);
  const id = st.publicaly_available_post_id?.[0] || st.publicly_available_post_id?.[0] || null;
  const audited = getSetting('tt_audited', '0') === '1';
  log(audited ? `published${id ? ' ' + id : ''}` : `published${id ? ' ' + id : ''} — app not audited by TikTok yet, so the video is private ("Only me"); make it public in the TikTok app or mark the app audited in Settings once approved`);
  const user = getSetting('tt_username');
  return { id, url: id && user ? `https://www.tiktok.com/@${user}/video/${id}` : null, privacy: level, audited };
}

export function status() { return { instagram: { configured: !!getSetting('ig_user_id'), accounts: db.prepare('SELECT COUNT(*) n FROM ig_accounts').get().n, posts: db.prepare('SELECT COUNT(*) n FROM ig_account_media').get().n }, tiktok: { ...tiktokStatus(), videos: db.prepare('SELECT COUNT(*) n FROM tiktok_videos').get().n } }; }
