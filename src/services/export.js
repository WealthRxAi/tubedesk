// Read-only channel audit export: identity, full synced catalogue, channel + per-video Analytics for the latest N completed
// days and the preceding N days, traffic (incl. advertising), retention where available, Studio-import impressions/CTR if
// present. Every dataset carries its source, exact dates and freshness; anything unavailable is null with a reason.
import fs from 'node:fs';
import path from 'node:path';
import { db, DATA_DIR } from '../db.js';
import { analyticsQuery, dateRange } from '../youtube/analytics.js';
import { getChannel, isAuthorized } from './channels.js';
import { studioData } from './misc.js';
import { retention } from './analytics.js';

const PER_VIDEO_METRICS = 'views,estimatedMinutesWatched,averageViewDuration,averageViewPercentage,likes,comments,shares,subscribersGained';
const CHANNEL_METRICS = 'views,estimatedMinutesWatched,averageViewDuration,averageViewPercentage,subscribersGained,subscribersLost,likes,comments,shares';

function shiftDays(iso, n) { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
const nullWith = reason => ({ value: null, reason });

export async function channelAudit(channelId, { days = 28, retentionLimit = 60, log = () => {} } = {}) {
  const ch = getChannel(channelId);
  if (!ch) throw new Error('channel not in TubeDesk');
  const authorized = isAuthorized(channelId);
  const now = new Date().toISOString();
  const cur = dateRange(days);
  const prev = { startDate: shiftDays(cur.startDate, -days), endDate: shiftDays(cur.startDate, -1) };
  const windows = { current: cur, previous: prev };
  const out = {
    schema: 'tubedesk.channel-audit/1',
    generated_at: now,
    generator: { app: 'TubeDesk', version: '1.1.0', mode: 'read-only; no credentials included' },
    channel: {
      id: ch.id, title: ch.title, handle: ch.handle, url: `https://www.youtube.com/${ch.handle || 'channel/' + ch.id}`, country: ch.country,
      published_at: ch.published_at, subscriber_count: ch.subscriber_count, view_count: ch.view_count, video_count: ch.video_count,
      uploads_playlist: ch.uploads_playlist, google_connected: authorized, oauth_email: ch.oauth_email || null,
      identity_source: 'YouTube Data API v3 channels.list (synced into TubeDesk)', identity_last_synced: ch.last_synced,
    },
    reporting_windows: {
      note: 'YouTube Analytics lags ~2-3 days; windows end 3 days before export so every day is complete.',
      current: { ...cur, days }, previous: { ...prev, days },
    },
    catalogue: null, channel_performance: null, per_video: null, traffic: null, retention: null, impressions_ctr: null, transcripts: null, revenue: null,
    unavailable: [],
  };

  // 1. Catalogue from the synced library (public Data API fields).
  const vids = db.prepare('SELECT * FROM videos WHERE channel_id = ? ORDER BY published_at DESC').all(channelId);
  out.catalogue = {
    source: 'YouTube Data API v3 videos.list via TubeDesk sync', retrieved_at: vids.length ? vids.reduce((a, v) => a > v.fetched_at ? a : v.fetched_at, '') : null,
    count: vids.length, note: ch.video_count && vids.length < ch.video_count ? `Channel reports ${ch.video_count} public videos; ${vids.length} synced (sync depth setting).` : null,
    videos: vids.map(v => ({
      id: v.id, title: v.title, url: `https://www.youtube.com/watch?v=${v.id}`, published_at: v.published_at, duration_sec: v.duration_sec,
      format: v.is_live ? 'live' : v.is_short ? 'short' : 'long', privacy_status: v.privacy_status || 'public', category_id: v.category_id,
      description: v.description || '', tags: JSON.parse(v.tags_json || '[]'), thumbnail: v.thumbnail,
      lifetime_public: { views: v.view_count, likes: v.like_count, comments: v.comment_count, as_of: v.fetched_at },
    })),
  };
  const byId = Object.fromEntries(vids.map(v => [v.id, v]));

  if (!authorized) {
    out.unavailable.push({ dataset: 'analytics', reason: 'Channel is not Google-connected in TubeDesk; the YouTube Analytics API needs owner OAuth.' });
    out.channel_performance = nullWith('no owner OAuth'); out.per_video = nullWith('no owner OAuth'); out.traffic = nullWith('no owner OAuth'); out.retention = nullWith('no owner OAuth');
  } else {
    const src = 'YouTube Analytics API v2 (owner-authorized, ids=channel==MINE)';
    // 2. Channel totals, split by content type, both windows.
    out.channel_performance = { source: src, retrieved_at: now, windows: {} };
    for (const [name, w] of Object.entries(windows)) {
      const [tot, byType, daily] = await Promise.all([
        analyticsQuery(channelId, { ...w, metrics: CHANNEL_METRICS, ttl: 1800 }),
        analyticsQuery(channelId, { ...w, metrics: 'views,estimatedMinutesWatched,averageViewDuration,averageViewPercentage,likes,comments', dimensions: 'creatorContentType', ttl: 1800 }).catch(e => ({ rows: [], error: e.message })),
        analyticsQuery(channelId, { ...w, metrics: 'views,estimatedMinutesWatched,subscribersGained,subscribersLost', dimensions: 'day', sort: 'day', ttl: 1800 }),
      ]);
      out.channel_performance.windows[name] = {
        ...w, totals: tot.rows[0] || null,
        by_content_type: byType.rows.length ? byType.rows : nullWith(byType.error || 'creatorContentType returned no rows for this window'),
        daily: daily.rows,
      };
      log(`channel ${name} window done`);
    }
    // 3. Per-video, both windows (video dimension, up to 200 rows), tagged with format from the library.
    out.per_video = { source: src, retrieved_at: now, note: 'Analytics rows exist only for videos with activity in the window; others are listed with null metrics.', windows: {} };
    const advByVideo = {};
    for (const [name, w] of Object.entries(windows)) {
      const [rows, adv] = await Promise.all([
        analyticsQuery(channelId, { ...w, metrics: PER_VIDEO_METRICS, dimensions: 'video', sort: '-views', maxResults: 200, ttl: 1800 }),
        analyticsQuery(channelId, { ...w, metrics: 'views', dimensions: 'video', filters: 'insightTrafficSourceType==ADVERTISING', sort: '-views', maxResults: 200, ttl: 1800 }).catch(e => ({ rows: [], error: e.message })),
      ]);
      advByVideo[name] = Object.fromEntries(adv.rows.map(r => [r.video, r.views]));
      const map = Object.fromEntries(rows.rows.map(r => [r.video, r]));
      const list = vids.map(v => {
        const r = map[v.id];
        return {
          id: v.id, title: v.title, format: v.is_live ? 'live' : v.is_short ? 'short' : 'long', published_at: v.published_at,
          views: r ? r.views : null, watch_time_minutes: r ? r.estimatedMinutesWatched : null, average_view_duration_sec: r ? r.averageViewDuration : null,
          average_view_percentage: r ? r.averageViewPercentage : null, likes: r ? r.likes : null, comments: r ? r.comments : null, shares: r ? r.shares : null, subscribers_gained: r ? r.subscribersGained : null,
          advertising_views: adv.error ? null : (advByVideo[name][v.id] || 0),
          impressions: null, thumbnail_ctr: null,
          no_data_reason: r ? null : 'no Analytics activity in this window',
        };
      });
      // Analytics rows for videos not in the synced library (older than sync depth, or deleted/private)
      const extra = rows.rows.filter(r => !byId[r.video]).map(r => ({ id: r.video, title: null, format: 'unknown (not in synced library)', views: r.views, watch_time_minutes: r.estimatedMinutesWatched, average_view_duration_sec: r.averageViewDuration, average_view_percentage: r.averageViewPercentage, likes: r.likes, comments: r.comments, shares: r.shares, subscribers_gained: r.subscribersGained, advertising_views: adv.error ? null : (advByVideo[name][r.video] || 0), impressions: null, thumbnail_ctr: null }));
      const sum = (arr, k) => arr.reduce((a, x) => a + (x[k] || 0), 0);
      out.per_video.windows[name] = {
        ...w, videos: list, videos_not_in_library: extra,
        advertising_note: adv.error ? `advertising split unavailable: ${adv.error}` : 'advertising_views = views whose insightTrafficSourceType is ADVERTISING (paid promotion).',
        totals_by_format: {
          long: { videos_with_data: list.filter(x => x.format === 'long' && x.views !== null).length, views: sum(list.filter(x => x.format === 'long'), 'views'), watch_time_minutes: sum(list.filter(x => x.format === 'long'), 'watch_time_minutes'), advertising_views: sum(list.filter(x => x.format === 'long'), 'advertising_views') },
          short: { videos_with_data: list.filter(x => x.format === 'short' && x.views !== null).length, views: sum(list.filter(x => x.format === 'short'), 'views'), watch_time_minutes: sum(list.filter(x => x.format === 'short'), 'watch_time_minutes'), advertising_views: sum(list.filter(x => x.format === 'short'), 'advertising_views') },
        },
      };
      log(`per-video ${name} window done`);
    }
    // 4. Traffic sources per window (channel level), advertising called out.
    out.traffic = { source: src, retrieved_at: now, windows: {} };
    for (const [name, w] of Object.entries(windows)) {
      const [types, search, suggested] = await Promise.all([
        analyticsQuery(channelId, { ...w, metrics: 'views,estimatedMinutesWatched', dimensions: 'insightTrafficSourceType', sort: '-views', ttl: 1800 }),
        analyticsQuery(channelId, { ...w, metrics: 'views', dimensions: 'insightTrafficSourceDetail', filters: 'insightTrafficSourceType==YT_SEARCH', sort: '-views', maxResults: 25, ttl: 1800 }).catch(() => ({ rows: [] })),
        analyticsQuery(channelId, { ...w, metrics: 'views', dimensions: 'insightTrafficSourceDetail', filters: 'insightTrafficSourceType==RELATED_VIDEO', sort: '-views', maxResults: 25, ttl: 1800 }).catch(() => ({ rows: [] })),
      ]);
      const total = types.rows.reduce((a, x) => a + x.views, 0);
      const adv = types.rows.find(x => x.insightTrafficSourceType === 'ADVERTISING');
      out.traffic.windows[name] = { ...w, total_views: total, by_source: types.rows.map(x => ({ ...x, share: total ? x.views / total : null })), advertising: { views: adv ? adv.views : 0, share: adv && total ? adv.views / total : 0 }, top_search_terms: search.rows, top_suggested_from: suggested.rows };
    }
    // 5. Retention (audienceWatchRatio) for videos active in either window, newest first, capped.
    const active = vids.filter(v => ['current', 'previous'].some(n => out.per_video.windows[n].videos.find(x => x.id === v.id && x.views)));
    const targets = active.slice(0, retentionLimit);
    out.retention = { source: src + ' — audienceWatchRatio by elapsedVideoTimeRatio, lifetime since publish', retrieved_at: now, covered: targets.length, skipped: Math.max(0, active.length - targets.length), skipped_reason: active.length > targets.length ? `capped at ${retentionLimit} videos per export` : null, videos: {} };
    for (const v of targets) {
      try {
        const r = await retention(channelId, v.id);
        out.retention.videos[v.id] = r.curve.length ? { checkpoints: r.checkpoints, biggest_drops: r.biggestDrops, curve: r.curve } : nullWith('YouTube returned no retention rows (too few views)');
      } catch (e) { out.retention.videos[v.id] = nullWith(e.message); }
    }
    log('retention done');
    // 6. Revenue (monetary scope), both windows.
    out.revenue = { source: 'YouTube Analytics API (yt-analytics-monetary.readonly)', retrieved_at: now, windows: {} };
    for (const [name, w] of Object.entries(windows)) {
      try {
        const r = await analyticsQuery(channelId, { ...w, metrics: 'estimatedRevenue,estimatedAdRevenue,monetizedPlaybacks,views', ttl: 1800 });
        out.revenue.windows[name] = { ...w, totals: r.rows[0] || null };
      } catch (e) { out.revenue.windows[name] = { ...w, totals: null, reason: e.message }; }
    }
  }
  // 7. Impressions / CTR: not exposed by the Analytics API; only via a Studio CSV import.
  const studio = studioData(channelId);
  out.impressions_ctr = studio.rows.length
    ? { source: 'YouTube Studio CSV import (manual)', imported_at: studio.rows[0].imported_at, period_label: studio.rows[0].period_label || null, rows: studio.rows.map(r => ({ video_id: r.video_id, title: r.video_title, impressions: r.impressions, ctr: r.ctr, avg_view_duration_sec: r.avg_view_duration_sec, avg_view_pct: r.avg_view_pct, views: r.views, watch_hours: r.watch_hours })) }
    : nullWith('Impressions and thumbnail CTR are not available from the YouTube Analytics API; TubeDesk only has them after a YouTube Studio CSV import, and none has been imported for this channel.');
  // 8. Transcripts: TubeDesk does not store them; fetching costs ~250 Data API units per video.
  out.transcripts = nullWith('TubeDesk does not store transcripts or content summaries. Owner captions can be fetched on demand (captions.list + captions.download ≈ 250 quota units per video), which was not done for this export.');
  return out;
}

export function saveAudit(audit, filename) {
  const dir = path.join(DATA_DIR, 'exports'); fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, filename.replace(/[^\w.-]/g, '_'));
  fs.writeFileSync(file, JSON.stringify(audit, null, 2));
  return file;
}
