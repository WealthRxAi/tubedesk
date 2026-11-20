// Reliability: retries, YouTube's Pacific-day quota, missed-job catch-up, backups + restore, the doctor, broken
// Google sign-ins, and self-updates that roll back when the new version can't start.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'td-rel-'));
process.env.TUBEDESK_DATA_DIR = DATA;
process.env.TUBEDESK_RETRY_BASE_MS = '5';
const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname), '..');
let srv, base, hits = {}, script = {}, hook, hookUrl;
const texts = [];

before(async () => {
  // one fake server for YouTube, Google sign-in and a flaky endpoint; script[path] = list of responses to play
  srv = http.createServer((req, res) => {
    const p = new URL(req.url, 'http://x').pathname;
    hits[p] = (hits[p] || 0) + 1;
    const next = (script[p] || []).shift() || { status: 200, body: { ok: true, items: [] } };
    if (next.drop) { req.socket.destroy(); return; }
    res.writeHead(next.status, { 'content-type': 'application/json', ...(next.headers || {}) });
    res.end(JSON.stringify(next.body || {}));
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${srv.address().port}`;
  process.env.YT_API_BASE = `${base}/youtube/v3`;
  process.env.GOOGLE_TOKEN_URL = `${base}/token`;
  hook = http.createServer((req, res) => { let b = ''; req.on('data', d => b += d); req.on('end', () => { try { texts.push(JSON.parse(b)); } catch { /* */ } res.end('ok'); }); });
  await new Promise(r => hook.listen(0, '127.0.0.1', r));
  hookUrl = `http://127.0.0.1:${hook.address().port}/hook`;
});
after(async () => { srv?.close(); hook?.close(); (await import('../src/services/jobs.js')).stopAll(); });

test('transient failures are retried; writes that may have landed are not repeated', async () => {
  const { fetchRetry } = await import('../src/lib/http.js');
  script['/flaky'] = [{ status: 503 }, { status: 502 }, { status: 200, body: { ok: 1 } }];
  const r = await fetchRetry(`${base}/flaky`);
  assert.equal(r.status, 200); assert.equal(hits['/flaky'], 3);
  script['/post'] = [{ status: 503 }, { status: 200 }];
  const p = await fetchRetry(`${base}/post`, { method: 'POST', body: 'x' });
  assert.equal(p.status, 503, 'a POST that reached the server is not sent twice'); assert.equal(hits['/post'], 1);
  script['/ra'] = [{ status: 429, headers: { 'retry-after': '0' } }, { status: 200 }];
  assert.equal((await fetchRetry(`${base}/ra`)).status, 200);
  // a dropped connection on a GET is retried
  script['/drop'] = [{ drop: true }, { status: 200 }];
  assert.equal((await fetchRetry(`${base}/drop`)).status, 200);
  // nothing listening: retried, then the error surfaces
  await assert.rejects(fetchRetry('http://127.0.0.1:1/', {}, { retries: 1 }));
});

test('quota follows YouTube\'s Pacific day; "slow down" is retried; "quota used up" stops calls until the reset', async () => {
  const { quotaDay, msUntilQuotaReset, ytGet, quotaToday } = await import('../src/youtube/client.js');
  const { setSetting } = await import('../src/db.js');
  assert.equal(quotaDay(new Date('2026-11-20T05:00:00Z')), '2026-11-19', '9 pm Pacific is still the 19th');
  assert.equal(quotaDay(new Date('2026-11-20T08:30:00Z')), '2026-11-20');
  const ms = msUntilQuotaReset(new Date('2026-11-20T07:30:00Z')); // 11:30 pm PST
  assert.ok(ms > 29 * 60e3 && ms <= 31 * 60e3, String(ms));
  setSetting('yt_api_key', 'K');
  script['/youtube/v3/videos'] = [{ status: 403, body: { error: { message: 'slow', errors: [{ reason: 'rateLimitExceeded' }] } } }, { status: 200, body: { items: [{ id: 'a' }] } }];
  const r = await ytGet('videos.list', { id: 'a', part: 'snippet' }, { ttl: 0 });
  assert.equal(r.items[0].id, 'a'); assert.equal(hits['/youtube/v3/videos'], 2);
  script['/youtube/v3/channels'] = [{ status: 403, body: { error: { message: 'The request cannot be completed because you have exceeded your quota.', errors: [{ reason: 'quotaExceeded' }] } } }];
  await assert.rejects(ytGet('channels.list', { id: 'x', part: 'id' }, { ttl: 0 }), /exceeded your quota/);
  assert.equal(quotaToday().exhausted, true); assert.equal(quotaToday().remaining, 0);
  const before = hits['/youtube/v3/channels'];
  await assert.rejects(ytGet('channels.list', { id: 'y', part: 'id' }, { ttl: 0 }), /resets at midnight Pacific/);
  assert.equal(hits['/youtube/v3/channels'], before, 'no call made once Google said the quota is gone');
  setSetting('yt_quota_exhausted', '');
});

test('a missed or failed scheduled job is caught up — once — and quota failures wait for the reset', async () => {
  const jobs = await import('../src/services/jobs.js');
  const { setSetting } = await import('../src/db.js');
  const tz = 'America/New_York';
  // DST-safe "last scheduled time"
  assert.equal(jobs.lastScheduled('30 3 * * *', tz, new Date('2026-11-20T12:00:00Z')).toISOString(), '2026-11-20T08:30:00.000Z');
  assert.equal(jobs.lastScheduled('30 3 * * *', tz, new Date('2026-11-01T12:00:00Z')).toISOString(), '2026-11-01T08:30:00.000Z', '3:30 EST on the day clocks go back');
  assert.equal(jobs.lastScheduled('30 3 * * *', tz, new Date('2026-11-01T06:30:00Z')).toISOString(), '2026-10-31T07:30:00.000Z', '3:30 EDT the day before');
  assert.equal(jobs.lastScheduled('10 8 * * 1', tz, new Date('2026-11-19T12:00:00Z')).toISOString(), '2026-11-16T13:10:00.000Z', 'last Monday');
  assert.equal(jobs.lastScheduled('*/5 * * * *', tz), null, 'frequent jobs are not caught up');
  let runs = 0, fail = null;
  jobs.schedule('t_daily', '0 4 * * *', async () => { runs++; if (fail) throw fail; return 'done'; }, { tz });
  setSetting('job_since_t_daily', '2026-01-01T00:00:00Z'); // pretend it has been scheduled for a long time
  const now = new Date(Date.now());
  assert.ok(jobs.overdue(now).some(o => o.name === 't_daily'), 'never ran since its last scheduled time');
  await jobs.catchUpTick(now);
  assert.equal(runs, 1);
  assert.ok(!jobs.overdue(now).some(o => o.name === 't_daily'), 'done after one catch-up');
  // a failure: retried after 30 minutes, not on every tick
  jobs.schedule('t_fail', '0 4 * * *', async () => { runs++; throw new Error('network down'); }, { tz });
  setSetting('job_since_t_fail', '2026-01-01T00:00:00Z');
  await jobs.catchUpTick(now);
  assert.ok(!jobs.overdue(now).some(o => o.name === 't_fail'), 'backs off right after a failure');
  assert.ok(jobs.overdue(new Date(now.getTime() + 31 * 60e3)).some(o => o.name === 't_fail'), 'tries again later');
  // quota failure: waits for the Pacific reset
  jobs.schedule('t_quota', '0 4 * * *', async () => { throw Object.assign(new Error('quota'), { reason: 'quotaGuard', status: 429 }); }, { tz });
  setSetting('job_since_t_quota', '2026-01-01T00:00:00Z');
  await jobs.catchUpTick(now);
  assert.ok(!jobs.overdue(new Date(now.getTime() + 40 * 60e3)).some(o => o.name === 't_quota') || (await import('../src/youtube/client.js')).quotaDay(new Date(now.getTime() + 40 * 60e3)) !== (await import('../src/youtube/client.js')).quotaDay(now));
  // a fresh install doesn't fire daily jobs that were "due" before it existed
  jobs.schedule('t_new', '0 4 * * *', async () => { runs++; }, { tz });
  assert.ok(!jobs.overdue(now).some(o => o.name === 't_new'));
  assert.ok(jobs.status().find(s => s.name === 't_fail').failuresInARow >= 1);
});

test('nightly backup: consistent copy, verified, pruned; a restore swaps the database on the next start', async () => {
  const backup = await import('../src/services/backup.js');
  const { setSetting, getSetting } = await import('../src/db.js');
  setSetting('marker', 'before');
  const r = await backup.create();
  assert.match(r.created, /^tubedesk-\d{4}-\d{2}-\d{2}\.sqlite$/);
  assert.equal((await backup.create()).skipped, 'already backed up today');
  assert.ok(backup.verify(path.join(backup.BACKUP_DIR, r.created)).ok);
  // old backups: keep 7 days + Sundays, drop the rest
  for (const d of ['2026-01-04', '2026-01-05', '2025-06-01']) fs.writeFileSync(path.join(backup.BACKUP_DIR, `tubedesk-${d}.sqlite`), 'x');
  const removed = backup.prune(new Date());
  assert.ok(removed.includes('tubedesk-2026-01-05.sqlite'), 'a Monday from January goes'); assert.ok(!removed.includes('tubedesk-2026-01-04.sqlite'), 'a recent Sunday stays');
  assert.throws(() => backup.stageRestore('../../etc/passwd'), /Pick one of the listed backups/);
  fs.writeFileSync(path.join(backup.BACKUP_DIR, 'tubedesk-2026-01-11.sqlite'), 'not a database');
  assert.throws(() => backup.stageRestore('tubedesk-2026-01-11.sqlite'), /damaged/);
  setSetting('marker', 'after');
  backup.stageRestore(r.created);
  // the swap happens when the database module loads in a new process
  const out = spawnSync(process.execPath, ['-e', "import('./src/db.js').then(m => console.log('MARKER=' + m.getSetting('marker')))"], { cwd: ROOT, env: { ...process.env, TUBEDESK_DATA_DIR: DATA }, encoding: 'utf8' });
  assert.match(out.stdout, /MARKER=before/, out.stderr);
  assert.ok(!fs.existsSync(path.join(DATA, 'restore-pending.json')));
  assert.ok(backup.list().some(b => /-\d{6}\.sqlite$/.test(b.file)), 'the replaced data was kept as a backup');
  const m = backup.maintenance(); assert.ok('cache' in m);
});

test('a revoked Google sign-in is reported with the exact fix (7-day expiry = OAuth app still in Testing)', async () => {
  const { db, setSetting } = await import('../src/db.js');
  const { getAccessToken } = await import('../src/youtube/oauth.js');
  setSetting('google_client_id', 'c'); setSetting('google_client_secret', 's');
  db.prepare("INSERT OR REPLACE INTO channels (id, title, kind, oauth_json) VALUES ('UCbroken', 'Broken Channel', 'owned', ?)").run(JSON.stringify({ refresh_token: 'r', access_token: 'old', expires_at: 0, connected_at: new Date(Date.now() - 7 * 86400e3).toISOString() }));
  script['/token'] = [{ status: 400, body: { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' } }];
  await assert.rejects(getAccessToken('UCbroken'), /publish it \(Google Auth Platform → Audience → Publish app\)/);
  const health = await import('../src/services/health.js');
  const h = await health.check();
  const it = h.items.find(i => i.id === 'signin_UCbroken');
  assert.equal(it.level, 'error'); assert.match(it.fix, /Publish app/);
  // the morning doctor texts it once a day
  setSetting('notify_webhook_url', hookUrl); setSetting('notify_quiet', 'off');
  const d1 = await health.doctor(); const d2 = await health.doctor();
  assert.ok(d1.notified.includes('signin_UCbroken')); assert.deepEqual(d2.notified, []);
  await new Promise(r => setTimeout(r, 200));
  assert.equal(texts.filter(t => /need/.test(t.title || '')).length, 1);
  // reconnecting clears it
  script['/token'] = [{ status: 200, body: { access_token: 'new', expires_in: 3600 } }];
  assert.equal(await getAccessToken('UCbroken'), 'new');
  assert.equal((await health.check()).items.find(i => i.id === 'signin_UCbroken').level, 'ok');
});

test('self-update: fast-forwards from GitHub, refuses over local edits, and rolls back a version that cannot start', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'td-upd-'));
  const origin = path.join(tmp, 'origin.git'), work = path.join(tmp, 'seed'), clone = path.join(tmp, 'install');
  const g = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();
  execFileSync('git', ['init', '--bare', '-b', 'main', origin]);
  g(tmp, 'clone', '-q', origin, work);
  fs.mkdirSync(path.join(work, 'src'), { recursive: true });
  fs.writeFileSync(path.join(work, 'package.json'), JSON.stringify({ name: 'x', version: '1.0.0', type: 'module' }));
  fs.copyFileSync(path.join(ROOT, 'src', 'boot.js'), path.join(work, 'src', 'boot.js'));
  fs.writeFileSync(path.join(work, 'src', 'server.js'), "console.log('v1 up');\n");
  g(work, 'add', '-A'); g(work, 'commit', '-qm', 'v1'); g(work, 'push', '-q', 'origin', 'HEAD:main');
  g(tmp, 'clone', '-q', origin, clone);
  // v2 is broken: its server throws on start
  fs.writeFileSync(path.join(work, 'package.json'), JSON.stringify({ name: 'x', version: '2.0.0', type: 'module' }));
  fs.writeFileSync(path.join(work, 'src', 'server.js'), "throw new Error('v2 is broken');\n");
  g(work, 'commit', '-qam', 'v2'); g(work, 'push', '-q', 'origin', 'HEAD:main');
  const env = { ...process.env, TUBEDESK_ROOT: clone, TUBEDESK_DATA_DIR: path.join(clone, 'data') };
  fs.mkdirSync(env.TUBEDESK_DATA_DIR, { recursive: true });
  const run = code => JSON.parse(spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: ROOT, env, encoding: 'utf8' }).stdout.trim().split('\n').pop());
  // local edits block the update
  fs.appendFileSync(path.join(clone, 'src', 'server.js'), '// my edit\n');
  assert.match(run("const u = await import('./src/services/updater.js'); console.log(JSON.stringify(await u.apply({ restart: false })))").reason, /changed locally/);
  g(clone, 'checkout', '-q', '--', '.');
  const up = run("const u = await import('./src/services/updater.js'); console.log(JSON.stringify(await u.apply({ restart: false })))");
  assert.equal(up.updated, true); assert.equal(up.version, '2.0.0');
  // launchd keeps restarting the broken v2; the 4th start rolls back to v1
  for (let i = 1; i <= 4; i++) spawnSync(process.execPath, [path.join(clone, 'src', 'boot.js')], { env, encoding: 'utf8' });
  assert.equal(JSON.parse(fs.readFileSync(path.join(clone, 'package.json'), 'utf8')).version, '1.0.0', 'rolled back');
  assert.match(spawnSync(process.execPath, [path.join(clone, 'src', 'boot.js')], { env, encoding: 'utf8' }).stdout, /v1 up/);
  assert.ok(fs.existsSync(path.join(clone, 'data', 'update-rolled-back.json')));
  assert.ok(!fs.existsSync(path.join(clone, 'data', 'update-state.json')));
  assert.match(run("const u = await import('./src/services/updater.js'); console.log(JSON.stringify(await u.apply({ restart: false })))").reason, /failed to start here/, 'the broken version is not installed again');
  // an update never restarts TubeDesk while an upload is running
  const busyOut = spawnSync(process.execPath, ['--input-type=module', '-e', "const { db } = await import('./src/db.js'); db.exec(\"CREATE TABLE IF NOT EXISTS publish_jobs (id TEXT, platform TEXT, status TEXT, file TEXT, title TEXT, params_json TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')))\"); db.prepare(\"INSERT INTO publish_jobs (id, platform, status, file) VALUES ('j1', 'youtube', 'running', '/x.mp4')\").run(); const u = await import('./src/services/updater.js'); console.log(JSON.stringify(await u.apply()))"], { cwd: ROOT, env: { ...env, TUBEDESK_SUPERVISED: '1' }, encoding: 'utf8' });
  assert.match(busyOut.stdout, /"busy":true/, busyOut.stderr);
});
