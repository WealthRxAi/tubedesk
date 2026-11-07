// One board for every channel you own (+ Instagram): growth this week vs last, the latest upload's pace, CTR,
// monetization progress, open alerts, autopilot activity, today's top idea and queued Shorts. A weekly summary
// of the same goes to your phone every Monday morning.
import { db, getSetting } from '../db.js';
import { listChannels } from './channels.js';
import { isAuthorized } from '../youtube/oauth.js';
import { watchHours } from './analytics.js';
import { channelSummary } from './reach.js';
import { currentModel } from './radar.js';
import { notify } from './notify.js';
import './clips.js'; import './autopilot.js'; import './ideas.js'; // their tables are read here

const DAY = 86400000;
const dayStr = ms => new Date(ms).toISOString().slice(0, 10);

/** Value of a snapshot metric on (or nearest before) a day. */
function snapAt(type, id, day, field = 'views') {
  return db.prepare(`SELECT ${field} AS v, day FROM snapshots WHERE entity_type = ? AND entity_id = ? AND day <= ? ORDER BY day DESC LIMIT 1`).get(type, id, day) || null;
}
/** Change in a channel metric over the last `days` and the `days` before that (from daily snapshots). */
export function deltas(channelId, days = 7, field = 'views') {
  const now = Date.now();
  const cur = snapAt('channel', channelId, dayStr(now), field);
  const mid = snapAt('channel', channelId, dayStr(now - days * DAY), field);
  const old = snapAt('channel', channelId, dayStr(now - 2 * days * DAY), field);
  const last = cur && mid && cur.day !== mid.day ? cur.v - mid.v : null;
  const prev = mid && old && mid.day !== old.day ? mid.v - old.v : null;
  return { last, prev, change: last !== null && prev ? (last - prev) / prev : null };
}

/** Uploads that gained the most views in the last `days` (snapshot deltas; new uploads count from zero). */
export function topGainers(channelId, days = 7, limit = 3) {
  const since = dayStr(Date.now() - days * DAY);
  return db.prepare('SELECT id, title, view_count, published_at, is_short FROM videos WHERE channel_id = ? AND is_live = 0').all(channelId).map(v => {
    const base = snapAt('video', v.id, since);
    const gained = v.published_at >= since ? v.view_count : base ? v.view_count - base.v : null;
    return { ...v, gained };
  }).filter(v => v.gained !== null && v.gained > 0).sort((a, b) => b.gained - a.gained).slice(0, limit);
}

async function ypp(channelId) {
  if (!isAuthorized(channelId)) return null;
  try { const w = await watchHours(channelId, 365); return { watchHours: Math.round(w.publicWatchHours), watchHoursPct: w.ypp.watchHoursPct, subs: w.subscribers, subsPct: w.ypp.subsPct }; }
  catch { return null; }
}

export async function channelCard(ch) {
  const id = ch.id;
  const views = deltas(id, 7, 'views'), subs = deltas(id, 7, 'subs');
  const latest = db.prepare('SELECT id, title, thumbnail, published_at, is_short FROM videos WHERE channel_id = ? AND is_live = 0 ORDER BY published_at DESC LIMIT 1').get(id) || null;
  const w = latest ? db.prepare('SELECT idx, status, confidence, ctr, ctr_vs_channel FROM radar_watch WHERE video_id = ?').get(latest.id) : null;
  const reach = channelSummary(id, { days: 28 });
  const ap = db.prepare("SELECT status, COUNT(*) AS n FROM autopilot_actions WHERE channel_id = ? AND created_at >= datetime('now', '-7 days') GROUP BY status").all(id);
  const idea = db.prepare("SELECT best_title, score, predicted_x FROM radar_ideas WHERE channel_id = ? AND status != 'dismissed' ORDER BY day DESC, rank LIMIT 1").get(id) || null;
  const model = currentModel(id);
  const clipsQueued = db.prepare("SELECT COUNT(*) AS n FROM clips WHERE channel_id = ? AND status IN ('queued', 'scheduled')").get(id).n;
  const clipsPublished7 = db.prepare("SELECT COUNT(*) AS n FROM clips WHERE channel_id = ? AND status = 'published' AND publish_at >= ?").get(id, new Date(Date.now() - 7 * DAY).toISOString()).n;
  return {
    id, title: ch.title, thumbnail: ch.thumbnail, handle: ch.handle, authorized: !!ch.authorized,
    subscribers: ch.subscriber_count, totalViews: ch.view_count, videoCount: ch.video_count,
    views7: views.last, views7Prev: views.prev, views7Change: views.change, subs7: subs.last,
    uploads30: db.prepare("SELECT COUNT(*) AS n FROM videos WHERE channel_id = ? AND published_at >= ?").get(id, new Date(Date.now() - 30 * DAY).toISOString()).n,
    latest: latest && { ...latest, pace: w?.idx ?? null, status: w?.status ?? null, confidence: w?.confidence ?? null, ctr: w?.ctr ?? null, ctrVsUsual: w?.ctr_vs_channel ?? null },
    ctr28: reach.totals.ctr, impressions28: reach.totals.impressions, ctrStatus: reach.status,
    ypp: await ypp(id),
    alertsOpen: db.prepare('SELECT COUNT(*) AS n FROM alerts WHERE channel_id = ? AND read = 0').get(id).n,
    autopilot7: Object.fromEntries(ap.map(a => [a.status, a.n])),
    topIdea: idea, radar: { calibrated: model.calibrated, verdict: model.metrics?.holdout?.verdict || null },
    shorts: { queued: clipsQueued, published7: clipsPublished7 },
    topGainers: topGainers(id, 7, 3),
  };
}

function instagramCard() {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'ig_media'").get() || !getSetting('ig_user_id')) return null;
  const since = new Date(Date.now() - 7 * DAY).toISOString();
  const recent = db.prepare("SELECT * FROM ig_media WHERE published_at >= ? AND (product_type = 'REELS' OR media_type = 'VIDEO') ORDER BY views DESC").all(since);
  const w = db.prepare("SELECT idx, status FROM radar_watch WHERE kind = 'instagram' ORDER BY published_at DESC LIMIT 1").get() || null;
  return { username: getSetting('ig_username') || null, reels7: recent.length, views7: recent.reduce((a, r) => a + (r.views || 0), 0), best: recent[0] ? { caption: String(recent[0].caption || '').split('\n')[0].slice(0, 80), views: recent[0].views, permalink: recent[0].permalink } : null, latestPace: w?.idx ?? null, latestStatus: w?.status ?? null };
}

export async function overview() {
  const channels = [];
  for (const ch of listChannels('owned')) channels.push(await channelCard(ch));
  const sum = k => channels.reduce((a, c) => a + (c[k] || 0), 0);
  return { generatedAt: new Date().toISOString(), totals: { subscribers: sum('subscribers'), views7: channels.some(c => c.views7 !== null) ? sum('views7') : null, subs7: channels.some(c => c.subs7 !== null) ? sum('subs7') : null, alertsOpen: sum('alertsOpen') }, channels, instagram: instagramCard() };
}

const n = x => x === null || x === undefined ? '—' : Math.round(x).toLocaleString('en-US');
const pctChange = c => c === null || c === undefined ? '' : ` (${c >= 0 ? '+' : ''}${Math.round(c * 100)}% vs last week)`;

/** Plain-text weekly summary (also sent to the phone). */
export async function weeklySummary({ send = true } = {}) {
  const o = await overview();
  const lines = [];
  for (const c of o.channels) {
    const parts = [`${c.title}: ${n(c.views7)} views${pctChange(c.views7Change)}, ${c.subs7 === null ? '—' : (c.subs7 >= 0 ? '+' : '') + n(c.subs7)} subs`];
    if (c.topGainers[0]) parts.push(`best: "${c.topGainers[0].title.slice(0, 60)}" +${n(c.topGainers[0].gained)}`);
    if (c.ctr28 !== null && c.ctr28 !== undefined) parts.push(`CTR ${c.ctr28.toFixed(1)}%`);
    if (c.ypp) parts.push(`YPP ${Math.round(c.ypp.watchHoursPct * 100)}% watch hrs / ${Math.round(c.ypp.subsPct * 100)}% subs`);
    const apN = (c.autopilot7.applied || 0) + (c.autopilot7.kept || 0) + (c.autopilot7.reverted || 0);
    if (apN) parts.push(`autopilot ${apN} change${apN > 1 ? 's' : ''}`);
    if (c.shorts.published7) parts.push(`${c.shorts.published7} Shorts posted`);
    if (c.alertsOpen) parts.push(`${c.alertsOpen} open alert${c.alertsOpen > 1 ? 's' : ''}`);
    lines.push('• ' + parts.join(' · '));
  }
  if (o.instagram) lines.push(`• Instagram${o.instagram.username ? ' @' + o.instagram.username : ''}: ${o.instagram.reels7} reels, ${n(o.instagram.views7)} views${o.instagram.best ? ` · best: "${o.instagram.best.caption}" ${n(o.instagram.best.views)}` : ''}`);
  const text = lines.join('\n') || 'No owned channels yet.';
  let sent = null;
  if (send) sent = await notify({ kind: 'weekly_summary', title: 'TubeDesk weekly summary', body: text });
  return { text, sent, overview: o };
}
