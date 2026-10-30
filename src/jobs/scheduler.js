// Daily jobs: snapshot every channel + video (history charts, growth, forecasts),
// refresh competitors (upload feed, breakout alerts, packaging-change history).
import cron from 'node-cron';
import { db, getSetting, today } from '../db.js';
import { listChannels, refreshChannel, syncVideos } from '../services/channels.js';
import { refreshAll, addAlert } from '../services/competitors.js';

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
  return task;
}
