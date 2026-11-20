// Every scheduled job runs through here: one run at a time per job, a ledger of runs (for the health check), and
// catch-up. node-cron fires only at the exact minute; if the Mac was asleep, TubeDesk was restarting, or the job
// failed (network, YouTube quota), the job runs again on the next catch-up tick instead of waiting a whole day.
import cron from 'node-cron';
import { db, getSetting, setSetting } from '../db.js';

db.exec(`
CREATE TABLE IF NOT EXISTS job_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  ok INTEGER,
  error TEXT,
  ms INTEGER,
  trigger TEXT
);
CREATE INDEX IF NOT EXISTS idx_job_runs_name ON job_runs(name, id);
`);

const JOBS = new Map(); // name -> { expr, tz, fn, catchUp, label, running }
const isQuota = e => /quotaGuard|quotaExceeded|dailyLimitExceeded/.test(`${e?.reason || ''} ${e?.message || ''}`) || /quota/i.test(e?.message || '') && e?.status === 429;

/** Run a job now (deduplicated: a second call while it runs returns the same promise). */
export function runJob(name, trigger = 'manual') {
  const j = JOBS.get(name);
  if (!j) throw Object.assign(new Error(`No job "${name}"`), { status: 404 });
  if (j.running) return j.running;
  const started = new Date();
  const id = db.prepare('INSERT INTO job_runs (name, started_at, trigger) VALUES (?, ?, ?)').run(name, started.toISOString(), trigger).lastInsertRowid;
  j.running = (async () => {
    try {
      const out = await j.fn();
      db.prepare('UPDATE job_runs SET finished_at = ?, ok = 1, ms = ? WHERE id = ?').run(new Date().toISOString(), Date.now() - started, id);
      return out;
    } catch (e) {
      db.prepare('UPDATE job_runs SET finished_at = ?, ok = 0, error = ?, ms = ? WHERE id = ?').run(new Date().toISOString(), `${isQuota(e) ? '[quota] ' : ''}${e.message}`.slice(0, 500), Date.now() - started, id);
      console.error(`[job ${name}]`, e.message);
      throw e;
    } finally { j.running = null; }
  })();
  j.running.catch(() => {});
  return j.running;
}

/**
 * Schedule a job. catchUp: run it if its most recent scheduled time passed without a successful run since
 * (only for daily/weekly "M H * * D" schedules; frequent jobs simply run at their next tick).
 */
export function schedule(name, expr, fn, { tz, catchUp = true, label = name, runIfNeverRun = () => false } = {}) {
  if (!cron.validate(expr)) { console.warn(`[jobs] invalid cron for ${name}: ${expr}`); return null; }
  const prev = JOBS.get(name);
  prev?.task?.stop?.();
  // Catch-up only covers runs missed after TubeDesk first scheduled this job (a fresh install doesn't fire every
  // daily job at once). runIfNeverRun() lets a job ask for a first run anyway (e.g. today's snapshot).
  if (!getSetting(`job_since_${name}`, '')) setSetting(`job_since_${name}`, new Date().toISOString());
  const job = { name, expr, tz, fn, catchUp, label, runIfNeverRun, running: null };
  job.task = cron.schedule(expr, () => runJob(name, 'schedule').catch(() => {}), { timezone: tz });
  JOBS.set(name, job);
  return job;
}

// ---------- catch-up ----------
function zonedParts(date, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short' }).formatToParts(date).map(x => [x.type, x.value]));
  return { y: +p.year, mo: +p.month, d: +p.day, h: +p.hour, mi: +p.minute, dow: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday) };
}
/** The Date at local wall-clock y-mo-d h:mi in tz (DST-safe to the minute). */
function zonedDate(y, mo, d, h, mi, tz) {
  let t = Date.UTC(y, mo - 1, d, h, mi);
  for (let i = 0; i < 3; i++) { const p = zonedParts(new Date(t), tz); t += (Date.UTC(y, mo - 1, d, h, mi) - Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi)); }
  return new Date(t);
}
const field = (spec, v) => spec === '*' || spec.split(',').some(part => { const [a, b] = part.split('-').map(Number); return b === undefined ? a === v : v >= a && v <= b; });
/** Most recent time ≤ now that a "M H * * D" schedule fired; null for other shapes (every-N-minutes, lists of hours…). */
export function lastScheduled(expr, tz, now = new Date()) {
  const f = expr.trim().split(/\s+/);
  if (f.length !== 5 || !/^\d+$/.test(f[0]) || !/^\d+$/.test(f[1]) || f[2] !== '*' || f[3] !== '*' || !/^(\*|[\d,-]+)$/.test(f[4])) return null;
  const [mi, h] = [Number(f[0]), Number(f[1])];
  const today = zonedParts(now, tz);
  for (let back = 0; back <= 8; back++) {
    // step back by calendar days (not 24-hour blocks, which skip a day around daylight-saving changes)
    const cal = new Date(Date.UTC(today.y, today.mo - 1, today.d - back));
    const at = zonedDate(cal.getUTCFullYear(), cal.getUTCMonth() + 1, cal.getUTCDate(), h, mi, tz);
    if (at <= now && field(f[4].replace(/\b7\b/g, '0'), zonedParts(at, tz).dow)) return at;
  }
  return null;
}
export function lastRun(name, { ok } = {}) {
  return db.prepare(`SELECT * FROM job_runs WHERE name = ? ${ok === undefined ? '' : 'AND ok = ' + (ok ? 1 : 0)} AND finished_at IS NOT NULL ORDER BY id DESC LIMIT 1`).get(name) || null;
}
/** Jobs whose last scheduled time has no successful run after it (and no attempt in the last 30 minutes). */
export function overdue(now = new Date()) {
  const out = [];
  for (const j of JOBS.values()) {
    if (!j.catchUp || j.running) continue;
    const due = lastScheduled(j.expr, j.tz, now);
    if (!due || now - due < 2 * 60_000) continue; // let the cron tick itself run first
    const okRun = lastRun(j.name, { ok: true });
    if (okRun && Date.parse(okRun.started_at) >= due.getTime() - 60_000) continue;
    const since = Date.parse(getSetting(`job_since_${j.name}`, '') || 0) || 0;
    if (due.getTime() < since && !(okRun === null && !lastRun(j.name) && j.runIfNeverRun())) continue;
    const attempt = db.prepare('SELECT started_at, error FROM job_runs WHERE name = ? ORDER BY id DESC LIMIT 1').get(j.name);
    if (attempt && now - Date.parse(attempt.started_at) < 30 * 60_000) continue; // back off between failed attempts
    // a job that failed on YouTube quota waits for the Pacific-midnight reset instead of burning attempts
    if (attempt?.error?.startsWith('[quota]') && quotaDayOf(new Date(attempt.started_at)) === quotaDayOf(now)) continue;
    out.push({ name: j.name, due: due.toISOString(), lastOk: okRun?.started_at || null });
  }
  return out;
}
const quotaDayOf = d => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(d);
export async function catchUpTick(now = new Date()) {
  const due = overdue(now);
  for (const d of due) await runJob(d.name, 'catch-up').catch(() => {});
  return due.map(d => d.name);
}
let catchUpTimer = null;
export function startCatchUp() {
  if (catchUpTimer) return;
  const every = Number(getSetting('jobs_catchup_minutes', 10)) * 60_000;
  catchUpTimer = setInterval(() => catchUpTick().catch(e => console.error('[jobs] catch-up', e.message)), every);
  catchUpTimer.unref?.();
  setTimeout(() => catchUpTick().catch(() => {}), 120_000).unref?.();
}

/** Status of every job, for the health check and Settings. */
export function status() {
  return [...JOBS.values()].map(j => {
    const last = lastRun(j.name), ok = lastRun(j.name, { ok: true });
    const fails = db.prepare('SELECT COUNT(*) n FROM job_runs WHERE name = ? AND ok = 0 AND id > COALESCE((SELECT MAX(id) FROM job_runs WHERE name = ? AND ok = 1), 0)').get(j.name, j.name).n;
    return { name: j.name, label: j.label, schedule: j.expr, running: !!j.running, lastRun: last?.started_at || null, lastOk: ok?.started_at || null, lastError: last && !last.ok ? last.error : null, failuresInARow: fails, due: lastScheduled(j.expr, j.tz)?.toISOString() || null };
  });
}
export function prune(days = 60) { return db.prepare("DELETE FROM job_runs WHERE started_at < ?").run(new Date(Date.now() - days * 86400000).toISOString()).changes; }
export function list() { return [...JOBS.keys()]; }
/** Stop every schedule (shutdown, tests). */
export function stopAll() { for (const j of JOBS.values()) j.task?.stop?.(); JOBS.clear(); if (catchUpTimer) { clearInterval(catchUpTimer); catchUpTimer = null; } }
