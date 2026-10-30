// Owner analytics (YouTube Analytics API) plus local computations over synced videos.
import { db } from '../db.js';
import { analyticsQuery, dateRange } from '../youtube/analytics.js';
import { hydrateVideo } from './channels.js';
import { median, pct } from './stats.js';

export async function overview(channelId, days = 28) {
  const { startDate, endDate } = dateRange(days);
  const prev = dateRange(days * 2);
  const metrics = 'views,estimatedMinutesWatched,averageViewDuration,averageViewPercentage,subscribersGained,subscribersLost,likes,comments,shares';
  const [cur, daily, prevTot] = await Promise.all([
    analyticsQuery(channelId, { startDate, endDate, metrics }),
    analyticsQuery(channelId, { startDate, endDate, metrics: 'views,estimatedMinutesWatched,subscribersGained,subscribersLost', dimensions: 'day', sort: 'day' }),
    analyticsQuery(channelId, { startDate: prev.startDate, endDate: new Date(new Date(startDate).getTime() - 86400000).toISOString().slice(0, 10), metrics }),
  ]);
  const c = cur.rows[0] || {}, p = prevTot.rows[0] || {};
  const delta = {};
  for (const k of Object.keys(c)) delta[k] = p[k] ? (c[k] - p[k]) / p[k] : null;
  return { period: { startDate, endDate, days }, totals: c, previous: p, delta, daily: daily.rows, source: 'YouTube Analytics API (owner-authorized)' };
}

export async function revenue(channelId, days = 28) {
  const { startDate, endDate } = dateRange(days);
  try {
    const r = await analyticsQuery(channelId, { startDate, endDate, metrics: 'estimatedRevenue,estimatedAdRevenue,cpm,playbackBasedCpm,monetizedPlaybacks,views', dimensions: 'day', sort: 'day' });
    const tot = r.rows.reduce((a, x) => ({ revenue: a.revenue + (x.estimatedRevenue || 0), views: a.views + (x.views || 0), monetized: a.monetized + (x.monetizedPlaybacks || 0) }), { revenue: 0, views: 0, monetized: 0 });
    return { available: true, daily: r.rows, totals: { ...tot, rpm: tot.views ? (tot.revenue / tot.views) * 1000 : null }, source: 'YouTube Analytics API (monetary scope)' };
  } catch (e) {
    return { available: false, reason: e.message, daily: [], totals: null };
  }
}

export async function topVideos(channelId, days = 28, limit = 50) {
  const { startDate, endDate } = dateRange(days);
  const r = await analyticsQuery(channelId, { startDate, endDate, metrics: 'views,estimatedMinutesWatched,averageViewDuration,averageViewPercentage,likes,comments,subscribersGained', dimensions: 'video', sort: '-views', maxResults: limit });
  const titles = db.prepare('SELECT id, title, thumbnail, is_short, published_at FROM videos WHERE channel_id = ?').all(channelId);
  const map = Object.fromEntries(titles.map(t => [t.id, t]));
  return r.rows.map(x => ({ ...x, ...(map[x.video] || {}) }));
}

export async function retention(channelId, videoId) {
  const v = db.prepare('SELECT published_at FROM videos WHERE id = ?').get(videoId);
  const startDate = (v?.published_at || '2010-01-01').slice(0, 10);
  const endDate = dateRange(1).endDate;
  const r = await analyticsQuery(channelId, { startDate, endDate, metrics: 'audienceWatchRatio,relativeRetentionPerformance', dimensions: 'elapsedVideoTimeRatio', filters: `video==${videoId}`, ttl: 24 * 3600 });
  const curve = r.rows;
  // Hook analysis: how much of the audience is left at 10% / 30% / 50% of the video
  const at = f => { let best = null; for (const x of curve) if (!best || Math.abs(x.elapsedVideoTimeRatio - f) < Math.abs(best.elapsedVideoTimeRatio - f)) best = x; return best && Math.abs(best.elapsedVideoTimeRatio - f) <= 0.03 ? best.audienceWatchRatio : null; };
  const drops = [];
  for (let i = 1; i < curve.length; i++) {
    const d = (curve[i - 1].audienceWatchRatio || 0) - (curve[i].audienceWatchRatio || 0);
    if (d > 0.04) drops.push({ at: curve[i].elapsedVideoTimeRatio, drop: d });
  }
  return { videoId, curve, checkpoints: { p10: at(0.1), p30: at(0.3), p50: at(0.5), p90: at(0.9) }, biggestDrops: drops.sort((a, b) => b.drop - a.drop).slice(0, 5) };
}

export async function trafficSources(channelId, days = 28) {
  const { startDate, endDate } = dateRange(days);
  const [types, search, suggested, external] = await Promise.all([
    analyticsQuery(channelId, { startDate, endDate, metrics: 'views,estimatedMinutesWatched', dimensions: 'insightTrafficSourceType', sort: '-views' }),
    analyticsQuery(channelId, { startDate, endDate, metrics: 'views', dimensions: 'insightTrafficSourceDetail', filters: 'insightTrafficSourceType==YT_SEARCH', sort: '-views', maxResults: 25 }).catch(() => ({ rows: [] })),
    analyticsQuery(channelId, { startDate, endDate, metrics: 'views', dimensions: 'insightTrafficSourceDetail', filters: 'insightTrafficSourceType==RELATED_VIDEO', sort: '-views', maxResults: 25 }).catch(() => ({ rows: [] })),
    analyticsQuery(channelId, { startDate, endDate, metrics: 'views', dimensions: 'insightTrafficSourceDetail', filters: 'insightTrafficSourceType==EXT_URL', sort: '-views', maxResults: 25 }).catch(() => ({ rows: [] })),
  ]);
  const total = types.rows.reduce((a, x) => a + x.views, 0) || 1;
  return {
    period: { startDate, endDate },
    types: types.rows.map(x => ({ ...x, share: x.views / total })),
    searchTerms: search.rows,
    suggestedFrom: suggested.rows,
    externalSites: external.rows,
  };
}

export async function geography(channelId, days = 28) {
  const { startDate, endDate } = dateRange(days);
  const r = await analyticsQuery(channelId, { startDate, endDate, metrics: 'views,estimatedMinutesWatched,averageViewDuration', dimensions: 'country', sort: '-views', maxResults: 50 });
  const total = r.rows.reduce((a, x) => a + x.views, 0) || 1;
  return { period: { startDate, endDate }, rows: r.rows.map(x => ({ ...x, share: x.views / total })) };
}

export async function demographics(channelId, days = 28) {
  const { startDate, endDate } = dateRange(days);
  const r = await analyticsQuery(channelId, { startDate, endDate, metrics: 'viewerPercentage', dimensions: 'ageGroup,gender' });
  return { period: { startDate, endDate }, rows: r.rows };
}

export async function devices(channelId, days = 28) {
  const { startDate, endDate } = dateRange(days);
  const r = await analyticsQuery(channelId, { startDate, endDate, metrics: 'views', dimensions: 'deviceType', sort: '-views' });
  return r.rows;
}

export async function subscribers(channelId, days = 90) {
  const { startDate, endDate } = dateRange(days);
  const [daily, byVideo] = await Promise.all([
    analyticsQuery(channelId, { startDate, endDate, metrics: 'subscribersGained,subscribersLost', dimensions: 'day', sort: 'day' }),
    analyticsQuery(channelId, { startDate, endDate, metrics: 'subscribersGained,subscribersLost,views', dimensions: 'video', sort: '-subscribersGained', maxResults: 25 }),
  ]);
  const titles = Object.fromEntries(db.prepare('SELECT id, title FROM videos WHERE channel_id = ?').all(channelId).map(t => [t.id, t.title]));
  return { daily: daily.rows, byVideo: byVideo.rows.map(x => ({ ...x, title: titles[x.video] || x.video, net: x.subscribersGained - x.subscribersLost })) };
}

export async function watchHours(channelId, days = 365) {
  const { startDate, endDate } = dateRange(days);
  const r = await analyticsQuery(channelId, { startDate, endDate, metrics: 'estimatedMinutesWatched,views', dimensions: 'day', sort: 'day' });
  const total = r.rows.reduce((a, x) => a + x.estimatedMinutesWatched, 0) / 60;
  const ch = db.prepare('SELECT subscriber_count FROM channels WHERE id = ?').get(channelId);
  return {
    period: { startDate, endDate },
    publicWatchHours: total,
    subscribers: ch?.subscriber_count || 0,
    ypp: { watchHoursNeeded: 4000, subsNeeded: 1000, watchHoursPct: Math.min(1, total / 4000), subsPct: Math.min(1, (ch?.subscriber_count || 0) / 1000) },
    daily: r.rows,
    note: 'YPP long-form threshold is 4,000 public watch hours in the trailing 365 days + 1,000 subscribers; the Shorts path (10M views / 90 days) is tracked under Content breakdown. Watch hours here include all public videos; YouTube excludes Shorts watch time for YPP.',
  };
}

export async function contentTypeBreakdown(channelId, days = 28) {
  const { startDate, endDate } = dateRange(days);
  const r = await analyticsQuery(channelId, { startDate, endDate, metrics: 'views,estimatedMinutesWatched', dimensions: 'creatorContentType' }).catch(() => ({ rows: [] }));
  const local = db.prepare(`SELECT is_short, is_live, COUNT(*) AS n, SUM(view_count) AS views FROM videos WHERE channel_id = ? GROUP BY is_short, is_live`).all(channelId);
  return { analytics: r.rows, library: local.map(x => ({ type: x.is_live ? 'live' : x.is_short ? 'shorts' : 'long', count: x.n, views: x.views })) };
}

/** Publish-slot performance from local library (no Analytics hour dimension exists). Labeled heuristic. */
export function publishSlots(channelId) {
  const vids = db.prepare(`SELECT published_at, view_count, is_short FROM videos WHERE channel_id = ? AND published_at IS NOT NULL AND is_live = 0`).all(channelId);
  const now = Date.now();
  const scored = vids.map(v => {
    const ageDays = Math.max(1, (now - new Date(v.published_at).getTime()) / 86400000);
    const d = new Date(v.published_at);
    return { dow: d.getUTCDay(), hour: d.getUTCHours(), vpd: v.view_count / Math.min(ageDays, 90), is_short: !!v.is_short };
  });
  const grid = {};
  for (const s of scored) {
    const k = `${s.dow}-${s.hour}`;
    (grid[k] ||= { dow: s.dow, hour: s.hour, n: 0, vals: [] });
    grid[k].n++; grid[k].vals.push(s.vpd);
  }
  const all = scored.map(s => s.vpd);
  const base = median(all) || 1;
  const cells = Object.values(grid).map(c => ({ dow: c.dow, hourUTC: c.hour, n: c.n, medianVpd: median(c.vals), index: median(c.vals) / base }));
  const byDow = [0, 1, 2, 3, 4, 5, 6].map(d => {
    const vals = scored.filter(s => s.dow === d).map(s => s.vpd);
    return { dow: d, n: vals.length, medianVpd: median(vals), index: vals.length ? median(vals) / base : null };
  });
  return {
    method: 'Median views-per-day (capped at 90 days of age) for videos grouped by UTC publish weekday/hour, indexed to the channel median. This measures how your own uploads performed by slot; it is not when your audience is online (that is only in YouTube Studio).',
    sampleSize: scored.length, cells: cells.sort((a, b) => b.index - a.index), byWeekday: byDow,
  };
}

/** Compare a new upload's first-N-days views to the channel's matched-age historical median. */
export function uploadAgeComparison(channelId, videoId) {
  const target = db.prepare('SELECT * FROM videos WHERE id = ?').get(videoId);
  if (!target) return null;
  const ageDays = Math.max(1, Math.floor((Date.now() - new Date(target.published_at).getTime()) / 86400000));
  // Peers: same format, published > ageDays ago; use the snapshot nearest to the same age if we have it, else views/ageDays scaled.
  const peers = db.prepare(`SELECT id, title, view_count, published_at FROM videos WHERE channel_id = ? AND id != ? AND is_short = ? AND published_at < ? ORDER BY published_at DESC LIMIT 30`)
    .all(channelId, videoId, target.is_short, target.published_at);
  const snapAt = db.prepare(`SELECT views FROM snapshots WHERE entity_type='video' AND entity_id = ? AND day <= date(?, '+' || ? || ' days') ORDER BY day DESC LIMIT 1`);
  const peerVals = peers.map(p => {
    const s = snapAt.get(p.id, p.published_at.slice(0, 10), ageDays);
    const peerAge = Math.max(1, (Date.now() - new Date(p.published_at).getTime()) / 86400000);
    return { id: p.id, title: p.title, viewsAtAge: s ? s.views : Math.round(p.view_count * Math.min(1, ageDays / peerAge)), estimated: !s };
  });
  const med = median(peerVals.map(p => p.viewsAtAge));
  return {
    video: hydrateVideo(target), ageDays, viewsNow: target.view_count, peerMedianAtSameAge: med,
    index: med ? target.view_count / med : null, percentile: pct(peerVals.map(p => p.viewsAtAge), target.view_count), peers: peerVals,
    note: 'Peers without a stored snapshot at matching age are linearly estimated from current views; snapshots accumulate daily once the scheduler runs.',
  };
}

/** Segment library by performance vs channel median for retrospective review. */
export function performanceSegments(channelId) {
  const vids = db.prepare('SELECT * FROM videos WHERE channel_id = ? AND is_live = 0').all(channelId).map(hydrateVideo);
  const groups = { long: vids.filter(v => !v.is_short), shorts: vids.filter(v => v.is_short) };
  const out = {};
  for (const [k, list] of Object.entries(groups)) {
    const med = median(list.map(v => v.view_count)) || 1;
    out[k] = {
      median: med,
      breakout: list.filter(v => v.view_count >= 3 * med).sort((a, b) => b.view_count - a.view_count),
      above: list.filter(v => v.view_count >= 1.3 * med && v.view_count < 3 * med),
      typical: list.filter(v => v.view_count >= 0.5 * med && v.view_count < 1.3 * med).length,
      under: list.filter(v => v.view_count < 0.5 * med).sort((a, b) => a.view_count - b.view_count),
    };
  }
  return out;
}
