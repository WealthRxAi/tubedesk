// Thumbnail impressions + impressions CTR, pulled automatically from the YouTube Reporting API's daily "reach"
// bulk reports (channel_reach_basic_a1, available since 15 Jan 2026). Free: the Reporting API does not use Data API
// quota. Needs the channel connected with Google (yt-analytics.readonly). The first reports appear about two days
// after TubeDesk schedules the job; each report covers one day and YouTube keeps them for a limited time, so
// TubeDesk stores every row locally.
import { db, getSetting, setSetting } from '../db.js';
import { getAccessToken, isAuthorized } from '../youtube/oauth.js';
import { listChannels } from './channels.js';
import { parseCsv } from './misc.js';
import { median } from './stats.js';

const BASE = () => process.env.YT_REPORTING_BASE || 'https://youtubereporting.googleapis.com/v1';
export const REPORT_TYPE = 'channel_reach_basic_a1';

db.exec(`
CREATE TABLE IF NOT EXISTS reach_daily (
  channel_id TEXT NOT NULL,
  video_id TEXT NOT NULL,
  day TEXT NOT NULL,             -- YYYY-MM-DD
  impressions INTEGER NOT NULL,
  ctr REAL,                      -- percent (e.g. 4.8)
  PRIMARY KEY (video_id, day)
);
CREATE INDEX IF NOT EXISTS idx_reach_channel_day ON reach_daily(channel_id, day);
CREATE TABLE IF NOT EXISTS reach_reports (
  report_id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  start_time TEXT,
  rows INTEGER,
  ingested_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

function state(channelId) { try { return JSON.parse(getSetting(`reach_state_${channelId}`) || '{}'); } catch { return {}; } }
function saveState(channelId, s) { setSetting(`reach_state_${channelId}`, JSON.stringify(s)); }

async function call(channelId, pathOrUrl, { method = 'GET', json } = {}) {
  const token = await getAccessToken(channelId);
  const url = /^https?:/.test(pathOrUrl) ? pathOrUrl : BASE() + pathOrUrl;
  const res = await fetch(url, { method, signal: AbortSignal.timeout(60_000), headers: { Authorization: `Bearer ${token}`, ...(json ? { 'content-type': 'application/json' } : {}) }, body: json ? JSON.stringify(json) : undefined });
  const text = await res.text();
  if (!res.ok) {
    let msg = text.slice(0, 300);
    try { msg = JSON.parse(text).error?.message || msg; } catch { /* not json */ }
    if (res.status === 403 && /disabled|not been used/i.test(msg)) msg += ' — enable "YouTube Reporting API" for your Google Cloud project (same project as the OAuth client; free).';
    throw Object.assign(new Error(`Reporting API ${res.status}: ${msg}`), { status: res.status });
  }
  return text;
}

export async function ensureJob(channelId) {
  const st = state(channelId);
  if (st.jobId) return st.jobId;
  const jobs = JSON.parse(await call(channelId, '/jobs')).jobs || [];
  let job = jobs.find(j => j.reportTypeId === REPORT_TYPE);
  if (!job) job = JSON.parse(await call(channelId, '/jobs', { method: 'POST', json: { reportTypeId: REPORT_TYPE, name: 'TubeDesk reach (impressions + CTR)' } }));
  saveState(channelId, { ...st, jobId: job.id, jobCreated: job.createTime || new Date().toISOString() });
  return job.id;
}

/** Parse one reach report CSV into per-video-per-day totals (other dimensions are summed; CTR impression-weighted). */
export function parseReachCsv(text) {
  const rows = parseCsv(text);
  if (rows.length < 2) return [];
  const h = rows[0].map(x => x.trim().toLowerCase());
  const iDate = h.indexOf('date'), iVid = h.indexOf('video_id'), iImp = h.indexOf('video_thumbnail_impressions'), iCtr = h.indexOf('video_thumbnail_impressions_ctr');
  if (iVid < 0 || iImp < 0) throw new Error('Unexpected reach report columns: ' + h.join(','));
  const raw = rows.slice(1).filter(r => r[iVid]).map(r => ({ day: String(r[iDate] || '').replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3'), vid: r[iVid], imp: Number(r[iImp]) || 0, ctr: iCtr >= 0 && r[iCtr] !== '' ? Number(r[iCtr]) : null }));
  // The API documents CTR as a percentage; if a whole report only holds values ≤ 1 they are fractions.
  const ctrs = raw.map(r => r.ctr).filter(v => Number.isFinite(v));
  const scale = ctrs.length && Math.max(...ctrs) <= 1 ? 100 : 1;
  const agg = new Map();
  for (const r of raw) {
    const k = r.vid + '|' + r.day;
    const a = agg.get(k) || { video_id: r.vid, day: r.day, impressions: 0, clicks: 0, ctrImp: 0 };
    a.impressions += r.imp;
    if (Number.isFinite(r.ctr)) { a.clicks += r.imp * r.ctr * scale / 100; a.ctrImp += r.imp; }
    agg.set(k, a);
  }
  return [...agg.values()].map(a => ({ video_id: a.video_id, day: a.day, impressions: a.impressions, ctr: a.ctrImp ? (a.clicks / a.ctrImp) * 100 : null }));
}

export async function syncChannel(channelId) {
  if (!isAuthorized(channelId)) return { channelId, skipped: 'not connected with Google' };
  const st = state(channelId);
  try {
    const jobId = await ensureJob(channelId);
    const seen = new Set(db.prepare('SELECT report_id FROM reach_reports WHERE channel_id = ?').all(channelId).map(r => r.report_id));
    let pageToken = null, fresh = [];
    do {
      const q = new URLSearchParams(pageToken ? { pageToken } : {});
      const page = JSON.parse(await call(channelId, `/jobs/${encodeURIComponent(jobId)}/reports${q.size ? '?' + q : ''}`));
      fresh.push(...(page.reports || []).filter(r => !seen.has(r.id)));
      pageToken = page.nextPageToken || null;
    } while (pageToken);
    fresh.sort((a, b) => String(a.startTime).localeCompare(String(b.startTime)));
    const up = db.prepare(`INSERT INTO reach_daily (channel_id, video_id, day, impressions, ctr) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(video_id, day) DO UPDATE SET impressions = excluded.impressions, ctr = excluded.ctr, channel_id = excluded.channel_id`);
    let rows = 0;
    for (const rep of fresh) {
      const parsed = parseReachCsv(await call(channelId, rep.downloadUrl));
      const fallbackDay = String(rep.startTime || '').slice(0, 10);
      db.transaction(() => {
        for (const r of parsed) up.run(channelId, r.video_id, r.day || fallbackDay, r.impressions, r.ctr);
        db.prepare('INSERT OR IGNORE INTO reach_reports (report_id, channel_id, start_time, rows) VALUES (?, ?, ?, ?)').run(rep.id, channelId, rep.startTime || null, parsed.length);
      })();
      rows += parsed.length;
    }
    saveState(channelId, { ...state(channelId), lastSync: new Date().toISOString(), lastError: null, reportsIngested: seen.size + fresh.length });
    return { channelId, jobId, newReports: fresh.length, rows };
  } catch (e) {
    saveState(channelId, { ...st, ...state(channelId), lastSync: new Date().toISOString(), lastError: e.message });
    return { channelId, error: e.message };
  }
}

export async function syncAll() {
  const out = [];
  for (const ch of listChannels('owned')) out.push(await syncChannel(ch.id));
  return out;
}

/** Impression-weighted CTR + impressions for a video over its first `days` days (or all days when null). */
export function videoReach(videoId, { days = null } = {}) {
  const v = db.prepare('SELECT published_at FROM videos WHERE id = ?').get(videoId);
  let rows = db.prepare('SELECT day, impressions, ctr FROM reach_daily WHERE video_id = ? ORDER BY day').all(videoId);
  if (days && v?.published_at) {
    const last = new Date(Date.parse(v.published_at) + days * 86400000).toISOString().slice(0, 10);
    rows = rows.filter(r => r.day <= last);
  }
  if (!rows.length) return null;
  const imp = rows.reduce((a, r) => a + r.impressions, 0);
  const wi = rows.filter(r => r.ctr !== null).reduce((a, r) => a + r.impressions, 0);
  const ctr = wi ? rows.filter(r => r.ctr !== null).reduce((a, r) => a + r.ctr * r.impressions, 0) / wi : null;
  return { impressions: imp, ctr, days: rows.length, firstDay: rows[0].day, lastDay: rows.at(-1).day };
}

/** The channel's typical CTR/impressions over the first `days` days of earlier uploads (median across videos). */
export function channelBaseline(channelId, { days = 3, excludeId = null, isShort = null } = {}) {
  const vids = db.prepare(`SELECT DISTINCT r.video_id FROM reach_daily r JOIN videos v ON v.id = r.video_id
    WHERE r.channel_id = ? AND r.video_id != ? ${isShort === null ? '' : 'AND v.is_short = ' + (isShort ? 1 : 0)}`).all(channelId, excludeId || '');
  const per = vids.map(x => videoReach(x.video_id, { days })).filter(r => r && r.ctr !== null && r.impressions >= 50);
  if (per.length < 3) return null;
  return { ctr: median(per.map(r => r.ctr)), impressions: median(per.map(r => r.impressions)), n: per.length, days };
}

/** Everything the Analytics → Impressions & CTR tab needs. */
export function channelSummary(channelId, { days = 28 } = {}) {
  const st = state(channelId);
  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  const daily = db.prepare(`SELECT day, SUM(impressions) AS impressions, SUM(impressions * COALESCE(ctr, 0)) / NULLIF(SUM(CASE WHEN ctr IS NULL THEN 0 ELSE impressions END), 0) AS ctr
    FROM reach_daily WHERE channel_id = ? AND day >= ? GROUP BY day ORDER BY day`).all(channelId, since);
  const videos = db.prepare(`SELECT r.video_id, v.title, v.thumbnail, v.published_at, v.is_short, v.view_count, SUM(r.impressions) AS impressions,
      SUM(r.impressions * COALESCE(r.ctr, 0)) / NULLIF(SUM(CASE WHEN r.ctr IS NULL THEN 0 ELSE r.impressions END), 0) AS ctr
    FROM reach_daily r LEFT JOIN videos v ON v.id = r.video_id WHERE r.channel_id = ? AND r.day >= ? GROUP BY r.video_id ORDER BY impressions DESC`).all(channelId, since);
  const totalImp = videos.reduce((a, v) => a + (v.impressions || 0), 0);
  const avgCtr = totalImp ? videos.reduce((a, v) => a + (v.ctr || 0) * (v.impressions || 0), 0) / totalImp : null;
  const latest = db.prepare('SELECT MAX(day) AS d FROM reach_daily WHERE channel_id = ?').get(channelId)?.d || null;
  let status = 'ok';
  if (!isAuthorized(channelId)) status = 'not-connected';
  else if (st.lastError) status = 'error';
  else if (!st.jobId) status = 'not-started';
  else if (!latest) status = 'waiting-for-first-report';
  return {
    status, jobId: st.jobId || null, jobCreated: st.jobCreated || null, lastSync: st.lastSync || null, lastError: st.lastError || null, latestDay: latest,
    days, totals: { impressions: totalImp, ctr: avgCtr }, daily, videos,
    lowCtrHighImpressions: avgCtr ? videos.filter(v => v.ctr !== null && v.ctr < avgCtr * 0.8 && v.impressions >= 500).slice(0, 15) : [],
    baseline: channelBaseline(channelId),
    source: `YouTube Reporting API · ${REPORT_TYPE} (daily bulk report, ~2-day delay)`,
  };
}
