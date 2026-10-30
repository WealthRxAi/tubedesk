// YouTube Data API v3 client with transparent caching and a quota ledger.
// Every call is logged to api_log so the Settings page can show real quota use.
import crypto from 'node:crypto';
import { db, getSetting, today } from '../db.js';
import { getAccessToken } from './oauth.js';

const BASE = process.env.YT_API_BASE || 'https://www.googleapis.com/youtube/v3';
const SUGGEST_URL = process.env.YT_SUGGEST_URL || 'https://suggestqueries.google.com/complete/search';

// Published quota costs (units) for the endpoints this app uses.
export const COST = {
  'channels.list': 1,
  'videos.list': 1,
  'playlistItems.list': 1,
  'playlists.list': 1,
  'playlists.insert': 50,
  'playlistItems.insert': 50,
  'search.list': 100,
  'commentThreads.list': 1,
  'comments.list': 1,
  'comments.insert': 50,
  'videos.update': 50,
  'captions.list': 50,
  'captions.download': 200,
  'videoCategories.list': 1,
  'i18nRegions.list': 1,
  'thumbnails.set': 50,
};

export class YouTubeError extends Error {
  constructor(message, { status, reason, endpoint } = {}) {
    super(message);
    this.name = 'YouTubeError';
    this.status = status;
    this.reason = reason;
    this.endpoint = endpoint;
  }
}

export const DEFAULT_TTL = {
  channel: 6 * 3600,        // channel stats
  videoStats: 3 * 3600,     // video stats
  uploads: 3600,            // playlist items
  search: 24 * 3600,        // search.list is expensive: cache a full day
  trending: 3 * 3600,
  comments: 1800,
  categories: 7 * 24 * 3600,
};

function cacheKey(endpoint, params, scope) {
  const h = crypto.createHash('sha1').update(endpoint + JSON.stringify(params) + '|' + (scope || '')).digest('hex');
  return `yt:${endpoint}:${h}`;
}

export function cacheGet(key) {
  const row = db.prepare('SELECT value, expires_at FROM api_cache WHERE key = ?').get(key);
  if (!row) return null;
  if (row.expires_at < Date.now()) {
    db.prepare('DELETE FROM api_cache WHERE key = ?').run(key);
    return null;
  }
  return JSON.parse(row.value);
}
export function cacheSet(key, value, ttlSec) {
  db.prepare('INSERT INTO api_cache(key, value, expires_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at')
    .run(key, JSON.stringify(value), Date.now() + ttlSec * 1000);
}
export function cacheClear(prefix = '') {
  if (!prefix) return db.prepare('DELETE FROM api_cache').run().changes;
  return db.prepare('DELETE FROM api_cache WHERE key LIKE ?').run(prefix + '%').changes;
}

export function logApi({ api, endpoint, units, cached, ms, ok = 1 }) {
  db.prepare('INSERT INTO api_log(day, api, endpoint, units, cached, ms, ok) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(today(), api, endpoint, units, cached ? 1 : 0, ms || 0, ok ? 1 : 0);
}

export function quotaToday() {
  const row = db.prepare("SELECT COALESCE(SUM(units),0) AS units, COUNT(*) AS calls, SUM(cached) AS cached FROM api_log WHERE day = ? AND api = 'data'").get(today());
  const limit = Number(getSetting('yt_quota_limit', 10000));
  return { day: today(), units: row.units, calls: row.calls, cached: row.cached || 0, limit, remaining: Math.max(0, limit - row.units) };
}

export function quotaHistory(days = 14) {
  return db.prepare(`SELECT day, SUM(units) AS units, COUNT(*) AS calls, SUM(cached) AS cached
    FROM api_log WHERE api = 'data' GROUP BY day ORDER BY day DESC LIMIT ?`).all(days);
}

function assertQuota(units) {
  const q = quotaToday();
  const reserve = Number(getSetting('yt_quota_reserve', 500));
  if (q.units + units > q.limit - reserve) {
    throw new YouTubeError(`Daily YouTube API quota guard: ${q.units}/${q.limit} units used today; this call needs ${units}. Resets at midnight Pacific. Raise the limit in Settings if your project has a higher quota.`, { status: 429, reason: 'quotaGuard' });
  }
}

/**
 * ytGet('videos.list', {part:'snippet', id:'...'}, {ttl, channelId})
 *  - endpoint is "resource.method"; GET requests use the resource path.
 *  - channelId: when set, the request is authorized with that owned channel's OAuth token
 *    (required for mine=true, analytics, and private data). Otherwise the API key is used.
 */
export async function ytGet(endpoint, params = {}, { ttl = 3600, channelId = null, noCache = false } = {}) {
  const [resource] = endpoint.split('.');
  const units = COST[endpoint] ?? 1;
  const key = cacheKey(endpoint, params, channelId);
  if (!noCache) {
    const hit = cacheGet(key);
    if (hit) { logApi({ api: 'data', endpoint, units: 0, cached: 1 }); return hit; }
  }
  assertQuota(units);
  const url = new URL(`${BASE}/${resource}`);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  const headers = { Accept: 'application/json' };
  if (channelId) {
    headers.Authorization = `Bearer ${await getAccessToken(channelId)}`;
  } else {
    const apiKey = getSetting('yt_api_key');
    if (!apiKey) throw new YouTubeError('No YouTube Data API key configured. Add one in Settings.', { status: 401, reason: 'noApiKey' });
    url.searchParams.set('key', apiKey);
  }
  const t0 = Date.now();
  const res = await fetch(url, { headers });
  const ms = Date.now() - t0;
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    logApi({ api: 'data', endpoint, units, cached: 0, ms, ok: 0 });
    const reason = body?.error?.errors?.[0]?.reason || body?.error?.status || 'error';
    throw new YouTubeError(body?.error?.message || `YouTube API error ${res.status}`, { status: res.status, reason, endpoint });
  }
  logApi({ api: 'data', endpoint, units, cached: 0, ms });
  if (ttl > 0) cacheSet(key, body, ttl);
  return body;
}

/** Authenticated write (POST/PUT) on behalf of an owned channel. Never cached. */
export async function ytWrite(endpoint, { method = 'POST', params = {}, json = null, channelId, rawBody = null, contentType = null }) {
  if (!channelId) throw new YouTubeError('Write operations need an owned, authorized channel.', { status: 401 });
  const [resource] = endpoint.split('.');
  const units = COST[endpoint] ?? 50;
  assertQuota(units);
  const url = new URL(`${BASE}/${resource}`);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  const headers = { Authorization: `Bearer ${await getAccessToken(channelId)}`, Accept: 'application/json' };
  let body;
  if (rawBody) { headers['Content-Type'] = contentType || 'application/octet-stream'; body = rawBody; }
  else if (json) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(json); }
  const t0 = Date.now();
  const res = await fetch(url, { method, headers, body });
  const ms = Date.now() - t0;
  const out = await res.json().catch(() => ({}));
  if (!res.ok) {
    logApi({ api: 'data', endpoint, units, cached: 0, ms, ok: 0 });
    throw new YouTubeError(out?.error?.message || `YouTube API error ${res.status}`, { status: res.status, reason: out?.error?.errors?.[0]?.reason, endpoint });
  }
  logApi({ api: 'data', endpoint, units, cached: 0, ms });
  return out;
}

/** Google's public suggest endpoint (YouTube autocomplete). Free, no quota, no key. */
export async function suggest(query, { country = 'US', lang = 'en' } = {}) {
  const key = cacheKey('suggest', { query, country, lang });
  const hit = cacheGet(key);
  if (hit) return hit;
  const url = new URL(SUGGEST_URL);
  url.searchParams.set('client', 'firefox');
  url.searchParams.set('ds', 'yt');
  url.searchParams.set('gl', country);
  url.searchParams.set('hl', lang);
  url.searchParams.set('q', query);
  const t0 = Date.now();
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const text = await res.text();
    const parsed = JSON.parse(text);
    const list = Array.isArray(parsed?.[1]) ? parsed[1].map(x => Array.isArray(x) ? x[0] : x).filter(Boolean) : [];
    logApi({ api: 'suggest', endpoint: 'suggest', units: 0, cached: 0, ms: Date.now() - t0 });
    cacheSet(key, list, 24 * 3600);
    return list;
  } catch (e) {
    logApi({ api: 'suggest', endpoint: 'suggest', units: 0, cached: 0, ms: Date.now() - t0, ok: 0 });
    return [];
  }
}

// ---------- helpers ----------
export function parseDuration(iso) {
  if (!iso) return 0;
  const m = /P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(iso);
  if (!m) return 0;
  const [, d, h, mi, s] = m.map(x => Number(x || 0));
  return d * 86400 + h * 3600 + mi * 60 + s;
}

export function isShort(durationSec, title = '', description = '') {
  // YouTube Shorts: vertical video up to 3 minutes. The API does not expose aspect ratio, so
  // the rule is: ≤ 180 s, or the #shorts marker in the title/description.
  if (/#shorts?\b/i.test(title) || /#shorts?\b/i.test(description)) return true;
  return durationSec > 0 && durationSec <= 180;
}

export function bestThumb(thumbs) {
  if (!thumbs) return null;
  return (thumbs.maxres || thumbs.standard || thumbs.high || thumbs.medium || thumbs.default)?.url || null;
}

export function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}
