// Boot guard: the LaunchAgent starts this file. It only uses Node built-ins, so it still works when an update
// broke something TubeDesk imports. Right after an update, if the new version fails to come up 3 times in a row,
// it puts the previous version back (git reset to the commit before the update) and lets launchd start that.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = process.env.TUBEDESK_DATA_DIR || path.join(ROOT, 'data');
const STATE = path.join(DATA_DIR, 'update-state.json');
const MAX_BOOTS = Number(process.env.TUBEDESK_MAX_BOOTS || 3);

function rollback(state, why) {
  console.error(`[boot] version ${state.toVersion || state.to} failed to start (${why}); rolling back to ${state.fromVersion || state.from}`);
  // the marker first: even if a step below fails, the same version is not installed again tonight
  try { fs.writeFileSync(path.join(DATA_DIR, 'update-rolled-back.json'), JSON.stringify({ ...state, why, rolledBackAt: new Date().toISOString() })); } catch { /* */ }
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  try { execFileSync('git', ['-C', ROOT, 'reset', '--hard', state.from], { stdio: 'inherit', timeout: 60_000, env }); } catch (e) { console.error('[boot] git reset failed:', e.message); }
  if (state.deps) try { execFileSync('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], { cwd: ROOT, stdio: 'inherit', timeout: 600_000, killSignal: 'SIGKILL', env }); } catch (e) { console.error('[boot] npm install failed:', e.message); }
  fs.rmSync(STATE, { force: true });
}

let state = null;
try { state = JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { /* no update in progress */ }
if (state) {
  state.boots = (state.boots || 0) + 1;
  if (state.boots > MAX_BOOTS) { rollback(state, `${MAX_BOOTS} failed starts`); process.exit(1); }
  fs.writeFileSync(STATE, JSON.stringify(state));
}
try {
  await import('./server.js');
} catch (e) {
  console.error('[boot] TubeDesk failed to start:', e?.stack || e);
  if (state && state.boots >= MAX_BOOTS) rollback(state, e?.message || 'import failed');
  process.exit(1);
}
