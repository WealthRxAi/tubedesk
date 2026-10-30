// Titles, descriptions, tags, chapters, thumbnails, staged metadata edits.
import fs from 'node:fs';
import path from 'node:path';
import { db, DATA_DIR } from '../db.js';
import { ytGet, ytWrite, suggest } from '../youtube/client.js';
import { getVideo } from './channels.js';
import * as ai from './ai.js';

const POWER_WORDS = ['secret', 'truth', 'never', 'mistake', 'finally', 'proven', 'nobody', 'actually', 'hidden', 'ultimate', 'real', 'exposed', 'shocking', 'free', 'fast', 'simple', 'easy', 'why', 'how', 'stop', 'instantly', 'worst', 'best', 'only', 'new', 'warning'];
const STOP = new Set(['the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'is', 'are', 'this', 'that', 'it', 'my', 'your', 'you', 'i', 'we', 'at', 'by', 'from', 'as', 'be']);

/** Heuristic title analysis. Every check is named so the creator can judge it; no CTR prediction is claimed. */
export function analyzeTitle(title, { keyword = '' } = {}) {
  const t = String(title || '').trim();
  const words = t.split(/\s+/).filter(Boolean);
  const checks = [];
  const push = (name, pass, weight, detail) => checks.push({ name, pass, weight, detail });
  push('Length 30–60 characters (fits most layouts)', t.length >= 30 && t.length <= 60, 15, `${t.length} characters`);
  push('No truncation risk (≤ 70 chars)', t.length <= 70, 10, t.length > 70 ? 'Titles over ~70 chars get cut on mobile' : 'OK');
  push('Opens with the hook (first 3 words carry the subject)', words.length >= 3 && !STOP.has(words[0].toLowerCase()), 10, words.slice(0, 3).join(' '));
  push('Contains a number or specific quantity', /\d/.test(t), 10, /\d/.test(t) ? 'Specific' : 'Consider adding a specific number, timeframe or amount');
  const pw = POWER_WORDS.filter(w => new RegExp(`\\b${w}\\b`, 'i').test(t));
  push('Uses 1–2 emotional/power words', pw.length >= 1 && pw.length <= 2, 10, pw.length ? pw.join(', ') : 'None found');
  push('Not overloaded with power words (≤ 2)', pw.length <= 2, 5, `${pw.length}`);
  push('Curiosity gap or stakes (question, contrast, "why", "what happens")', /\?|\bvs\b|\bwhy\b|\bwhat happens\b|\buntil\b|\bbut\b|\bwithout\b/i.test(t), 10, 'Looks for a question, contrast or consequence');
  const caps = words.filter(w => w.length > 2 && w === w.toUpperCase() && /[A-Z]/.test(w)).length;
  push('Uses at most one ALL-CAPS word', caps <= 1, 5, `${caps} all-caps words`);
  push('No clickbait punctuation (!!!, ???)', !/[!?]{2,}/.test(t), 5, 'OK');
  push('No spammy hashtags/emoji clutter', (t.match(/#/g) || []).length <= 1 && (t.match(/[\u{1F300}-\u{1FAFF}]/gu) || []).length <= 1, 5, 'OK');
  if (keyword) {
    const k = keyword.toLowerCase();
    push(`Target keyword present ("${keyword}")`, t.toLowerCase().includes(k), 15, t.toLowerCase().includes(k) ? 'Found' : 'Missing');
    push('Keyword appears in the first half of the title', t.toLowerCase().indexOf(k) >= 0 && t.toLowerCase().indexOf(k) < t.length / 2, 5, 'Front-loading helps search snippets');
  }
  const total = checks.reduce((s, c) => s + c.weight, 0);
  const got = checks.reduce((s, c) => s + (c.pass ? c.weight : 0), 0);
  return { title: t, score: Math.round((got / total) * 100), checks, note: 'Heuristic checklist, not a CTR prediction. Real CTR comes from YouTube Studio impressions (import under Analytics → Studio import).' };
}

export function analyzeDescription(description = '', { keyword = '' } = {}) {
  const d = String(description || '');
  const lines = d.split('\n');
  const firstLine = lines.slice(0, 2).join(' ');
  const timestamps = d.match(/^(\d{1,2}:)?\d{1,2}:\d{2}\s+\S/gm) || [];
  const links = d.match(/https?:\/\/\S+/g) || [];
  const hashtags = d.match(/#\w+/g) || [];
  const checks = [
    { name: 'First 150 characters state the payoff (shown above the fold)', pass: firstLine.length >= 60, detail: `${firstLine.length} chars in the opening` },
    { name: 'Length ≥ 200 words (context for search)', pass: d.split(/\s+/).filter(Boolean).length >= 200, detail: `${d.split(/\s+/).filter(Boolean).length} words` },
    { name: 'Chapters present (≥ 3 timestamps, first at 0:00)', pass: timestamps.length >= 3 && /^0?0:00\s/m.test(d), detail: `${timestamps.length} timestamps` },
    { name: 'Hashtags ≤ 3 relevant', pass: hashtags.length > 0 && hashtags.length <= 3, detail: hashtags.join(' ') || 'none' },
    { name: 'Has links (resources, playlists, socials)', pass: links.length > 0, detail: `${links.length} links` },
    { name: 'Target keyword in first two lines', pass: keyword ? firstLine.toLowerCase().includes(keyword.toLowerCase()) : true, detail: keyword || 'no keyword given' },
    { name: 'Not keyword-stuffed (keyword ≤ 5 times)', pass: keyword ? (d.toLowerCase().split(keyword.toLowerCase()).length - 1) <= 5 : true, detail: '' },
  ];
  return { score: Math.round(100 * checks.filter(c => c.pass).length / checks.length), checks, timestamps: timestamps.length, links: links.length, hashtags };
}

export function validateChapters(text = '') {
  const lines = String(text).split('\n').map(l => l.trim()).filter(Boolean);
  const chapters = [];
  const errors = [];
  for (const l of lines) {
    const m = /^((?:\d{1,2}:)?\d{1,2}:\d{2})\s*[-–—]?\s*(.+)$/.exec(l);
    if (!m) { errors.push(`Not a chapter line: "${l}"`); continue; }
    const parts = m[1].split(':').map(Number);
    const sec = parts.length === 3 ? parts[0] * 3600 + parts[1] * 60 + parts[2] : parts[0] * 60 + parts[1];
    chapters.push({ time: m[1], seconds: sec, label: m[2].trim() });
  }
  if (chapters.length && chapters[0].seconds !== 0) errors.push('First chapter must start at 0:00');
  if (chapters.length < 3) errors.push('YouTube needs at least 3 chapters');
  for (let i = 1; i < chapters.length; i++) {
    if (chapters[i].seconds <= chapters[i - 1].seconds) errors.push(`Chapter ${i + 1} is not later than chapter ${i}`);
    if (chapters[i].seconds - chapters[i - 1].seconds < 10) errors.push(`Chapter ${i + 1} is shorter than 10 seconds`);
  }
  return { valid: errors.length === 0, chapters, errors, formatted: chapters.map(c => `${c.time} ${c.label}`).join('\n') };
}

/** Candidate tags from title/description terms + autocomplete; no ranking promises. */
export async function suggestTags({ title = '', description = '', keyword = '', country = 'US' }) {
  const text = `${title} ${description}`.toLowerCase().replace(/[^\w\s]/g, ' ');
  const freq = {};
  for (const w of text.split(/\s+/)) if (w.length > 3 && !STOP.has(w)) freq[w] = (freq[w] || 0) + 1;
  const topWords = Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 8).map(x => x[0]);
  const seeds = [keyword, title.split(/[:|\-–(]/)[0]].filter(Boolean).map(s => s.trim()).filter(Boolean);
  const sugg = (await Promise.all(seeds.map(s => suggest(s, { country })))).flat();
  const candidates = [...new Set([...seeds, ...sugg, ...topWords, ...topWords.slice(0, 3).map((w, i) => topWords[i + 1] ? `${w} ${topWords[i + 1]}` : null).filter(Boolean)])].map(t => t.toLowerCase().trim());
  let total = 0; const tags = [];
  for (const c of candidates) { if (total + c.length + 1 > 480) break; tags.push(c); total += c.length + 1; }
  return { tags, charactersUsed: total, limit: 500, note: 'Tags are a weak ranking signal; use them for misspellings and alternate phrasings. The 500-character limit is enforced here.' };
}

/** Publishing checklist for a synced video. */
export function optimizationChecklist(videoId) {
  const v = getVideo(videoId);
  if (!v) return null;
  const ta = analyzeTitle(v.title);
  const da = analyzeDescription(v.description);
  const items = [
    { item: 'Title scores ≥ 70 on the heuristic check', pass: ta.score >= 70, detail: `${ta.score}/100` },
    { item: 'Description has chapters', pass: da.timestamps >= 3, detail: `${da.timestamps} timestamps` },
    { item: 'Description has ≥ 200 words', pass: da.checks[1].pass, detail: da.checks[1].detail },
    { item: 'Tags set (5–25)', pass: v.tags.length >= 5 && v.tags.length <= 25, detail: `${v.tags.length} tags` },
    { item: 'Default language set', pass: !!v.default_language, detail: v.default_language || 'missing' },
    { item: 'Custom thumbnail (not auto-frame)', pass: !!v.thumbnail && !/\/hqdefault|\/default\.jpg/.test(v.thumbnail) || !!v.thumbnail, detail: 'Cannot be verified by API; confirm in Studio' },
    { item: 'Category set', pass: !!v.category_id, detail: v.category_id || 'missing' },
    { item: 'Not a #shorts mislabel (long video with #shorts)', pass: !(v.duration_sec > 180 && /#shorts/i.test(v.title + v.description)), detail: '' },
  ];
  return { video: v, title: ta, description: da, items, score: Math.round(100 * items.filter(i => i.pass).length / items.length) };
}

/** Channel health: missing metadata across the library. */
export function channelHealth(channelId) {
  const vids = db.prepare('SELECT id, title, description, tags_json, default_language, category_id, thumbnail, view_count, published_at, is_short FROM videos WHERE channel_id = ?').all(channelId);
  const issues = [];
  for (const v of vids) {
    const tags = JSON.parse(v.tags_json || '[]');
    const d = v.description || '';
    const problems = [];
    if (!v.is_short && !(d.match(/^(\d{1,2}:)?\d{1,2}:\d{2}\s/gm) || []).length) problems.push('no chapters');
    if (d.split(/\s+/).filter(Boolean).length < 100) problems.push('thin description');
    if (tags.length < 5) problems.push('few tags');
    if (!v.default_language) problems.push('no language');
    if (v.title.length > 70) problems.push('title too long');
    if (v.title.length < 20) problems.push('title too short');
    if (problems.length) issues.push({ id: v.id, title: v.title, published_at: v.published_at, view_count: v.view_count, problems });
  }
  const summary = {};
  for (const i of issues) for (const p of i.problems) summary[p] = (summary[p] || 0) + 1;
  return { total: vids.length, withIssues: issues.length, summary, issues: issues.sort((a, b) => b.view_count - a.view_count) };
}

// ---------- AI-assisted generation ----------
export async function generateTitles({ topic, keyword = '', audience = '', facts = '', channelContext = '', count = 10 }) {
  const prompt = `Generate ${count} YouTube title options.
Topic: ${topic}
Target keyword (include naturally): ${keyword || 'none'}
Audience: ${audience || 'general'}
Facts/claims that may be used (do not invent others): ${facts || 'none provided'}
Channel context: ${channelContext || 'none'}
Mix structures: number list, how-to, question, contrast, first-person, warning. Keep each under 60 characters. Return JSON: {"titles":[{"title":"...","structure":"...","why":"..."}]}`;
  const out = await ai.ask('title_generator', prompt, { json: true });
  const titles = (out.titles || []).map(t => ({ ...t, analysis: analyzeTitle(t.title, { keyword }) }));
  return { titles };
}

export async function generateDescription({ title, keyword = '', summary = '', links = '', chapters = '', channelContext = '' }) {
  const prompt = `Write a YouTube description outline and draft.
Title: ${title}
Keyword: ${keyword || 'none'}
What the video covers (source of truth; do not add claims): ${summary || 'not given — write a structural template with placeholders'}
Links to include: ${links || 'none'}
Chapters (keep as-is): ${chapters || 'none'}
Channel context: ${channelContext || 'none'}
Format: 2-line hook that states the payoff, 1 paragraph summary with the keyword once, chapters block, links block, 2-3 hashtags. Return plain text only.`;
  return { description: await ai.ask('description_builder', prompt) };
}

export async function critiqueThumbnail({ imageUrl, title = '', localPath = null }) {
  let file = localPath ? assertThumbPath(localPath) : null;
  if (!file && imageUrl) file = await downloadImage(imageUrl);
  const prompt = `Critique this YouTube thumbnail for a video titled "${title}".
Assess: (1) legibility at 160px wide (text size, contrast), (2) one clear focal point, (3) relevance/truthfulness to the title, (4) emotion or curiosity, (5) clutter, (6) does it duplicate the title text instead of complementing it.
Return JSON: {"score":0-100,"strengths":[],"weaknesses":[],"fixes":[],"textDetected":"...","focalPoint":"...","mobileLegibility":"good|borderline|poor"}. Do not claim to predict CTR.`;
  return await ai.ask('thumbnail_critique', prompt, { json: true, imagePath: file });
}

export async function downloadImage(url) {
  const dir = path.join(DATA_DIR, 'thumbs');
  fs.mkdirSync(dir, { recursive: true });
  const name = Buffer.from(url).toString('base64url').slice(0, 80) + (url.includes('.png') ? '.png' : '.jpg');
  const file = path.join(dir, name);
  if (fs.existsSync(file)) return file;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not fetch image (${res.status})`);
  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  return file;
}

export async function translateMetadata({ title, description = '', tags = [], languages = [] }) {
  const prompt = `Translate this YouTube metadata into ${languages.join(', ')}. Keep meaning, adapt idioms, keep titles ≤ 70 chars, keep timestamps/URLs unchanged.
Title: ${title}
Description: ${description}
Tags: ${tags.join(', ')}
Return JSON: {"translations":{"<lang>":{"title":"...","description":"...","tags":[...]}}}`;
  return await ai.ask('metadata_translation', prompt, { json: true });
}

export async function abTestPlan({ title, variants = [], hypothesis = '' }) {
  const prompt = `Create a YouTube "Test & Compare" (native thumbnail A/B) experiment plan.
Video title: ${title}
Thumbnail variant descriptions: ${variants.map((v, i) => `${String.fromCharCode(65 + i)}: ${v}`).join('; ') || 'none provided'}
Hypothesis: ${hypothesis || 'none'}
Return JSON: {"hypothesis":"...","variants":[{"label":"A","change":"...","expectedEffect":"..."}],"metric":"watch time share (YouTube's winner metric)","minimumDuration":"...","successCriteria":"...","risks":[],"nextTestIfInconclusive":"..."}`;
  return await ai.ask('ab_plan', prompt, { json: true });
}

export async function hookReview({ transcriptOrScript, title }) {
  const first = String(transcriptOrScript || '').split(/\s+/).slice(0, 120).join(' ');
  const prompt = `Review the first ~30 seconds of this YouTube video script/transcript against the title "${title}".
Opening: """${first}"""
Check: does it restate the title's promise in the first 10 seconds? Is there visual proof or a concrete stake early? Any throat-clearing (greetings, channel intro, "in this video")? Does it open a loop that the video pays off?
Return JSON: {"score":0-100,"promiseRestated":bool,"throatClearing":[],"missing":[],"rewrite":"a tighter 2-3 sentence opening using only facts present"}`;
  return await ai.ask('hook_advisor', prompt, { json: true });
}

// ---------- Staged edits & apply (owner-authorized) ----------
export function stageEdit({ channelId, videoId, field, newValue }) {
  const v = getVideo(videoId);
  const old = field === 'tags' ? JSON.stringify(v?.tags || []) : (v?.[field === 'privacy' ? 'privacy_status' : field] ?? null);
  const r = db.prepare('INSERT INTO staged_edits (channel_id, video_id, field, old_value, new_value) VALUES (?, ?, ?, ?, ?)').run(channelId, videoId, field, old === null ? null : String(old), typeof newValue === 'string' ? newValue : JSON.stringify(newValue));
  return db.prepare('SELECT * FROM staged_edits WHERE id = ?').get(r.lastInsertRowid);
}
export function listStaged(channelId, status = 'staged') {
  return db.prepare('SELECT s.*, v.title AS video_title FROM staged_edits s LEFT JOIN videos v ON v.id = s.video_id WHERE s.channel_id = ? AND s.status = ? ORDER BY s.created_at DESC').all(channelId, status);
}
export function discardStaged(id) {
  return db.prepare("UPDATE staged_edits SET status = 'discarded' WHERE id = ? AND status = 'staged'").run(id).changes;
}

/** Apply staged edits for one video in a single videos.update (50 units) — snippet + status in one call. */
export async function applyStaged(channelId, videoId) {
  const edits = db.prepare("SELECT * FROM staged_edits WHERE channel_id = ? AND video_id = ? AND status = 'staged'").all(channelId, videoId);
  if (!edits.length) return { applied: 0 };
  // Must use the owner's OAuth token: an API-key request returns no items for private videos ("Video not found").
  const cur = await ytGet('videos.list', { part: 'snippet,status', id: videoId }, { ttl: 0, noCache: true, channelId });
  const item = cur.items?.[0];
  if (!item) throw new Error('Video not found');
  const snippet = { ...item.snippet };
  const status = { ...item.status };
  const parts = new Set(['snippet']);
  for (const e of edits) {
    if (e.field === 'title') snippet.title = e.new_value;
    else if (e.field === 'description') snippet.description = e.new_value;
    else if (e.field === 'tags') snippet.tags = JSON.parse(e.new_value);
    else if (e.field === 'defaultLanguage') snippet.defaultLanguage = e.new_value;
    else if (e.field === 'categoryId') snippet.categoryId = e.new_value;
    else if (e.field === 'privacy') { status.privacyStatus = e.new_value; parts.add('status'); }
    else if (e.field === 'publishAt') { status.privacyStatus = 'private'; status.publishAt = e.new_value; parts.add('status'); }
  }
  const body = { id: videoId, snippet: { title: snippet.title, description: snippet.description, tags: snippet.tags, categoryId: snippet.categoryId, defaultLanguage: snippet.defaultLanguage } };
  if (parts.has('status')) { body.status = { privacyStatus: status.privacyStatus, selfDeclaredMadeForKids: status.selfDeclaredMadeForKids }; if (edits.some(e => e.field === 'publishAt')) body.status.publishAt = status.publishAt; }
  try {
    await ytWrite('videos.update', { method: 'PUT', params: { part: [...parts].join(',') }, json: body, channelId });
    db.prepare("UPDATE staged_edits SET status = 'applied', applied_at = datetime('now') WHERE channel_id = ? AND video_id = ? AND status = 'staged'").run(channelId, videoId);
    for (const e of edits) db.prepare('INSERT INTO metadata_history (video_id, field, old_value, new_value) VALUES (?, ?, ?, ?)').run(videoId, e.field, e.old_value, e.new_value);
    if (snippet.title !== undefined) db.prepare('UPDATE videos SET title = ?, description = ?, tags_json = ? WHERE id = ?').run(snippet.title, snippet.description, JSON.stringify(snippet.tags || []), videoId);
    return { applied: edits.length };
  } catch (e) {
    db.prepare("UPDATE staged_edits SET status = 'failed', error = ? WHERE channel_id = ? AND video_id = ? AND status = 'staged'").run(e.message, channelId, videoId);
    throw e;
  }
}

export function assertThumbPath(p) {
  const dir = path.resolve(DATA_DIR, 'thumbs');
  const r = path.resolve(String(p || ''));
  if (!r.startsWith(dir + path.sep)) throw new Error('Image path must be inside the app thumbs folder (use the upload button or an image URL).');
  return r;
}

export async function setThumbnail(channelId, videoId, imagePath) {
  imagePath = assertThumbPath(imagePath);
  const { logApi } = await import('../youtube/client.js');
  const data = fs.readFileSync(imagePath);
  const ext = path.extname(imagePath).toLowerCase();
  const ct = ext === '.png' ? 'image/png' : 'image/jpeg';
  const url = new URL(process.env.YT_UPLOAD_BASE ? `${process.env.YT_UPLOAD_BASE}/thumbnails/set` : 'https://www.googleapis.com/upload/youtube/v3/thumbnails/set');
  url.searchParams.set('videoId', videoId);
  url.searchParams.set('uploadType', 'media');
  const { getAccessToken } = await import('../youtube/oauth.js');
  const res = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${await getAccessToken(channelId)}`, 'Content-Type': ct }, body: data });
  const j = await res.json();
  logApi({ api: 'data', endpoint: 'thumbnails.set', units: 50, cached: 0, ok: res.ok ? 1 : 0 });
  if (!res.ok) throw new Error(j?.error?.message || `thumbnails.set failed ${res.status}`);
  db.prepare('INSERT INTO metadata_history (video_id, field, old_value, new_value) VALUES (?, ?, ?, ?)').run(videoId, 'thumbnail', null, 'uploaded ' + path.basename(imagePath));
  return j;
}
