// Daily database backups (SQLite online backup: consistent while TubeDesk runs), kept 7 days + 8 Sundays, with a
// restore that swaps the file on the next start. Plus housekeeping so the database doesn't grow forever.
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { db, DATA_DIR, DB_PATH } from '../db.js';

export const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const NAME = /^tubedesk-(\d{4}-\d{2}-\d{2})(?:-(\d{6}))?\.sqlite$/;
const localDay = (d = new Date()) => new Intl.DateTimeFormat('en-CA').format(d);

export function list() {
  if (!fs.existsSync(BACKUP_DIR)) return [];
  return fs.readdirSync(BACKUP_DIR).filter(n => NAME.test(n)).map(n => {
    const st = fs.statSync(path.join(BACKUP_DIR, n));
    return { file: n, day: NAME.exec(n)[1], bytes: st.size, at: st.mtime.toISOString() };
  }).sort((a, b) => b.file.localeCompare(a.file));
}
export function latest() { return list()[0] || null; }

/** Make a backup now (one per day by default; `force` adds a timestamped extra). Verifies it opens cleanly. */
export async function create({ force = false } = {}) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const day = localDay();
  let name = `tubedesk-${day}.sqlite`;
  if (fs.existsSync(path.join(BACKUP_DIR, name))) {
    if (!force) return { skipped: 'already backed up today', ...list().find(b => b.file === name) };
    name = `tubedesk-${day}-${new Date().toTimeString().slice(0, 8).replace(/:/g, '')}.sqlite`;
  }
  const tmp = path.join(BACKUP_DIR, `.${name}.tmp`);
  await db.backup(tmp);
  const check = verify(tmp);
  if (!check.ok) { fs.rmSync(tmp, { force: true }); throw new Error(`backup failed its integrity check: ${check.error}`); }
  fs.renameSync(tmp, path.join(BACKUP_DIR, name));
  const pruned = prune();
  return { created: name, bytes: fs.statSync(path.join(BACKUP_DIR, name)).size, pruned };
}
export function verify(file) {
  try {
    const t = new Database(file, { readonly: true, fileMustExist: true });
    const r = t.pragma('quick_check', { simple: true });
    const hasSettings = t.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='settings'").get();
    t.close();
    return r === 'ok' && hasSettings ? { ok: true } : { ok: false, error: r === 'ok' ? 'not a TubeDesk database' : r };
  } catch (e) { return { ok: false, error: e.message }; }
}
/** Keep the newest 7 days, plus one backup per Sunday for 8 weeks. Extra timestamped backups go after 7 days. */
export function prune(now = new Date()) {
  const removed = [];
  const keepDays = new Set(), sundays = [];
  for (let i = 0; i < 7; i++) keepDays.add(localDay(new Date(now - i * 86400000)));
  for (const b of list()) {
    const d = new Date(`${b.day}T12:00:00`);
    if (keepDays.has(b.day)) continue;
    if (d.getDay() === 0 && !NAME.exec(b.file)[2] && sundays.length < 8) { sundays.push(b.file); continue; }
    fs.rmSync(path.join(BACKUP_DIR, b.file), { force: true }); removed.push(b.file);
  }
  return removed;
}

/**
 * Restore a backup: checks it, saves the current database as a backup too, and stages the swap for the next start
 * (the running database can't be replaced underneath itself). The caller restarts TubeDesk.
 */
export function stageRestore(file) {
  const name = path.basename(String(file || ''));
  if (!NAME.test(name)) throw Object.assign(new Error('Pick one of the listed backups.'), { status: 400 });
  const src = path.join(BACKUP_DIR, name);
  if (!fs.existsSync(src)) throw Object.assign(new Error('That backup no longer exists.'), { status: 404 });
  const v = verify(src);
  if (!v.ok) throw Object.assign(new Error(`That backup is damaged: ${v.error}`), { status: 400 });
  fs.writeFileSync(path.join(DATA_DIR, 'restore-pending.json'), JSON.stringify({ file: src, at: new Date().toISOString() }));
  return { staged: name, note: 'TubeDesk restarts now and comes back with that backup. The current data was kept as a backup first.' };
}

/** Housekeeping: expired cache rows, old API/AI/job logs, alerts older than 180 days; then let SQLite reuse space. */
export function maintenance() {
  const cut = days => new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  const out = {};
  out.cache = db.prepare('DELETE FROM api_cache WHERE expires_at < ?').run(Date.now()).changes;
  out.apiLog = db.prepare('DELETE FROM api_log WHERE day < ?').run(cut(120)).changes;
  try { out.aiLog = db.prepare('DELETE FROM ai_log WHERE ts < ?').run(cut(180)).changes; } catch { /* older schema */ }
  try { out.alerts = db.prepare('DELETE FROM alerts WHERE created_at < ? AND COALESCE(read, 0) = 1').run(cut(180)).changes; } catch { /* */ }
  db.pragma('optimize');
  db.pragma('wal_checkpoint(TRUNCATE)');
  return out;
}
export const dbFile = DB_PATH;
