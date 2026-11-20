// Keeps the Mac's TubeDesk current with GitHub (fast-forward only, never over local edits). After an update the
// boot guard (src/boot.js) watches the new version start: if it can't stay up, it rolls back to the previous commit.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { db, getSetting, setSetting, DATA_DIR } from '../db.js';

export const ROOT = process.env.TUBEDESK_ROOT || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const STATE = path.join(DATA_DIR, 'update-state.json');
const git = (...args) => run('git', ['-C', ROOT, ...args]);
function run(cmd, args, timeout = 120_000) {
  // never wait on a password prompt or an editor: fail fast instead
  return new Promise(resolve => execFile(cmd, args, { cwd: ROOT, timeout, killSignal: 'SIGKILL', maxBuffer: 8 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'echo', npm_config_yes: 'true' } }, (err, stdout, stderr) =>
    resolve({ ok: !err, out: String(stdout || '').trim(), err: String(stderr || err?.message || '').trim() })));
}
const version = () => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version; } catch { return null; } };
// launchd (KeepAlive) restarts TubeDesk after it exits; older installs are recognised by launchd's service name.
export const supervised = () => process.env.TUBEDESK_SUPERVISED === '1' || process.env.XPC_SERVICE_NAME === 'com.tubedesk';

/** Where this install stands against GitHub. */
export async function check({ fetch: doFetch = true } = {}) {
  if (!fs.existsSync(path.join(ROOT, '.git'))) return { ok: false, reason: 'not-a-git-checkout', version: version() };
  const branch = (await git('rev-parse', '--abbrev-ref', 'HEAD')).out;
  if (doFetch) { const f = await git('fetch', '--quiet', 'origin', 'main'); if (!f.ok) return { ok: false, reason: 'fetch-failed', error: f.err.slice(0, 300), version: version() }; }
  const head = (await git('rev-parse', 'HEAD')).out, remote = (await git('rev-parse', 'origin/main')).out;
  const behind = Number((await git('rev-list', '--count', `HEAD..origin/main`)).out || 0);
  const ahead = Number((await git('rev-list', '--count', `origin/main..HEAD`)).out || 0);
  const dirty = (await git('status', '--porcelain', '--untracked-files=no')).out.split('\n').filter(Boolean);
  const log = behind ? (await git('log', '--oneline', '-n', '10', 'HEAD..origin/main')).out.split('\n').filter(Boolean) : [];
  const out = { ok: true, version: version(), branch, head: head.slice(0, 7), remote: remote.slice(0, 7), behind, ahead, dirty: dirty.length, changes: log, checkedAt: new Date().toISOString() };
  setSetting('update_last_check', JSON.stringify(out));
  return out;
}
export function lastCheck() { try { return JSON.parse(getSetting('update_last_check', '') || 'null'); } catch { return null; } }

/**
 * Update to GitHub's main when it is strictly ahead (fast-forward), on branch main, with no local edits.
 * Installs dependencies when package files changed, then restarts (launchd brings it back) under the boot guard.
 */
/** Work that a restart would cut off: uploads, renders, scheduled posts going out, bulk edits, videos being made. */
export async function busy() {
  const q = (sql) => { try { return db.prepare(sql).get().n; } catch { return 0; } };
  // only recent rows count: a row left "running" by a crash must not block updates forever
  const n = q("SELECT COUNT(*) n FROM publish_jobs WHERE status IN ('queued', 'running') AND created_at > datetime('now', '-3 hours')")
    + q("SELECT COUNT(*) n FROM render_jobs WHERE status IN ('queued', 'running') AND created_at > datetime('now', '-2 hours')");
  let live = 0; try { const wf = await import('./workflow.js'); live = wf.makingNow() + (wf.bulkBusy() ? 1 : 0); } catch { /* */ }
  return n + live;
}

export async function apply({ restart = true } = {}) {
  if (restart && supervised() && await busy()) return { updated: false, busy: true, reason: 'uploads or renders are running — the update waits for them' };
  const st = await check();
  if (!st.ok) return { updated: false, reason: st.reason, error: st.error };
  if (!st.behind) return { updated: false, reason: 'up-to-date', version: st.version };
  if (st.branch !== 'main') return { updated: false, reason: `on branch ${st.branch}, not main` };
  if (st.dirty) return { updated: false, reason: `${st.dirty} file(s) changed locally — left alone` };
  if (st.ahead) return { updated: false, reason: 'this copy has commits GitHub does not — left alone' };
  // a version that already failed to start here is skipped until GitHub has a newer one
  const target = (await git('rev-parse', 'origin/main')).out;
  try { const rb = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'update-rolled-back.json'), 'utf8')); if (rb.to === target) return { updated: false, reason: `version ${rb.toVersion} failed to start here and was rolled back — waiting for a newer one` }; } catch { /* none */ }
  const from = (await git('rev-parse', 'HEAD')).out;
  const changed = (await git('diff', '--name-only', 'HEAD', 'origin/main')).out.split('\n');
  const deps = changed.some(f => f === 'package.json' || f === 'package-lock.json');
  // the boot guard's state is written before anything changes, so a failure at any step below can be rolled back
  fs.writeFileSync(STATE, JSON.stringify({ from, to: target, fromVersion: st.version, toVersion: null, at: new Date().toISOString(), boots: 0, deps }));
  const m = await git('merge', '--ff-only', 'origin/main');
  if (!m.ok) { fs.rmSync(STATE, { force: true }); return { updated: false, reason: 'merge failed', error: m.err.slice(0, 300) }; }
  if (deps) {
    const npm = await run('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], 600_000);
    if (!npm.ok) {
      await git('reset', '--hard', from);
      await run('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], 600_000); // put the old dependencies back too
      fs.rmSync(STATE, { force: true });
      fs.writeFileSync(path.join(DATA_DIR, 'update-rolled-back.json'), JSON.stringify({ from, to: target, fromVersion: st.version, why: 'npm install failed', rolledBackAt: new Date().toISOString() }));
      return { updated: false, reason: 'npm install failed — rolled back', error: npm.err.slice(-300) };
    }
  }
  const to = (await git('rev-parse', 'HEAD')).out;
  fs.rmSync(path.join(DATA_DIR, 'update-rolled-back.json'), { force: true }); // a newer version: give it its chance
  fs.writeFileSync(STATE, JSON.stringify({ from, to, fromVersion: st.version, toVersion: version(), at: new Date().toISOString(), boots: 0, deps }));
  setSetting('update_last', JSON.stringify({ from: from.slice(0, 7), to: to.slice(0, 7), version: version(), at: new Date().toISOString() }));
  if (restart && supervised()) setTimeout(() => process.exit(0), 1500).unref?.(); // launchd (KeepAlive) starts the new version
  return { updated: true, from: from.slice(0, 7), to: to.slice(0, 7), version: version(), restarting: restart && supervised(), changes: st.changes };
}

/** Called once the new version has been up for a while: the update is good, the boot guard stands down. */
export function markHealthy() {
  if (!fs.existsSync(STATE)) return false;
  try { const s = JSON.parse(fs.readFileSync(STATE, 'utf8')); setSetting('update_last', JSON.stringify({ ...JSON.parse(getSetting('update_last', '{}') || '{}'), healthy: true, version: s.toVersion })); } catch { /* */ }
  fs.rmSync(STATE, { force: true });
  return true;
}
export const enabled = () => getSetting('auto_update', '1') === '1';
