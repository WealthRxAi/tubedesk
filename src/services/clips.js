// Shorts from breakouts: when one of your uploads breaks out (or on demand), transcribe its source file locally,
// let the AI pick self-contained moments, score each moment's title on the virality radar, cut the best ones as
// vertical 1080×1920 clips with word-timed captions and an on-screen hook, then schedule them into your best
// Shorts slots on YouTube and Instagram through a local publish queue (one upload per slot, so the YouTube
// quota is spread across days).
import fs from 'node:fs';
import path from 'node:path';
import { db, getSetting, DATA_DIR } from '../db.js';
import { isAuthorized } from '../youtube/oauth.js';
import { quotaToday } from '../youtube/client.js';
import { getChannel } from './channels.js';
import * as render from './render.js';
import * as pub from './publish.js';
import { transcriptFor, sourceFileFor, engineStatus } from './transcribe.js';
import { scorePackages, aiAvailable } from './radar.js';
import { bestSlots } from './slots.js';
import { notify } from './notify.js';
import * as ai from './ai.js';

db.exec(`
CREATE TABLE IF NOT EXISTS clips (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  video_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  rank INTEGER,
  start REAL, end REAL,
  title TEXT NOT NULL,
  hook_text TEXT,
  description TEXT,
  file TEXT,
  cover TEXT,
  score REAL,
  prediction_json TEXT,
  status TEXT NOT NULL,          -- rendering | ready | queued | scheduled | published | failed | cancelled
  publish_at TEXT,
  yt_video_id TEXT,
  ig_media_id TEXT,
  error TEXT,
  trigger TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_clips_video ON clips(video_id);
CREATE TABLE IF NOT EXISTS publish_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  platform TEXT NOT NULL,        -- youtube | instagram
  channel_id TEXT,
  clip_id INTEGER,
  params_json TEXT NOT NULL,
  run_at TEXT NOT NULL,          -- when TubeDesk starts the upload
  publish_at TEXT,               -- when it goes public
  status TEXT NOT NULL DEFAULT 'waiting',   -- waiting | running | done | failed | cancelled
  job_id TEXT,
  result_json TEXT,
  error TEXT,
  note TEXT,
  shifts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_queue_due ON publish_queue(status, run_at);
`);
try { db.exec('ALTER TABLE publish_queue ADD COLUMN shifts INTEGER NOT NULL DEFAULT 0'); } catch { /* already there */ }

const CLIPS_DIR = () => path.join(DATA_DIR, 'clips');
export const clipUrl = f => f ? '/data/clips/' + path.basename(f) : null;

export function settings() {
  return {
    enabled: getSetting('clips_enabled', '1') === '1',
    count: Number(getSetting('clips_count', 3)),
    publish: getSetting('clips_publish', 'auto'),          // auto | review
    platforms: String(getSetting('clips_platforms', 'youtube,instagram')).split(',').map(s => s.trim()).filter(Boolean),
    minSeconds: Number(getSetting('clips_min_seconds', 15)),
    maxSeconds: Number(getSetting('clips_max_seconds', 58)),
  };
}

/** Sentence-ish lines with timestamps, for the AI to choose moments from. */
function transcriptLines(words) {
  const lines = []; let cur = [];
  words.forEach((w, i) => {
    cur.push(w);
    const nxt = words[i + 1];
    if (!nxt || /[.!?]$/.test(w.text) || nxt.start - w.end > 0.7 || cur.length >= 16) { lines.push({ start: cur[0].start, end: cur.at(-1).end, text: cur.map(x => x.text).join(' ') }); cur = []; }
  });
  return lines;
}

/** Word-timed caption groups (≤ 3 words, break on punctuation), relative to the clip start. */
export function captionGroups(words, start, end) {
  const inWin = words.filter(w => w.start >= start - 0.05 && w.end <= end + 0.05);
  const out = []; let cur = [];
  inWin.forEach((w, i) => {
    cur.push(w);
    if (cur.length >= 3 || /[.,!?;:]$/.test(w.text) || i === inWin.length - 1) {
      out.push({ text: cur.map(x => x.text).join(' ').toUpperCase(), start: +(cur[0].start - start).toFixed(3), end: +(cur.at(-1).end - start).toFixed(3) });
      cur = [];
    }
  });
  out.forEach((g, i) => { g.end = out[i + 1] ? out[i + 1].start : Math.min(end - start, g.end + 0.4); });
  return out;
}

/** Snap an AI-chosen window to word boundaries and the allowed length. null if it can't be made valid. */
export function snapWindow(words, s, e, { min = 15, max = 58 } = {}) {
  const first = words.find(w => w.start >= s - 0.3);
  if (!first) return null;
  const startT = first.start;
  let lastIdx = -1;
  words.forEach((w, i) => { if (w.end <= e + 0.3 && w.start >= startT) lastIdx = i; });
  if (lastIdx < 0) return null;
  let endT = words[lastIdx].end;
  if (endT - startT > max) { const cut = words.filter(w => w.start >= startT && w.end <= startT + max).at(-1); endT = cut ? cut.end : startT + max; }
  if (endT - startT < min) return null;
  return { start: +startT.toFixed(3), end: +(endT + 0.25).toFixed(3) };
}

const running = new Map();
export function makeClips(videoId, opts = {}) {
  if (running.has(videoId)) return running.get(videoId);
  const p = makeClipsInner(videoId, opts).finally(() => running.delete(videoId));
  running.set(videoId, p);
  return p;
}

/** Everything that must hold before cutting starts; throws a clear 4xx error otherwise. */
export function preflight(videoId) {
  const video = db.prepare('SELECT * FROM videos WHERE id = ?').get(videoId);
  if (!video) throw Object.assign(new Error('Video not synced'), { status: 404 });
  const ch = getChannel(video.channel_id);
  if (!ch || ch.kind !== 'owned') throw Object.assign(new Error('Shorts can only be cut from your own videos'), { status: 400 });
  if (video.is_short) throw Object.assign(new Error('This upload is already a Short'), { status: 400 });
  if (!aiAvailable()) throw Object.assign(new Error('Cutting Shorts needs the AI provider (Settings → AI) to pick the moments.'), { status: 400 });
  const file = sourceFileFor(videoId);
  if (!file) throw Object.assign(new Error('No source file for this video on this Mac. Link it in Virality radar → Autopilot → Source file (videos published through TubeDesk are linked automatically).'), { status: 400 });
  const eng = engineStatus();
  if (!eng.ready) throw Object.assign(new Error(eng.hint), { status: 400 });
  return { video, file };
}

async function makeClipsInner(videoId, { count = settings().count, trigger = 'manual', autoPublish = null, force = false, log = () => {} } = {}) {
  const { video, file } = preflight(videoId);
  // Moments already cut from this video (and not failed/cancelled) are never cut and posted twice unless forced.
  const existing = force ? [] : db.prepare("SELECT start, end FROM clips WHERE video_id = ? AND status NOT IN ('failed', 'cancelled')").all(videoId);
  const t = await transcriptFor(videoId, { needWords: true, log });
  const words = t.words;
  const lines = transcriptLines(words);
  const s = settings();
  const prompt = `Video: "${video.title}"
Transcript with timestamps in seconds:
${lines.map(l => `[${l.start.toFixed(1)}-${l.end.toFixed(1)}] ${l.text}`).join('\n').slice(0, 60000)}

Pick the ${count + 2} best self-contained moments to cut as vertical Shorts (${s.minSeconds}-${s.maxSeconds} seconds each, non-overlapping).
Each must make sense with no context, open with its strongest line (a claim, number, question or surprise), and end on a complete thought.
For each give: start and end (seconds, from the timestamps above), a Shorts title under 60 characters that is honest to the clip, hookText (2-5 words shown on screen for the first 3 seconds), a one-sentence description, and why it will hold attention.
Return JSON: {"clips":[{"start":0,"end":0,"title":"...","hookText":"...","description":"...","why":"..."}]}`;
  const out = await ai.ask('shorts_moments', prompt, { json: true });
  const cands = [];
  for (const c of out.clips || []) {
    const win = snapWindow(words, Number(c.start), Number(c.end), { min: s.minSeconds, max: s.maxSeconds });
    if (!win || !String(c.title || '').trim()) continue;
    if (cands.some(x => win.start < x.end && x.start < win.end)) continue; // overlap
    if (existing.some(x => win.start < x.end && x.start < win.end)) continue; // already cut
    cands.push({ ...win, title: String(c.title).trim().slice(0, 95), hookText: String(c.hookText || '').slice(0, 40), description: String(c.description || '').slice(0, 300), why: String(c.why || '').slice(0, 300) });
  }
  if (!cands.length) throw Object.assign(new Error(existing.length ? 'Every strong moment in this video has already been cut into a Short. Pass force to cut again.' : 'The AI found no usable moments in this transcript.'), { status: existing.length ? 409 : 422 });
  // Score every candidate's title (with its opening words as the hook) and keep the best `count`.
  const packages = cands.map((c, i) => ({ key: 'c' + i, title: c.title, hook: words.filter(w => w.start >= c.start && w.start < c.start + 8).map(w => w.text).join(' ') }));
  const { results } = await scorePackages(video.channel_id, packages, { format: 'short' });
  cands.forEach((c, i) => { c.score = results['c' + i].score; c.prediction = results['c' + i].prediction; });
  const chosen = [...cands].sort((a, b) => (b.score ?? -1) - (a.score ?? -1)).slice(0, count);
  fs.mkdirSync(CLIPS_DIR(), { recursive: true });
  const ids = [];
  for (const [k, c] of chosen.entries()) {
    const D = +(c.end - c.start).toFixed(3);
    const stem = `${videoId}-${Date.now().toString(36)}-${k + 1}`;
    const output = path.join(CLIPS_DIR(), stem + '.mp4');
    const tracks = [
      { type: 'video', src: file, in: c.start, start: 0, end: D, fit: 'cover', focus: [0.5, 0.4] },
      { type: 'captions', groups: captionGroups(words, c.start, c.end), size: 70, y: 1240, font: 'bold' },
    ];
    if (c.hookText) tracks.push({ type: 'text', text: c.hookText.toUpperCase(), start: 0, end: Math.min(3, D), y: 250, size: 84, box: true, boxColor: '#000000', boxOpacity: 0.55 });
    const ins = db.prepare(`INSERT INTO clips (video_id, channel_id, rank, start, end, title, hook_text, description, file, score, prediction_json, status, trigger) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'rendering', ?)`)
      .run(videoId, video.channel_id, k + 1, c.start, c.end, c.title, c.hookText, c.description, output, c.score, JSON.stringify(c.prediction), trigger);
    const id = ins.lastInsertRowid;
    try {
      const job = render.render({ width: 1080, height: 1920, fps: 30, duration: D, output, tracks, preset: 'veryfast', crf: 20 });
      const done = await render.waitForJob(job.id, 30 * 60 * 1000);
      if (done.status !== 'done') throw new Error(done.error || 'render failed');
      const cover = path.join(CLIPS_DIR(), stem + '.jpg');
      try { await render.frame({ file: output, at: Math.min(1.2, D / 2), output: cover }); } catch { /* cover is optional */ }
      db.prepare("UPDATE clips SET status = 'ready', cover = ? WHERE id = ?").run(fs.existsSync(cover) ? cover : null, id);
      ids.push(id);
    } catch (e) {
      db.prepare("UPDATE clips SET status = 'failed', error = ? WHERE id = ?").run(e.message, id);
    }
  }
  const auto = autoPublish ?? s.publish === 'auto';
  let scheduled = [];
  if (auto && ids.length) scheduled = schedule(ids);
  const list = ids.map(getClip);
  if (list.length) {
    notify({ kind: 'clips', title: `${list.length} Short${list.length > 1 ? 's' : ''} cut from "${video.title}"`,
      body: list.map(c => `• ${c.title} (radar ${c.score ?? '—'})${c.publish_at ? ' — ' + new Date(c.publish_at).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' }) : ''}`).join('\n') + (auto ? '' : '\nReview and schedule them in Virality radar → Shorts.'),
      url: `https://youtu.be/${videoId}` }).catch(() => {});
  }
  return { videoId, transcript: { source: t.source, words: words.length }, candidates: cands.length, clips: list, scheduled };
}

const MIN = 60000, HOUR = 3600000;
const YT_LEAD = 90 * MIN;            // YouTube uploads this early as private + publishAt
const OVERDUE = HOUR;                // a slot missed by more than this (Mac asleep/off) is moved, not posted late
const MAX_QUOTA_SHIFTS = 3;

function queueParams(c, platform) {
  if (platform === 'youtube') return { file: c.file, channelId: c.channel_id, title: c.title, description: `${c.description || ''}\n\nFull video: https://youtu.be/${c.video_id}\n#Shorts`.trim(), privacy: 'private', tags: ['shorts'] };
  return { kind: 'reel', file: c.file, caption: `${c.title}\n\n${c.description || ''}`.trim(), cover: c.cover || undefined };
}
const runAtFor = (platform, publishAt) => platform === 'youtube' ? new Date(Date.parse(publishAt) - YT_LEAD).toISOString() : publishAt;

/** Put clips into the publish queue at the channel's best Shorts slots (one per slot). */
export function schedule(clipIds) {
  const s = settings();
  const clips = clipIds.map(getClip).filter(c => c && c.status === 'ready');
  if (!clips.length) return [];
  const channelId = clips[0].channel_id;
  const slots = bestSlots(channelId, { format: 'short', count: clips.length });
  const igOn = s.platforms.includes('instagram') && pub.instagramStatus().configured;
  const ytOn = s.platforms.includes('youtube') && isAuthorized(channelId);
  const out = [];
  clips.forEach((c, i) => {
    const slot = slots[i];
    if (!slot) return;
    const publishAt = slot.at;
    for (const [platform, on] of [['youtube', ytOn], ['instagram', igOn]]) if (on) enqueue({ platform, channelId, clipId: c.id, publishAt, runAt: runAtFor(platform, publishAt), params: queueParams(c, platform) });
    if (ytOn || igOn) { db.prepare("UPDATE clips SET status = 'queued', publish_at = ?, error = NULL WHERE id = ?").run(publishAt, c.id); out.push({ clipId: c.id, publishAt, local: slot.local, youtube: ytOn, instagram: igOn }); }
  });
  return out;
}

export function enqueue({ platform, channelId = null, clipId = null, params, runAt, publishAt = null }) {
  const r = db.prepare('INSERT INTO publish_queue (platform, channel_id, clip_id, params_json, run_at, publish_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(platform, channelId, clipId, JSON.stringify(params), new Date(Math.max(Date.now(), Date.parse(runAt))).toISOString(), publishAt);
  return getQueueItem(r.lastInsertRowid);
}

/**
 * A clip's status follows its queue rows: anything waiting/running → queued; any failure → failed;
 * all done → scheduled (YouTube holds it private until publish_at) or published once that time has passed.
 */
export function settleClip(clipId) {
  const c = db.prepare('SELECT id, status FROM clips WHERE id = ?').get(clipId);
  if (!c || ['cancelled', 'rendering'].includes(c.status)) return;
  const rows = db.prepare("SELECT platform, status, publish_at, error FROM publish_queue WHERE clip_id = ? AND status != 'cancelled'").all(clipId);
  if (!rows.length) return;
  let status, error = null;
  if (rows.some(r => r.status === 'waiting' || r.status === 'running')) status = 'queued';
  else if (rows.some(r => r.status === 'failed')) { status = 'failed'; error = rows.filter(r => r.status === 'failed').map(r => `${r.platform}: ${r.error}`).join(' · '); }
  else status = rows.some(r => r.publish_at && Date.parse(r.publish_at) > Date.now()) ? 'scheduled' : 'published';
  db.prepare('UPDATE clips SET status = ?, error = ? WHERE id = ?').run(status, error, clipId);
}

// YouTube: read the video's current status and write it back with a new visibility (no publishAt).
async function setYouTubeVisibility(channelId, videoId, privacyStatus) {
  const { ytGet, ytWrite } = await import('../youtube/client.js');
  const cur = (await ytGet('videos.list', { part: 'status', id: videoId }, { channelId, noCache: true, ttl: 0 })).items?.[0]?.status;
  if (!cur) throw new Error(`video ${videoId} not found on YouTube`);
  const status = { privacyStatus, selfDeclaredMadeForKids: !!cur.selfDeclaredMadeForKids };
  for (const k of ['embeddable', 'license', 'publicStatsViewable', 'containsSyntheticMedia']) if (cur[k] !== undefined) status[k] = cur[k];
  await ytWrite('videos.update', { method: 'PUT', params: { part: 'status' }, channelId, json: { id: videoId, status } });
}

/** Run due queue items (every few minutes from the scheduler). Calls made while a run is going queue one more run. */
let processing = null;
export function processQueue() {
  if (processing) return processing.then(() => processQueue());
  processing = processInner().finally(() => { processing = null; });
  return processing;
}

function settleRow(q, job) {
  if (job.status === 'done') {
    const result = { id: job.remote_id, url: job.url };
    db.prepare("UPDATE publish_queue SET status = 'done', result_json = ?, error = NULL WHERE id = ?").run(JSON.stringify(result), q.id);
    if (q.clip_id) db.prepare(`UPDATE clips SET ${q.platform === 'youtube' ? 'yt_video_id' : 'ig_media_id'} = ? WHERE id = ?`).run(result.id || null, q.clip_id);
    if (q.clip_id) settleClip(q.clip_id);
    return { id: q.id, platform: q.platform, result };
  }
  const msg = job.error || `publish ${job.status}`;
  db.prepare("UPDATE publish_queue SET status = 'failed', error = ? WHERE id = ?").run(msg, q.id);
  if (q.clip_id) settleClip(q.clip_id);
  notify({ kind: 'publish_failed', title: `Scheduled ${q.platform} upload failed`, body: `${msg}\nCheck ${q.platform} before retrying with Publish now in Virality radar → Shorts.` }).catch(() => {});
  return { id: q.id, platform: q.platform, error: msg };
}

/** Rows still 'running' from an earlier pass whose upload has since finished. */
function settleFinishedRunning(done) {
  for (const q of db.prepare("SELECT * FROM publish_queue WHERE status = 'running' AND job_id IS NOT NULL").all()) {
    if (pub.isActive(q.job_id)) continue;
    const job = pub.getJob(q.job_id);
    if (job && (job.status === 'done' || job.status === 'failed')) done.push(settleRow(q, job));
  }
}

/** Move a missed or quota-blocked item (and its clip's other waiting rows) to the next free best slot. */
function reslot(q, reason) {
  const owner = q.channel_id || db.prepare("SELECT id FROM channels WHERE kind = 'owned' ORDER BY rowid LIMIT 1").get()?.id;
  const slot = owner ? bestSlots(owner, { format: 'short', count: 1, exclude: { clipId: q.clip_id, queueId: q.id } })[0] : null;
  const at = slot?.at || new Date(Date.now() + 2 * HOUR).toISOString();
  const rows = q.clip_id ? db.prepare("SELECT * FROM publish_queue WHERE clip_id = ? AND (status = 'waiting' OR id = ?)").all(q.clip_id, q.id) : [q];
  for (const r of rows) db.prepare("UPDATE publish_queue SET status = 'waiting', run_at = ?, publish_at = ?, note = ? WHERE id = ?").run(new Date(Math.max(Date.now(), Date.parse(runAtFor(r.platform, at)))).toISOString(), at, reason, r.id);
  if (q.clip_id) { db.prepare('UPDATE clips SET publish_at = ? WHERE id = ?').run(at, q.clip_id); settleClip(q.clip_id); }
  return { at, local: slot?.local || at };
}

async function processInner() {
  const done = [];
  settleFinishedRunning(done);
  for (const c of db.prepare("SELECT id FROM clips WHERE status = 'scheduled'").all()) settleClip(c.id);
  for (let guard = 0; guard < 500; guard++) {
    const due = db.prepare("SELECT id FROM publish_queue WHERE status = 'waiting' AND run_at <= ? ORDER BY run_at LIMIT 1").get(new Date().toISOString());
    if (!due) break;
    if (!db.prepare("UPDATE publish_queue SET status = 'running' WHERE id = ? AND status = 'waiting'").run(due.id).changes) continue;
    const q = db.prepare('SELECT * FROM publish_queue WHERE id = ?').get(due.id); // fresh: "publish now" may have just changed it
    const params = JSON.parse(q.params_json);
    try {
      // TubeDesk was off/asleep past the slot: don't post several Shorts at once — move it to the next free slot.
      if (q.publish_at && Date.now() > Date.parse(q.publish_at) + OVERDUE) {
        const to = reslot(q, `Missed its slot while TubeDesk was off — moved to the next best slot.`);
        notify({ kind: 'clips', title: 'A scheduled Short missed its slot', body: `"${params.title || params.caption?.split('\n')[0] || 'Short'}" moved to ${to.local}.` }).catch(() => {});
        done.push({ id: q.id, platform: q.platform, moved: to.at });
        continue;
      }
      let job;
      if (q.platform === 'youtube') {
        // Not enough quota today → move this upload (and its public time) by a day, at most MAX_QUOTA_SHIFTS times.
        if (quotaToday().remaining < pub.YT_UPLOAD_UNITS + 100) {
          const shifts = (q.shifts || 0) + 1;
          if (shifts > MAX_QUOTA_SHIFTS) throw new Error(`Not enough YouTube quota left on ${MAX_QUOTA_SHIFTS} days in a row — other features use it up before the upload. Lower radar/competitor refreshes or raise yt_quota_limit, then use Publish now.`);
          const shift = t => t ? new Date(Date.parse(t) + 86400000).toISOString() : t;
          db.prepare("UPDATE publish_queue SET status = 'waiting', run_at = ?, publish_at = ?, shifts = ?, note = ? WHERE id = ?").run(shift(q.run_at), shift(q.publish_at), shifts, `Moved one day (${shifts}/${MAX_QUOTA_SHIFTS}): not enough YouTube quota left today.`, q.id);
          if (q.clip_id) db.prepare('UPDATE clips SET publish_at = ? WHERE id = ?').run(shift(q.publish_at), q.clip_id);
          notify({ kind: 'publish_failed', title: 'YouTube Short moved one day', body: `Only ${quotaToday().remaining} quota units left today; an upload needs ${pub.YT_UPLOAD_UNITS}. "${params.title}" now goes out ${shift(q.publish_at) ? new Date(shift(q.publish_at)).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' }) : 'tomorrow'}.` }).catch(() => {});
          done.push({ id: q.id, platform: q.platform, shifted: shifts });
          continue;
        }
        const late = !q.publish_at || Date.parse(q.publish_at) < Date.now() + 5 * MIN;
        job = pub.publishYouTube({ ...params, ...(late ? { privacy: 'public', publishAt: undefined } : { privacy: 'private', publishAt: q.publish_at }) });
      } else job = pub.publishInstagram(params);
      db.prepare('UPDATE publish_queue SET job_id = ? WHERE id = ?').run(job.id, q.id);
      const fin = await pub.waitForJob(job.id, 30 * MIN);
      if (fin.status === 'running' || fin.status === 'queued') { // still uploading: settle it on a later pass, never retry it
        db.prepare("UPDATE publish_queue SET note = 'Still uploading — will settle when it finishes.' WHERE id = ?").run(q.id);
        continue;
      }
      done.push(settleRow(q, fin));
    } catch (e) {
      done.push(settleRow(q, { status: 'failed', error: e.message }));
    }
  }
  return done;
}

/** Called once at startup: settle or fail rows a previous run left mid-upload (never re-sent automatically). */
export function recoverAfterRestart() {
  for (const q of db.prepare("SELECT * FROM publish_queue WHERE status = 'running'").all()) {
    const job = q.job_id ? pub.getJob(q.job_id) : null;
    if (job && (job.status === 'done' || job.status === 'failed')) settleRow(q, job);
    else {
      db.prepare("UPDATE publish_queue SET status = 'failed', error = ? WHERE id = ?").run('Interrupted by a restart while uploading — check the platform, then use Publish now if it is not there.', q.id);
      if (q.clip_id) settleClip(q.clip_id);
    }
  }
  db.prepare("UPDATE clips SET status = 'failed', error = 'Interrupted by a restart while rendering.' WHERE status = 'rendering'").run();
}

const httpErr = (status, msg) => Object.assign(new Error(msg), { status });

/** Publish a clip now: queued rows run immediately, failed rows are retried, a YouTube upload waiting for its time goes public. */
export async function publishNow(clipId) {
  let c = getClip(clipId);
  if (!c) throw httpErr(404, 'clip not found');
  if (c.status === 'cancelled') throw httpErr(409, 'This clip was cancelled.');
  if (c.queue.some(q => q.status === 'running')) throw httpErr(409, 'It is uploading right now — give it a minute.');
  if (c.status === 'ready') schedule([clipId]);
  for (const q of db.prepare("SELECT * FROM publish_queue WHERE clip_id = ? AND status = 'done' AND platform = 'youtube' AND publish_at > ?").all(clipId, new Date().toISOString())) {
    const vid = JSON.parse(q.result_json || '{}').id;
    await setYouTubeVisibility(q.channel_id, vid, 'public');
    db.prepare("UPDATE publish_queue SET publish_at = ?, note = 'Made public early (Publish now).' WHERE id = ?").run(new Date().toISOString(), q.id);
  }
  // An explicit "publish now" also retries uploads that failed (you've checked they aren't on the platform).
  db.prepare("UPDATE publish_queue SET status = 'waiting', error = NULL, shifts = 0 WHERE clip_id = ? AND status = 'failed'").run(clipId);
  const now = new Date().toISOString();
  db.prepare("UPDATE publish_queue SET run_at = ?, publish_at = NULL WHERE clip_id = ? AND status = 'waiting'").run(now, clipId);
  db.prepare('UPDATE clips SET publish_at = ?, error = NULL WHERE id = ?').run(now, clipId);
  settleClip(clipId);
  await processQueue();
  return getClip(clipId);
}

/** Cancel a clip. Waiting uploads are dropped; a YouTube upload still waiting for its public time is kept private. */
export async function cancel(clipId) {
  const c = getClip(clipId);
  if (!c) throw httpErr(404, 'clip not found');
  if (c.queue.some(q => q.status === 'running')) throw httpErr(409, 'It is uploading right now — cancel again in a minute and TubeDesk will keep it private.');
  const notes = [];
  for (const q of db.prepare("SELECT * FROM publish_queue WHERE clip_id = ? AND status = 'done'").all(clipId)) {
    const res = JSON.parse(q.result_json || '{}');
    if (q.platform === 'youtube' && q.publish_at && Date.parse(q.publish_at) > Date.now() + MIN) {
      try { await setYouTubeVisibility(q.channel_id, res.id, 'private'); }
      catch (e) { throw httpErr(502, `Could not stop the scheduled YouTube publish (${e.message}). Set it to private in YouTube Studio: ${res.url || res.id}`); }
      db.prepare("UPDATE publish_queue SET status = 'cancelled', note = 'Kept private on YouTube — the scheduled publish was removed.' WHERE id = ?").run(q.id);
      notes.push('YouTube: uploaded but kept private (scheduled publish removed). Delete it in Studio if you want it gone.');
    } else notes.push(`${q.platform === 'youtube' ? 'YouTube' : 'Instagram'}: already public${res.url ? ' — ' + res.url : ''}. Remove it there if you want it gone.`);
  }
  db.prepare("UPDATE publish_queue SET status = 'cancelled' WHERE clip_id = ? AND status IN ('waiting', 'failed')").run(clipId);
  db.prepare("UPDATE clips SET status = 'cancelled' WHERE id = ?").run(clipId);
  return { ...getClip(clipId), notes };
}

export function getQueueItem(id) { const q = db.prepare('SELECT * FROM publish_queue WHERE id = ?').get(id); return q && { ...q, params: JSON.parse(q.params_json), params_json: undefined }; }
export function queue({ channelId = null, limit = 50 } = {}) {
  return db.prepare(`SELECT id FROM publish_queue ${channelId ? 'WHERE channel_id = ?' : ''} ORDER BY id DESC LIMIT ?`).all(...(channelId ? [channelId, limit] : [limit])).map(r => getQueueItem(r.id));
}
export function getClip(id) {
  const c = db.prepare('SELECT c.*, v.title AS video_title FROM clips c LEFT JOIN videos v ON v.id = c.video_id WHERE c.id = ?').get(id);
  if (!c) return null;
  return { ...c, prediction: JSON.parse(c.prediction_json || 'null'), prediction_json: undefined, url: clipUrl(c.file), coverUrl: clipUrl(c.cover),
    queue: db.prepare('SELECT id, platform, status, run_at, publish_at, error, note, result_json FROM publish_queue WHERE clip_id = ? ORDER BY id').all(id).map(q => ({ ...q, result: JSON.parse(q.result_json || 'null'), result_json: undefined })) };
}
export function listClips(channelId, limit = 60) { return db.prepare('SELECT id FROM clips WHERE channel_id = ? ORDER BY id DESC LIMIT ?').all(channelId, limit).map(r => getClip(r.id)); }

/** Called by the radar watch when one of your long-form uploads breaks out. Fire-and-forget. */
export function onBreakout(videoId) {
  const s = settings();
  if (!s.enabled || !aiAvailable() || !engineStatus().ready) return false;
  if (db.prepare('SELECT 1 FROM clips WHERE video_id = ? LIMIT 1').get(videoId)) return false;
  if (!sourceFileFor(videoId)) return false;
  makeClips(videoId, { trigger: 'breakout' }).catch(e => {
    notify({ kind: 'clips', title: 'Could not cut Shorts from a breakout', body: e.message, url: `https://youtu.be/${videoId}` }).catch(() => {});
  });
  return true;
}
