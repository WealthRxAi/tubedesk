// Radar autopilot: when an upload lags its usual launch curve (or its CTR is well below the channel's normal),
// diagnose why, generate truthful alternative titles and thumbnails, score them on the radar against the current
// package, and — if one wins by a clear margin — swap it in through the owner's Google connection.
// Guardrails: one swap per video, never touches a video with the owner's own staged edits pending, Shorts excluded
// by default, every change is logged with the original saved for one-click undo, and after 48 h the change is
// graded on real CTR (Reporting API) and reverted automatically if it made things worse.
import fs from 'node:fs';
import path from 'node:path';
import { db, getSetting, DATA_DIR } from '../db.js';
import { isAuthorized } from '../youtube/oauth.js';
import { getChannel, syncVideos } from './channels.js';
import { downloadImage, stageEdit, applyStaged, setThumbnail, assertThumbPath } from './packaging.js';
import { scorePackages, buildCorpus, aiAvailable } from './radar.js';
import * as reach from './reach.js';
import * as render from './render.js';
import { notify } from './notify.js';
import * as ai from './ai.js';

db.exec(`
CREATE TABLE IF NOT EXISTS autopilot_actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id TEXT NOT NULL,
  video_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  trigger TEXT,
  diagnosis_json TEXT,
  mode TEXT,
  status TEXT NOT NULL,          -- applied | suggested | skipped | failed | reverted | kept
  message TEXT,
  before_title TEXT, before_thumb_path TEXT, before_thumb_url TEXT, before_score REAL,
  after_title TEXT, after_thumb_path TEXT, after_score REAL,
  changed TEXT,                  -- title | thumbnail | title,thumbnail
  candidates_json TEXT,
  pace_at REAL,
  ctr_before REAL, ctr_after REAL, imp_before INTEGER, imp_after INTEGER,
  applied_at TEXT, evaluated_at TEXT, outcome TEXT
);
CREATE INDEX IF NOT EXISTS idx_autopilot_video ON autopilot_actions(video_id, id);
CREATE TABLE IF NOT EXISTS autopilot_assets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id TEXT,
  video_id TEXT NOT NULL,
  kind TEXT NOT NULL,            -- thumbnail | source
  path TEXT NOT NULL,
  label TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_autopilot_assets_video ON autopilot_assets(video_id);
`);

export function settings() {
  return {
    mode: getSetting('autopilot_mode', 'auto'),               // auto | suggest | off
    minGain: Number(getSetting('autopilot_min_gain', 8)),     // radar points a candidate must win by
    minHours: Number(getSetting('autopilot_min_hours', 24)),
    maxDays: Number(getSetting('autopilot_max_days', 7)),
    shorts: getSetting('autopilot_shorts', '0') === '1',
    titles: getSetting('autopilot_titles', '1') === '1',
    thumbnails: getSetting('autopilot_thumbnails', '1') === '1',
    autoRevert: getSetting('autopilot_auto_revert', '1') === '1',
    revertDrop: Number(getSetting('autopilot_revert_drop', 0.15)), // revert when CTR after < CTR before × (1 − this)
  };
}

const THUMBS = () => path.join(DATA_DIR, 'thumbs');
const fmtCtr = v => v === null || v === undefined ? 'n/a' : v.toFixed(1) + '%';

/** Why is this upload lagging? Uses real CTR/impressions when the Reporting API has data for it. */
export function diagnose(video, { paceIndex = null } = {}) {
  const ageDays = Math.max(1, Math.ceil((Date.now() - Date.parse(video.published_at)) / 86400000));
  const r = reach.videoReach(video.id);
  const base = r ? reach.channelBaseline(video.channel_id, { days: Math.max(1, Math.min(ageDays, r.days, 3)), excludeId: video.id, isShort: !!video.is_short }) : null;
  const out = { paceIndex, ctr: r?.ctr ?? null, impressions: r?.impressions ?? null, ctrBaseline: base?.ctr ?? null, impressionsBaseline: base?.impressions ?? null, reachDays: r?.days ?? 0 };
  if (r && r.ctr !== null && r.impressions >= 200 && base) {
    out.ctrRatio = r.ctr / base.ctr;
    out.impRatio = r.impressions / Math.max(1, base.impressions);
    if (out.ctrRatio < 0.85) return { ...out, kind: 'packaging', text: `CTR ${fmtCtr(r.ctr)} vs your usual ${fmtCtr(base.ctr)}: people see it but don't click. Title/thumbnail is the lever.` };
    if (out.impRatio < 0.7) return { ...out, kind: 'reach', text: `People who see it click at your usual rate (${fmtCtr(r.ctr)}), but YouTube is showing it ${Math.round((1 - out.impRatio) * 100)}% less than your usual launch. Packaging is not the problem; push it yourself (community post, a Short pointing to it, end screens).` };
    return { ...out, kind: 'other', text: `CTR (${fmtCtr(r.ctr)}) and impressions are near normal; the gap is likely watch time. Check the retention curve for an early drop.` };
  }
  return { ...out, kind: 'unknown', text: `No CTR yet (YouTube's reach reports arrive ~2 days after a day ends). Views are at ${paceIndex === null ? '?' : paceIndex.toFixed(2) + '×'} your usual pace, so the packaging is the fastest lever to test.` };
}

function sourceFileFor(videoId) {
  const a = db.prepare("SELECT path FROM autopilot_assets WHERE video_id = ? AND kind = 'source' ORDER BY id DESC LIMIT 1").get(videoId);
  if (a && fs.existsSync(a.path)) return a.path;
  const j = db.prepare("SELECT file FROM publish_jobs WHERE platform = 'youtube' AND remote_id = ? AND status = 'done' ORDER BY created_at DESC LIMIT 1").get(videoId);
  return j && fs.existsSync(j.file) ? j.file : null;
}

async function generateTitles(video, diag) {
  const corpus = buildCorpus(video.channel_id);
  const winners = corpus.filter(r => r.own && r.y !== null && r.y >= 0.6).sort((a, b) => b.y - a.y).slice(0, 6).map(r => `- ${r.title} (${(2 ** r.y).toFixed(1)}× usual)`);
  const prompt = `A YouTube video is underperforming and needs a better title. Rewrite the packaging WITHOUT changing what the video is about.
Current title: ${video.title}
Description (source of truth for what the video delivers — do not add claims beyond it): """${String(video.description || '').slice(0, 900)}"""
Diagnosis: ${diag.text}
This channel's best-performing titles (learn the style, never copy):
${winners.join('\n') || '- none yet'}
Write 4 alternative titles, each under 60 characters and each a different angle: (1) specific outcome or number, (2) curiosity gap, (3) stakes or warning, (4) the viewer's own question in their words. Every title must be honest to the video.
Also write thumbText: 2-4 punchy words for the thumbnail that COMPLEMENT the strongest title (never repeat it).
Return JSON: {"titles":[{"title":"...","angle":"..."}],"thumbText":"..."}`;
  const out = await ai.ask('autopilot_titles', prompt, { json: true });
  const seen = new Set([video.title.toLowerCase()]);
  const titles = (out.titles || []).map(t => String(t.title || '').trim().slice(0, 100)).filter(t => t && !seen.has(t.toLowerCase()) && seen.add(t.toLowerCase())).slice(0, 4);
  return { titles, thumbText: String(out.thumbText || '').slice(0, 40) };
}

async function thumbnailCandidates(video, thumbText) {
  const out = [];
  for (const a of db.prepare("SELECT * FROM autopilot_assets WHERE video_id = ? AND kind = 'thumbnail' ORDER BY id").all(video.id)) {
    try { out.push({ path: assertThumbPath(a.path), label: a.label || 'from your thumbnail bank' }); } catch { /* moved or deleted */ }
  }
  const src = sourceFileFor(video.id);
  if (src && out.length < 3) {
    try {
      const pr = await render.probe(src);
      const dur = Number(pr.duration) || 60;
      for (const frac of [0.22, 0.48, 0.71]) {
        if (out.length >= 3) break;
        const file = path.join(THUMBS(), `autopilot-${video.id}-${Math.round(frac * 100)}.jpg`);
        await render.thumbnailCard({ file: src, at: Math.max(0.5, dur * frac).toFixed(2), text: thumbText, output: file });
        out.push({ path: file, label: `frame at ${Math.round(frac * 100)}% + "${thumbText}"` });
      }
    } catch (e) { out.push({ error: `Could not cut frames from ${path.basename(src)}: ${e.message}` }); }
  }
  return out;
}

function attempts(videoId) { return db.prepare('SELECT * FROM autopilot_actions WHERE video_id = ? ORDER BY id').all(videoId); }

/** Decide whether autopilot should act on this upload now. */
export function shouldRun(video, { status, ageHours, confidence, paceIndex }) {
  const s = settings();
  if (s.mode === 'off') return { run: false, why: 'autopilot is off' };
  if (video.is_short && !s.shorts) return { run: false, why: 'Shorts are excluded' };
  if (ageHours < s.minHours || ageHours > s.maxDays * 24) return { run: false, why: 'outside the age window' };
  const prev = attempts(video.id);
  if (prev.some(a => ['applied', 'suggested', 'reverted', 'kept'].includes(a.status))) return { run: false, why: 'already handled' };
  if (prev.length >= 2) return { run: false, why: 'two attempts already' };
  if (prev.length && Date.now() - Date.parse(prev.at(-1).created_at.replace(' ', 'T') + 'Z') < 24 * 3600e3) return { run: false, why: 'tried less than 24 h ago' };
  const d = diagnose(video, { paceIndex });
  const lagging = ['lagging', 'stalled'].includes(status) && confidence !== 'low' && confidence !== 'none';
  const lowCtr = d.kind === 'packaging' && d.ctrRatio < 0.75 && ageHours >= 48;
  if (!lagging && !lowCtr) return { run: false, why: 'not lagging', diagnosis: d };
  if (d.kind === 'reach' || d.kind === 'other') return { run: false, why: 'packaging is not the problem', diagnosis: d, notifyOnly: true };
  return { run: true, diagnosis: d, trigger: lowCtr ? 'low CTR' : `pace ${paceIndex?.toFixed(2)}× (${status})` };
}

/**
 * Run the autopilot for one owned video. opts.force skips the lag check (manual "run now").
 * Returns the stored action.
 */
const inFlight = new Map(); // videoId → promise: a manual run and the hourly watch never act on one video twice
export function runForVideo(videoId, opts = {}) {
  if (inFlight.has(videoId)) return inFlight.get(videoId);
  const p = runForVideoInner(videoId, opts).finally(() => inFlight.delete(videoId));
  inFlight.set(videoId, p);
  return p;
}
async function runForVideoInner(videoId, { force = false, trigger = 'manual', paceIndex = null, diagnosis = null } = {}) {
  let video = db.prepare('SELECT * FROM videos WHERE id = ?').get(videoId);
  if (!video) {
    // A fresh upload the daily sync hasn't stored yet: pull the newest uploads of the owning channel (≈2 quota units).
    const w = db.prepare('SELECT channel_id FROM radar_watch WHERE video_id = ?').get(videoId);
    if (w) { try { await syncVideos(w.channel_id, { maxVideos: 10, force: true }); } catch { /* fall through */ } }
    video = db.prepare('SELECT * FROM videos WHERE id = ?').get(videoId);
  }
  if (!video) throw Object.assign(new Error('Video not synced'), { status: 404 });
  const ch = getChannel(video.channel_id);
  if (!ch || ch.kind !== 'owned') throw Object.assign(new Error('Autopilot only works on your own channels'), { status: 400 });
  const s = settings();
  const diag = diagnosis || diagnose(video, { paceIndex });
  const record = (fields) => {
    const cols = Object.keys(fields);
    const r = db.prepare(`INSERT INTO autopilot_actions (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...cols.map(c => fields[c]));
    return getAction(r.lastInsertRowid);
  };
  const base = { channel_id: video.channel_id, video_id: video.id, trigger: force ? 'manual' : trigger, diagnosis_json: JSON.stringify(diag), mode: s.mode, before_title: video.title, before_thumb_url: video.thumbnail, pace_at: paceIndex };
  if (!aiAvailable()) return record({ ...base, status: 'skipped', message: 'Autopilot needs the AI provider (Settings → AI) to write and rate new titles.' });
  const live = attempts(video.id).find(a => ['applied', 'suggested'].includes(a.status));
  if (live) return getAction(live.id); // one open change per video: undo or resolve it before running again
  if (!force && (diag.kind === 'reach' || diag.kind === 'other')) return record({ ...base, status: 'skipped', message: diag.text });

  // Current package (keep a local copy of the live thumbnail for undo).
  let curThumb = null;
  try { curThumb = video.thumbnail ? await downloadImage(video.thumbnail) : null; } catch { curThumb = null; }
  let gen;
  try { gen = await generateTitles(video, diag); } catch (e) { return record({ ...base, before_thumb_path: curThumb, status: 'failed', message: 'Title generation failed: ' + e.message }); }
  const thumbs = s.thumbnails ? await thumbnailCandidates(video, gen.thumbText) : [];
  const usableThumbs = thumbs.filter(t => t.path).slice(0, 3);
  const packages = [{ key: 'cur', title: video.title, image: curThumb }];
  if (s.titles) gen.titles.forEach((t, i) => packages.push({ key: 't' + (i + 1), title: t, image: curThumb }));
  usableThumbs.forEach((t, i) => packages.push({ key: 'i' + (i + 1), title: video.title, image: t.path }));
  const { results, notes } = await scorePackages(video.channel_id, packages, { format: video.is_short ? 'short' : 'long' });
  const cur = results.cur;
  const titleWin = Object.values(results).filter(r => r.key === 'cur' || r.key.startsWith('t')).sort((a, b) => (b.score ?? -1) - (a.score ?? -1))[0];
  const thumbWin = Object.values(results).filter(r => r.key === 'cur' || r.key.startsWith('i')).sort((a, b) => (b.score ?? -1) - (a.score ?? -1))[0];
  // An image is only "rated" when the AI actually scored the thumbnail axis.
  const gainT = titleWin && titleWin.key !== 'cur' ? (titleWin.score ?? 0) - (cur.score ?? 0) : 0;
  const gainI = thumbWin && thumbWin.key !== 'cur' && Number.isFinite(thumbWin.axes.thumbnail) ? (thumbWin.score ?? 0) - (cur.score ?? 0) : 0;
  const newTitle = gainT >= s.minGain ? titleWin.title : null;
  // Only swap a thumbnail when the current one is saved locally, so undo/auto-revert can always restore it.
  const newThumb = gainI >= s.minGain && curThumb ? usableThumbs[Number(thumbWin.key.slice(1)) - 1].path : null;
  const candidates = { titles: packages.filter(p => p.key.startsWith('t')).map(p => ({ title: p.title, score: results[p.key].score, axes: results[p.key].axes })),
    thumbnails: usableThumbs.map((t, i) => ({ path: t.path, url: '/data/thumbs/' + path.basename(t.path), label: t.label, score: results['i' + (i + 1)]?.score, thumbnailAxis: results['i' + (i + 1)]?.axes.thumbnail })),
    thumbErrors: thumbs.filter(t => t.error).map(t => t.error), current: { score: cur.score, axes: cur.axes }, thumbText: gen.thumbText, notes };
  const common = { ...base, before_thumb_path: curThumb, before_score: cur.score, candidates_json: JSON.stringify(candidates) };
  if (!newTitle && !newThumb) {
    return record({ ...common, status: 'skipped', message: `No candidate beat the current package by ${s.minGain}+ radar points (best title ${titleWin?.score ?? '—'}, best thumbnail ${thumbWin?.score ?? '—'} vs current ${cur.score ?? '—'}). Left unchanged.` });
  }
  const afterScore = Math.max(newTitle ? titleWin.score : 0, newThumb ? thumbWin.score : 0);
  const changed = [newTitle && 'title', newThumb && 'thumbnail'].filter(Boolean).join(',');
  const otherStaged = db.prepare("SELECT COUNT(*) AS n FROM staged_edits WHERE video_id = ? AND status = 'staged'").get(video.id).n;
  const canApply = s.mode === 'auto' && isAuthorized(video.channel_id) && !otherStaged;
  if (!canApply) {
    if (newTitle && !otherStaged) stageEdit({ channelId: video.channel_id, videoId: video.id, field: 'title', newValue: newTitle });
    const why = s.mode !== 'auto' ? 'suggest mode' : !isAuthorized(video.channel_id) ? 'channel not connected with Google' : 'you have your own staged edits pending on this video';
    const a = record({ ...common, after_title: newTitle, after_thumb_path: newThumb, after_score: afterScore, changed, status: 'suggested', message: `Suggested (${why}). Approve in Virality radar → Autopilot.` });
    notify({ kind: 'autopilot', title: `Autopilot suggestion for "${video.title}"`, body: `${diag.text}\n${newTitle ? `New title: "${newTitle}"` : ''}${newThumb ? '\nNew thumbnail ready.' : ''}\nRadar ${cur.score} → ${afterScore}. Approve in TubeDesk → Virality radar → Autopilot.`, url: `https://youtu.be/${video.id}` }).catch(() => {});
    return a;
  }
  try {
    if (newTitle) { stageEdit({ channelId: video.channel_id, videoId: video.id, field: 'title', newValue: newTitle }); await applyStaged(video.channel_id, video.id); }
    if (newThumb) await setThumbnail(video.channel_id, video.id, newThumb);
  } catch (e) {
    return record({ ...common, after_title: newTitle, after_thumb_path: newThumb, after_score: afterScore, changed, status: 'failed', message: 'YouTube rejected the change: ' + e.message });
  }
  const a = record({ ...common, after_title: newTitle, after_thumb_path: newThumb, after_score: afterScore, changed, status: 'applied', applied_at: new Date().toISOString(), message: `Changed ${changed.replace(',', ' and ')} (radar ${cur.score} → ${afterScore}). Graded on real CTR after 48 h; reverted automatically if CTR drops.` });
  notify({ kind: 'autopilot', title: `Autopilot updated "${video.title}"`, body: `${diag.text}\n${newTitle ? `Title → "${newTitle}"\n` : ''}${newThumb ? 'New thumbnail set.\n' : ''}Radar ${cur.score} → ${afterScore}. Undo anytime: TubeDesk → Virality radar → Autopilot.`, url: `https://youtu.be/${video.id}` }).catch(() => {});
  return a;
}

/** Approve a suggestion (applies the staged title and/or the thumbnail). */
export async function approve(id) {
  const a = getAction(id);
  if (!a || a.status !== 'suggested') throw Object.assign(new Error('Only suggestions can be approved'), { status: 400 });
  if (a.after_title) {
    const staged = db.prepare("SELECT COUNT(*) AS n FROM staged_edits WHERE video_id = ? AND field = 'title' AND status = 'staged' AND new_value = ?").get(a.video_id, a.after_title).n;
    if (!staged) stageEdit({ channelId: a.channel_id, videoId: a.video_id, field: 'title', newValue: a.after_title });
    await applyStaged(a.channel_id, a.video_id);
  }
  if (a.after_thumb_path) await setThumbnail(a.channel_id, a.video_id, a.after_thumb_path);
  db.prepare("UPDATE autopilot_actions SET status = 'applied', applied_at = ?, message = ? WHERE id = ?").run(new Date().toISOString(), 'Approved and applied. Graded on real CTR after 48 h.', id);
  return getAction(id);
}

export async function revert(id, { reason = 'Reverted by you.' } = {}) {
  const a = getAction(id);
  if (!a || !['applied', 'kept'].includes(a.status)) throw Object.assign(new Error('Only applied changes can be reverted'), { status: 400 });
  if (a.after_title && a.before_title) { stageEdit({ channelId: a.channel_id, videoId: a.video_id, field: 'title', newValue: a.before_title }); await applyStaged(a.channel_id, a.video_id); }
  if (a.after_thumb_path && a.before_thumb_path) await setThumbnail(a.channel_id, a.video_id, a.before_thumb_path);
  db.prepare("UPDATE autopilot_actions SET status = 'reverted', outcome = COALESCE(outcome, '') || ? WHERE id = ?").run((a.outcome ? ' ' : '') + reason, id);
  return getAction(id);
}

function ctrSplit(videoId, appliedAt) {
  const day = String(appliedAt).slice(0, 10);
  const rows = db.prepare('SELECT day, impressions, ctr FROM reach_daily WHERE video_id = ? AND ctr IS NOT NULL').all(videoId);
  const agg = list => { const imp = list.reduce((x, r) => x + r.impressions, 0); return { imp, ctr: imp ? list.reduce((x, r) => x + r.ctr * r.impressions, 0) / imp : null }; };
  return { before: agg(rows.filter(r => r.day < day)), after: agg(rows.filter(r => r.day > day)) };
}

/** Grade applied changes on real CTR once enough post-change impressions exist; revert losers when enabled. */
export async function evaluatePending() {
  const s = settings();
  const out = [];
  for (const a of db.prepare("SELECT * FROM autopilot_actions WHERE status = 'applied' AND evaluated_at IS NULL").all()) {
    const ageH = (Date.now() - Date.parse(a.applied_at)) / 3600e3;
    if (ageH < 48) continue;
    const { before, after } = ctrSplit(a.video_id, a.applied_at);
    const w = db.prepare('SELECT idx FROM radar_watch WHERE video_id = ?').get(a.video_id);
    if (before.imp >= 300 && after.imp >= 300 && before.ctr !== null && after.ctr !== null) {
      const worse = after.ctr < before.ctr * (1 - s.revertDrop);
      const outcome = `CTR ${fmtCtr(before.ctr)} before → ${fmtCtr(after.ctr)} after (${before.imp.toLocaleString()} / ${after.imp.toLocaleString()} impressions); pace ${a.pace_at?.toFixed(2) ?? '?'}× → ${w?.idx?.toFixed(2) ?? '?'}×.`;
      db.prepare("UPDATE autopilot_actions SET ctr_before = ?, ctr_after = ?, imp_before = ?, imp_after = ?, evaluated_at = datetime('now'), outcome = ?, status = ? WHERE id = ?")
        .run(before.ctr, after.ctr, before.imp, after.imp, outcome, worse ? 'applied' : 'kept', a.id);
      const current = db.prepare('SELECT title FROM videos WHERE id = ?').get(a.video_id)?.title;
      const userChanged = a.after_title && current && current !== a.after_title;
      if (worse && s.autoRevert && userChanged) {
        db.prepare('UPDATE autopilot_actions SET message = ? WHERE id = ?').run('CTR fell after the change, but you have edited the title since, so the autopilot left your version in place.', a.id);
        notify({ kind: 'autopilot_revert', title: `CTR fell after the autopilot change on "${current}"`, body: outcome + ' You edited the title since, so nothing was reverted.', url: `https://youtu.be/${a.video_id}` }).catch(() => {});
      } else if (worse && s.autoRevert) {
        try {
          await revert(a.id, { reason: 'Auto-reverted: CTR fell after the change.' });
          notify({ kind: 'autopilot_revert', title: `Autopilot reverted "${a.after_title || a.before_title}"`, body: outcome + ' The original packaging is back.', url: `https://youtu.be/${a.video_id}` }).catch(() => {});
        } catch (e) { db.prepare('UPDATE autopilot_actions SET message = ? WHERE id = ?').run('Auto-revert failed: ' + e.message, a.id); }
      }
      out.push({ id: a.id, outcome, reverted: worse && s.autoRevert && !userChanged });
    } else if (ageH > 7 * 24) {
      db.prepare("UPDATE autopilot_actions SET evaluated_at = datetime('now'), status = 'kept', outcome = ? WHERE id = ?").run('Kept: not enough CTR data from YouTube to grade the change within 7 days.', a.id);
      out.push({ id: a.id, outcome: 'kept (no CTR data)' });
    }
  }
  return out;
}

export function getAction(id) {
  const a = db.prepare('SELECT a.*, v.title AS video_title, v.thumbnail AS video_thumbnail FROM autopilot_actions a LEFT JOIN videos v ON v.id = a.video_id WHERE a.id = ?').get(id);
  if (!a) return null;
  return { ...a, diagnosis: JSON.parse(a.diagnosis_json || 'null'), candidates: JSON.parse(a.candidates_json || 'null'), diagnosis_json: undefined, candidates_json: undefined,
    before_thumb: a.before_thumb_path ? '/data/thumbs/' + path.basename(a.before_thumb_path) : a.before_thumb_url, after_thumb: a.after_thumb_path ? '/data/thumbs/' + path.basename(a.after_thumb_path) : null };
}
export function listActions(channelId, limit = 50) {
  return db.prepare('SELECT id FROM autopilot_actions WHERE channel_id = ? ORDER BY id DESC LIMIT ?').all(channelId, limit).map(r => getAction(r.id));
}

export function addAsset({ videoId, kind = 'thumbnail', path: p, label = '' }) {
  const v = db.prepare('SELECT channel_id FROM videos WHERE id = ?').get(videoId);
  if (kind === 'thumbnail') p = assertThumbPath(p);
  else if (kind === 'source') { p = path.resolve(String(p || '')); if (!fs.existsSync(p)) throw Object.assign(new Error('Source video not found on this machine: ' + p), { status: 400 }); }
  else throw Object.assign(new Error('kind must be thumbnail or source'), { status: 400 });
  const r = db.prepare('INSERT INTO autopilot_assets (channel_id, video_id, kind, path, label) VALUES (?, ?, ?, ?, ?)').run(v?.channel_id || null, videoId, kind, p, label);
  return db.prepare('SELECT * FROM autopilot_assets WHERE id = ?').get(r.lastInsertRowid);
}
export function listAssets(videoId) {
  return db.prepare('SELECT * FROM autopilot_assets WHERE video_id = ? ORDER BY id').all(videoId).map(a => ({ ...a, url: a.kind === 'thumbnail' ? '/data/thumbs/' + path.basename(a.path) : null }));
}
export function removeAsset(id) { return db.prepare('DELETE FROM autopilot_assets WHERE id = ?').run(id).changes; }
