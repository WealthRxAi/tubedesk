#!/usr/bin/env node
// TubeDesk MCP server (stdio, no dependencies). Lets any MCP client — Claude Code, Claude Desktop, Cursor, Codex, etc. —
// publish to YouTube/Instagram and read TubeDesk data by calling the local TubeDesk server.
//   claude mcp add tubedesk -- node /path/to/tubedesk/mcp/server.js
//   TUBEDESK_URL=http://localhost:4949 (default)
import readline from 'node:readline';

const BASE = (process.env.TUBEDESK_URL || 'http://localhost:4949').replace(/\/$/, '');
const VERSION = '1.7.0';

async function call(method, path, body) {
  const res = await fetch(BASE + path, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok) throw new Error(json?.error || `${method} ${path} → ${res.status}`);
  return json;
}
const q = o => { const u = new URLSearchParams(); for (const [k, v] of Object.entries(o || {})) if (v !== undefined && v !== null && v !== '') u.set(k, String(v)); const s = u.toString(); return s ? '?' + s : ''; };

const TOOLS = [
  { name: 'render_video', description: 'Render an MP4 from a JSON timeline with ffmpeg: video/image/box/text/captions/audio/tone tracks, zoom, auto-timed captions from a script, ducked music, loudness normalization. Returns the job with the output path when wait=true (default). Call tubedesk_api GET /api/render/schema for the full track reference.',
    inputSchema: { type: 'object', required: ['tracks'], properties: { width: { type: 'integer', default: 1080 }, height: { type: 'integer', default: 1920 }, fps: { type: 'integer', default: 30 }, background: { type: 'string' }, duration: { type: 'number' }, loudness: { type: 'number', default: -14 }, output: { type: 'string', description: 'absolute output path (.mp4)' }, tracks: { type: 'array', items: { type: 'object' } }, wait: { type: 'boolean', default: true } } } },
  { name: 'media_transcode', description: 'Transcode a video to a platform preset (short/reel 1080x1920, youtube 1920x1080, square, contain) with H.264/AAC and loudness normalization.',
    inputSchema: { type: 'object', required: ['file'], properties: { file: { type: 'string' }, preset: { type: 'string', enum: ['short', 'reel', 'youtube', 'square', 'contain'], default: 'short' }, output: { type: 'string' }, width: { type: 'integer' }, height: { type: 'integer' }, fit: { type: 'string', enum: ['cover', 'contain'] }, trim: { type: 'object', properties: { start: { type: 'number' }, duration: { type: 'number' } } }, wait: { type: 'boolean', default: true } } } },
  { name: 'media_probe', description: 'Duration, resolution, fps, codecs, size of a media file.', inputSchema: { type: 'object', required: ['file'], properties: { file: { type: 'string' } } } },
  { name: 'speech_segments', description: 'Speech segments (start/end) of a voice track via pause detection — use to place cuts and B-roll on sentence boundaries.', inputSchema: { type: 'object', required: ['file'], properties: { file: { type: 'string' }, noiseDb: { type: 'number', default: -35 }, minPause: { type: 'number', default: 0.22 } } } },
  { name: 'caption_timing', description: 'Time a script (one line per spoken sentence/pause) against the voice track → word timings and 3–4-word caption groups ready for a captions track.', inputSchema: { type: 'object', required: ['file', 'script'], properties: { file: { type: 'string' }, script: { type: 'array', items: { type: 'string' } }, maxWords: { type: 'integer', default: 4 } } } },
  { name: 'extract_frame', description: 'Save a JPG frame from a video at a timestamp (for QA or a cover image).', inputSchema: { type: 'object', required: ['file'], properties: { file: { type: 'string' }, at: { type: 'number', default: 1 }, output: { type: 'string' }, width: { type: 'integer' } } } },
  { name: 'render_job', description: 'Get a render/transcode job by id; wait=true blocks until it finishes.', inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'string' }, wait: { type: 'boolean', default: false } } } },
  { name: 'publish_youtube', description: 'Upload a video file from this machine to the connected YouTube channel. Costs 1,600 API units (≈6 uploads/day on the free quota). Returns the job with the video URL when wait=true (default).',
    inputSchema: { type: 'object', required: ['file', 'title'], properties: {
      file: { type: 'string', description: 'Absolute path to an MP4/MOV on this machine' }, title: { type: 'string', maxLength: 100 }, description: { type: 'string', maxLength: 5000 },
      tags: { type: 'array', items: { type: 'string' } }, privacy: { type: 'string', enum: ['private', 'unlisted', 'public'], default: 'private' },
      publishAt: { type: 'string', description: 'ISO-8601 future time to schedule (privacy must be private), or "best" for the channel next best slot' }, format: { type: 'string', enum: ['long', 'short'], description: 'With publishAt "best": which history to learn the slot from' }, thumbnail: { type: 'string', description: 'Absolute path to JPG/PNG ≤2 MB' },
      playlistId: { type: 'string' }, categoryId: { type: 'string' }, language: { type: 'string' }, madeForKids: { type: 'boolean', default: false }, notifySubscribers: { type: 'boolean', default: true },
      containsSyntheticMedia: { type: 'boolean', description: 'true for AI-generated or altered realistic content (YouTube disclosure)' }, channelId: { type: 'string' }, wait: { type: 'boolean', default: true } } } },
  { name: 'publish_instagram', description: 'Publish a Reel (MP4/MOV, 9:16) or an image (JPG/PNG) from this machine to the connected Instagram professional account. Free. Returns the job with the permalink when wait=true (default).',
    inputSchema: { type: 'object', required: ['file'], properties: {
      file: { type: 'string', description: 'Absolute path on this machine' }, kind: { type: 'string', enum: ['reel', 'image'], default: 'reel' }, caption: { type: 'string', maxLength: 2200 },
      shareToFeed: { type: 'boolean', default: true }, cover: { type: 'string', description: 'Absolute path to a JPG/PNG cover (reels)' }, thumbOffsetMs: { type: 'integer' },
      collaborators: { type: 'array', items: { type: 'string' } }, locationId: { type: 'string' }, wait: { type: 'boolean', default: true } } } },
  { name: 'publish_tiktok', description: 'Upload and publish a video (MP4/MOV/WebM) from this machine to the connected TikTok account. Until TikTok audits the app, the post is private ("Only me"). Returns the job with the URL when wait=true (default).',
    inputSchema: { type: 'object', required: ['file'], properties: { file: { type: 'string' }, title: { type: 'string', description: 'caption, hashtags allowed, ≤2200 chars' }, privacy: { type: 'string', enum: ['PUBLIC_TO_EVERYONE', 'MUTUAL_FOLLOW_FRIENDS', 'FOLLOWER_OF_CREATOR', 'SELF_ONLY'] }, allowComment: { type: 'boolean', default: true }, allowDuet: { type: 'boolean', default: false }, allowStitch: { type: 'boolean', default: false }, disclose: { type: 'boolean', description: 'AI-generated content label' }, wait: { type: 'boolean', default: true } } } },
  { name: 'voiceover', description: 'Generate an ElevenLabs voiceover from text (the user\'s key in TubeDesk settings). Returns the MP3 path, duration, per-word timings and caption groups ready for a render_video captions track ({type:"captions", groups}).', inputSchema: { type: 'object', required: ['text'], properties: { text: { type: 'string' }, voiceId: { type: 'string' }, model: { type: 'string' }, speed: { type: 'number', default: 1 }, maxWords: { type: 'integer', default: 4 } } } },
  { name: 'voiceover_short', description: 'Script → voiceover → ready 9:16 timeline (background clip/image, ducked voice, word captions, optional headline). render=true also renders the MP4 and returns its path.', inputSchema: { type: 'object', required: ['text', 'background'], properties: { text: { type: 'string' }, background: { type: 'string', description: 'absolute path to a video or image' }, headline: { type: 'string' }, music: { type: 'string' }, voiceId: { type: 'string' }, render: { type: 'boolean', default: true } } } },
  { name: 'voiceover_voices', description: 'List ElevenLabs voices available on the account, plus remaining character quota.', inputSchema: { type: 'object', properties: {} } },
  { name: 'make_thumbnails', description: 'Thumbnail maker: frames from a video (or given images / an optional Higgsfield AI background) × headlines × styles → 1280×720 candidates ranked 0–100 by the thumbnail critic. Use the best file as `thumbnail` in publish_youtube.', inputSchema: { type: 'object', properties: { file: { type: 'string', description: 'absolute path to the video' }, title: { type: 'string' }, headlines: { type: 'array', items: { type: 'string' }, description: 'up to 3; use "|" to force a line break' }, styles: { type: 'array', items: { type: 'string', enum: ['bold', 'clean', 'alert', 'contrast'] } }, frames: { type: 'integer', default: 3 }, backgrounds: { type: 'array', items: { type: 'string' } }, aiPrompt: { type: 'string', description: 'optional Higgsfield text→image background (needs API key+secret in settings; costs credits)' }, score: { type: 'boolean', default: true }, max: { type: 'integer', default: 12 } } } },
  { name: 'similar_channels', description: 'Channels similar to one of yours: ranks channels that keep appearing for your best-performing title terms, scored by overlap × size fit. Marks ones already tracked as competitors.', inputSchema: { type: 'object', required: ['channelId'], properties: { channelId: { type: 'string' }, limit: { type: 'integer', default: 25 }, country: { type: 'string' } } } },
  { name: 'ig_track_account', description: 'Track a professional Instagram account (Creator/Business) by username: public profile, followers, last 50 posts with likes/comments; kept locally and re-synced daily for outlier detection.', inputSchema: { type: 'object', required: ['username'], properties: { username: { type: 'string' }, note: { type: 'string' } } } },
  { name: 'ig_lookup', description: 'One-off public lookup of a professional Instagram account (profile + recent posts) without tracking it.', inputSchema: { type: 'object', required: ['username'], properties: { username: { type: 'string' }, limit: { type: 'integer', default: 25 } } } },
  { name: 'ig_outliers', description: 'Instagram posts from tracked accounts that beat their own account\'s median engagement (likes+comments) by ≥ minX — the vidIQ outlier idea for Instagram. Views are not public on other accounts, so engagement is the signal.', inputSchema: { type: 'object', properties: { days: { type: 'integer', default: 90 }, minX: { type: 'number', default: 1.5 }, reelsOnly: { type: 'boolean', default: false }, username: { type: 'string' }, limit: { type: 'integer', default: 50 } } } },
  { name: 'ig_hashtag', description: 'Instagram hashtag research: top or recent media for a hashtag with engagement, reel share and median engagement (Instagram allows 30 unique hashtags per 7 days; results are cached 24h).', inputSchema: { type: 'object', required: ['tag'], properties: { tag: { type: 'string' }, kind: { type: 'string', enum: ['top', 'recent'], default: 'top' } } } },
  { name: 'tiktok_videos', description: 'Your TikTok videos (connected account) with views, likes, comments, shares, views/day and × vs your median. sync=true pulls fresh numbers first.', inputSchema: { type: 'object', properties: { sync: { type: 'boolean', default: false }, limit: { type: 'integer', default: 50 } } } },
  { name: 'publish_job', description: 'Get a publish job by id (status queued|running|done|failed, url, log). Set wait=true to block until it finishes.',
    inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'string' }, wait: { type: 'boolean', default: false }, timeoutSeconds: { type: 'integer', default: 600 } } } },
  { name: 'publish_status', description: 'Publishing readiness: authorized YouTube channels, uploads left today, Instagram configuration, recent jobs.', inputSchema: { type: 'object', properties: {} } },
  { name: 'list_channels', description: 'Owned and competitor channels tracked in TubeDesk (owned ones show whether they are authorized for uploads).', inputSchema: { type: 'object', properties: { kind: { type: 'string', enum: ['owned', 'competitor'] } } } },
  { name: 'channel_videos', description: 'Local catalogue of a channel: views, views/day, outlier × vs the channel median, format.', inputSchema: { type: 'object', required: ['channelId'], properties: { channelId: { type: 'string' }, limit: { type: 'integer', default: 50 }, sort: { type: 'string' } } } },
  { name: 'keyword_research', description: 'Autocomplete tree, competition evidence and demand index (0–100, not search volume) for a query.', inputSchema: { type: 'object', required: ['q'], properties: { q: { type: 'string' }, country: { type: 'string', default: 'US' } } } },
  { name: 'outliers', description: 'Videos performing far above their own channel median for a topic (search.list, 100 units per uncached query).', inputSchema: { type: 'object', required: ['q'], properties: { q: { type: 'string' }, days: { type: 'integer', default: 90 }, maxSubs: { type: 'integer' }, format: { type: 'string', enum: ['all', 'long', 'short'] } } } },
  { name: 'radar_score', description: 'Virality radar: score 1–8 title/thumbnail variants (plus optional opening hook) for a video idea BEFORE publishing. Returns each variant ranked with 8 axes (demand, proven-pattern fit, freshness, title craft, curiosity, emotion, thumbnail, hook), a 0–100 score, the predicted multiplier vs the channel\'s usual views with an 80% range, P(breakout ≥2×) and concrete fixes. Calibrated to the channel once radar_calibrate has run.',
    inputSchema: { type: 'object', required: ['variants'], properties: {
      channelId: { type: 'string', description: 'Owned channel id (defaults to the first owned channel)' },
      variants: { type: 'array', items: { type: 'object', required: ['title'], properties: { title: { type: 'string' }, thumbnailUrl: { type: 'string' }, thumbnailPath: { type: 'string', description: 'Image inside TubeDesk data/thumbs (POST /api/packaging/thumbnail/upload)' } } } },
      hook: { type: 'string', description: 'First ~30 seconds of the script' }, keyword: { type: 'string' }, format: { type: 'string', enum: ['long', 'short'], default: 'long' } } } },
  { name: 'radar_watch', description: 'Live breakout watch: new uploads (yours and tracked competitors\') with views vs the channel\'s usual launch curve at the same age (velocity index), status (breakout/rising/on-track/lagging/stalled) and retention when available. run=true takes a fresh reading first (≈2 quota units per channel).',
    inputSchema: { type: 'object', properties: { channelId: { type: 'string' }, run: { type: 'boolean', default: false } } } },
  { name: 'radar_calibrate', description: 'Backtest the radar on the channel\'s own history (plus tracked competitors) and store calibrated weights. Reports holdout accuracy (Spearman, top-quartile hit rate vs base rate). AI features are cached, so reruns are cheap.',
    inputSchema: { type: 'object', properties: { channelId: { type: 'string' }, aiLimit: { type: 'integer', default: 60 }, ai: { type: 'boolean', default: true } } } },
  { name: 'daily_ideas', description: 'Today\'s radar-scored video ideas for a channel, each with 3 title options ranked on the virality radar, thumbnail text, a hook and the evidence it came from (competitor breakouts, your winners, real search terms, new autocomplete suggestions). run=true builds a fresh list first (AI; ~1–3 minutes).',
    inputSchema: { type: 'object', properties: { channelId: { type: 'string' }, run: { type: 'boolean', default: false }, count: { type: 'integer', default: 8 } } } },
  { name: 'autopilot', description: 'Radar autopilot for lagging uploads. action "list" (default): every title/thumbnail change made or suggested, with diagnosis, before/after radar scores and the CTR grade. action "run" with videoId: diagnose → write truthful alternatives → score on the radar → swap in a clear winner (respects autopilot_mode auto/suggest/off). action "revert" with actionId: restore the original packaging.',
    inputSchema: { type: 'object', properties: { channelId: { type: 'string' }, action: { type: 'string', enum: ['list', 'run', 'revert'], default: 'list' }, videoId: { type: 'string' }, actionId: { type: 'integer' } } } },
  { name: 'ctr_report', description: 'Impressions and impressions CTR per video and per day from the YouTube Reporting API (daily, ~2-day delay), the channel\'s usual first-days CTR, and high-impression videos with low CTR (packaging fix candidates). sync=true pulls new reports first.',
    inputSchema: { type: 'object', properties: { channelId: { type: 'string' }, days: { type: 'integer', default: 28 }, sync: { type: 'boolean', default: false } } } },
  { name: 'make_shorts', description: 'Cut vertical Shorts from one of your long-form uploads: transcribes its source file locally (whisper.cpp), picks self-contained moments, scores each title on the virality radar, renders 1080×1920 clips with word-timed captions and an on-screen hook, and (autoPublish, default from settings) schedules them into your best Shorts slots on YouTube and Instagram. Runs automatically when an upload breaks out; use this to run it on demand. Takes a few minutes.',
    inputSchema: { type: 'object', required: ['videoId'], properties: { videoId: { type: 'string' }, count: { type: 'integer', default: 3 }, autoPublish: { type: 'boolean' } } } },
  { name: 'portfolio', description: 'Every channel you own (+ Instagram) on one board: views and subs this week vs last, the latest upload\'s pace and CTR, monetization progress, open alerts, autopilot activity, today\'s top idea, queued Shorts. weekly=true also returns (and phones) the weekly summary text.',
    inputSchema: { type: 'object', properties: { weekly: { type: 'boolean', default: false } } } },
  { name: 'best_publish_time', description: 'Next best publish slots for a channel, learned from how your own uploads performed by local weekday and 3-hour block (shrunk toward neutral when data is thin). Use format "short" for Shorts. To schedule straight into the best slot, call publish_youtube with publishAt "best".',
    inputSchema: { type: 'object', properties: { channelId: { type: 'string' }, format: { type: 'string', enum: ['long', 'short'] }, count: { type: 'integer', default: 3 } } } },
  { name: 'tubedesk_api', description: 'Call any TubeDesk REST endpoint (GET /api/... or POST /api/... with a JSON body). See GET /api/agent for the route list.',
    inputSchema: { type: 'object', required: ['path'], properties: { method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'DELETE'], default: 'GET' }, path: { type: 'string', description: 'e.g. /api/channels' }, body: { type: 'object' } } } },
];

async function firstOwned() {
  const owned = await call('GET', '/api/channels?kind=owned');
  if (!owned.length) throw new Error('No owned channel in TubeDesk yet — add one under Channels.');
  return owned[0].id;
}

async function runTool(name, a = {}) {
  switch (name) {
    case 'render_video': { const { wait = true, ...body } = a; return call('POST', `/api/render${wait ? '?wait=1&timeout=3600' : ''}`, body); }
    case 'media_transcode': { const { wait = true, ...body } = a; return call('POST', `/api/media/transcode${wait ? '?wait=1&timeout=3600' : ''}`, body); }
    case 'media_probe': return call('POST', '/api/media/probe', { file: a.file });
    case 'speech_segments': return call('POST', '/api/media/segments', a);
    case 'caption_timing': return call('POST', '/api/media/captions', a);
    case 'extract_frame': return call('POST', '/api/media/frame', a);
    case 'render_job': return call('GET', `/api/render/jobs/${encodeURIComponent(a.id)}${q({ wait: a.wait ? 1 : undefined, timeout: 3600 })}`);
    case 'publish_youtube': { const { wait = true, ...body } = a; return call('POST', `/api/publish/youtube${wait ? '?wait=1&timeout=1800' : ''}`, body); }
    case 'publish_instagram': { const { wait = true, ...body } = a; return call('POST', `/api/publish/instagram${wait ? '?wait=1&timeout=1800' : ''}`, body); }
    case 'publish_tiktok': { const { wait = true, ...body } = a; return call('POST', `/api/publish/tiktok${wait ? '?wait=1&timeout=1800' : ''}`, body); }
    case 'ig_track_account': return call('POST', '/api/social/ig/accounts', { username: a.username, note: a.note });
    case 'voiceover': return call('POST', '/api/media/voiceover', a);
    case 'voiceover_short': { const { render = true, ...body } = a; return call('POST', `/api/media/voiceover/short${render ? '?wait=1' : ''}`, { ...body, render }); }
    case 'voiceover_voices': { const voices = await call('GET', '/api/media/voiceover/voices'); let quota = null; try { quota = await call('GET', '/api/media/voiceover/quota'); } catch { /* optional */ } return { voices, quota }; }
    case 'make_thumbnails': { const { aiPrompt, ...body } = a; return call('POST', '/api/media/thumbnails', { ...body, ai: aiPrompt ? { prompt: aiPrompt } : null }); }
    case 'similar_channels': return call('GET', `/api/channels/${encodeURIComponent(a.channelId)}/similar-channels${q({ limit: a.limit, country: a.country })}`);
    case 'ig_lookup': return call('GET', `/api/social/ig/lookup${q({ username: a.username, limit: a.limit })}`);
    case 'ig_outliers': return call('GET', `/api/social/ig/outliers${q({ days: a.days, minX: a.minX, reels: a.reelsOnly ? 1 : undefined, username: a.username, limit: a.limit })}`);
    case 'ig_hashtag': return call('GET', `/api/social/ig/hashtag${q({ q: a.tag, kind: a.kind })}`);
    case 'tiktok_videos': { if (a.sync) await call('POST', '/api/social/tiktok/sync', {}); return call('GET', `/api/social/tiktok/videos${q({ limit: a.limit })}`); }
    case 'publish_job': return call('GET', `/api/publish/jobs/${encodeURIComponent(a.id)}${q({ wait: a.wait ? 1 : undefined, timeout: a.timeoutSeconds })}`);
    case 'publish_status': return call('GET', '/api/publish/status');
    case 'list_channels': return call('GET', `/api/channels${q({ kind: a.kind })}`);
    case 'channel_videos': return call('GET', `/api/channels/${encodeURIComponent(a.channelId)}/videos${q({ limit: a.limit, sort: a.sort })}`);
    case 'keyword_research': { const [explore, demand] = await Promise.all([call('GET', `/api/keywords/explore${q({ q: a.q, country: a.country })}`), call('GET', `/api/keywords/demand${q({ q: a.q, country: a.country })}`)]); return { demand, explore }; }
    case 'outliers': return call('GET', `/api/outliers/search${q({ q: a.q, days: a.days, maxSubs: a.maxSubs, format: a.format })}`);
    case 'radar_score': return call('POST', '/api/radar/score', { ...a, channelId: a.channelId || await firstOwned() });
    case 'radar_watch': { const id = a.channelId || await firstOwned(); if (a.run) await call('POST', '/api/radar/watch/run'); return call('GET', `/api/radar/watch/${encodeURIComponent(id)}`); }
    case 'radar_calibrate': { const id = a.channelId || await firstOwned(); return call('POST', `/api/radar/calibrate/${encodeURIComponent(id)}?wait=1&timeout=3600`, { aiLimit: a.aiLimit, ai: a.ai }); }
    case 'daily_ideas': { const id = a.channelId || await firstOwned(); if (a.run) return call('POST', `/api/ideas/${encodeURIComponent(id)}/run`, { count: a.count }); return call('GET', `/api/ideas/${encodeURIComponent(id)}`); }
    case 'autopilot': {
      if (a.action === 'run') { if (!a.videoId) throw new Error('videoId is required for action "run"'); return call('POST', `/api/autopilot/run/${encodeURIComponent(a.videoId)}`, {}); }
      if (a.action === 'revert') { if (!a.actionId) throw new Error('actionId is required for action "revert"'); return call('POST', `/api/autopilot/actions/${a.actionId}/revert`, {}); }
      return call('GET', `/api/autopilot/${encodeURIComponent(a.channelId || await firstOwned())}`);
    }
    case 'ctr_report': { const id = a.channelId || await firstOwned(); if (a.sync) await call('POST', `/api/reach/${encodeURIComponent(id)}/sync`, {}); return call('GET', `/api/reach/${encodeURIComponent(id)}?days=${a.days || 28}`); }
    case 'make_shorts': return call('POST', `/api/shorts/make/${encodeURIComponent(a.videoId)}?wait=1`, { count: a.count, autoPublish: a.autoPublish });
    case 'portfolio': return a.weekly ? call('POST', '/api/portfolio/weekly-summary', { send: true }) : call('GET', '/api/portfolio');
    case 'best_publish_time': { const id = a.channelId || await firstOwned(); return call('GET', `/api/slots/${encodeURIComponent(id)}?count=${a.count || 3}${a.format ? '&format=' + a.format : ''}`); }
    case 'tubedesk_api': { const p = String(a.path || ''); if (!p.startsWith('/api/')) throw new Error('path must start with /api/'); return call(a.method || 'GET', p, a.body); }
    default: throw new Error(`unknown tool ${name}`);
  }
}

const out = msg => process.stdout.write(JSON.stringify(msg) + '\n');
let pending = 0;
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', async line => {
  if (!line.trim()) return;
  pending++;
  try { await handle(line); } finally { pending--; }
});
async function handle(line) {
  let req; try { req = JSON.parse(line); } catch { return; }
  const { id, method, params } = req;
  const reply = result => id !== undefined && out({ jsonrpc: '2.0', id, result });
  const fail = (code, message) => id !== undefined && out({ jsonrpc: '2.0', id, error: { code, message } });
  try {
    if (method === 'initialize') return reply({ protocolVersion: params?.protocolVersion || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'tubedesk', version: VERSION }, instructions: `TubeDesk at ${BASE}: render_video turns a JSON timeline into an MP4; publish_youtube / publish_instagram upload it. Before publishing, radar_score ranks title/thumbnail variants on the virality radar; after publishing, radar_watch shows whether the upload is beating its usual launch curve, autopilot fixes lagging uploads, ctr_report gives real impressions/CTR, and daily_ideas is the morning idea list. All file arguments are absolute paths on this machine. Read GET /api/agent (tubedesk_api) for the full route list.` });
    if (method === 'notifications/initialized' || method === 'initialized') return;
    if (method === 'ping') return reply({});
    if (method === 'tools/list') return reply({ tools: TOOLS });
    if (method === 'tools/call') {
      try { const r = await runTool(params?.name, params?.arguments || {}); return reply({ content: [{ type: 'text', text: JSON.stringify(r, null, 2) }], isError: false }); }
      catch (e) { return reply({ content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true }); }
    }
    if (method === 'resources/list') return reply({ resources: [] });
    if (method === 'prompts/list') return reply({ prompts: [] });
    return fail(-32601, `method not found: ${method}`);
  } catch (e) { return fail(-32000, e.message); }
}
process.stdin.on('end', () => { const t = setInterval(() => { if (pending === 0) { clearInterval(t); process.exit(0); } }, 20); });
