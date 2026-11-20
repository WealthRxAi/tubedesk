// Workflow features: bulk metadata edits (preview → apply → undo), finding each upload's source file on this Mac
// (so Shorts can be cut from any of your videos), and one call that makes a finished video from an idea.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { db, getSetting, DATA_DIR } from '../db.js';
import { quotaToday, ytGet, ytWrite } from '../youtube/client.js';
import { getChannel, getVideo } from './channels.js';
import { isAuthorized } from '../youtube/oauth.js';
import * as ren from './render.js';
import * as ai from './ai.js';
import * as accounts from './accounts.js';

const err = (m, status = 400) => Object.assign(new Error(m), { status });
db.exec(`
CREATE TABLE IF NOT EXISTS bulk_batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT, channel_id TEXT NOT NULL, ops_json TEXT NOT NULL, changes_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'preview', results_json TEXT, undo_of INTEGER, created_at TEXT NOT NULL DEFAULT (datetime('now')), applied_at TEXT
);
CREATE TABLE IF NOT EXISTS media_files (
  path TEXT PRIMARY KEY, size INTEGER, mtime INTEGER, duration REAL, width INTEGER, height INTEGER, probed_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

// ======================= bulk editor =======================
const TITLE_MAX = 100, DESC_MAX = 5000, TAGS_MAX = 500;
const escRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function applyText(cur, op) {
  cur = cur || '';
  switch (op.action) {
    case 'set': return String(op.value ?? '');
    case 'append': return cur.replace(/\s+$/, '') + (cur ? (op.separator ?? '\n\n') : '') + String(op.value ?? '');
    case 'prepend': return String(op.value ?? '') + (cur ? (op.separator ?? '\n\n') : '') + cur;
    case 'replace': {
      if (!op.find) throw err('replace needs "find"');
      const re = op.regex ? new RegExp(op.find, op.caseSensitive ? 'g' : 'gi') : new RegExp(escRe(String(op.find)), op.caseSensitive ? 'g' : 'gi');
      return cur.replace(re, String(op.value ?? ''));
    }
    case 'remove-line': { if (!op.find) throw err('remove-line needs "find"'); return cur.split('\n').filter(l => !l.toLowerCase().includes(String(op.find).toLowerCase())).join('\n'); }
    default: throw err(`unknown action "${op.action}" for text (use set, append, prepend, replace, remove-line)`);
  }
}
function applyTags(cur, op) {
  const norm = t => String(t).trim();
  const list = (op.values || (op.value ? String(op.value).split(',') : [])).map(norm).filter(Boolean);
  if (op.action === 'set') return [...new Set(list)];
  if (op.action === 'add') { const have = new Set(cur.map(t => t.toLowerCase())); return [...cur, ...list.filter(t => !have.has(t.toLowerCase()) && have.add(t.toLowerCase()))]; }
  if (op.action === 'remove') { const drop = new Set(list.map(t => t.toLowerCase())); return cur.filter(t => !drop.has(t.toLowerCase())); }
  throw err(`unknown action "${op.action}" for tags (use set, add, remove)`);
}
const tagChars = tags => tags.reduce((n, t) => n + t.length + (/\s/.test(t) ? 2 : 0), 0) + Math.max(0, tags.length - 1);

/**
 * Preview a bulk edit on your own videos. Pick videos by ids, a title search, format and/or date range; ops are
 * applied in order. Nothing changes on YouTube until apply. Returns every change with problems flagged.
 */
export function bulkPreview({ channelId, videoIds = null, q = '', format = 'all', since = null, until = null, ops = [] } = {}) {
  const ch = getChannel(channelId);
  if (!ch || ch.kind !== 'owned') throw err('Bulk edits are for your own channels.');
  if (!Array.isArray(ops) || !ops.length) throw err('ops: give at least one edit, e.g. {"field":"description","action":"append","value":"…"}');
  for (const op of ops) if (!['title', 'description', 'tags'].includes(op.field)) throw err(`field must be title, description or tags (got "${op.field}")`);
  const where = ['channel_id = ?', 'is_live = 0'], args = [channelId];
  if (Array.isArray(videoIds) && videoIds.length) { where.push(`id IN (${videoIds.map(() => '?').join(',')})`); args.push(...videoIds); }
  if (q) { where.push('title LIKE ?'); args.push(`%${q}%`); }
  if (format === 'shorts') where.push('is_short = 1'); else if (format === 'long') where.push('is_short = 0');
  if (since) { where.push('published_at >= ?'); args.push(since); }
  if (until) { where.push('published_at <= ?'); args.push(until); }
  const vids = db.prepare(`SELECT id, title, description, tags_json FROM videos WHERE ${where.join(' AND ')} ORDER BY published_at DESC LIMIT 500`).all(...args);
  const changes = [];
  for (const v of vids) {
    const before = { title: v.title || '', description: v.description || '', tags: v.tags_json ? JSON.parse(v.tags_json) : [] };
    const after = { ...before, tags: [...before.tags] };
    for (const op of ops) after[op.field] = op.field === 'tags' ? applyTags(after.tags, op) : applyText(after[op.field], op);
    const fields = ['title', 'description', 'tags'].filter(f => JSON.stringify(before[f]) !== JSON.stringify(after[f]));
    if (!fields.length) continue;
    const problems = [];
    if (after.title.length > TITLE_MAX) problems.push(`title is ${after.title.length} characters (max ${TITLE_MAX})`);
    if (!after.title.trim()) problems.push('title would be empty');
    if (Buffer.byteLength(after.description) > DESC_MAX) problems.push(`description is ${Buffer.byteLength(after.description)} bytes (max ${DESC_MAX})`);
    if (/[<>]/.test(after.title + after.description)) problems.push('YouTube rejects < and > in titles and descriptions');
    if (tagChars(after.tags) > TAGS_MAX) problems.push(`tags total ${tagChars(after.tags)} characters (max ${TAGS_MAX})`);
    changes.push({ videoId: v.id, fields, before: Object.fromEntries(fields.map(f => [f, before[f]])), after: Object.fromEntries(fields.map(f => [f, after[f]])), problems });
  }
  const id = db.prepare('INSERT INTO bulk_batches (channel_id, ops_json, changes_json) VALUES (?, ?, ?)').run(channelId, JSON.stringify(ops), JSON.stringify(changes)).lastInsertRowid;
  const ok = changes.filter(c => !c.problems.length).length;
  return { batchId: id, matched: vids.length, changes: changes.length, ready: ok, blocked: changes.length - ok, quotaUnits: ok * 51, items: changes, next: ok ? `Apply with bulk_apply {batchId: ${id}} — ${ok} video(s), ${ok * 51} quota units.` : 'Nothing to apply.' };
}

/**
 * Write one video's bulk change straight to YouTube — only the fields this batch changes, never the owner's other
 * staged edits — and only if YouTube still holds the values the preview was made from (an edit made in Studio since
 * the last sync is never overwritten).
 */
async function writeChange(channelId, c, { from = 'before', to = 'after' } = {}) {
  const cur = await ytGet('videos.list', { part: 'snippet', id: c.videoId }, { ttl: 0, noCache: true, channelId });
  const sn = cur.items?.[0]?.snippet;
  if (!sn) throw err('Video not found on YouTube');
  const live = { title: sn.title || '', description: sn.description || '', tags: sn.tags || [] };
  const drift = c.fields.filter(f => JSON.stringify(live[f]) !== JSON.stringify(c[from][f]));
  if (drift.length) return { skipped: `changed on YouTube since the preview (${drift.join(', ')}) — preview again` };
  const next = { ...live }; for (const f of c.fields) next[f] = c[to][f];
  await ytWrite('videos.update', { method: 'PUT', params: { part: 'snippet' }, json: { id: c.videoId, snippet: { title: next.title, description: next.description, tags: next.tags, categoryId: sn.categoryId, defaultLanguage: sn.defaultLanguage } }, channelId });
  for (const f of c.fields) db.prepare('INSERT INTO metadata_history (video_id, field, old_value, new_value) VALUES (?, ?, ?, ?)').run(c.videoId, f, JSON.stringify(c[from][f]), JSON.stringify(c[to][f]));
  db.prepare('UPDATE videos SET title = ?, description = ?, tags_json = ? WHERE id = ?').run(next.title, next.description, JSON.stringify(next.tags), c.videoId);
  return { applied: c.fields };
}
let activeBulk = 0;
let makingCounter = () => 0;
export const registerMaking = fn => { makingCounter = fn; };
export const makingNow = () => makingCounter();
export const bulkBusy = () => activeBulk > 0;

/**
 * Apply a previewed batch. Results are saved after every video, so a quota stop or a restart loses nothing: run
 * apply again to finish (done videos are skipped), and undo always covers every video the batch changed.
 */
export async function bulkApply(batchId) {
  const b = db.prepare('SELECT * FROM bulk_batches WHERE id = ?').get(batchId);
  if (!b) throw err('No such batch', 404);
  if (!['preview', 'partial', 'applying'].includes(b.status)) throw err(`Batch ${batchId} was already ${b.status}.`);
  if (!isAuthorized(b.channel_id)) throw err('Connect this channel with Google first (Channels → Connect with Google).');
  const undoOf = b.undo_of;
  const results = Object.fromEntries((b.results_json ? JSON.parse(b.results_json) : []).map(r => [r.videoId, r]));
  const save = status => db.prepare("UPDATE bulk_batches SET status = ?, results_json = ?, applied_at = datetime('now') WHERE id = ?").run(status, JSON.stringify(Object.values(results)), batchId);
  save('applying');
  activeBulk++;
  try {
    for (const c of JSON.parse(b.changes_json)) {
      if (results[c.videoId]?.applied) continue;
      if (c.problems.length) { results[c.videoId] = { videoId: c.videoId, skipped: c.problems.join('; ') }; continue; }
      if (quotaToday().remaining < 51 + Number(getSetting('yt_quota_reserve', 500))) { results[c.videoId] = { videoId: c.videoId, skipped: 'quota — run apply again after the reset' }; continue; }
      try { results[c.videoId] = { videoId: c.videoId, ...(await writeChange(b.channel_id, c, undoOf ? { from: 'before', to: 'after' } : {})) }; }
      catch (e) { results[c.videoId] = { videoId: c.videoId, error: e.message }; }
      save('applying');
    }
  } finally { activeBulk--; }
  const list = Object.values(results);
  const leftover = list.some(r => /^quota/.test(r.skipped || ''));
  save(leftover ? 'partial' : 'applied');
  return { batchId, applied: list.filter(r => r.applied).length, skipped: list.filter(r => r.skipped).length, failed: list.filter(r => r.error).length, results: list, ...(leftover ? { next: 'Quota ran low: run apply again after midnight Pacific to finish.' } : {}), undo: `bulk_undo {batchId: ${batchId}} puts the old values back.` };
}

/** Undo an applied (or partly applied) batch: every video it changed gets its old values back. */
export async function bulkUndo(batchId) {
  const b = db.prepare('SELECT * FROM bulk_batches WHERE id = ?').get(batchId);
  if (!b || !b.results_json) throw err('Nothing applied in that batch.', 404);
  const applied = new Set(JSON.parse(b.results_json).filter(r => r.applied).map(r => r.videoId));
  const back = JSON.parse(b.changes_json).filter(c => applied.has(c.videoId)).map(c => ({ ...c, before: c.after, after: c.before, problems: [] }));
  if (!back.length) throw err('Nothing to undo.');
  const id = db.prepare('INSERT INTO bulk_batches (channel_id, ops_json, changes_json, undo_of) VALUES (?, ?, ?, ?)').run(b.channel_id, JSON.stringify([{ undo: batchId }]), JSON.stringify(back), batchId).lastInsertRowid;
  db.prepare("UPDATE bulk_batches SET status = 'undone' WHERE id = ? AND status IN ('applied', 'partial')").run(batchId);
  return { undoBatch: id, ...(await bulkApply(id)) };
}
export function bulkBatches(channelId, limit = 20) {
  return db.prepare('SELECT id, status, ops_json, created_at, applied_at, undo_of, json_array_length(changes_json) n FROM bulk_batches WHERE channel_id = ? ORDER BY id DESC LIMIT ?').all(channelId, limit).map(r => ({ ...r, ops: JSON.parse(r.ops_json), ops_json: undefined }));
}

// ======================= source files on this Mac =======================
const VIDEO_EXT = /\.(mp4|mov|m4v|mkv|webm)$/i;
export function mediaDirs() {
  const set = String(getSetting('media_dirs', '')).split(',').map(s => s.trim()).filter(Boolean);
  const home = process.env.TUBEDESK_HOME || os.homedir();
  return (set.length ? set : ['Movies', 'Downloads', 'Desktop', 'Documents'].map(d => path.join(home, d))).map(d => d.replace(/^~(?=\/|$)/, home)).filter(d => fs.existsSync(d));
}
function walk(dir, depth, out, limit) {
  if (depth < 0 || out.length >= limit) return;
  let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    if (e.name.startsWith('.') || e.name === 'node_modules' || /\.(photoslibrary|fcpbundle|app)$/.test(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, depth - 1, out, limit);
    else if (e.isFile() && VIDEO_EXT.test(e.name)) out.push(p);
    if (out.length >= limit) return;
  }
}
/** Probe new/changed video files under the media folders (durations cached by path + mtime). */
export async function scanMedia({ limit = 4000 } = {}) {
  const files = []; for (const d of mediaDirs()) walk(d, 5, files, limit);
  const get = db.prepare('SELECT * FROM media_files WHERE path = ?');
  const put = db.prepare('INSERT INTO media_files (path, size, mtime, duration, width, height) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(path) DO UPDATE SET size = excluded.size, mtime = excluded.mtime, duration = excluded.duration, width = excluded.width, height = excluded.height, probed_at = datetime(\'now\')');
  let probed = 0;
  for (const f of files) {
    let st; try { st = fs.statSync(f); } catch { continue; }
    if (st.size < 1e6) continue;
    const row = get.get(f);
    if (row && row.size === st.size && row.mtime === Math.round(st.mtimeMs)) continue;
    try { const p = await ren.probe(f); put.run(f, st.size, Math.round(st.mtimeMs), p.duration || null, p.video?.width || null, p.video?.height || null); probed++; } catch { /* unreadable */ }
  }
  db.prepare('DELETE FROM media_files WHERE path NOT IN (' + (files.length ? files.map(() => '?').join(',') : "''") + ')').run(...files);
  return { files: files.length, probed };
}
/**
 * Link each of your uploads without a known source file to a video on this Mac with the same length (±1 s) and a
 * file date before the upload. Only unambiguous matches are linked; the rest are listed as candidates.
 */
export async function matchSources(channelId = null, { rescan = true } = {}) {
  if (rescan) await scanMedia();
  const { sourceFileFor } = await import('./transcribe.js');
  const owned = channelId ? [channelId] : db.prepare("SELECT id FROM channels WHERE kind = 'owned'").all().map(r => r.id);
  const linked = [], ambiguous = [];
  for (const cid of owned) {
    for (const v of db.prepare('SELECT id, title, duration_sec, published_at FROM videos WHERE channel_id = ? AND is_live = 0 AND duration_sec > 0').all(cid)) {
      if (sourceFileFor(v.id)) continue;
      const pub = Date.parse(v.published_at);
      // YouTube rounds durations to the second: the file must round to the same length, be dated in the 60 days
      // before the upload (renders are made shortly before publishing), and not already belong to another video.
      const used = new Set(db.prepare("SELECT path FROM autopilot_assets WHERE kind = 'source'").all().map(r => r.path));
      const cands = db.prepare('SELECT path, duration, mtime FROM media_files WHERE ABS(duration - ?) <= 0.6').all(v.duration_sec)
        .filter(m => m.mtime <= pub + 86400000 && m.mtime >= pub - 60 * 86400000 && !used.has(m.path));
      if (cands.length === 1 && db.prepare('SELECT COUNT(*) n FROM videos WHERE channel_id = ? AND ABS(duration_sec - ?) <= 0.6 AND id <> ?').get(cid, v.duration_sec, v.id).n === 0) {
        db.prepare("INSERT INTO autopilot_assets (channel_id, video_id, kind, path, label) VALUES (?, ?, 'source', ?, 'matched by length')").run(cid, v.id, cands[0].path);
        linked.push({ videoId: v.id, title: v.title, file: cands[0].path });
      } else if (cands.length) ambiguous.push({ videoId: v.id, title: v.title, candidates: cands.map(c => c.path).slice(0, 5), note: 'Several possible files (or another upload has the same length): link the right one under Autopilot → Source file.' });
    }
  }
  return { linked, ambiguous, folders: mediaDirs() };
}

// ======================= make a video =======================
const MAKE_DIR = path.join(DATA_DIR, 'made');
function bestSlotFor(channelId, format) {
  return import('./slots.js').then(m => (m.bestSlots || m.nextSlots)(channelId, { format, count: 1 })[0] || null).catch(() => null);
}
/**
 * Idea → finished video: script (AI), titles scored on the virality radar, voiceover (your HeyGen/ElevenLabs voice)
 * with word-timed captions, background (your footage/image, an AI image, or a clean branded card), render,
 * thumbnail, and — when asked — scheduled at the channel's best slot on YouTube and the brand's Instagram/TikTok.
 */
export async function makeVideo({ channelId, topic = '', script = null, title = null, format = 'short', background = null, voiceProvider = null, publish = 'review', log = () => {} } = {}) {
  const ch = getChannel(channelId);
  if (!ch || ch.kind !== 'owned') throw err('Pick one of your own channels.');
  if (!topic && !script) throw err('Give a topic (or a finished script).');
  if (format !== 'short') throw err('format: "short" (vertical, up to 60 s) is supported for made-from-scratch videos; long-form uses your own footage with render_video.');
  fs.mkdirSync(MAKE_DIR, { recursive: true });
  // 1. script + title options
  let plan = { script, titles: title ? [title] : [], headline: '', description: '' };
  if (!script || !title) {
    if (ai.aiProvider() === 'none') throw err('Writing the script needs an AI provider (Settings → AI), or pass script and title yourself.');
    log('writing the script');
    const recent = db.prepare('SELECT title FROM videos WHERE channel_id = ? ORDER BY published_at DESC LIMIT 8').all(channelId).map(r => r.title);
    const out = ai.parseJson(await ai.ask('make_video', `Write a YouTube Short for the channel "${ch.title}" about: ${topic || plan.titles[0]}.
Rules: 40–55 seconds spoken (110–140 words). The first sentence is the hook and must create a question the rest answers.
Plain spoken English, no stage directions, no emojis, no hashtags in the script. Every claim must be true; if unsure, leave it out.
Recent titles on the channel (avoid repeating them): ${recent.join(' | ')}
Return JSON: {"script": "...", "titles": ["5 different titles, each under 60 characters"], "headline": "2–5 word on-screen hook", "description": "2 short sentences"}`, { json: true }));
    plan = { script: script || out.script, titles: title ? [title] : (out.titles || []).slice(0, 5), headline: out.headline || '', description: out.description || '' };
  }
  if (!plan.script || !plan.titles.length) throw err('The AI did not return a usable script; try again or pass script and title.');
  // 2. pick the title the radar likes best
  let chosen = plan.titles[0], scores = null;
  if (plan.titles.length > 1) {
    try {
      const { scorePackages } = await import('./radar.js');
      const r = await scorePackages(channelId, plan.titles.map((t, i) => ({ key: `t${i}`, title: t })), { format: 'short' });
      scores = Object.values(r.results || {}).map(p => ({ title: p.title, score: p.score, predicted: p.prediction?.multiplier ?? null }));
      const best = [...scores].sort((a, b) => (b.score ?? 0) - (a.score ?? 0))[0];
      if (best?.title) chosen = best.title;
    } catch (e) { log(`radar unavailable: ${e.message}`); }
  }
  // 3. voice + timeline (the on-screen hook falls back to the title's first words)
  if (!plan.headline) plan.headline = chosen.replace(/[^\p{L}\p{N}$%' ]/gu, ' ').split(/\s+/).filter(Boolean).slice(0, 4).join(' ');
  log('recording the voiceover');
  const voice = await import('./voice.js');
  let bg = background;
  if (bg === 'ai') {
    try { const thumbs = await import('./thumbs.js'); const img = await thumbs.hfImage({ prompt: `${chosen}. vertical background`, aspect: '9:16', output: path.join(MAKE_DIR, `bg-${Date.now()}.jpg`) }); bg = img?.file || img?.path || img; }
    catch (e) { log(`AI background unavailable (${e.message}) — using a clean card`); bg = null; }
  }
  if (bg && !fs.existsSync(bg)) throw err(`background not found: ${bg}`);
  let timeline, vo;
  if (bg) { const r = await voice.shortFromScript({ text: plan.script, background: bg, headline: plan.headline || undefined, provider: voiceProvider || undefined }); timeline = r.timeline; vo = r.voiceover; }
  else {
    const s = await voice.speak({ text: plan.script, provider: voiceProvider || undefined });
    vo = { id: s.id, file: s.file, duration: s.duration };
    const dur = +(s.duration + 0.6).toFixed(2);
    timeline = { width: 1080, height: 1920, fps: 30, duration: dur, loudness: -14, background: getSetting('make_video_color', '#101318'), tracks: [
      { type: 'box', start: 0, end: dur, x: 60, y: 200, w: 960, h: 8, color: getSetting('make_video_accent', '#c6ff3d'), opacity: 1 },
      ...(plan.headline ? [{ type: 'text', text: plan.headline.toUpperCase(), y: 300, size: 92, font: 'bold', start: 0, end: dur, color: '#ffffff', stroke: 0 }] : []),
      { type: 'text', text: ch.title, y: 1760, size: 40, font: 'regular', start: 0, end: dur, color: '#9aa3b2', stroke: 0 },
      { type: 'audio', src: s.file, start: 0.3, volume: 1 },
      { type: 'captions', groups: s.groups.map(g => ({ ...g, start: +(g.start + 0.3).toFixed(3), end: +(g.end + 0.3).toFixed(3) })), y: 1000, size: 72, font: 'bold' },
    ] };
  }
  const id = `made-${Date.now()}`;
  timeline.output = path.join(MAKE_DIR, `${id}.mp4`);
  log('rendering');
  const job = ren.render(timeline);
  const done = await ren.waitForJob(job.id, 20 * 60 * 1000);
  if (done.status !== 'done') throw err(`render failed: ${done.error || done.status}`, 500);
  const cover = await ren.frame({ file: timeline.output, at: Math.min(2, (vo.duration || 4) / 2), output: path.join(MAKE_DIR, `${id}-cover.jpg`) }).catch(() => null);
  const result = { id, channelId, file: timeline.output, cover: cover?.file || null, title: chosen, titles: plan.titles, scores, script: plan.script, description: plan.description, voiceover: vo, renderJob: job.id };
  // 4. publish
  if (publish === 'schedule' || publish === 'now') result.scheduled = await scheduleFile({ channelId, file: result.file, title: chosen, description: plan.description, cover: result.cover, when: publish });
  else result.next = `Review ${result.file}, then publish with make_video {…, publish: "schedule"} or publish_youtube / publish_instagram.`;
  return result;
}

/** Queue a finished vertical video for this brand: YouTube at the best Shorts slot + the brand's Instagram/TikTok. */
export async function scheduleFile({ channelId, file, title, description = '', cover = null, when = 'schedule' }) {
  const clips = await import('./clips.js');
  const slot = when === 'now' ? { at: new Date(Date.now() + 5 * 60e3).toISOString() } : await bestSlotFor(channelId, 'short');
  const publishAt = slot?.at || new Date(Date.now() + 24 * 3600e3).toISOString();
  const plats = clips.settings().platforms;
  const ig = plats.includes('instagram') ? accounts.forBrand('instagram', channelId) : null;
  const tt = plats.includes('tiktok') ? accounts.forBrand('tiktok', channelId) : null;
  const out = { publishAt, youtube: false, instagram: false, tiktok: false };
  const lead = when === 'now' ? 0 : 90 * 60e3;
  if (plats.includes('youtube') && isAuthorized(channelId)) { clips.enqueue({ platform: 'youtube', channelId, publishAt, runAt: new Date(Date.parse(publishAt) - lead).toISOString(), params: { file, channelId, title, description: `${description}\n\n#Shorts`.trim(), privacy: 'private', tags: ['shorts'] } }); out.youtube = true; }
  if (ig?.token) { clips.enqueue({ platform: 'instagram', channelId, publishAt, runAt: publishAt, params: { kind: 'reel', file, caption: `${title}\n\n${description}`.trim(), cover: cover || undefined, account: ig.account_id } }); out.instagram = '@' + (ig.username || ig.account_id); }
  if (tt?.refresh_token) { clips.enqueue({ platform: 'tiktok', channelId, publishAt, runAt: publishAt, params: { file, title: `${title}${description ? ' — ' + description : ''}`.slice(0, 2200), account: tt.account_id } }); out.tiktok = '@' + (tt.username || tt.account_id); }
  return out;
}
export { getVideo };
