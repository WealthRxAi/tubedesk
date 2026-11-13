// Thumbnail maker: frame × headline × style variants from a local video (free, ffmpeg), optional AI-generated backgrounds
// through Higgsfield's API when a key is set, and a 0–100 score per candidate from the thumbnail critic.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { db, getSetting, DATA_DIR } from '../db.js';
import { frame, probe, fonts, toolStatus } from './render.js';
import * as pack from './packaging.js';
import { spawn } from 'node:child_process';

const THUMB_DIR = path.join(DATA_DIR, 'thumbs', 'maker'); // inside data/thumbs so the critic and thumbnails.set accept the files
const HF_BASE = () => process.env.HF_API_BASE || 'https://platform.higgsfield.ai';

db.exec(`CREATE TABLE IF NOT EXISTS thumbnail_sets (
  id TEXT PRIMARY KEY, title TEXT, source TEXT, candidates_json TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`);

export const STYLES = {
  bold: { desc: 'White + yellow headline bottom-left, dark gradient', accent: '0xFFD60A', gradient: true },
  clean: { desc: 'Single white line, centered, no gradient', accent: 'white', gradient: false, center: true },
  alert: { desc: 'Red box behind line 1, white line 2', accent: 'white', gradient: true, box: '0xE11D48' },
  contrast: { desc: 'Yellow box, black text — highest contrast at small sizes', accent: 'black', gradient: false, box: '0xFFD60A', textColor: 'black' },
};

function esc(s) { return String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\\\\\'").replace(/:/g, '\\:').replace(/%/g, '\\%').replace(/,/g, '\\,'); }
function run(bin, args) { return new Promise((res, rej) => { const p = spawn(bin, args); let err = ''; p.stderr.on('data', d => err += d); p.on('error', rej); p.on('close', c => c === 0 ? res() : rej(new Error(err.trim().split('\n').pop() || `${bin} exited ${c}`))); }); }
function ffmpeg() { const s = toolStatus(); if (!s.ffmpeg) throw new Error(s.hint); return s.ffmpeg; }

export function status() {
  const hf = !!getSetting('higgsfield_api_key', '') && !!getSetting('higgsfield_api_secret', '');
  return { ffmpeg: toolStatus().ready, higgsfield: hf, styles: Object.fromEntries(Object.entries(STYLES).map(([k, v]) => [k, v.desc])), dir: THUMB_DIR, sets: db.prepare('SELECT COUNT(*) c FROM thumbnail_sets').get().c };
}

/** Split a headline into ≤2 lines of ≤3–4 words; honour an explicit "|" break. */
export function splitHeadline(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return [];
  if (t.includes('|')) return t.split('|').map(s => s.trim().toUpperCase()).filter(Boolean).slice(0, 2);
  const words = t.toUpperCase().split(' ').slice(0, 7);
  if (words.length <= 3) return [words.join(' ')];
  const half = Math.ceil(words.length / 2);
  return [words.slice(0, half).join(' '), words.slice(half).join(' ')];
}

/** Compose one 1280×720 candidate: background image + headline in a style. */
export async function compose({ background, headline, style = 'bold', output, focus = [0.5, 0.4] }) {
  const st = STYLES[style]; if (!st) throw new Error(`unknown style; use ${Object.keys(STYLES).join(', ')}`);
  const font = fonts().bold || fonts().regular;
  const lines = splitHeadline(headline);
  const out = output ? path.resolve(output) : path.join(THUMB_DIR, `thumb-${crypto.randomBytes(4).toString('hex')}.jpg`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const longest = Math.max(1, ...lines.map(l => l.length));
  const size = Math.max(64, Math.min(150, Math.floor(1160 / (longest * 0.6))));
  const vf = [`scale=1280:720:force_original_aspect_ratio=increase:flags=lanczos`, `crop=1280:720:(iw-1280)*${(focus[0]).toFixed(3)}:(ih-720)*${(focus[1]).toFixed(3)}`, 'eq=contrast=1.08:saturation=1.2'];
  if (st.gradient) vf.push(`drawbox=x=0:y=360:w=1280:h=360:color=black@0.45:t=fill`);
  if (lines.length && font) {
    const n = lines.length;
    lines.forEach((l, i) => {
      const y = st.center ? (n === 1 ? '(h-th)/2' : i === 0 ? `h/2-${size}` : `h/2+20`) : (n === 1 ? `h-th-70` : i === 0 ? `h-${2 * size + 100}` : `h-${size + 70}`);
      const x = st.center ? '(w-tw)/2' : '56';
      const color = i === 1 && !st.textColor ? st.accent : (st.textColor || 'white');
      const box = st.box && (i === 0 || st.textColor) ? `:box=1:boxcolor=${st.box}:boxborderw=18` : '';
      vf.push(`drawtext=fontfile=${font}:text='${esc(l)}':fontcolor=${color}:fontsize=${size}:borderw=${box ? 0 : Math.max(6, Math.round(size / 12))}:bordercolor=black:x=${x}:y=${y}${box}`);
    });
  }
  await run(ffmpeg(), ['-y', '-loglevel', 'error', '-i', path.resolve(background), '-frames:v', '1', '-vf', vf.join(','), '-q:v', '2', out]);
  return { file: out, style, lines, size };
}

/** Pick N evenly spaced frames, skipping the first/last 5% (intro cards and end screens). */
export async function pickFrames(file, n = 4) {
  const p = await probe(file);
  const dur = p.duration || 10;
  const ts = []; for (let i = 0; i < n; i++) ts.push(+(dur * (0.08 + 0.84 * (n === 1 ? 0.3 : i / (n - 1)))).toFixed(2));
  fs.mkdirSync(path.join(THUMB_DIR, 'frames'), { recursive: true });
  const out = [];
  for (const at of ts) out.push({ at, ...(await frame({ file, at, output: path.join(THUMB_DIR, 'frames', `${path.basename(file, path.extname(file))}-${String(at).replace('.', '_')}.jpg`), width: 1280 })) });
  return out;
}

/** Higgsfield text→image for a thumbnail background (optional; costs credits on the user's existing plan). */
export async function hfImage({ prompt, aspect = '16:9', model = 'soul', output, timeoutMs = 180000 }) {
  const k = getSetting('higgsfield_api_key', ''), s = getSetting('higgsfield_api_secret', '');
  if (!k || !s) throw new Error('Higgsfield API key + secret are not set (Settings → Thumbnails). The maker still works with frames from your own video.');
  const headers = { 'hf-api-key': k, 'hf-secret': s, 'content-type': 'application/json' };
  const r = await fetch(`${HF_BASE()}/v1/text2image/${model}`, { method: 'POST', headers, body: JSON.stringify({ params: { prompt: `${prompt}. YouTube thumbnail background, no text, cinematic lighting, high contrast, 16:9`, aspect_ratio: aspect, quality: '1080p', enhance_prompt: true } }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j?.detail || j?.message || `Higgsfield ${r.status}`);
  const id = j.id || j.request_id; if (!id) throw new Error('Higgsfield returned no request id');
  const t0 = Date.now(); let url = null;
  while (Date.now() - t0 < timeoutMs) {
    await new Promise(r => setTimeout(r, process.env.HF_API_BASE ? 50 : 4000));
    const st = await fetch(`${HF_BASE()}/v1/requests/${id}`, { headers }).then(r => r.json()).catch(() => ({}));
    const status = (st.status || '').toLowerCase();
    if (['completed', 'succeeded', 'success'].includes(status)) { url = st.images?.[0]?.url || st.output?.[0]?.url || st.result?.url; break; }
    if (['failed', 'nsfw', 'cancelled', 'error'].includes(status)) throw new Error(`Higgsfield ${status}: ${st.error || ''}`);
  }
  if (!url) throw new Error('Higgsfield timed out');
  const buf = Buffer.from(await (await fetch(url)).arrayBuffer());
  const out = output ? path.resolve(output) : path.join(THUMB_DIR, 'ai', `hf-${id}.jpg`);
  fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, buf);
  return { file: out, id, url };
}

/**
 * Make a set of candidates: frames (or AI backgrounds) × headlines × styles, score each with the critic when AI is available.
 * `headlines` — up to 3 strings; `styles` — subset of STYLES; `ai` — {prompt} to add a Higgsfield background; `score` — run the critic.
 */
export async function makeSet({ file, title = '', headlines = [], styles = ['bold', 'contrast'], frames = 3, backgrounds = [], ai = null, score = true, max = 12 }) {
  if (!file && !backgrounds.length && !ai) throw new Error('file (video), backgrounds[] (images) or ai {prompt} is required');
  if (!headlines.length) headlines = [title.split(/[:|—-]/)[0].trim().split(' ').slice(0, 5).join(' ')].filter(Boolean);
  const bgs = backgrounds.map(b => ({ file: path.resolve(b), source: 'image' }));
  if (file) for (const f of await pickFrames(file, frames)) bgs.push({ file: f.file, at: f.at, source: 'frame' });
  const notes = [];
  if (ai?.prompt) { try { const g = await hfImage(ai); bgs.unshift({ file: g.file, source: 'higgsfield', prompt: ai.prompt }); } catch (e) { notes.push(`Higgsfield skipped: ${e.message}`); } }
  const candidates = [];
  outer: for (const bg of bgs) for (const h of headlines) for (const st of styles) {
    if (candidates.length >= max) break outer;
    const c = await compose({ background: bg.file, headline: h, style: st });
    candidates.push({ ...c, headline: h, background: bg.file, source: bg.source, at: bg.at ?? null, score: null, critique: null });
  }
  if (score) for (const c of candidates) {
    try { const cr = await pack.critiqueThumbnail({ localPath: c.file, title }); c.score = cr?.score ?? cr?.overall ?? null; c.critique = cr; }
    catch (e) { c.critique = { error: e.message }; if (!notes.includes('scoring unavailable: ' + e.message)) notes.push('scoring unavailable: ' + e.message); break; }
  }
  if (!candidates.some(c => c.score != null)) candidates.forEach(c => { c.score = heuristicScore(c); c.scoredBy = 'heuristic'; });
  candidates.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  const id = crypto.randomBytes(5).toString('hex');
  db.prepare('INSERT INTO thumbnail_sets (id, title, source, candidates_json) VALUES (?,?,?,?)').run(id, title, file || null, JSON.stringify(candidates));
  return { id, title, candidates, notes, best: candidates[0] || null };
}

/** No-AI fallback: fewer words, two lines, high-contrast style and a mid-video frame score higher. */
export function heuristicScore(c) {
  let s = 55;
  const words = c.lines.join(' ').split(' ').filter(Boolean).length;
  s += words <= 4 ? 15 : words <= 6 ? 6 : -10;
  if (c.style === 'contrast' || c.style === 'bold') s += 8;
  if (c.source === 'higgsfield') s += 10;
  if (c.at != null) s += 5;
  return Math.max(0, Math.min(100, s));
}

export function listSets(limit = 20) { return db.prepare('SELECT id, title, source, created_at, json_array_length(candidates_json) n FROM thumbnail_sets ORDER BY created_at DESC LIMIT ?').all(limit); }
export function getSet(id) { const r = db.prepare('SELECT * FROM thumbnail_sets WHERE id = ?').get(id); return r ? { ...r, candidates: JSON.parse(r.candidates_json), candidates_json: undefined } : null; }
