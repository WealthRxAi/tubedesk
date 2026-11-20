// The doctor: one honest list of everything that could quietly stop TubeDesk from working, each with what to do.
// Runs on demand (Settings → Health, the `health` tool) and every morning; problems are texted once a day.
import fs from 'node:fs';
import { db, getSetting, setSetting, DATA_DIR } from '../db.js';
import { quotaToday } from '../youtube/client.js';
import * as jobs from './jobs.js';
import * as backup from './backup.js';
import * as updater from './updater.js';
import { toolStatus } from './render.js';
import { engineStatus } from './transcribe.js';
import { notify, channelsConfigured } from './notify.js';

const item = (id, level, title, detail = '', fix = null) => ({ id, level, ok: level === 'ok', title, detail, fix });
const days = iso => (Date.now() - Date.parse(iso)) / 86400000;

export async function check({ deep = false } = {}) {
  const items = [];
  // database
  try {
    const r = db.pragma(deep ? 'integrity_check' : 'quick_check', { simple: true });
    const bytes = fs.statSync(backup.dbFile).size;
    items.push(item('database', r === 'ok' ? 'ok' : 'error', 'Database', r === 'ok' ? `${(bytes / 1e6).toFixed(1)} MB, intact` : r, r === 'ok' ? null : 'Restore the latest backup (Settings → Health → Backups).'));
  } catch (e) { items.push(item('database', 'error', 'Database', e.message, 'Restore the latest backup.')); }
  // disk
  try {
    const s = fs.statfsSync(DATA_DIR); const free = s.bavail * s.bsize;
    items.push(item('disk', free < 0.5e9 ? 'error' : free < 2e9 ? 'warn' : 'ok', 'Disk space', `${(free / 1e9).toFixed(1)} GB free`, free < 2e9 ? 'Free up space: renders and Shorts need room (old renders live in data/renders).' : null));
  } catch { /* statfs unsupported */ }
  // backups
  const b = backup.latest();
  items.push(!b ? item('backups', 'warn', 'Backups', 'No backup yet — one is made every night.', null)
    : item('backups', days(b.at) > 2 ? 'warn' : 'ok', 'Backups', `last ${b.file} (${(b.bytes / 1e6).toFixed(1)} MB), ${backup.list().length} kept`, days(b.at) > 2 ? 'The nightly backup has not run for 2+ days — check the job list below.' : null));
  // YouTube quota
  const q = quotaToday();
  items.push(item('quota', q.exhausted ? 'warn' : q.units > q.limit * 0.9 ? 'warn' : 'ok', 'YouTube quota', `${q.units.toLocaleString()} / ${q.limit.toLocaleString()} units today${q.exhausted ? ' — used up' : ''}; resets in ${Math.ceil(q.resetsInMinutes / 60)} h`, q.exhausted ? 'Scheduled work waits for the reset automatically. If this happens often, lower sync depths or request more quota from Google.' : null));
  // YouTube sign-ins
  if (getSetting('yt_api_key', '')) items.push(item('api_key', 'ok', 'YouTube API key', 'set'));
  else items.push(item('api_key', 'error', 'YouTube API key', 'missing', 'Ask your AI to "set up TubeDesk", or paste a key in Settings.'));
  for (const ch of db.prepare("SELECT id, title, oauth_json FROM channels WHERE kind = 'owned'").all()) {
    const broken = getSetting(`oauth_broken_${ch.id}`, '');
    if (!ch.oauth_json) { items.push(item(`signin_${ch.id}`, 'warn', `${ch.title}: Google sign-in`, 'not connected — analytics, CTR, publishing and the autopilot are off for this channel', 'Channels → Connect with Google.')); continue; }
    if (broken) {
      const info = JSON.parse(broken);
      const testing = info.ageDays >= 6 && info.ageDays <= 8;
      items.push(item(`signin_${ch.id}`, 'error', `${ch.title}: Google sign-in`, `expired or revoked ${new Date(info.at).toLocaleString()}`, `Reconnect it (Channels → Connect with Google).${testing ? ' It lasted ~7 days: publish the Google Cloud OAuth app (Google Auth Platform → Audience → Publish app) so it stops expiring.' : ''}`));
    } else items.push(item(`signin_${ch.id}`, 'ok', `${ch.title}: Google sign-in`, 'working'));
  }
  // Instagram / TikTok accounts
  try {
    for (const a of db.prepare('SELECT platform, username, account_id, token_refreshed_at, token_expires_at FROM social_accounts').all()) {
      const who = `${a.platform === 'instagram' ? 'Instagram' : 'TikTok'} @${a.username || a.account_id}`;
      if (a.platform === 'instagram') {
        const age = a.token_refreshed_at ? days(a.token_refreshed_at) : null;
        const level = age === null ? 'warn' : age > 60 ? 'error' : age > 50 ? 'warn' : 'ok';
        items.push(item(`ig_${a.account_id}`, level, who, age === null ? 'token age unknown' : `token refreshed ${Math.round(age)} days ago (Instagram tokens last 60)`, level === 'ok' ? null : level === 'error' ? 'The token has expired: add the account again with a new token.' : 'TubeDesk refreshes it automatically every morning; if this stays, check the job list.'));
      } else items.push(item(`tt_${a.account_id}`, 'ok', who, 'connected'));
    }
  } catch { /* table not created yet */ }
  // scheduled jobs
  for (const j of jobs.status()) {
    if (j.failuresInARow >= 2 && !/^busy/.test(j.lastError || '')) items.push(item(`job_${j.name}`, 'warn', `Job: ${j.label}`, `failed ${j.failuresInARow}× in a row — ${j.lastError}`, /quota/i.test(j.lastError || '') ? 'Waits for the quota reset automatically.' : 'It retries automatically; the error above says what it needs.'));
  }
  const ov = jobs.overdue();
  if (ov.length) items.push(item('jobs_overdue', 'warn', 'Scheduled jobs', `${ov.length} waiting to catch up: ${ov.map(o => o.name).join(', ')}`, 'They run on the next catch-up tick (every 10 minutes).'));
  // publishing queue
  try {
    const failed = db.prepare("SELECT COUNT(*) n FROM publish_queue WHERE status = 'failed' AND created_at > datetime('now', '-7 days')").get().n;
    const stuck = db.prepare("SELECT COUNT(*) n FROM publish_queue WHERE status = 'running' AND run_at < ?").get(new Date(Date.now() - 3 * 3600e3).toISOString()).n; // run_at is ISO
    items.push(item('publish_queue', failed || stuck ? 'warn' : 'ok', 'Publishing queue', `${failed} failed this week, ${stuck} stuck`, failed || stuck ? 'Open Virality radar → Shorts to retry or cancel them; each failure says why.' : null));
  } catch { /* */ }
  // tools
  const ff = toolStatus();
  items.push(item('ffmpeg', ff.ready ? 'ok' : 'warn', 'ffmpeg (video)', ff.ready ? 'installed' : 'missing — rendering, Shorts and thumbnails from frames are off', ff.hint));
  const wh = engineStatus();
  if (getSetting('clips_enabled', '1') === '1') items.push(item('whisper', wh.whisper ? 'ok' : 'warn', 'Transcriber (Shorts)', wh.whisper ? (wh.modelReady ? 'ready' : 'model downloads on first use') : 'missing', wh.whisper ? null : wh.hint));
  // phone alerts
  items.push(item('alerts', channelsConfigured().length ? 'ok' : 'warn', 'Phone alerts', channelsConfigured().length ? channelsConfigured().join(', ') : 'none set up — you will not hear about breakouts or problems', channelsConfigured().length ? null : 'Settings → Phone alerts (iMessage is free on the Mac).'));
  // updates
  const u = updater.lastCheck();
  const rolled = (() => { try { return JSON.parse(fs.readFileSync(`${DATA_DIR}/update-rolled-back.json`, 'utf8')); } catch { return null; } })();
  if (rolled) items.push(item('update', 'warn', 'Updates', `version ${rolled.toVersion} failed to start and was rolled back to ${rolled.fromVersion}`, 'Nothing to do: the next fixed version installs itself.'));
  else if (u?.ok) items.push(item('update', u.behind && !updater.enabled() ? 'warn' : 'ok', 'Updates', u.behind ? `${u.behind} update(s) available${u.dirty ? ' — local edits block automatic updates' : ''}` : `up to date (v${u.version})`, u.behind && u.dirty ? 'Local file edits stop automatic updates; ask your AI to "update TubeDesk".' : null));
  const levels = items.map(i => i.level);
  const out = { at: new Date().toISOString(), status: levels.includes('error') ? 'error' : levels.includes('warn') ? 'warn' : 'ok', errors: levels.filter(l => l === 'error').length, warnings: levels.filter(l => l === 'warn').length, items, jobs: jobs.status() };
  setSetting('health_last', JSON.stringify({ at: out.at, status: out.status, errors: out.errors, warnings: out.warnings }));
  return out;
}

/** Morning doctor: text the owner about new errors (each problem at most once a day). */
export async function doctor() {
  const r = await check({ deep: new Date().getDay() === 0 });
  const bad = r.items.filter(i => i.level === 'error' || (i.level === 'warn' && !['alerts', 'quota', 'backups'].includes(i.id)));
  const sent = JSON.parse(getSetting('health_notified', '{}') || '{}');
  const day = new Date().toISOString().slice(0, 10);
  const fresh = bad.filter(i => sent[i.id] !== day);
  if (fresh.length) {
    await notify({ kind: 'health', force: true, title: `TubeDesk: ${fresh.length} thing${fresh.length > 1 ? 's' : ''} need${fresh.length > 1 ? '' : 's'} attention`, body: fresh.slice(0, 5).map(i => `• ${i.title}: ${i.detail}${i.fix ? ` → ${i.fix}` : ''}`).join('\n') }).catch(() => {});
    for (const i of fresh) sent[i.id] = day;
    setSetting('health_notified', JSON.stringify(sent));
  }
  return { status: r.status, notified: fresh.map(i => i.id) };
}
