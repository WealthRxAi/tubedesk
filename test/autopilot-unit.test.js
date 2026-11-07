// Unit tests: reach CSV parsing, quiet hours, thumbnail cards from video frames.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'td-ap-unit-'));
process.env.TUBEDESK_DATA_DIR = dir;
const reach = await import('../src/services/reach.js');
const notify = await import('../src/services/notify.js');
const render = await import('../src/services/render.js');
const FFMPEG = ['/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg', '/opt/homebrew/bin/ffmpeg'].find(f => fs.existsSync(f));

test('reach CSV: other dimensions summed, CTR impression-weighted, percent kept', () => {
  const csv = 'date,channel_id,video_id,live_or_on_demand,subscribed_status,country_code,video_thumbnail_impressions,video_thumbnail_impressions_ctr\n'
    + '20261101,UC1,v1,on_demand,subscribed,US,1000,6.0\n20261101,UC1,v1,on_demand,unsubscribed,US,3000,2.0\n20261102,UC1,v1,on_demand,subscribed,US,500,4.0\n20261101,UC1,v2,on_demand,subscribed,US,0,\n';
  const rows = reach.parseReachCsv(csv);
  const a = rows.find(r => r.video_id === 'v1' && r.day === '2026-11-01');
  assert.equal(a.impressions, 4000);
  assert.ok(Math.abs(a.ctr - 3.0) < 1e-9, '(1000×6 + 3000×2) / 4000 = 3%');
  assert.equal(rows.find(r => r.day === '2026-11-02').ctr, 4);
  assert.equal(rows.find(r => r.video_id === 'v2').ctr, null, 'blank CTR stays null');
});

test('reach CSV: fraction-scaled reports are converted to percent; bad headers rejected', () => {
  const rows = reach.parseReachCsv('date,video_id,video_thumbnail_impressions,video_thumbnail_impressions_ctr\n20261101,v1,1000,0.05\n20261101,v2,1000,0.02\n');
  assert.ok(Math.abs(rows.find(r => r.video_id === 'v1').ctr - 5) < 1e-9);
  assert.throws(() => reach.parseReachCsv('a,b\n1,2\n'), /Unexpected reach report columns/);
  assert.deepEqual(reach.parseReachCsv('date,video_id\n'), []);
});

test('quiet hours, including windows across midnight', () => {
  const at = h => { const d = new Date(); d.setHours(h, 30, 0, 0); return d; };
  assert.equal(notify.inQuietHours(at(23), '22-7'), true);
  assert.equal(notify.inQuietHours(at(3), '22-7'), true);
  assert.equal(notify.inQuietHours(at(7), '22-7'), false);
  assert.equal(notify.inQuietHours(at(12), '22-7'), false);
  assert.equal(notify.inQuietHours(at(13), '12-14'), true);
  assert.equal(notify.inQuietHours(at(14), '12-14'), false);
  assert.equal(notify.inQuietHours(at(3), ''), false);
  assert.equal(notify.inQuietHours(at(3), 'nonsense'), false);
});

test('notify without a phone channel is a no-op, not an error', async () => {
  const r = await notify.notify({ kind: 'radar_breakout', title: 'x' });
  assert.equal(r.skipped, 'no phone channel configured');
  const r2 = await notify.notify({ kind: 'some_unlisted_kind', title: 'x' });
  assert.equal(r2.skipped, 'kind not enabled for phone');
  await assert.rejects(notify.test(), /Add an iMessage/);
});

test('thumbnail card: 1280×720 frame with text', { skip: !FFMPEG }, async () => {
  const src = path.join(dir, 'clip.mp4');
  execFileSync(FFMPEG, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=25:duration=2', '-pix_fmt', 'yuv420p', src]);
  for (const text of ["Don't sign: it's 100% a trap, [really]", '']) {
    const out = path.join(dir, 'thumbs', `card-${text.length}.jpg`);
    await render.thumbnailCard({ file: src, at: 1, text, output: out });
    const pr = await render.probe(out);
    assert.equal(pr.video.width, 1280); assert.equal(pr.video.height, 720);
    assert.ok(fs.statSync(out).size < 2 * 1024 * 1024, 'under YouTube\'s 2 MB thumbnail limit');
  }
});

test('autopilot acts below 0.6× usual pace only, with a trustworthy baseline, inside the age window', async () => {
  const ap = await import('../src/services/autopilot.js');
  const v = { id: 'unitvid0001', channel_id: 'UCunit', published_at: new Date(Date.now() - 2 * 86400000).toISOString(), is_short: 0, title: 't' };
  const run = (o) => ap.shouldRun(v, { ageHours: 40, confidence: 'high', paceIndex: 0.5, ...o });
  assert.equal(run({}).run, true);
  assert.equal(run({ paceIndex: 0.65 }).run, false, '0.6–0.7 is "lagging" on the board but not enough to act');
  assert.equal(run({ confidence: 'low' }).run, false, 'estimated baselines never trigger a swap');
  assert.equal(run({ ageHours: 10 }).why, 'outside the age window');
  assert.equal(ap.shouldRun({ ...v, is_short: 1 }, { ageHours: 40, confidence: 'high', paceIndex: 0.2 }).run, false, 'Shorts excluded by default');
});

test('day arithmetic is calendar-based (daylight-saving safe)', () => {
  assert.equal(reach.addDays('2026-11-01', 2), '2026-11-03'); // US DST ends 2026-11-01
  assert.equal(reach.addDays('2026-03-07', 1), '2026-03-08');
  assert.equal(reach.addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(reach.addDays('2026-11-05', 0), '2026-11-05');
});
