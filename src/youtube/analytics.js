// YouTube Analytics API v2 (owner-authorized only). Separate quota from the Data API.
import crypto from 'node:crypto';
import { getAccessToken } from './oauth.js';
import { cacheGet, cacheSet, logApi, YouTubeError } from './client.js';

const BASE = process.env.YT_ANALYTICS_BASE || 'https://youtubeanalytics.googleapis.com/v2/reports';

export async function analyticsQuery(channelId, { startDate, endDate, metrics, dimensions, filters, sort, maxResults, ttl = 3 * 3600 }) {
  const params = { ids: 'channel==MINE', startDate, endDate, metrics, dimensions, filters, sort, maxResults };
  const key = 'ya:' + crypto.createHash('sha1').update(channelId + JSON.stringify(params)).digest('hex');
  const hit = cacheGet(key);
  if (hit) { logApi({ api: 'analytics', endpoint: 'reports.query', units: 0, cached: 1 }); return hit; }
  const url = new URL(BASE);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  const t0 = Date.now();
  const res = await fetch(url, { headers: { Authorization: `Bearer ${await getAccessToken(channelId)}` } });
  const body = await res.json().catch(() => ({}));
  const ms = Date.now() - t0;
  if (!res.ok) {
    logApi({ api: 'analytics', endpoint: 'reports.query', units: 0, cached: 0, ms, ok: 0 });
    throw new YouTubeError(body?.error?.message || `Analytics API error ${res.status}`, { status: res.status, reason: body?.error?.status, endpoint: 'analytics' });
  }
  logApi({ api: 'analytics', endpoint: 'reports.query', units: 0, cached: 0, ms });
  const out = toObjects(body);
  cacheSet(key, out, ttl);
  return out;
}

function toObjects(body) {
  const cols = (body.columnHeaders || []).map(c => c.name);
  const rows = (body.rows || []).map(r => Object.fromEntries(r.map((v, i) => [cols[i], v])));
  return { columns: cols, rows };
}

export function dateRange(days) {
  const end = new Date(); end.setUTCDate(end.getUTCDate() - 3); // Analytics lags ~2-3 days
  const start = new Date(end); start.setUTCDate(start.getUTCDate() - days + 1);
  return { startDate: start.toISOString().slice(0, 10), endDate: end.toISOString().slice(0, 10) };
}
