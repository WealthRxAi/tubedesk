import { db } from '../db.js';
import { addChannel, getChannel, publicChannel, syncVideos, channelHistory, hydrateVideo, refreshChannel } from './channels.js';
import { median, mean, daysSince } from './stats.js';

export function listCompetitors(ownedId) {
  return db.prepare(`SELECT c.*, l.note, l.added_at AS linked_at FROM competitor_links l JOIN channels c ON c.id = l.competitor_channel_id WHERE l.owned_channel_id = ? ORDER BY c.subscriber_count DESC`).all(ownedId).map(publicChannel);
}

export async function addCompetitor(ownedId, input, note = '') {
  const c = await addChannel(input, 'competitor');
  if (c.id === ownedId) throw new Error('That is the owned channel itself.');
  db.prepare('INSERT OR IGNORE INTO competitor_links (owned_channel_id, competitor_channel_id, note) VALUES (?, ?, ?)').run(ownedId, c.id, note);
  // Seed library so comparisons/outliers work immediately (≤ 100 most recent videos: 4 units).
  await syncVideos(c.id, { maxVideos: 100 }).catch(() => {});
  return c;
}

export function removeCompetitor(ownedId, competitorId) {
  const changes = db.prepare('DELETE FROM competitor_links WHERE owned_channel_id = ? AND competitor_channel_id = ?').run(ownedId, competitorId).changes;
  const stillLinked = db.prepare('SELECT COUNT(*) AS n FROM competitor_links WHERE competitor_channel_id = ?').get(competitorId).n;
  const kind = db.prepare('SELECT kind FROM channels WHERE id = ?').get(competitorId)?.kind;
  if (!stillLinked && kind === 'competitor') db.prepare('DELETE FROM channels WHERE id = ?').run(competitorId);
  return changes;
}

function channelMetrics(id, days = 30) {
  const ch = db.prepare('SELECT * FROM channels WHERE id = ?').get(id);
  const vids = db.prepare('SELECT * FROM videos WHERE channel_id = ? AND is_live = 0').all(id).map(hydrateVideo);
  const recent = vids.filter(v => daysSince(v.published_at) <= days);
  const long = vids.filter(v => !v.is_short), shorts = vids.filter(v => v.is_short);
  const hist = channelHistory(id, days);
  const first = hist[0], last = hist[hist.length - 1];
  return {
    id, title: ch.title, thumbnail: ch.thumbnail, handle: ch.handle, kind: ch.kind,
    subscribers: ch.subscriber_count, totalViews: ch.view_count, totalVideos: ch.video_count, created: ch.published_at,
    viewsPerVideo: ch.video_count ? Math.round(ch.view_count / ch.video_count) : 0,
    uploadsLastN: recent.length, uploadsPerWeek: +(recent.length / (days / 7)).toFixed(2),
    medianViewsLong: median(long.map(v => v.view_count)), medianViewsShorts: median(shorts.map(v => v.view_count)),
    recentMedianViews: median(recent.map(v => v.view_count)),
    engagement: mean(vids.slice(0, 50).map(v => v.view_count ? (v.like_count + v.comment_count) / v.view_count : 0)),
    subsGrowthN: first && last && hist.length > 1 ? last.subs - first.subs : null,
    viewsGrowthN: first && last && hist.length > 1 ? last.views - first.views : null,
    snapshotDays: hist.length,
    librarySynced: vids.length,
  };
}

export function compare(ownedId, days = 30) {
  const ids = [ownedId, ...db.prepare('SELECT competitor_channel_id AS id FROM competitor_links WHERE owned_channel_id = ?').all(ownedId).map(r => r.id)];
  return { days, channels: ids.map(id => channelMetrics(id, days)), note: 'Growth columns need daily snapshots (scheduler); medians come from synced libraries, so sync depth matters.' };
}

export function uploadFeed(ownedId, { days = 14, limit = 100 } = {}) {
  return db.prepare(`SELECT v.*, c.title AS channel_title, c.thumbnail AS channel_thumbnail, c.subscriber_count AS channel_subs FROM videos v JOIN channels c ON c.id = v.channel_id
    WHERE v.channel_id IN (SELECT competitor_channel_id FROM competitor_links WHERE owned_channel_id = ?) AND v.published_at >= datetime('now', ?) ORDER BY v.published_at DESC LIMIT ?`)
    .all(ownedId, `-${days} days`, limit).map(hydrateVideo);
}

/** Refresh every competitor of an owned channel; emit alerts for new uploads and breakouts. */
export async function refreshAll(ownedId, { maxVideos = 50 } = {}) {
  const comps = listCompetitors(ownedId);
  const alerts = [];
  for (const c of comps) {
    const before = new Set(db.prepare('SELECT id FROM videos WHERE channel_id = ?').all(c.id).map(r => r.id));
    await refreshChannel(c.id, { force: true }).catch(() => {});
    const r = await syncVideos(c.id, { maxVideos, force: true }).catch(e => ({ error: e.message }));
    const after = db.prepare('SELECT * FROM videos WHERE channel_id = ? ORDER BY published_at DESC LIMIT 50').all(c.id).map(hydrateVideo);
    const newOnes = after.filter(v => !before.has(v.id) && daysSince(v.published_at) <= 7);
    for (const v of newOnes) alerts.push(addAlert(ownedId, 'new_upload', `${c.title} uploaded: ${v.title}`, { videoId: v.id, channelId: c.id }));
    const med = median(after.filter(v => !v.is_short).map(v => v.view_count)) || 0;
    for (const v of after.filter(v => daysSince(v.published_at) <= 14 && med && v.view_count >= 3 * med)) {
      const exists = db.prepare("SELECT 1 FROM alerts WHERE kind = 'breakout' AND payload_json LIKE ?").get(`%${v.id}%`);
      if (!exists) alerts.push(addAlert(ownedId, 'breakout', `${c.title}: "${v.title}" is at ${(v.view_count / med).toFixed(1)}× their median`, { videoId: v.id, channelId: c.id, x: v.view_count / med }));
    }
    if (r?.metadataChanges) alerts.push(addAlert(ownedId, 'metadata_change', `${c.title} changed packaging on ${r.metadataChanges} field(s)`, { channelId: c.id }));
  }
  return { refreshed: comps.length, alerts };
}

export function addAlert(channelId, kind, title, payload) {
  const r = db.prepare('INSERT INTO alerts (channel_id, kind, title, payload_json) VALUES (?, ?, ?, ?)').run(channelId, kind, title, JSON.stringify(payload || {}));
  return db.prepare('SELECT * FROM alerts WHERE id = ?').get(r.lastInsertRowid);
}
export function listAlerts(channelId, { unreadOnly = false, limit = 100 } = {}) {
  return db.prepare(`SELECT * FROM alerts WHERE (channel_id = ? OR channel_id IS NULL) ${unreadOnly ? 'AND read = 0' : ''} ORDER BY created_at DESC LIMIT ?`).all(channelId, limit).map(a => ({ ...a, payload: JSON.parse(a.payload_json || '{}') }));
}
export function markRead(id) { return db.prepare('UPDATE alerts SET read = 1 WHERE id = ?').run(id).changes; }
export function markAllRead(channelId) { return db.prepare('UPDATE alerts SET read = 1 WHERE channel_id = ?').run(channelId).changes; }

/** Public report card for any synced channel. */
export function reportCard(id) {
  const m = channelMetrics(id, 30);
  const hist = channelHistory(id, 365);
  const grades = [];
  const g = (name, value, bands, detail) => { let grade = 'C'; if (value >= bands[0]) grade = 'A'; else if (value >= bands[1]) grade = 'B'; grades.push({ name, grade, value, detail }); };
  g('Upload consistency (uploads/week, 30d)', m.uploadsPerWeek, [2, 0.75], `${m.uploadsLastN} uploads in 30 days`);
  g('Views per video vs subscribers', m.subscribers ? m.medianViewsLong / m.subscribers : 0, [0.3, 0.1], `median long-form views ÷ subscribers`);
  g('Engagement rate', m.engagement, [0.04, 0.015], 'likes+comments ÷ views (recent 50)');
  return { ...m, grades, history: hist, generated: new Date().toISOString(), disclaimer: 'Public counts only; YouTube rounds subscriber counts, so small daily deltas are noisy.' };
}

/** Scenario projection with explicit uncertainty, from the channel's own snapshot trend. */
export function forecast(id, { days = 90 } = {}) {
  const hist = channelHistory(id, 180);
  if (hist.length < 7) return { available: false, reason: `Need ≥ 7 daily snapshots (have ${hist.length}); the scheduler collects one per day.` };
  const n = hist.length;
  const dailySubs = (hist[n - 1].subs - hist[0].subs) / Math.max(1, n - 1);
  const dailyViews = (hist[n - 1].views - hist[0].views) / Math.max(1, n - 1);
  const recent = hist.slice(-14);
  const rSubs = (recent[recent.length - 1].subs - recent[0].subs) / Math.max(1, recent.length - 1);
  const rViews = (recent[recent.length - 1].views - recent[0].views) / Math.max(1, recent.length - 1);
  const scen = (rate, mult) => Math.round(rate * mult * days);
  const last = hist[n - 1];
  return {
    available: true, basedOnDays: n, horizonDays: days,
    scenarios: {
      low: { subs: last.subs + scen(Math.min(dailySubs, rSubs), 0.6), views: last.views + scen(Math.min(dailyViews, rViews), 0.6) },
      base: { subs: last.subs + scen((dailySubs + rSubs) / 2, 1), views: last.views + scen((dailyViews + rViews) / 2, 1) },
      high: { subs: last.subs + scen(Math.max(dailySubs, rSubs), 1.5), views: last.views + scen(Math.max(dailyViews, rViews), 1.5) },
    },
    note: 'Linear extrapolation of observed daily deltas (whole window vs last 14 days). YouTube growth is lumpy and driven by individual videos; treat these as ranges, not predictions.',
  };
}
