// Media pipeline: ffmpeg-backed rendering from a JSON timeline, plus probe / transcode / speech segments / caption timing.
// Built for AI agents: describe the video as data, get an MP4 back. No GUI, no project files — the timeline IS the project.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { db, getSetting, DATA_DIR } from '../db.js';

const RENDER_DIR = path.join(DATA_DIR, 'renders');
fs.mkdirSync(RENDER_DIR, { recursive: true });

db.exec(`CREATE TABLE IF NOT EXISTS render_jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,              -- render | transcode
  status TEXT NOT NULL,            -- queued | running | done | failed
  spec_json TEXT NOT NULL,
  output TEXT,
  error TEXT,
  log TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT
)`);

// ---------- binaries & fonts ----------
function findBin(name) {
  const configured = getSetting(`${name}_path`) || (name === 'ffprobe' && getSetting('ffmpeg_path') ? path.join(path.dirname(getSetting('ffmpeg_path')), 'ffprobe') : null);
  if (configured && fs.existsSync(configured)) return configured;
  const dirs = (process.env.PATH || '').split(':').concat(['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin']);
  for (const d of dirs) { const p = path.join(d, name); if (d && fs.existsSync(p)) return p; }
  return null;
}
export function toolStatus() {
  const ffmpeg = findBin('ffmpeg'), ffprobe = findBin('ffprobe');
  return { ffmpeg, ffprobe, ready: !!(ffmpeg && ffprobe), fonts: fonts(), renderDir: RENDER_DIR, hint: ffmpeg ? null : 'Install ffmpeg (brew install ffmpeg — free) or set ffmpeg_path / ffprobe_path in Settings.' };
}
const FONT_CANDIDATES = {
  regular: ['/usr/share/fonts/opentype/inter/Inter-SemiBold.otf', '/usr/share/fonts/truetype/inter/Inter-SemiBold.ttf', '/System/Library/Fonts/Supplemental/Arial Bold.ttf', '/System/Library/Fonts/Helvetica.ttc', '/Library/Fonts/Arial Bold.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', 'C:/Windows/Fonts/arialbd.ttf'],
  bold: ['/usr/share/fonts/opentype/inter/Inter-Black.otf', '/usr/share/fonts/truetype/inter/Inter-Black.ttf', '/System/Library/Fonts/Supplemental/Arial Black.ttf', '/System/Library/Fonts/Supplemental/Impact.ttf', '/Library/Fonts/Arial Black.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', 'C:/Windows/Fonts/ariblk.ttf'],
  mono: ['/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf', '/System/Library/Fonts/Menlo.ttc', '/System/Library/Fonts/Monaco.ttf', 'C:/Windows/Fonts/consola.ttf'],
};
export function fonts() {
  const out = {};
  for (const [k, list] of Object.entries(FONT_CANDIDATES)) out[k] = getSetting(`font_${k}`) || list.find(f => fs.existsSync(f)) || null;
  return out;
}

function run(bin, args, { log, cwd } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', d => { out += d; });
    p.stderr.on('data', d => { err += d; if (log && /error|Error|Invalid/.test(String(d))) log(String(d).trim().slice(0, 300)); });
    p.on('error', reject);
    p.on('exit', code => code === 0 ? resolve({ out, err }) : reject(new Error(`${path.basename(bin)} exited ${code}: ${err.trim().split('\n').slice(-6).join(' | ').slice(0, 900)}`)));
  });
}

// ---------- probe ----------
export async function probe(file) {
  const abs = resolvePath(file);
  const ffprobe = findBin('ffprobe'); if (!ffprobe) throw new Error(toolStatus().hint);
  const { out } = await run(ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', abs]);
  const j = JSON.parse(out);
  const v = j.streams.find(s => s.codec_type === 'video'), a = j.streams.find(s => s.codec_type === 'audio');
  const [num, den] = (v?.r_frame_rate || '0/1').split('/').map(Number);
  return {
    file: abs, size: Number(j.format.size), duration: Number(j.format.duration), bitrate: Number(j.format.bit_rate),
    video: v ? { codec: v.codec_name, width: v.width, height: v.height, fps: den ? +(num / den).toFixed(3) : null, aspect: v.width && v.height ? +(v.width / v.height).toFixed(4) : null, vertical: v.height > v.width } : null,
    audio: a ? { codec: a.codec_name, sampleRate: Number(a.sample_rate), channels: a.channels } : null,
  };
}
function resolvePath(file) {
  if (!file || typeof file !== 'string') throw new Error('file is required: an absolute path on this machine.');
  const abs = path.resolve(file);
  if (!fs.existsSync(abs)) throw new Error(`file not found: ${abs}`);
  return abs;
}

// ---------- speech segments (pause detection) & caption timing ----------
export async function speechSegments(file, { noiseDb = -35, minPause = 0.22 } = {}) {
  const abs = resolvePath(file);
  const ffmpeg = findBin('ffmpeg'); if (!ffmpeg) throw new Error(toolStatus().hint);
  const { err } = await run(ffmpeg, ['-i', abs, '-af', `silencedetect=noise=${noiseDb}dB:d=${minPause}`, '-f', 'null', '-']);
  const dur = (await probe(abs)).duration;
  const st = [...err.matchAll(/silence_start: ([\d.]+)/g)].map(m => +m[1]), en = [...err.matchAll(/silence_end: ([\d.]+)/g)].map(m => +m[1]);
  const seg = []; let t = 0;
  for (let i = 0; i < st.length; i++) { if (st[i] > t + 0.05) seg.push({ start: +t.toFixed(3), end: +st[i].toFixed(3) }); t = en[i] ?? st[i]; }
  if (dur > t + 0.05) seg.push({ start: +t.toFixed(3), end: +dur.toFixed(3) });
  return { file: abs, duration: dur, segments: seg };
}
const weight = w => max2(w.replace(/[^A-Za-z0-9]/g, '').length) + 1.5;
const max2 = n => Math.max(2, n);
/** Time a script (array of lines, one per spoken sentence/pause) against detected segments; merges the smallest gaps when there are more segments than lines. */
export function timeScript(script, segments) {
  const seg = segments.map(s => [s.start, s.end]);
  while (seg.length > script.length) { let bi = 0, bg = Infinity; for (let i = 0; i < seg.length - 1; i++) { const g = seg[i + 1][0] - seg[i][1]; if (g < bg) { bg = g; bi = i; } } seg.splice(bi, 2, [seg[bi][0], seg[bi + 1][1]]); }
  if (seg.length < script.length) throw new Error(`script has ${script.length} lines but only ${seg.length} speech segments were detected; join lines or lower minPause.`);
  const words = [];
  seg.forEach(([s, e], i) => { const ws = script[i].split(/\s+/).filter(Boolean); const W = ws.reduce((a, w) => a + weight(w), 0); let t = s; for (const w of ws) { const d = (e - s) * weight(w) / W; words.push({ w, start: +t.toFixed(3), end: +(t + d).toFixed(3), line: i }); t += d; } });
  return { lines: seg.map(([start, end], i) => ({ start, end, text: script[i] })), words };
}
export function groupWords(words, { maxWords = 4 } = {}) {
  const out = []; let cur = [];
  words.forEach((w, i) => {
    cur.push(w); const nxt = words[i + 1];
    const boundary = !nxt || nxt.line !== w.line || /[.:!?,]$/.test(w.w);
    if (boundary || cur.length >= maxWords || (cur.length === maxWords - 1 && nxt && nxt.w.length > 8)) { out.push({ text: cur.map(x => x.w).join(' '), start: cur[0].start, end: cur[cur.length - 1].end }); cur = []; }
  });
  out.forEach((g, i) => { g.end = out[i + 1] ? out[i + 1].start : g.end + 0.4; });
  return out;
}
export function parseSrtGroups(srt) {
  const out = [];
  for (const b of srt.split(/\n\s*\n/)) {
    const lines = b.trim().split('\n'); const m = lines.find(l => /-->/.test(l)); if (!m) continue;
    const [a, c] = m.split('-->').map(s => s.trim().replace(',', '.'));
    const sec = x => { const [h, mi, s] = x.split(':'); return Number(h) * 3600 + Number(mi) * 60 + Number(s); };
    out.push({ start: sec(a), end: sec(c), text: lines.slice(lines.indexOf(m) + 1).join(' ').replace(/<[^>]+>/g, '').trim() });
  }
  return out;
}

// ---------- timeline → ffmpeg ----------
const esc = s => String(s).replace(/\\/g, '\\\\').replace(/'/g, '\u2019').replace(/:/g, '\\:').replace(/%/g, '\\%').replace(/,/g, '\\,').replace(/\[/g, '\\[').replace(/\]/g, '\\]');
const color = c => { if (!c) return 'white'; c = String(c).trim(); return c.startsWith('#') ? '0x' + c.slice(1) : c; };
const num = (v, d) => (v === undefined || v === null || v === '' ? d : Number(v));

export const TIMELINE_SCHEMA = {
  output: 'absolute path for the MP4 (default: data/renders/<id>.mp4)', width: 1080, height: 1920, fps: 30, background: '#0f1115',
  duration: 'seconds (default: end of the last track)', loudness: 'integrated LUFS target for the mix (default -14; null to skip)',
  tracks: [
    { type: 'video', src: '/abs/clip.mp4', start: 0, in: 0, duration: 'seconds (default: clip length)', x: 0, y: 0, w: 1080, h: 1920, crop: '[x, y, w, h] in source pixels before fitting (optional)', fit: "'cover' (default) | 'contain'", focus: '[fx, fy] 0–1 point kept in frame when cover-cropping (default [0.5,0.35])', zoom: { from: 1, to: 1.1 }, audio: true, volume: 1, freeze: 'seconds to hold the last frame after the clip ends' },
    { type: 'image', src: '/abs/still.jpg', start: 3, end: 6, x: 0, y: 0, w: 1080, h: 960, fit: 'cover', focus: [0.5, 0.3], zoom: { from: 1, to: 1.4 }, crop: '[x, y, w, h] in source pixels before fitting (optional)' },
    { type: 'box', start: 0, end: 3, x: 0, y: 840, w: 1080, h: 250, color: '#000000', opacity: 0.7 },
    { type: 'text', text: 'COMMENT DESK', start: 19, end: 22, x: "'center' (default) or px", y: 520, size: 120, color: '#FFD60A', font: "'bold' | 'regular' | 'mono'", stroke: 4, strokeColor: '#000000', box: false, boxColor: '#000000', boxOpacity: 0.6, fadeIn: 0.1 },
    { type: 'captions', groups: '[{text,start,end}] OR srt: "/abs/file.srt" OR script: ["line per pause", …] with audioFrom: <track index> (auto-timed from the voice)', y: 1180, yWhen: '[{from, to, y}] optional per-time overrides', size: 58, color: '#ffffff', stroke: 5, font: 'regular', maxWords: 4, skipFirst: 0 },
    { type: 'audio', src: '/abs/music.mp3', start: 0, volume: 0.35, duck: 'true → compressed under the voice tracks', loop: false, fadeOut: 1.2 },
    { type: 'tone', start: 3.0, kind: "'thump' | 'click' | 'riser'", volume: 0.8 },
  ],
};

function fitExpr(track, W, H) {
  // Returns a filter chain string that produces a w×h canvas-sized stream from [in]. Focus point stays in frame when cropping.
  const w = num(track.w, W), h = num(track.h, H), [fx, fy] = track.focus || [0.5, 0.35];
  if (track.fit === 'contain') return `scale=${w}:${h}:force_original_aspect_ratio=decrease:flags=lanczos,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=${color(track.pad || '#000000')}`;
  return `scale=${w}:${h}:force_original_aspect_ratio=increase:flags=lanczos,crop=${w}:${h}:(iw-${w})*${fx}:(ih-${h})*${fy}`;
}
function zoomExpr(track, w, h, frames, fps) {
  if (!track.zoom) return '';
  const z0 = num(track.zoom.from, 1), z1 = num(track.zoom.to, z0), [fx, fy] = track.focus || [0.5, 0.35];
  return `,zoompan=z='${z0}+(${z1}-${z0})*on/${Math.max(1, frames)}':x='iw*${fx}-(iw/zoom)*${fx}':y='iw*0+ih*${fy}-(ih/zoom)*${fy}':d=1:s=${w}x${h}:fps=${fps}`;
}

export function compile(spec, { id }) {
  const W = num(spec.width, 1080), H = num(spec.height, 1920), FPS = num(spec.fps, 30);
  const F = fonts();
  const tracks = Array.isArray(spec.tracks) ? spec.tracks : [];
  if (!tracks.length) throw new Error('tracks[] is required.');
  const srcDur = {};
  const inputs = [], f = [], aud = [], voice = [], notes = [];
  let n = 0, cur = 'bg';
  // duration: explicit, else max end over tracks that have one
  const ends = tracks.map(t => t.end ?? (t.duration != null ? num(t.start, 0) + num(t.duration, 0) : null)).filter(x => x != null);
  const TOTAL = num(spec.duration, ends.length ? Math.max(...ends) : 0);
  if (!TOTAL) throw new Error('duration could not be inferred: set duration, or give tracks an end/duration.');
  f.push(`color=c=${color(spec.background || '#0f1115')}:s=${W}x${H}:r=${FPS}:d=${TOTAL.toFixed(3)}[bg]`);
  tracks.forEach((t, ti) => {
    const start = num(t.start, 0), end = t.end != null ? num(t.end, TOTAL) : (t.duration != null ? start + num(t.duration, 0) : TOTAL);
    const en = `enable='between(t,${start.toFixed(3)},${end.toFixed(3)})'`;
    switch (t.type) {
      case 'video': {
        const src = resolvePath(t.src); const inp = num(t.in, 0); const dur = end - start; const w = num(t.w, W), h = num(t.h, H);
        inputs.push('-ss', String(inp), '-t', String(dur + num(t.freeze, 0) + 0.5), '-i', src); const idx = n++;
        const frames = Math.round(dur * FPS);
        const hold = num(t.freeze, 0) ? `,tpad=stop_mode=clone:stop_duration=${num(t.freeze, 0)}` : '';
        const pre = t.crop ? `crop=${t.crop[2]}:${t.crop[3]}:${t.crop[0]}:${t.crop[1]},` : '';
        f.push(`[${idx}:v]fps=${FPS},${pre}${fitExpr(t, W, H)}${zoomExpr(t, w, h, frames, FPS)}${hold},setpts=PTS-STARTPTS+${start.toFixed(3)}/TB,format=rgba[v${ti}]`);
        const holdEnd = end + num(t.freeze, 0);
        f.push(`[${cur}][v${ti}]overlay=${num(t.x, 0)}:${num(t.y, 0)}:enable='between(t,${start.toFixed(3)},${holdEnd.toFixed(3)})'[c${ti}]`); cur = `c${ti}`;
        if (t.audio !== false) { aud.push(`[${idx}:a]aresample=48000,volume=${num(t.volume, 1)},adelay=${Math.round(start * 1000)}|${Math.round(start * 1000)},apad=whole_dur=${TOTAL.toFixed(3)}[a${ti}]`); voice.push(`a${ti}`); }
        break;
      }
      case 'image': {
        const src = resolvePath(t.src); const dur = end - start; const w = num(t.w, W), h = num(t.h, H);
        inputs.push('-loop', '1', '-framerate', String(FPS), '-t', String(dur + 0.2), '-i', src); const idx = n++;
        const pre = t.crop ? `crop=${t.crop[2]}:${t.crop[3]}:${t.crop[0]}:${t.crop[1]},` : '';
        f.push(`[${idx}:v]${pre}${fitExpr(t, W, H)}${zoomExpr(t, w, h, Math.round(dur * FPS), FPS)},setpts=PTS+${start.toFixed(3)}/TB,format=rgba[v${ti}]`);
        f.push(`[${cur}][v${ti}]overlay=${num(t.x, 0)}:${num(t.y, 0)}:${en}[c${ti}]`); cur = `c${ti}`;
        break;
      }
      case 'box': {
        f.push(`[${cur}]drawbox=x=${num(t.x, 0)}:y=${num(t.y, 0)}:w=${num(t.w, W)}:h=${num(t.h, 100)}:color=${color(t.color || '#000000')}@${num(t.opacity, 0.7)}:t=fill:${en}[c${ti}]`); cur = `c${ti}`;
        break;
      }
      case 'text': {
        const font = F[t.font || 'bold'] || F.regular; if (!font) throw new Error('no usable font found; set font_bold/font_regular in Settings to a .ttf/.otf path');
        const size = num(t.size, 80), x = t.x === undefined || t.x === 'center' ? '(w-text_w)/2' : String(t.x), y = t.y === undefined ? '(h-text_h)/2' : String(t.y);
        const box = t.box ? `:box=1:boxcolor=${color(t.boxColor || '#000000')}@${num(t.boxOpacity, 0.6)}:boxborderw=${num(t.boxPad, 14)}` : '';
        const alpha = num(t.fadeIn, 0) ? `:alpha='min(1,(t-${start.toFixed(3)})/${num(t.fadeIn, 0.1)})'` : '';
        f.push(`[${cur}]drawtext=fontfile=${font}:text='${esc(t.text || '')}':fontcolor=${color(t.color || '#ffffff')}:fontsize=${size}:borderw=${num(t.stroke, Math.max(3, Math.round(size / 14)))}:bordercolor=${color(t.strokeColor || '#000000')}${box}${alpha}:x=${x}:y=${y}:${en}[c${ti}]`); cur = `c${ti}`;
        break;
      }
      case 'captions': {
        let groups = t.groups;
        if (!groups && t.srt) groups = parseSrtGroups(fs.readFileSync(resolvePath(t.srt), 'utf8'));
        if (!groups && t.script) { if (!t._timed) throw new Error('captions.script needs timing: the renderer resolves it before compile'); groups = t._timed; }
        if (!Array.isArray(groups)) throw new Error('captions needs groups[], srt, or script[] + audioFrom.');
        const font = F[t.font || 'regular'] || F.bold; const size = num(t.size, 58);
        const yFor = tm => { for (const o of t.yWhen || []) if (tm >= o.from && tm < o.to) return o.y; return num(t.y, Math.round(H * 0.61)); };
        groups.slice(num(t.skipFirst, 0)).forEach((g, gi) => {
          const y = yFor((g.start + g.end) / 2);
          f.push(`[${cur}]drawtext=fontfile=${font}:text='${esc(g.text)}':fontcolor=${color(t.color || '#ffffff')}:fontsize=${size}:borderw=${num(t.stroke, 5)}:bordercolor=${color(t.strokeColor || '#000000')}@0.9:x=(w-text_w)/2:y=${y}:enable='between(t,${g.start.toFixed(3)},${g.end.toFixed(3)})'[c${ti}_${gi}]`); cur = `c${ti}_${gi}`;
        });
        break;
      }
      case 'audio': {
        const src = resolvePath(t.src); const dur = end - start;
        inputs.push(...(t.loop ? ['-stream_loop', '-1'] : []), '-t', String(dur), '-i', src); const idx = n++;
        const fade = num(t.fadeOut, 0) ? `,afade=t=out:st=${(dur - num(t.fadeOut, 0)).toFixed(3)}:d=${num(t.fadeOut, 0)}` : '';
        aud.push(`[${idx}:a]aresample=48000,volume=${num(t.volume, 0.35)}${fade},adelay=${Math.round(start * 1000)}|${Math.round(start * 1000)},apad=whole_dur=${TOTAL.toFixed(3)}[${t.duck ? 'duck' : 'a'}${ti}]`);
        if (t.duck) notes.push(`duck${ti}`); else aud.push(`[a${ti}]anull[a${ti}x]`), voice.push(`a${ti}x`);
        break;
      }
      case 'tone': {
        const k = t.kind || 'thump', vol = num(t.volume, 0.8);
        const expr = k === 'click' ? `${vol}*sin(2*PI*1100*t)*exp(-45*t)` : k === 'riser' ? `${vol * 0.5}*sin(2*PI*(200+900*t)*t)*min(1,t*2)` : `${vol}*sin(2*PI*(90-60*min(t,0.3)/0.3)*t)*exp(-9*t)+${vol * 0.5}*sin(2*PI*1100*t)*exp(-45*t)`;
        const d = k === 'riser' ? num(t.duration, 1.5) : 0.5;
        aud.push(`aevalsrc='${expr}':s=48000:d=${d},adelay=${Math.round(start * 1000)}|${Math.round(start * 1000)},apad=whole_dur=${TOTAL.toFixed(3)}[a${ti}]`); voice.push(`a${ti}`);
        break;
      }
      default: throw new Error(`unknown track type '${t.type}' at tracks[${ti}]`);
    }
  });
  f.push(`[${cur}]trim=0:${TOTAL.toFixed(3)},format=yuv420p[vout]`);
  // Audio bus: voice/sfx mixed; ducked beds compressed against the voice mix.
  let af = [...aud]; let mixIn = voice;
  if (voice.length) {
    af.push(voice.map(v => `[${v}]`).join('') + (voice.length > 1 ? `amix=inputs=${voice.length}:normalize=0[voice]` : 'anull[voice]'));
    if (notes.length) {
      af.push(notes.map(d => `[${d}]`).join('') + (notes.length > 1 ? `amix=inputs=${notes.length}:normalize=0[beds]` : 'anull[beds]'));
      af.push('[voice]asplit[vo1][vo2]', '[beds][vo1]sidechaincompress=threshold=0.03:ratio=8:attack=15:release=350:makeup=1[ducked]', '[ducked][vo2]amix=inputs=2:normalize=0[mix]');
    } else af.push('[voice]anull[mix]');
  } else if (notes.length) af.push(notes.map(d => `[${d}]`).join('') + (notes.length > 1 ? `amix=inputs=${notes.length}:normalize=0[mix]` : 'anull[mix]'));
  else af.push(`anullsrc=r=48000:cl=mono:d=${TOTAL.toFixed(3)}[mix]`);
  return { W, H, FPS, TOTAL, inputs, graph: [...f, ...af].join(';\n'), hasAudio: true };
}

// ---------- jobs ----------
const running = new Map();
function rowToJob(r) { return r ? { ...r, spec: JSON.parse(r.spec_json), spec_json: undefined, log: r.log.split('\n').filter(Boolean) } : null; }
export function getJob(id) { return rowToJob(db.prepare('SELECT * FROM render_jobs WHERE id = ?').get(id)); }
export function listJobs(limit = 50) { return db.prepare('SELECT * FROM render_jobs ORDER BY created_at DESC LIMIT ?').all(limit).map(rowToJob); }
export async function waitForJob(id, timeoutMs = 20 * 60 * 1000) { const p = running.get(id); if (p) await Promise.race([p, new Promise(r => setTimeout(r, timeoutMs))]); return getJob(id); }
function logLine(id, line) { db.prepare("UPDATE render_jobs SET log = log || ? || char(10), updated_at = datetime('now') WHERE id = ?").run(`${new Date().toISOString().slice(11, 19)} ${line}`, id); }
function finish(id, patch) { const sets = Object.keys(patch).map(k => `${k} = @${k}`).join(', '); db.prepare(`UPDATE render_jobs SET ${sets}, updated_at = datetime('now'), finished_at = datetime('now') WHERE id = @id`).run({ ...patch, id }); }

async function resolveCaptionTiming(spec, log) {
  for (const t of spec.tracks || []) {
    if (t.type !== 'captions' || !t.script) continue;
    const from = spec.tracks[num(t.audioFrom, 0)];
    if (!from?.src) throw new Error('captions.audioFrom must point at a video/audio track with src');
    const segs = await speechSegments(from.src, { noiseDb: num(t.noiseDb, -35), minPause: num(t.minPause, 0.22) });
    const offset = num(from.start, 0) - num(from.in, 0);
    const timed = timeScript(t.script, segs.segments);
    t._timed = groupWords(timed.words, { maxWords: num(t.maxWords, 4) }).map(g => ({ ...g, start: +(g.start + offset).toFixed(3), end: +(g.end + offset).toFixed(3) }));
    t._lines = timed.lines.map(l => ({ ...l, start: +(l.start + offset).toFixed(3), end: +(l.end + offset).toFixed(3) }));
    log(`captions: ${segs.segments.length} speech segments → ${t.script.length} lines → ${t._timed.length} caption groups`);
  }
}

export function render(spec) {
  const ffmpeg = findBin('ffmpeg'); if (!ffmpeg) throw new Error(toolStatus().hint);
  if (!spec || typeof spec !== 'object') throw new Error('timeline JSON body is required (see GET /api/render/schema).');
  const id = crypto.randomBytes(6).toString('hex');
  // Fail fast on structural problems (missing files, unknown track types, no duration) before a job row exists.
  const dry = JSON.parse(JSON.stringify(spec));
  for (const t of dry.tracks || []) if (t?.type === 'captions' && t.script) t._timed = [];
  compile(dry, { id });
  const output = spec.output ? path.resolve(spec.output) : path.join(RENDER_DIR, `${id}.mp4`);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  db.prepare('INSERT INTO render_jobs(id, kind, status, spec_json, output) VALUES (?, ?, ?, ?, ?)').run(id, 'render', 'running', JSON.stringify(spec), output);
  const log = l => logLine(id, l);
  const p = (async () => {
    try {
      const s = JSON.parse(JSON.stringify(spec));
      await resolveCaptionTiming(s, log);
      const c = compile(s, { id });
      const graphFile = path.join(RENDER_DIR, `${id}.graph.txt`); fs.writeFileSync(graphFile, c.graph);
      const raw = path.join(RENDER_DIR, `${id}.raw.mov`);
      log(`rendering ${c.W}x${c.H}@${c.FPS} · ${c.TOTAL.toFixed(2)}s · ${(s.tracks || []).length} tracks`);
      const t0 = Date.now();
      await run(ffmpeg, ['-y', '-loglevel', 'error', ...c.inputs, '-filter_complex_script', graphFile, '-map', '[vout]', '-map', '[mix]', '-t', c.TOTAL.toFixed(3), '-r', String(c.FPS), '-c:v', 'libx264', '-preset', s.preset || 'medium', '-crf', String(num(s.crf, 18)), '-pix_fmt', 'yuv420p', '-c:a', 'pcm_s16le', raw], { log });
      let gain = 0;
      if (s.loudness !== null) {
        const target = num(s.loudness, -14);
        const m = await run(ffmpeg, ['-i', raw, '-map', '0:a', '-af', 'ebur128', '-f', 'null', '-']);
        const I = Number((m.err.match(/I:\s+(-?[\d.]+) LUFS/g) || []).pop()?.match(/(-?[\d.]+)/)[1]);
        if (Number.isFinite(I) && I > -70) gain = target - I;
        log(`loudness ${Number.isFinite(I) ? I.toFixed(1) : '?'} LUFS → ${target} (gain ${gain.toFixed(1)} dB)`);
      }
      await run(ffmpeg, ['-y', '-loglevel', 'error', '-i', raw, '-af', `volume=${gain.toFixed(2)}dB,alimiter=limit=0.89:attack=3:release=60:level=0`, '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', output], { log });
      fs.rmSync(raw, { force: true }); if (!s.keepGraph) fs.rmSync(graphFile, { force: true });
      const info = await probe(output);
      log(`done in ${((Date.now() - t0) / 1000).toFixed(1)}s → ${output} (${(info.size / 1048576).toFixed(1)} MB)`);
      finish(id, { status: 'done', output });
    } catch (e) { log(`error: ${e.message}`); finish(id, { status: 'failed', error: e.message }); }
    finally { running.delete(id); }
  })();
  running.set(id, p);
  return getJob(id);
}

// ---------- transcode presets ----------
export const PRESETS = {
  short: { w: 1080, h: 1920, note: '9:16 vertical for Shorts/Reels/TikTok; crops to fill, H.264 + AAC' },
  reel: { w: 1080, h: 1920, note: 'same as short' },
  youtube: { w: 1920, h: 1080, note: '16:9 landscape; crops to fill' },
  square: { w: 1080, h: 1080, note: '1:1' },
  contain: { note: 'keep aspect, pad to the target size given as width/height' },
};
export function transcode({ file, preset = 'short', output, width, height, fit = 'cover', focus = [0.5, 0.35], trim, fps = 30, crf = 18, loudness = -14 }) {
  const ffmpeg = findBin('ffmpeg'); if (!ffmpeg) throw new Error(toolStatus().hint);
  const src = resolvePath(file); const P = PRESETS[preset]; if (!P) throw new Error(`unknown preset ${preset}; one of ${Object.keys(PRESETS).join(', ')}`);
  const w = num(width, P.w || 1080), h = num(height, P.h || 1920);
  const id = crypto.randomBytes(6).toString('hex');
  const out = output ? path.resolve(output) : path.join(RENDER_DIR, `${path.basename(src, path.extname(src))}-${preset}.mp4`);
  const vf = (fit === 'contain' || preset === 'contain') ? `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2` : `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}:(iw-${w})*${focus[0]}:(ih-${h})*${focus[1]}`;
  db.prepare('INSERT INTO render_jobs(id, kind, status, spec_json, output) VALUES (?, ?, ?, ?, ?)').run(id, 'transcode', 'running', JSON.stringify({ file: src, preset, width: w, height: h, fit, trim }), out);
  const log = l => logLine(id, l);
  const p = (async () => {
    try {
      const args = ['-y', '-loglevel', 'error', ...(trim?.start ? ['-ss', String(trim.start)] : []), '-i', src, ...(trim?.duration ? ['-t', String(trim.duration)] : []), '-vf', `${vf},fps=${fps},format=yuv420p`, '-c:v', 'libx264', '-preset', 'medium', '-crf', String(crf), '-c:a', 'aac', '-b:a', '192k', ...(loudness !== null ? ['-af', `loudnorm=I=${loudness}:TP=-1.5:LRA=11`] : []), '-movflags', '+faststart', out];
      await run(ffmpeg, args, { log });
      const info = await probe(out); log(`done → ${out} (${info.video.width}x${info.video.height}, ${info.duration.toFixed(1)}s)`);
      finish(id, { status: 'done', output: out });
    } catch (e) { log(`error: ${e.message}`); finish(id, { status: 'failed', error: e.message }); }
    finally { running.delete(id); }
  })();
  running.set(id, p);
  return getJob(id);
}

export async function frame({ file, at = 1, output, width }) {
  const ffmpeg = findBin('ffmpeg'); if (!ffmpeg) throw new Error(toolStatus().hint);
  const src = resolvePath(file); const out = output ? path.resolve(output) : path.join(RENDER_DIR, `${path.basename(src, path.extname(src))}-${String(at).replace('.', '_')}s.jpg`);
  await run(ffmpeg, ['-y', '-loglevel', 'error', '-ss', String(at), '-i', src, '-frames:v', '1', ...(width ? ['-vf', `scale=${width}:-1`] : []), '-q:v', '2', out]);
  return { file: out };
}
