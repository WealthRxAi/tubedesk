// Daily jobs: snapshot every channel + video (history charts, growth, forecasts),
// refresh competitors (upload feed, breakout alerts, packaging-change history).
import cron from 'node-cron';
import * as jobs from '../services/jobs.js';
import * as backup from '../services/backup.js';
import * as health from '../services/health.js';
import * as updater from '../services/updater.js';
import * as research from '../services/research.js';
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
import * as pub from '../services/publish.js';
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
  // Snapshot errors per channel are collected, not thrown; a run where every channel failed counts as a failure
  // so the catch-up tick tries again (e.g. after the network or the quota comes back).
  const task = jobs.schedule('snapshot', expr, async () => { const r = await runDailySnapshot(); if (r.errors.length && !r.channels) throw new Error(r.errors.join('; ')); return r; }, { tz, label: 'Daily snapshot', runIfNeverRun: () => listChannels().length > 0 && (() => { try { return JSON.parse(getSetting('last_snapshot', '{}')).day !== today(); } catch { return true; } })() });
  console.log(`[scheduler] daily snapshot at "${expr}" (${tz})`);
  startRadar(tz);
  startAutopilotJobs(tz);
  startCareJobs(tz);
  startResearchJobs(tz);
  jobs.startCatchUp();
  return task;
}

// Research that grows every day: the outlier index (spare quota → searchable outliers, niches, formulas, thumbnails)
// and keyword rank checks. Run after the Pacific quota reset (≈3 am Eastern) and before the morning snapshot.
export function startResearchJobs(tz) {
  jobs.schedule('index', getSetting('index_cron', '0 5 * * *'), () => research.crawl({ log: console.log }), { tz, label: 'Outlier index' });
  jobs.schedule('ranks', getSetting('rank_cron', '40 5 * * *'), () => research.checkAllRanks(), { tz, label: 'Search rank check' });
  // find each upload's source file on this Mac (so Shorts can be cut from any video) + keep Threads tokens fresh
  jobs.schedule('sources', getSetting('sources_cron', '20 5 * * *'), async () => (await import('../services/workflow.js')).matchSources(null), { tz, label: 'Find source files' });
  jobs.schedule('social_tokens', getSetting('social_tokens_cron', '35 7 * * *'), async () => (await import('../services/social-publish.js')).refreshThreadsTokens(), { tz, label: 'Threads token refresh' });
}

// Keeping TubeDesk itself healthy: nightly backup + housekeeping, a morning check-up, and safe self-updates.
export function startCareJobs(tz) {
  jobs.schedule('backup', getSetting('backup_cron', '30 3 * * *'), async () => { const r = await backup.create(); backup.maintenance(); jobs.prune(); return r; }, { tz, label: 'Nightly backup' });
  jobs.schedule('doctor', getSetting('doctor_cron', '20 8 * * *'), () => health.doctor(), { tz, label: 'Morning check-up' });
  jobs.schedule('update', getSetting('update_cron', '10 4 * * *'), async () => {
    if (!updater.enabled()) return updater.check();
    const r = await updater.apply();
    console.log('[update]', r);
    if (r.busy) throw new Error('busy: uploads or renders are running — the update retries in 30 minutes'); // catch-up retries
    if (r.updated) await import('../services/notify.js').then(n => n.notify({ kind: 'health', force: true, title: `TubeDesk updated to v${r.version}`, body: r.changes?.slice(0, 5).join('\n') || '' })).catch(() => {});
    return r;
  }, { tz, label: 'Automatic update' });
}

// Daily: pull impressions + CTR from the Reporting API, then build the morning idea list and send the top 3.
export function startAutopilotJobs(tz) {
  const reachExpr = getSetting('reach_cron', '25 7 * * *');
  const ideasExpr = getSetting('ideas_cron', '50 6 * * *');
  jobs.schedule('reach', reachExpr, async () => {
    await reach.syncAll().then(r => console.log('[reach]', r)).catch(e => console.error('[reach]', e.message)); // the Reporting API keeps history: tomorrow's run fills any gap
    await pub.refreshInstagramToken({ all: true }).catch(e => console.error('[instagram token]', e.message)); // 60-day tokens: refresh every account monthly
    if (igwatch.configured()) await igwatch.syncMedia({ limit: 25, all: true }).catch(e => console.error('[instagram]', e.message)); // baseline for the reel radar
    if (igwatch.configured()) await social.syncAllAccounts().catch(e => console.error('[instagram accounts]', e.message)); // tracked accounts → outliers + follower history
    if (social.tiktokStatus().connected) await social.tiktokSyncVideos({ all: true }).catch(e => console.error('[tiktok]', e.message));
  }, { tz, label: 'CTR, Instagram and TikTok sync' });
  // Publish queue (scheduled Shorts / Instagram posts) every 5 minutes; weekly summary Monday morning.
  jobs.schedule('queue', '*/5 * * * *', () => clips.processQueue(), { tz, catchUp: false, label: 'Publishing queue' });
  jobs.schedule('weekly', getSetting('weekly_summary_cron', '10 8 * * 1'), () => portfolio.weeklySummary(), { tz, label: 'Weekly summary' });
  if (getSetting('ideas_enabled', '1') === '1') jobs.schedule('ideas', ideasExpr, () => runIdeas(), { tz, label: 'Daily ideas' });
  console.log(`[scheduler] reach sync "${reachExpr}", daily ideas "${ideasExpr}" (${tz})`);
  if (listChannels('owned').length) setTimeout(() => reach.syncAll().catch(() => {}), 60_000).unref?.();
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
  jobs.schedule('radar_watch', watchExpr, () => watchTick({ log: console.log }), { tz, catchUp: false, label: 'Radar live watch' });
  jobs.schedule('radar_calibrate', calExpr, () => runWeeklyCalibration(), { tz, label: 'Radar calibration' });
  console.log(`[scheduler] radar watch "${watchExpr}", calibration "${calExpr}" (${tz})`);
  if (listChannels('owned').length) setTimeout(() => jobs.runJob('radar_watch', 'start').catch(() => {}), 45_000).unref?.();
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
