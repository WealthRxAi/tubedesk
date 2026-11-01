#!/usr/bin/env node
// TubeDesk MCP server (stdio, no dependencies). Lets any MCP client — Claude Code, Claude Desktop, Cursor, Codex, etc. —
// publish to YouTube/Instagram and read TubeDesk data by calling the local TubeDesk server.
//   claude mcp add tubedesk -- node /path/to/tubedesk/mcp/server.js
//   TUBEDESK_URL=http://localhost:4949 (default)
import readline from 'node:readline';

const BASE = (process.env.TUBEDESK_URL || 'http://localhost:4949').replace(/\/$/, '');
const VERSION = '1.2.0';

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
      publishAt: { type: 'string', description: 'ISO-8601 future time to schedule (privacy must be private)' }, thumbnail: { type: 'string', description: 'Absolute path to JPG/PNG ≤2 MB' },
      playlistId: { type: 'string' }, categoryId: { type: 'string' }, language: { type: 'string' }, madeForKids: { type: 'boolean', default: false }, notifySubscribers: { type: 'boolean', default: true },
      containsSyntheticMedia: { type: 'boolean', description: 'true for AI-generated or altered realistic content (YouTube disclosure)' }, channelId: { type: 'string' }, wait: { type: 'boolean', default: true } } } },
  { name: 'publish_instagram', description: 'Publish a Reel (MP4/MOV, 9:16) or an image (JPG/PNG) from this machine to the connected Instagram professional account. Free. Returns the job with the permalink when wait=true (default).',
    inputSchema: { type: 'object', required: ['file'], properties: {
      file: { type: 'string', description: 'Absolute path on this machine' }, kind: { type: 'string', enum: ['reel', 'image'], default: 'reel' }, caption: { type: 'string', maxLength: 2200 },
      shareToFeed: { type: 'boolean', default: true }, cover: { type: 'string', description: 'Absolute path to a JPG/PNG cover (reels)' }, thumbOffsetMs: { type: 'integer' },
      collaborators: { type: 'array', items: { type: 'string' } }, locationId: { type: 'string' }, wait: { type: 'boolean', default: true } } } },
  { name: 'publish_job', description: 'Get a publish job by id (status queued|running|done|failed, url, log). Set wait=true to block until it finishes.',
    inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'string' }, wait: { type: 'boolean', default: false }, timeoutSeconds: { type: 'integer', default: 600 } } } },
  { name: 'publish_status', description: 'Publishing readiness: authorized YouTube channels, uploads left today, Instagram configuration, recent jobs.', inputSchema: { type: 'object', properties: {} } },
  { name: 'list_channels', description: 'Owned and competitor channels tracked in TubeDesk (owned ones show whether they are authorized for uploads).', inputSchema: { type: 'object', properties: { kind: { type: 'string', enum: ['owned', 'competitor'] } } } },
  { name: 'channel_videos', description: 'Local catalogue of a channel: views, views/day, outlier × vs the channel median, format.', inputSchema: { type: 'object', required: ['channelId'], properties: { channelId: { type: 'string' }, limit: { type: 'integer', default: 50 }, sort: { type: 'string' } } } },
  { name: 'keyword_research', description: 'Autocomplete tree, competition evidence and demand index (0–100, not search volume) for a query.', inputSchema: { type: 'object', required: ['q'], properties: { q: { type: 'string' }, country: { type: 'string', default: 'US' } } } },
  { name: 'outliers', description: 'Videos performing far above their own channel median for a topic (search.list, 100 units per uncached query).', inputSchema: { type: 'object', required: ['q'], properties: { q: { type: 'string' }, days: { type: 'integer', default: 90 }, maxSubs: { type: 'integer' }, format: { type: 'string', enum: ['all', 'long', 'short'] } } } },
  { name: 'tubedesk_api', description: 'Call any TubeDesk REST endpoint (GET /api/... or POST /api/... with a JSON body). See GET /api/agent for the route list.',
    inputSchema: { type: 'object', required: ['path'], properties: { method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'DELETE'], default: 'GET' }, path: { type: 'string', description: 'e.g. /api/channels' }, body: { type: 'object' } } } },
];

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
    case 'publish_job': return call('GET', `/api/publish/jobs/${encodeURIComponent(a.id)}${q({ wait: a.wait ? 1 : undefined, timeout: a.timeoutSeconds })}`);
    case 'publish_status': return call('GET', '/api/publish/status');
    case 'list_channels': return call('GET', `/api/channels${q({ kind: a.kind })}`);
    case 'channel_videos': return call('GET', `/api/channels/${encodeURIComponent(a.channelId)}/videos${q({ limit: a.limit, sort: a.sort })}`);
    case 'keyword_research': { const [explore, demand] = await Promise.all([call('GET', `/api/keywords/explore${q({ q: a.q, country: a.country })}`), call('GET', `/api/keywords/demand${q({ q: a.q, country: a.country })}`)]); return { demand, explore }; }
    case 'outliers': return call('GET', `/api/outliers/search${q({ q: a.q, days: a.days, maxSubs: a.maxSubs, format: a.format })}`);
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
    if (method === 'initialize') return reply({ protocolVersion: params?.protocolVersion || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'tubedesk', version: VERSION }, instructions: `TubeDesk at ${BASE}: render_video turns a JSON timeline into an MP4; publish_youtube / publish_instagram upload it. All file arguments are absolute paths on this machine. Read GET /api/agent (tubedesk_api) for the full route list.` });
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
