// Publishing: upload videos to YouTube (owned channel OAuth) and Reels/images to Instagram (Graph API).
// Every publish is a job row in publish_jobs so an AI agent can fire-and-poll, or wait inline.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { db, getSetting, setSetting, today } from '../db.js';
import { getAccessToken, isAuthorized } from '../youtube/oauth.js';
import { logApi, quotaToday, ytWrite, YouTubeError } from '../youtube/client.js';
import * as ch from './channels.js';

const YT_UPLOAD = process.env.YT_UPLOAD_BASE || 'https://www.googleapis.com/upload/youtube/v3';
const IG_GRAPH = process.env.IG_GRAPH_BASE || 'https://graph.instagram.com/v21.0';
const IG_REFRESH = process.env.IG_GRAPH_BASE ? `${process.env.IG_GRAPH_BASE}/refresh_access_token` : 'https://graph.instagram.com/refresh_access_token';
export const YT_UPLOAD_UNITS = 1600; // published cost of videos.insert
const PRIVACY = new Set(['private', 'unlisted', 'public']);
const VIDEO_EXT = new Set(['.mp4', '.mov', '.m4v', '.webm', '.mkv', '.avi']);
const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png']);

db.exec(`CREATE TABLE IF NOT EXISTS publish_jobs (
  id TEXT PRIMARY KEY,
  platform TEXT NOT NULL,            -- youtube | instagram
  status TEXT NOT NULL,              -- queued | running | done | failed
  file TEXT NOT NULL,
  title TEXT,
  params_json TEXT NOT NULL,
  remote_id TEXT,
  url TEXT,
  error TEXT,
  log TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT
)`);

// ---------- jobs ----------
const running = new Map(); // id -> Promise
function rowToJob(r) {
  if (!r) return null;
  return { ...r, params: JSON.parse(r.params_json), params_json: undefined, log: r.log.split('\n').filter(Boolean) };
}
export function getJob(id) { return rowToJob(db.prepare('SELECT * FROM publish_jobs WHERE id = ?').get(id)); }
export function listJobs({ limit = 50, platform = null } = {}) {
  const rows = platform ? db.prepare('SELECT * FROM publish_jobs WHERE platform = ? ORDER BY created_at DESC LIMIT ?').all(platform, limit)
    : db.prepare('SELECT * FROM publish_jobs ORDER BY created_at DESC LIMIT ?').all(limit);
  return rows.map(rowToJob);
}
function update(id, patch) {
  const sets = Object.keys(patch).map(k => `${k} = @${k}`).join(', ');
  db.prepare(`UPDATE publish_jobs SET ${sets}, updated_at = datetime('now') WHERE id = @id`).run({ ...patch, id });
}
function logLine(id, line) {
  db.prepare("UPDATE publish_jobs SET log = log || ? || char(10), updated_at = datetime('now') WHERE id = ?").run(`${new Date().toISOString().slice(11, 19)} ${line}`, id);
}
function createJob(platform, file, title, params) {
  const id = crypto.randomBytes(6).toString('hex');
  db.prepare('INSERT INTO publish_jobs(id, platform, status, file, title, params_json) VALUES (?, ?, ?, ?, ?, ?)').run(id, platform, 'queued', file, title || null, JSON.stringify(params));
  return id;
}
async function runJob(id, fn) {
  update(id, { status: 'running' });
  const p = (async () => {
    try {
      const out = await fn(line => logLine(id, line));
      update(id, { status: 'done', remote_id: out.id, url: out.url, finished_at: new Date().toISOString() });
    } catch (e) {
      logLine(id, `error: ${e.message}`);
      update(id, { status: 'failed', error: e.message, finished_at: new Date().toISOString() });
    } finally { running.delete(id); }
  })();
  running.set(id, p);
  return p;
}
/** Resolve when the job is finished (or timeoutMs elapses); returns the job either way. */
export async function waitForJob(id, timeoutMs = 10 * 60 * 1000) {
  const p = running.get(id);
  if (p) await Promise.race([p, new Promise(r => setTimeout(r, timeoutMs))]);
  return getJob(id);
}

// ---------- validation ----------
function resolveFile(file, kinds) {
  if (!file || typeof file !== 'string') throw new Error('file is required: an absolute path on this machine.');
  const abs = path.resolve(file);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) throw new Error(`file not found: ${abs}`);
  const ext = path.extname(abs).toLowerCase();
  if (!kinds.has(ext)) throw new Error(`unsupported file type ${ext || '(none)'}; expected one of ${[...kinds].join(', ')}`);
  return abs;
}
function mimeFor(abs) {
  const ext = path.extname(abs).toLowerCase();
  return { '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.mkv': 'video/x-matroska', '.avi': 'video/x-msvideo', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png' }[ext] || 'application/octet-stream';
}

// ---------- YouTube ----------
export function youtubeStatus() {
  const owned = ch.listChannels('owned').map(c => ({ id: c.id, title: c.title, handle: c.handle, authorized: isAuthorized(c.id) }));
  const q = quotaToday();
  return { channels: owned, ready: owned.some(c => c.authorized), quotaRemaining: q.remaining, uploadCostUnits: YT_UPLOAD_UNITS, uploadsLeftToday: Math.floor(q.remaining / YT_UPLOAD_UNITS) };
}

/**
 * publishYouTube({ file, title, description, tags, privacy, publishAt, categoryId, madeForKids, language, thumbnail, playlistId, notifySubscribers, channelId })
 * Resumable upload (videos.insert, 1,600 units) → optional thumbnails.set (50) → optional playlistItems.insert (50).
 */
export function validateYouTube(p = {}) {
  const file = resolveFile(p.file, VIDEO_EXT);
  const owned = ch.listChannels('owned');
  const channelId = p.channelId || owned.find(c => isAuthorized(c.id))?.id;
  if (!channelId) throw new Error('No authorized owned channel. Connect one with Google in Channels first.');
  if (!isAuthorized(channelId)) throw new Error(`Channel ${channelId} is not authorized for uploads; reconnect it with Google.`);
  const title = String(p.title || '').trim();
  if (!title) throw new Error('title is required.');
  if (title.length > 100) throw new Error('title must be 100 characters or fewer.');
  if (/[<>]/.test(title)) throw new Error('title cannot contain < or >.');
  const description = String(p.description || '');
  if (description.length > 5000) throw new Error('description must be 5,000 characters or fewer.');
  const privacy = p.privacy || (p.publishAt ? 'private' : 'private');
  if (!PRIVACY.has(privacy)) throw new Error("privacy must be 'private', 'unlisted' or 'public'.");
  let publishAt = null;
  if (p.publishAt) {
    const d = new Date(p.publishAt);
    if (Number.isNaN(d.getTime())) throw new Error('publishAt must be an ISO-8601 date-time.');
    if (d.getTime() < Date.now() + 60_000) throw new Error('publishAt must be in the future.');
    if (privacy !== 'private') throw new Error("scheduled videos must use privacy 'private' (YouTube makes them public at publishAt).");
    publishAt = d.toISOString();
  }
  const tags = Array.isArray(p.tags) ? p.tags.map(t => String(t).trim()).filter(Boolean) : (typeof p.tags === 'string' ? p.tags.split(',').map(t => t.trim()).filter(Boolean) : []);
  if (tags.join(',').length > 500) throw new Error('tags total length must be 500 characters or fewer.');
  const thumbnail = p.thumbnail ? resolveFile(p.thumbnail, IMAGE_EXT) : null;
  if (thumbnail && fs.statSync(thumbnail).size > 2 * 1024 * 1024) throw new Error('thumbnail must be 2 MB or smaller.');
  return {
    file, channelId, title, description, tags, privacy, publishAt, thumbnail,
    categoryId: p.categoryId ? String(p.categoryId) : undefined,
    madeForKids: !!p.madeForKids, language: p.language || undefined, playlistId: p.playlistId || undefined,
    notifySubscribers: p.notifySubscribers !== false, containsSyntheticMedia: p.containsSyntheticMedia === true,
  };
}

async function uploadResumable(v, log) {
  const size = fs.statSync(v.file).size;
  const mime = mimeFor(v.file);
  const q = quotaToday();
  if (q.remaining < YT_UPLOAD_UNITS) throw new YouTubeError(`YouTube quota: ${q.remaining} units left today, an upload costs ${YT_UPLOAD_UNITS}. Resets at midnight Pacific.`, { status: 429, reason: 'quotaGuard' });
  const token = await getAccessToken(v.channelId);
  const body = {
    snippet: { title: v.title, description: v.description, tags: v.tags, categoryId: v.categoryId, defaultLanguage: v.language, defaultAudioLanguage: v.language },
    status: { privacyStatus: v.privacy, publishAt: v.publishAt || undefined, selfDeclaredMadeForKids: v.madeForKids, containsSyntheticMedia: v.containsSyntheticMedia || undefined },
  };
  const init = await fetch(`${YT_UPLOAD}/videos?uploadType=resumable&part=snippet,status&notifySubscribers=${v.notifySubscribers}`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': mime, 'X-Upload-Content-Length': String(size) }, body: JSON.stringify(body),
  });
  if (!init.ok) {
    const j = await init.json().catch(() => ({}));
    logApi({ api: 'data', endpoint: 'videos.insert', units: 0, cached: 0, ok: 0 });
    throw new YouTubeError(j?.error?.message || `upload init failed ${init.status}`, { status: init.status, reason: j?.error?.errors?.[0]?.reason, endpoint: 'videos.insert' });
  }
  const session = init.headers.get('location');
  if (!session) throw new Error('upload init returned no session URL');
  log(`upload session opened (${(size / 1048576).toFixed(1)} MB, ${mime})`);
  let offset = 0, attempt = 0, t0 = Date.now();
  while (true) {
    const headers = { Authorization: `Bearer ${await getAccessToken(v.channelId)}`, 'Content-Type': mime, 'Content-Length': String(size - offset) };
    if (offset) headers['Content-Range'] = `bytes ${offset}-${size - 1}/${size}`;
    const res = await fetch(session, { method: 'PUT', headers, body: fs.createReadStream(v.file, { start: offset }), duplex: 'half' }).catch(e => ({ ok: false, status: 0, netError: e }));
    if (res.ok) {
      const j = await res.json();
      logApi({ api: 'data', endpoint: 'videos.insert', units: YT_UPLOAD_UNITS, cached: 0, ms: Date.now() - t0 });
      log(`uploaded in ${((Date.now() - t0) / 1000).toFixed(1)}s → video ${j.id}`);
      return j;
    }
    if (++attempt > 5) {
      logApi({ api: 'data', endpoint: 'videos.insert', units: YT_UPLOAD_UNITS, cached: 0, ok: 0 });
      throw new Error(`upload failed after ${attempt} attempts (status ${res.status})`);
    }
    // Ask the session how much arrived, then resume from there.
    await new Promise(r => setTimeout(r, 1500 * attempt));
    const probe = await fetch(session, { method: 'PUT', headers: { Authorization: `Bearer ${await getAccessToken(v.channelId)}`, 'Content-Range': `bytes */${size}`, 'Content-Length': '0' } }).catch(() => null);
    if (probe && probe.ok) { const j = await probe.json(); logApi({ api: 'data', endpoint: 'videos.insert', units: YT_UPLOAD_UNITS, cached: 0, ms: Date.now() - t0 }); return j; }
    const range = probe?.headers.get('range');
    offset = range ? Number(range.split('-')[1]) + 1 : 0;
    log(`retry ${attempt}: resuming from byte ${offset} (status ${res.status})`);
  }
}

export function publishYouTube(params) {
  const v = validateYouTube(params);
  const id = createJob('youtube', v.file, v.title, { ...v, file: undefined, thumbnail: v.thumbnail || undefined });
  runJob(id, async log => {
    const vid = await uploadResumable(v, log);
    const videoId = vid.id;
    if (v.thumbnail) {
      try {
        const token = await getAccessToken(v.channelId);
        const r = await fetch(`${YT_UPLOAD}/thumbnails/set?videoId=${videoId}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': mimeFor(v.thumbnail) }, body: fs.readFileSync(v.thumbnail) });
        logApi({ api: 'data', endpoint: 'thumbnails.set', units: 50, cached: 0, ok: r.ok ? 1 : 0 });
        if (!r.ok) { const j = await r.json().catch(() => ({})); log(`thumbnail not set: ${j?.error?.message || r.status} (custom thumbnails need a verified YouTube account)`); }
        else log('thumbnail set');
      } catch (e) { log(`thumbnail not set: ${e.message}`); }
    }
    if (v.playlistId) {
      try { await ytWrite('playlistItems.insert', { params: { part: 'snippet' }, json: { snippet: { playlistId: v.playlistId, resourceId: { kind: 'youtube#video', videoId } } }, channelId: v.channelId }); log(`added to playlist ${v.playlistId}`); }
      catch (e) { log(`playlist add failed: ${e.message}`); }
    }
    try { await ch.syncVideos(v.channelId, { maxVideos: 5 }); } catch { /* local catalogue refresh is best-effort */ }
    const status = vid.status?.uploadStatus || 'uploaded';
    log(`done: ${v.privacy}${v.publishAt ? `, scheduled for ${v.publishAt}` : ''} (${status})`);
    return { id: videoId, url: `https://youtu.be/${videoId}` };
  });
  return getJob(id);
}

// ---------- Instagram ----------
export function instagramStatus() {
  const configured = !!(getSetting('ig_user_id') && getSetting('ig_access_token'));
  return { configured, username: getSetting('ig_username') || null, userId: getSetting('ig_user_id') || null, tokenRefreshedAt: getSetting('ig_token_refreshed_at') || null, publicUrl: publicUrlMode() };
}
async function ig(pathname, { method = 'GET', params = {} } = {}) {
  const token = getSetting('ig_access_token');
  if (!token) throw new Error('Instagram is not configured: add the account ID and access token in Settings → Instagram.');
  const u = new URL(`${IG_GRAPH}/${pathname}`);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, String(v));
  u.searchParams.set('access_token', token);
  const t0 = Date.now();
  const res = await fetch(u, { method });
  const j = await res.json().catch(() => ({}));
  logApi({ api: 'instagram', endpoint: `${method} ${pathname.replace(/^\d+/, ':id')}`, units: 0, cached: 0, ms: Date.now() - t0, ok: res.ok ? 1 : 0 });
  if (!res.ok || j.error) {
    const e = j.error || {};
    throw new Error(`Instagram API: ${e.message || res.status}${e.error_user_msg ? ` — ${e.error_user_msg}` : ''}${e.code ? ` (code ${e.code}${e.error_subcode ? '/' + e.error_subcode : ''})` : ''}`);
  }
  return j;
}
export async function instagramTest() {
  const me = await ig('me', { params: { fields: 'id,username,account_type,media_count' } });
  setSetting('ig_username', me.username || '');
  if (me.id && !getSetting('ig_user_id')) setSetting('ig_user_id', me.id);
  return me;
}
/** Long-lived Instagram tokens last 60 days; refresh when older than 30. */
export async function refreshInstagramToken({ force = false } = {}) {
  const token = getSetting('ig_access_token');
  if (!token) return { refreshed: false, reason: 'not configured' };
  const last = Number(getSetting('ig_token_refreshed_at_ms', 0));
  if (!force && Date.now() - last < 30 * 86400e3) return { refreshed: false, reason: 'fresh' };
  const u = new URL(IG_REFRESH); u.searchParams.set('grant_type', 'ig_refresh_token'); u.searchParams.set('access_token', token);
  const res = await fetch(u); const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.access_token) return { refreshed: false, reason: j?.error?.message || `status ${res.status}` };
  setSetting('ig_access_token', j.access_token); setSetting('ig_token_refreshed_at', new Date().toISOString()); setSetting('ig_token_refreshed_at_ms', String(Date.now()));
  return { refreshed: true, expiresInDays: Math.round((j.expires_in || 0) / 86400) };
}

export function validateInstagram(p = {}) {
  if (!getSetting('ig_user_id') || !getSetting('ig_access_token')) throw new Error('Instagram is not configured: add the account ID and access token in Settings → Instagram.');
  const kind = p.kind || 'reel';
  if (!['reel', 'image'].includes(kind)) throw new Error("kind must be 'reel' or 'image'.");
  const file = resolveFile(p.file, kind === 'reel' ? VIDEO_EXT : IMAGE_EXT);
  if (kind === 'reel' && !['.mp4', '.mov', '.m4v'].includes(path.extname(file).toLowerCase())) throw new Error('Reels must be MP4 or MOV (H.264/AAC).');
  const caption = String(p.caption || '');
  if (caption.length > 2200) throw new Error('caption must be 2,200 characters or fewer.');
  if ((caption.match(/#/g) || []).length > 30) throw new Error('caption may contain at most 30 hashtags.');
  const cover = p.cover ? resolveFile(p.cover, IMAGE_EXT) : null;
  return { kind, file, caption, cover, shareToFeed: p.shareToFeed !== false, thumbOffsetMs: p.thumbOffsetMs ? Number(p.thumbOffsetMs) : undefined, locationId: p.locationId || undefined, collaborators: Array.isArray(p.collaborators) ? p.collaborators : undefined };
}

export function publishInstagram(params) {
  const v = validateInstagram(params);
  const igUser = getSetting('ig_user_id');
  const id = createJob('instagram', v.file, v.caption.slice(0, 80), { ...v, file: undefined });
  runJob(id, async log => {
    await refreshInstagramToken().then(r => { if (r.refreshed) log('access token refreshed'); }).catch(() => {});
    const lease = await publicLease([v.file, v.cover].filter(Boolean), log);
    try {
      const params = { caption: v.caption, location_id: v.locationId, collaborators: v.collaborators ? JSON.stringify(v.collaborators) : undefined };
      if (v.kind === 'reel') Object.assign(params, { media_type: 'REELS', video_url: lease.urls[0], share_to_feed: v.shareToFeed, cover_url: v.cover ? lease.urls[1] : undefined, thumb_offset: v.thumbOffsetMs });
      else Object.assign(params, { image_url: lease.urls[0] });
      const c = await ig(`${igUser}/media`, { method: 'POST', params });
      log(`container ${c.id} created; Instagram is fetching the ${v.kind}`);
      const deadline = Date.now() + 15 * 60 * 1000; let status = 'IN_PROGRESS', detail = '';
      while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, v.kind === 'reel' ? 6000 : 2000));
        const s = await ig(c.id, { params: { fields: 'status_code,status' } });
        status = s.status_code; detail = s.status || '';
        if (status === 'FINISHED') break;
        if (status === 'ERROR' || status === 'EXPIRED') throw new Error(`Instagram could not process the media: ${detail || status}`);
      }
      if (status !== 'FINISHED') throw new Error('Instagram processing timed out after 15 minutes.');
      const pub = await ig(`${igUser}/media_publish`, { method: 'POST', params: { creation_id: c.id } });
      log(`published media ${pub.id}`);
      let url = null;
      try { url = (await ig(pub.id, { params: { fields: 'permalink' } })).permalink || null; } catch { /* permalink is optional */ }
      return { id: pub.id, url };
    } finally { lease.release(); }
  });
  return getJob(id);
}

// ---------- public URLs for Instagram (it downloads the file from a public URL) ----------
// Mode 1: public_base_url points at this server through your own reverse proxy / tunnel.
// Mode 2: cloudflared is installed → a free Quick Tunnel is opened only while a publish runs (no account needed).
const leases = new Map(); // token -> { path, expires }
let tunnel = null; // { proc, url, refs, closeTimer }
export function publicUrlMode() {
  const base = getSetting('public_base_url') || '';
  if (base && !/localhost|127\.0\.0\.1/.test(base)) return { mode: 'public_base_url', base };
  const bin = getSetting('cloudflared_path') || 'cloudflared';
  return { mode: 'cloudflared', available: hasBinary(bin), bin };
}
function hasBinary(bin) {
  if (bin.includes('/')) return fs.existsSync(bin);
  return (process.env.PATH || '').split(':').some(d => d && fs.existsSync(path.join(d, bin)));
}
export function servePublic(token) {
  const l = leases.get(token);
  if (!l || l.expires < Date.now()) return null;
  return l.path;
}
async function openTunnel(log) {
  if (tunnel?.url) { tunnel.refs++; clearTimeout(tunnel.closeTimer); return tunnel.url; }
  const bin = getSetting('cloudflared_path') || 'cloudflared';
  if (!hasBinary(bin)) throw new Error("Instagram needs a public URL for the file. Install cloudflared (brew install cloudflared — free, no account) or set public_base_url in Settings to a reverse proxy that reaches this server.");
  const port = process.env.PORT || getSetting('port', 4949);
  const proc = spawn(bin, ['tunnel', '--url', `http://127.0.0.1:${port}`, '--no-autoupdate'], { stdio: ['ignore', 'pipe', 'pipe'] });
  tunnel = { proc, url: null, refs: 1, closeTimer: null };
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('cloudflared did not report a tunnel URL within 40s')), 40_000);
    const onData = d => { const m = String(d).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/); if (m) { clearTimeout(timer); resolve(m[0]); } };
    proc.stdout.on('data', onData); proc.stderr.on('data', onData);
    proc.on('exit', code => { clearTimeout(timer); reject(new Error(`cloudflared exited with code ${code}`)); });
  }).catch(e => { try { proc.kill(); } catch {} tunnel = null; throw e; });
  tunnel.url = url;
  proc.on('exit', () => { if (tunnel?.proc === proc) tunnel = null; });
  log(`temporary public tunnel ${url} (closes 60s after the publish)`);
  // Give the edge a moment to route the new hostname.
  await new Promise(r => setTimeout(r, 2500));
  return url;
}
function releaseTunnel() {
  if (!tunnel) return;
  tunnel.refs = Math.max(0, tunnel.refs - 1);
  if (tunnel.refs === 0) {
    clearTimeout(tunnel.closeTimer);
    tunnel.closeTimer = setTimeout(() => { try { tunnel?.proc.kill(); } catch {} tunnel = null; }, 60_000);
  }
}
export async function publicLease(files, log) {
  const mode = publicUrlMode();
  const base = mode.mode === 'public_base_url' ? mode.base.replace(/\/$/, '') : await openTunnel(log);
  const tokens = files.map(f => { const t = crypto.randomBytes(18).toString('hex'); leases.set(t, { path: f, expires: Date.now() + 60 * 60 * 1000 }); return t; });
  return {
    urls: tokens.map((t, i) => `${base}/public/media/${t}${path.extname(files[i]).toLowerCase()}`),
    release: () => { tokens.forEach(t => leases.delete(t)); if (mode.mode !== 'public_base_url') releaseTunnel(); },
  };
}
export function tunnelActive() { return !!tunnel?.url; }

export function status() {
  return { youtube: youtubeStatus(), instagram: instagramStatus(), jobs: listJobs({ limit: 10 }), day: today() };
}
