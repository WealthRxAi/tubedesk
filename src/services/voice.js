// Voiceover: text → mp3 + word timings, ready for the render pipeline's captions track. Two providers, both on accounts the user already has:
//  - HeyGen  (settings heygen_api_key + heygen_voice_id)  — the user's own cloned voice; POST /v3/models/audio/tts with_timestamps
//  - ElevenLabs (settings elevenlabs_api_key [+ voice id]) — stock or cloned voices; with-timestamps alignment
// voice_provider setting picks the default ('heygen' | 'elevenlabs'); auto = whichever is configured (HeyGen first).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { db, getSetting, DATA_DIR } from '../db.js';
import { groupWords as _groupWords } from './render.js';
// render.js groups words shaped {w, line, start, end}; ElevenLabs words are {word,start,end}, so adapt and trim the trailing pad.
const groupWords = (words, o) => _groupWords(words.map(w => ({ w: w.word, line: 0, start: w.start, end: w.end })), o).map(g => ({ ...g, start: +g.start.toFixed(3), end: +g.end.toFixed(3) }));

const BASE = () => process.env.EL_API_BASE || 'https://api.elevenlabs.io';
const HG_BASE = () => process.env.HEYGEN_API_BASE || 'https://api.heygen.com';
export const HEYGEN_MODELS = ['heygen-voice-1', 'heygen-voice-1-turbo', 'heygen-voice-1-turbo-free'];
const VOICE_DIR = path.join(DATA_DIR, 'voiceovers');
export const DEFAULT_VOICE = '21m00Tcm4TlvDq8ikWAM'; // "Rachel", ElevenLabs stock voice
export const MODELS = ['eleven_multilingual_v2', 'eleven_turbo_v2_5', 'eleven_flash_v2_5', 'eleven_v3'];

db.exec(`CREATE TABLE IF NOT EXISTS voiceovers (
  id TEXT PRIMARY KEY, text TEXT NOT NULL, voice_id TEXT, model TEXT, file TEXT, duration REAL, chars INTEGER,
  words_json TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`);

function key() { const k = getSetting('elevenlabs_api_key', ''); if (!k) throw new Error('ElevenLabs is not configured. Paste your API key in Settings → Voiceover (the $5 plan you already have).'); return k; }

export function provider(requested) {
  const pref = requested || getSetting('voice_provider', '') || 'auto';
  const hg = !!getSetting('heygen_api_key', ''), el = !!getSetting('elevenlabs_api_key', '');
  if (pref === 'heygen') return 'heygen';
  if (pref === 'elevenlabs') return 'elevenlabs';
  return hg ? 'heygen' : el ? 'elevenlabs' : 'none';
}

export function status() {
  const hg = !!getSetting('heygen_api_key', ''), el = !!getSetting('elevenlabs_api_key', '');
  return {
    configured: hg || el, provider: provider(),
    heygen: { configured: hg, voice_id: getSetting('heygen_voice_id', ''), model: getSetting('heygen_model', '') || HEYGEN_MODELS[0] },
    elevenlabs: { configured: el, voice_id: getSetting('elevenlabs_voice_id', '') || DEFAULT_VOICE, model: getSetting('elevenlabs_model', '') || MODELS[0] },
    voice_id: hg ? getSetting('heygen_voice_id', '') : getSetting('elevenlabs_voice_id', '') || DEFAULT_VOICE, model: hg ? getSetting('heygen_model', '') || HEYGEN_MODELS[0] : getSetting('elevenlabs_model', '') || MODELS[0],
    count: db.prepare('SELECT COUNT(*) c FROM voiceovers').get().c, dir: VOICE_DIR,
  };
}

// ---- HeyGen ----
function hgKey() { const k = getSetting('heygen_api_key', ''); if (!k) throw new Error('HeyGen is not configured. Paste your API key in Settings → Voiceover (HeyGen → Settings → Subscriptions → API).'); return k; }
async function hg(pathname, init = {}) {
  const res = await fetch(`${HG_BASE()}${pathname}`, { ...init, headers: { 'x-api-key': hgKey(), 'content-type': 'application/json', ...(init.headers || {}) } });
  const text = await res.text(); let j = null; try { j = JSON.parse(text); } catch { /* not json */ }
  if (!res.ok) throw new Error(j?.error?.message || j?.message || j?.error || `HeyGen ${res.status}: ${text.slice(0, 200)}`);
  return j;
}
/** HeyGen voices: the user's clones first (those are the ones /v3 TTS accepts). */
export async function heygenVoices() {
  const j = await hg('/v2/voices');
  const list = (j.data?.voices || j.voices || []).map(v => ({ id: v.voice_id, name: v.name, language: v.language, gender: v.gender, cloned: !!(v.is_clone ?? v.cloned ?? false), preview: v.preview_audio || null }));
  return list.sort((a, b) => (b.cloned - a.cloned) || a.name.localeCompare(b.name));
}
export async function heygenQuota() { const j = await hg('/v2/user/remaining_quota'); const d = j.data || j; return { remaining: d.remaining_quota, details: d.details || null, credits: d.remaining_quota != null ? +(d.remaining_quota / 60).toFixed(1) : null }; }
export function heygenWords(j) { return (j.original_words || j.words || []).map(w => ({ word: w.text, start: +(+w.start_time).toFixed(3), end: +(+w.end_time).toFixed(3) })).filter(w => w.word && !/^\s*$/.test(w.word)); }
async function speakHeygen({ text, voiceId, model, speed = 1, language, boost }) {
  const voice = voiceId || getSetting('heygen_voice_id', ''); if (!voice) throw new Error('No HeyGen voice ID set — Settings → Voiceover → pick your cloned voice.');
  const model_name = model || getSetting('heygen_model', '') || HEYGEN_MODELS[0];
  const body = { voice_id: voice, text, model: model_name, with_timestamps: true, output_format: { encoding: 'mp3', sample_rate_hertz: 44100, bitrate_bps: 128000 } };
  if (language) body.language = language;
  if (speed && speed !== 1) body.speed = Math.max(0.75, Math.min(1.25, speed));
  if (boost != null) body.expressiveness_boost = boost;
  const j = await hg('/v3/models/audio/tts', { method: 'POST', body: JSON.stringify(body) });
  const d = j.data || j; if (!d.audio_url) throw new Error('HeyGen returned no audio_url');
  const buf = Buffer.from(await (await fetch(d.audio_url)).arrayBuffer());
  return { buf, words: heygenWords(d), duration: d.duration != null ? +(+d.duration).toFixed(3) : null, voice, model: model_name, provider: 'heygen' };
}

async function el(pathname, init = {}) {
  const res = await fetch(`${BASE()}${pathname}`, { ...init, headers: { 'xi-api-key': key(), 'content-type': 'application/json', ...(init.headers || {}) } });
  const text = await res.text(); let j = null; try { j = JSON.parse(text); } catch { /* not json */ }
  if (!res.ok) throw new Error(j?.detail?.message || j?.detail || j?.error || `ElevenLabs ${res.status}: ${text.slice(0, 200)}`);
  return j;
}

export async function listVoices() {
  const j = await el('/v1/voices');
  return (j.voices || []).map(v => ({ id: v.voice_id, name: v.name, category: v.category, labels: v.labels || {}, preview: v.preview_url || null }));
}

export async function subscription() {
  const j = await el('/v1/user/subscription');
  return { tier: j.tier, used: j.character_count, limit: j.character_limit, left: Math.max(0, (j.character_limit || 0) - (j.character_count || 0)), resets: j.next_character_count_reset_unix ? new Date(j.next_character_count_reset_unix * 1000).toISOString() : null };
}

/** Turn ElevenLabs' character alignment into [{word,start,end}]. */
export function alignmentToWords(al) {
  if (!al?.characters?.length) return [];
  const chars = al.characters, st = al.character_start_times_seconds, en = al.character_end_times_seconds;
  const words = []; let cur = null;
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    if (/\s/.test(c)) { if (cur) { words.push(cur); cur = null; } continue; }
    if (!cur) cur = { word: c, start: st[i], end: en[i] }; else { cur.word += c; cur.end = en[i]; }
  }
  if (cur) words.push(cur);
  return words.map(w => ({ ...w, start: +w.start.toFixed(3), end: +w.end.toFixed(3) }));
}

/** Split the plain script into the sentence-ish lines a captions track or a timeline expects. */
export function sentences(text) {
  return String(text).replace(/\s+/g, ' ').trim().split(/(?<=[.!?…])\s+(?=[A-Z0-9"“(])/).map(s => s.trim()).filter(Boolean);
}

/**
 * Generate a voiceover. Returns { id, file, duration, words[], groups[], lines[] } — `groups` drops straight into a
 * captions track ({type:'captions', groups}) and `file` into an audio track.
 */
async function speakEleven({ text, voiceId, model, stability = 0.5, similarity = 0.75, style = 0, speed = 1 }) {
  const voice = voiceId || getSetting('elevenlabs_voice_id', '') || DEFAULT_VOICE;
  const model_id = model || getSetting('elevenlabs_model', '') || MODELS[0];
  const j = await el(`/v1/text-to-speech/${encodeURIComponent(voice)}/with-timestamps?output_format=mp3_44100_128`, {
    method: 'POST',
    body: JSON.stringify({ text, model_id, voice_settings: { stability, similarity_boost: similarity, style, use_speaker_boost: true, speed } }),
  });
  if (!j?.audio_base64) throw new Error('ElevenLabs returned no audio');
  const words = alignmentToWords(j.alignment || j.normalized_alignment);
  return { buf: Buffer.from(j.audio_base64, 'base64'), words, duration: words.length ? words[words.length - 1].end : null, voice, model: model_id, provider: 'elevenlabs' };
}

export async function speak({ text, provider: want, maxWords = 4, output, ...opts } = {}) {
  if (!text || !String(text).trim()) throw new Error('text is required');
  text = String(text).trim();
  if (text.length > 5000) throw new Error('text is over 5,000 characters — split the script into scenes and generate each one.');
  const p = provider(want);
  if (p === 'none') throw new Error('No voice provider configured. Settings → Voiceover: paste your HeyGen API key (your cloned voice) or an ElevenLabs key.');
  const r = p === 'heygen' ? await speakHeygen({ text, ...opts }) : await speakEleven({ text, ...opts });
  const id = crypto.randomBytes(6).toString('hex');
  fs.mkdirSync(VOICE_DIR, { recursive: true });
  const file = output ? path.resolve(output) : path.join(VOICE_DIR, `vo-${id}.mp3`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, r.buf);
  const duration = r.duration ?? (r.words.length ? r.words[r.words.length - 1].end : null);
  db.prepare('INSERT INTO voiceovers (id, text, voice_id, model, file, duration, chars, words_json) VALUES (?,?,?,?,?,?,?,?)').run(id, text, r.voice, `${r.provider}:${r.model}`, file, duration, text.length, JSON.stringify(r.words));
  return { id, file, duration, chars: text.length, provider: r.provider, voice_id: r.voice, model: r.model, words: r.words, groups: groupWords(r.words, { maxWords }), lines: sentences(text) };
}

export function listVoiceovers(limit = 50) {
  return db.prepare('SELECT id, text, voice_id, model, file, duration, chars, created_at FROM voiceovers ORDER BY created_at DESC LIMIT ?').all(limit);
}
export function getVoiceover(id) {
  const r = db.prepare('SELECT * FROM voiceovers WHERE id = ?').get(id); if (!r) return null;
  const words = JSON.parse(r.words_json || '[]');
  return { ...r, words_json: undefined, words, groups: groupWords(words, { maxWords: 4 }) };
}

/**
 * One call: voiceover + a vertical short timeline (background video/image + ducked voice + word captions + optional headline).
 * Returns the timeline spec for POST /api/render — nothing is rendered here so the caller can tweak first.
 */
export async function shortFromScript({ text, background, headline, voiceId, model, provider: want, captionY = 1180, size = 58, width = 1080, height = 1920, fps = 30, music, musicVolume = 0.12 } = {}) {
  if (!background) throw new Error('background (video or image path) is required');
  const vo = await speak({ text, voiceId, model, provider: want });
  const dur = +(vo.duration + 0.6).toFixed(2);
  const tracks = [
    { type: /\.(png|jpe?g|webp)$/i.test(background) ? 'image' : 'video', src: background, start: 0, duration: dur, fit: 'cover', zoom: { from: 1, to: 1.06 }, audio: false },
    { type: 'audio', src: vo.file, start: 0.3, volume: 1 },
  ];
  if (music) tracks.push({ type: 'audio', src: music, start: 0, duration: dur, volume: musicVolume, duck: true, loop: true, fadeOut: 1.2 });
  if (headline) tracks.push({ type: 'text', text: headline, y: 260, size: 72, font: 'bold', start: 0, end: Math.min(3.5, dur), color: '#ffffff', stroke: 6 });
  tracks.push({ type: 'captions', groups: vo.groups.map(g => ({ ...g, start: +(g.start + 0.3).toFixed(3), end: +(g.end + 0.3).toFixed(3) })), y: captionY, size, font: 'bold' });
  return { voiceover: { id: vo.id, file: vo.file, duration: vo.duration, chars: vo.chars }, timeline: { width, height, fps, duration: dur, loudness: -14, tracks } };
}
