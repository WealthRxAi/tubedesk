// Daily jobs: snapshot every channel + video (history charts, growth, forecasts),
// refresh competitors (upload feed, breakout alerts, packaging-change history).
import cron from 'node-cron';
import { db, getSetting, setSetting, today } from '../db.js';
import { listChannels, refreshChannel, syncVideos } from '../services/channels.js';
import { refreshAll, addAlert } from '../services/competitors.js';
import { watchTick, calibrate, buildCorpus } from '../services/radar.js';
import * as reach from '../services/reach.js';
import * as ideas from '../services/ideas.js';
import * as clips from '../services/clips.js';
import * as portfolio from '../services/portfolio.js';
import * as igwatch from '../services/igwatch.js';
import * as social from '../services/social.js';
import { aiAvailable } from '../services/radar.js';

let running = null;
export function runDailySnapshot(opts = {}) {
  if (running) return running;
  running = runDailySnapshotInner(opts).finally(() => { running = null; });
  return running;
}
async function runDailySnapshotInner({ log = console.log } = {}) {
  const started = Date.now();
  const summary = { channels: 0, videos: 0, alerts: 0, errors: [] };
  for (const ch of listChannels('owned')) {
    try {
      await refreshChannel(ch.id, { force: true });
      const r = await syncVideos(ch.id, { maxVideos: Number(getSetting('sync_depth_owned', 500)), force: true });
      summary.channels++; summary.videos += r.synced;
      if (r.metadataChanges) addAlert(ch.id, 'own_metadata_change', `${r.metadataChanges} metadata change(s) recorded on ${ch.title}`, {});
      const c = await refreshAll(ch.id, { maxVideos: Number(getSetting('sync_depth_competitor', 50)) });
      summary.alerts += c.alerts.length;
    } catch (e) { summary.errors.push(`${ch.title}: ${e.message}`); log('[snapshot]', ch.title, e.message); }
  }
  // Competitors not linked to any owned channel (added standalone) still get a daily snapshot.
  for (const ch of listChannels('competitor')) {
    const linked = db.prepare('SELECT 1 FROM competitor_links WHERE competitor_channel_id = ?').get(ch.id);
    if (linked) continue;
    try { await refreshChannel(ch.id, { force: true }); summary.channels++; } catch (e) { summary.errors.push(`${ch.title}: ${e.message}`); }
  }
  db.prepare("INSERT INTO settings(key, value) VALUES ('last_snapshot', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify({ day: today(), at: new Date().toISOString(), ms: Date.now() - started, ...summary }));
  log(`[snapshot] done in ${Date.now() - started}ms`, summary);
  return summary;
}

export function startScheduler() {
  const expr = getSetting('snapshot_cron', '15 6 * * *'); // 06:15 local every day
  const tz = getSetting('timezone', Intl.DateTimeFormat().resolvedOptions().timeZone);
  if (!cron.validate(expr)) { console.warn('[scheduler] invalid cron expression', expr); return null; }
  const task = cron.schedule(expr, () => runDailySnapshot().catch(e => console.error('[snapshot]', e)), { timezone: tz });
  console.log(`[scheduler] daily snapshot at "${expr}" (${tz})`);
  // Catch up if the app was off at the scheduled time today.
  const last = getSetting('last_snapshot');
  const lastDay = last ? JSON.parse(last).day : null;
  if (lastDay !== today() && listChannels().length) setTimeout(() => runDailySnapshot().catch(() => {}), 20_000);
  startRadar(tz);
  startAutopilotJobs(tz);
  return task;
}

// Daily: pull impressions + CTR from the Reporting API, then build the morning idea list and send the top 3.
export function startAutopilotJobs(tz) {
  const reachExpr = getSetting('reach_cron', '25 7 * * *');
  const ideasExpr = getSetting('ideas_cron', '50 6 * * *');
  if (cron.validate(reachExpr)) cron.schedule(reachExpr, async () => {
    await reach.syncAll().then(r => console.log('[reach]', r)).catch(e => console.error('[reach]', e.message));
    if (igwatch.configured()) await igwatch.syncMedia({ limit: 25 }).catch(e => console.error('[instagram]', e.message)); // baseline for the reel radar
    if (igwatch.configured()) await social.syncAllAccounts().catch(e => console.error('[instagram accounts]', e.message)); // tracked accounts → outliers + follower history
    if (social.tiktokStatus().connected) await social.tiktokSyncVideos().catch(e => console.error('[tiktok]', e.message));
  }, { timezone: tz });
  // Publish queue (scheduled Shorts / Instagram posts) every 5 minutes; weekly summary Monday morning.
  cron.schedule('*/5 * * * *', () => clips.processQueue().catch(e => console.error('[queue]', e.message)), { timezone: tz });
  const weeklyExpr = getSetting('weekly_summary_cron', '10 8 * * 1');
  if (cron.validate(weeklyExpr)) cron.schedule(weeklyExpr, () => portfolio.weeklySummary().catch(e => console.error('[weekly]', e.message)), { timezone: tz });
  if (cron.validate(ideasExpr) && getSetting('ideas_enabled', '1') === '1') cron.schedule(ideasExpr, () => runIdeas().catch(e => console.error('[ideas]', e.message)), { timezone: tz });
  console.log(`[scheduler] reach sync "${reachExpr}", daily ideas "${ideasExpr}" (${tz})`);
  if (listChannels('owned').length) setTimeout(() => reach.syncAll().catch(() => {}), 60_000);
  // Catch up on today's ideas if the app was off at the scheduled time.
  setTimeout(() => { if (getSetting('ideas_last_day') !== today() && new Date().getHours() >= 7) runIdeas().catch(() => {}); }, 90_000);
}
export async function runIdeas() {
  if (getSetting('ideas_enabled', '1') !== '1' || !aiAvailable() || !listChannels('owned').length) return [];
  const r = await ideas.runAll();
  setSetting('ideas_last_day', today());
  console.log('[ideas]', r);
  return r;
}

// Virality radar: hourly launch-curve watch of new uploads (≈2 quota units per channel per hour) and a weekly
// recalibration per owned channel (AI features are cached, so only new videos cost an AI call).
export function startRadar(tz) {
  if (getSetting('radar_enabled', '1') !== '1') { console.log('[scheduler] radar disabled'); return; }
  const watchExpr = getSetting('radar_watch_cron', '7 * * * *');
  const calExpr = getSetting('radar_calibrate_cron', '40 6 * * 0');
  if (cron.validate(watchExpr)) cron.schedule(watchExpr, () => watchTick({ log: console.log }).catch(e => console.error('[radar watch]', e.message)), { timezone: tz });
  if (cron.validate(calExpr)) cron.schedule(calExpr, () => runWeeklyCalibration().catch(e => console.error('[radar calibrate]', e.message)), { timezone: tz });
  console.log(`[scheduler] radar watch "${watchExpr}", calibration "${calExpr}" (${tz})`);
  if (listChannels('owned').length) setTimeout(() => watchTick({ log: console.log }).catch(() => {}), 45_000);
}
export async function runWeeklyCalibration() {
  const out = [];
  for (const ch of listChannels('owned')) {
    if (buildCorpus(ch.id).filter(r => r.y !== null).length < 12) { out.push({ channel: ch.title, skipped: 'not enough history' }); continue; }
    try { const m = await calibrate(ch.id, { useAI: getSetting('radar_calibrate_ai', '1') === '1' }); out.push({ channel: ch.title, model: m.id, verdict: m.metrics?.holdout?.verdict }); }
    catch (e) { out.push({ channel: ch.title, error: e.message }); }
  }
  console.log('[radar] weekly calibration', out);
  return out;
}
