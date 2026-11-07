// Local transcription with whisper.cpp (free, runs on the Mac: `brew install whisper-cpp`), word-level timings.
// Used to cut Shorts with captions and to rate the opening hook of past uploads. Falls back to the owner's YouTube
// captions (captions API, ~250 quota units per video, budgeted) when there is no local source file.
// Transcripts are cached per video in SQLite.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { db, getSetting, DATA_DIR } from '../db.js';
import { isAuthorized } from '../youtube/oauth.js';
import { toolStatus, parseSrtGroups } from './render.js';

db.exec(`
CREATE TABLE IF NOT EXISTS transcripts (
  video_id TEXT PRIMARY KEY,
  source TEXT NOT NULL,          -- whisper | captions
  file TEXT,
  words_json TEXT NOT NULL,      -- [{text, start, end}] (word-level for whisper, phrase-level for captions)
  text TEXT NOT NULL,
  duration REAL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

const MODELS_DIR = () => path.join(DATA_DIR, 'models');
const MODEL_URL = name => `${process.env.WHISPER_MODEL_BASE || 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main'}/ggml-${name}.bin`;

function findWhisper() {
  const configured = getSetting('whisper_path');
  if (configured && fs.existsSync(configured)) return configured;
  const dirs = (process.env.PATH || '').split(':').concat(['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin']);
  for (const name of ['whisper-cli', 'whisper-cpp']) for (const d of dirs) { const p = path.join(d, name); if (d && fs.existsSync(p)) return p; }
  return null;
}
function modelName() { return getSetting('whisper_model_name', 'small.en'); }
function modelPath() {
  const configured = getSetting('whisper_model');
  if (configured) return configured;
  return path.join(MODELS_DIR(), `ggml-${modelName()}.bin`);
}

export function engineStatus() {
  const bin = findWhisper(), model = modelPath(), ff = toolStatus();
  const modelReady = fs.existsSync(model);
  return {
    whisper: bin, model, modelName: modelName(), modelReady, ffmpeg: ff.ffmpeg,
    ready: !!(bin && ff.ready),
    hint: !ff.ready ? ff.hint : !bin ? 'Install the free local transcriber: brew install whisper-cpp (or set whisper_path in Settings).' : !modelReady ? `The ${modelName()} speech model (free) downloads automatically the first time it is needed.` : null,
  };
}

function run(bin, args, { timeoutMs = 60 * 60 * 1000 } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', d => { out += d; if (out.length > 2e6) out = out.slice(-1e6); });
    p.stderr.on('data', d => { err += d; if (err.length > 2e6) err = err.slice(-1e6); });
    const t = setTimeout(() => { p.kill('SIGKILL'); reject(new Error(`${path.basename(bin)} timed out`)); }, timeoutMs);
    p.on('error', e => { clearTimeout(t); reject(e); });
    p.on('close', code => { clearTimeout(t); code === 0 ? resolve({ out, err }) : reject(new Error(`${path.basename(bin)} exited ${code}: ${err.slice(-400)}`)); });
  });
}

let downloading = null;
export async function ensureModel(log = () => {}) {
  const file = modelPath();
  if (fs.existsSync(file)) return file;
  if (getSetting('whisper_model')) throw new Error(`whisper_model is set to ${file}, which does not exist.`);
  if (!downloading) downloading = (async () => {
    fs.mkdirSync(MODELS_DIR(), { recursive: true });
    log(`downloading the free ${modelName()} speech model (one time)…`);
    const res = await fetch(MODEL_URL(modelName()), { signal: AbortSignal.timeout(30 * 60 * 1000) });
    if (!res.ok) throw new Error(`model download failed (${res.status}) from ${MODEL_URL(modelName())}`);
    const tmp = file + '.part';
    fs.writeFileSync(tmp, Buffer.from(await res.arrayBuffer()));
    fs.renameSync(tmp, file);
    log(`model saved to ${file}`);
    return file;
  })().finally(() => { downloading = null; });
  return downloading;
}

/** Transcribe a local audio/video file → word-level [{text, start, end}]. */
export async function transcribeFile(file, { log = () => {} } = {}) {
  const st = engineStatus();
  if (!st.ready) throw Object.assign(new Error(st.hint), { status: 400 });
  const model = await ensureModel(log);
  const work = path.join(DATA_DIR, 'transcribe');
  fs.mkdirSync(work, { recursive: true });
  const base = path.join(work, `t-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`);
  try {
    await run(st.ffmpeg, ['-y', '-loglevel', 'error', '-i', path.resolve(file), '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', base + '.wav']);
    log('transcribing locally with whisper.cpp…');
    const lang = getSetting('whisper_language', modelName().endsWith('.en') ? 'en' : 'auto');
    await run(st.whisper, ['-m', model, '-f', base + '.wav', '-l', lang, '-ml', '1', '-sow', '-osrt', '-of', base, '-t', String(Number(getSetting('whisper_threads', 6)))]);
    const srt = fs.readFileSync(base + '.srt', 'utf8');
    const words = parseSrtGroups(srt).map(w => ({ text: w.text.trim(), start: +w.start.toFixed(3), end: +w.end.toFixed(3) })).filter(w => w.text);
    if (!words.length) throw new Error('whisper produced no words (silent audio?)');
    return { words, text: words.map(w => w.text).join(' ').replace(/\s+([,.!?;:])/g, '$1'), duration: words.at(-1).end };
  } finally {
    for (const ext of ['.wav', '.srt']) fs.rmSync(base + ext, { force: true });
  }
}

/** The local source video for an upload: autopilot asset, or the file it was published from through TubeDesk. */
export function sourceFileFor(videoId) {
  const hasAssets = db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'autopilot_assets'").get();
  if (hasAssets) {
    const a = db.prepare("SELECT path FROM autopilot_assets WHERE video_id = ? AND kind = 'source' ORDER BY id DESC LIMIT 1").get(videoId);
    if (a && fs.existsSync(a.path)) return a.path;
  }
  const j = db.prepare("SELECT file FROM publish_jobs WHERE platform = 'youtube' AND remote_id = ? AND status = 'done' ORDER BY created_at DESC LIMIT 1").get(videoId);
  return j && fs.existsSync(j.file) ? j.file : null;
}

export function cached(videoId) {
  const r = db.prepare('SELECT * FROM transcripts WHERE video_id = ?').get(videoId);
  return r ? { ...r, words: JSON.parse(r.words_json), words_json: undefined } : null;
}
function store(videoId, source, file, t) {
  db.prepare(`INSERT INTO transcripts (video_id, source, file, words_json, text, duration) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(video_id) DO UPDATE SET source = excluded.source, file = excluded.file, words_json = excluded.words_json, text = excluded.text, duration = excluded.duration, created_at = datetime('now')`)
    .run(videoId, source, file, JSON.stringify(t.words), t.text, t.duration ?? null);
  return cached(videoId);
}

/**
 * Transcript for an upload: cache → local whisper on its source file → (if allowed) the owner's YouTube captions.
 * opts.needWords: require word-level timing (cutting Shorts) — captions are not good enough for that.
 */
export async function transcriptFor(videoId, { allowCaptions = false, needWords = false, log = () => {} } = {}) {
  const c = cached(videoId);
  if (c && (!needWords || c.source === 'whisper')) return c;
  const src = sourceFileFor(videoId);
  if (src && engineStatus().ready) return store(videoId, 'whisper', src, await transcribeFile(src, { log }));
  if (needWords) throw Object.assign(new Error(src ? engineStatus().hint : 'No local source file for this video. Link it in Virality radar → Autopilot → Source file, or publish through TubeDesk.'), { status: 400 });
  const v = db.prepare('SELECT channel_id FROM videos WHERE id = ?').get(videoId);
  if (allowCaptions && v && isAuthorized(v.channel_id)) {
    const { ownedTranscript } = await import('./coach.js');
    const t = await ownedTranscript(v.channel_id, videoId);
    const segs = t.segments.map((s, i) => ({ text: s.text, start: s.start, end: t.segments[i + 1]?.start ?? s.start + 3 }));
    return store(videoId, 'captions', null, { words: segs, text: t.text, duration: segs.at(-1)?.end ?? null });
  }
  return null;
}

/** The first `seconds` of speech — what a viewer hears before deciding to stay. */
export function hookText(t, seconds = 30) {
  if (!t?.words?.length) return '';
  return t.words.filter(w => w.start < seconds).map(w => w.text).join(' ').replace(/\s+([,.!?;:])/g, '$1').slice(0, 900);
}
