// Setup, configuration and remote-access routes, plus the guard that limits what remote AI apps may do through the
// local API. Mounted on the /api router before every other route.
import { Router } from 'express';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getSetting, DATA_DIR } from '../db.js';
import { ytGet } from '../youtube/client.js';
import { authUrl } from '../youtube/oauth.js';
import * as ch from '../services/channels.js';
import * as comp from '../services/competitors.js';
import * as ai from '../services/ai.js';
import * as pub from '../services/publish.js';
import * as social from '../services/social.js';
import * as voice from '../services/voice.js';
import * as notifier from '../services/notify.js';
import * as transcribe from '../services/transcribe.js';
import * as ren from '../services/render.js';
import * as cfg from '../services/settings-schema.js';
import * as remote from '../services/remote.js';
import { TOOLS, createToolRunner } from '../../mcp/tools.js';
import { openapi } from '../services/openapi.js';

export const setup = Router();
const w = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
export const isRemote = req => req.headers['x-tubedesk-origin'] === 'remote';

// ---------- guard for calls arriving from remote AI apps (through the public listener) ----------
const MEDIA_EXT = /\.(mp4|mov|m4v|webm|mp3|wav|m4a|aac|jpg|jpeg|png|webp|gif|srt|vtt|json)$/i;
const outputRoots = () => [DATA_DIR, os.tmpdir(), ...['Movies', 'Desktop', 'Documents', 'Downloads', 'Pictures', 'Music'].map(d => path.join(os.homedir(), d))].map(p => path.resolve(p) + path.sep);
export function remoteGuard(req, res, next) {
  if (!isRemote(req)) return next();
  // Express matches routes case-insensitively and ignores a trailing slash, so compare a normalised path.
  const p = ('/' + req.path.toLowerCase().split('/').filter(Boolean).join('/'));
  // Raw settings writes (any key, including program paths) and remote-access management stay on the Mac.
  if (p === '/settings' && req.method !== 'GET') return res.status(403).json({ error: 'Remote apps change settings with update_settings (PUT /api/config).' });
  if (p.startsWith('/remote/') && !(req.method === 'GET' && p === '/remote/status')) return res.status(403).json({ error: 'Remote access can only be managed on the Mac running TubeDesk.' });
  // Where alerts go (and the alert log, which once carried approval codes) decides who can approve new apps: Mac only.
  if (p === '/plugin/download' || p.startsWith('/admin') || p.startsWith('/system') || p === '/notify/log') return res.status(403).json({ error: 'Only available on the Mac.' });
  // Files a remote app asks TubeDesk to write must be media in the user's media folders or TubeDesk's data folder.
  const out = req.body && typeof req.body === 'object' ? req.body.output : undefined;
  if (out !== undefined && out !== null && out !== '') {
    const abs = path.resolve(String(out));
    if (!MEDIA_EXT.test(abs) || !outputRoots().some(r => abs.startsWith(r))) return res.status(403).json({ error: `Remote apps can only write media files under ~/Movies, ~/Desktop, ~/Documents, ~/Downloads, ~/Pictures, ~/Music or TubeDesk's data folder (got ${abs}).` });
  }
  next();
}
setup.use(remoteGuard);

// ---------- setup checklist ----------
setup.get('/setup', w(async (req, res) => {
  const owned = ch.listChannels('owned');
  const items = [];
  const add = (id, label, ok, detail, next = null, required = false) => items.push({ id, label, ok: !!ok, required, detail, next: ok ? null : next });
  add('youtube_api_key', 'YouTube Data API key', !!getSetting('yt_api_key'), getSetting('yt_api_key') ? 'set' : 'missing',
    'Create a free key: console.cloud.google.com → APIs & Services → enable "YouTube Data API v3" → Credentials → Create API key. Then update_settings {yt_api_key}.', true);
  add('google_oauth', 'Google sign-in app (analytics + uploads)', getSetting('google_client_id') && getSetting('google_client_secret'), getSetting('google_client_id') ? 'client set' : 'missing',
    'Google Cloud → Credentials → Create OAuth client ID (type "Web application", redirect URI http://localhost:4949/oauth/callback; add yourself as a test user on the consent screen). Then update_settings {google_client_id, google_client_secret}.');
  const a = await ai.status();
  add('ai', 'AI provider (ideas, titles, scoring)', a.ok, `${a.provider}: ${a.detail}`, 'Install Claude Code on the Mac (npm i -g @anthropic-ai/claude-code, sign in once) or update_settings {ai_provider:"anthropic", anthropic_api_key}.', true);
  add('owned_channel', 'Your channels', owned.length > 0, owned.map(c => c.title).join(', ') || 'none', 'add_channel {input:"@yourhandle", kind:"owned"} for each channel you own.', true);
  for (const c of owned) add(`connected_${c.id}`, `${c.title}: connected with Google`, c.authorized, c.authorized ? (c.oauth_email || 'connected') : 'not connected — no analytics, CTR or uploads', 'connect_account {service:"google"} and open the link on the Mac, signing in with the Google account that owns this channel.');
  const competitors = owned.reduce((n, c) => n + comp.listCompetitors(c.id).length, 0);
  add('competitors', 'Competitors tracked', competitors > 0, `${competitors}`, 'similar_channels {channelId} to find them, then add_channel {input, kind:"competitor"}.');
  const ig = pub.instagramStatus();
  add('instagram', 'Instagram (publishing + reels radar)', ig.configured, ig.configured ? `@${getSetting('ig_username', '') || getSetting('ig_user_id')}` : 'not connected', 'connect_account {service:"instagram"} for the steps.');
  const tt = social.tiktokStatus();
  add('tiktok', 'TikTok (stats + publishing)', tt.connected, tt.connected ? `@${tt.username || tt.openId}` : (tt.configured ? 'app set, account not connected' : 'not set up'), 'connect_account {service:"tiktok"} for the steps.');
  const v = voice.status();
  add('voiceover', 'Voiceover (HeyGen / ElevenLabs)', v.configured, v.configured ? v.provider : 'no key', 'update_settings {heygen_api_key, heygen_voice_id} (or elevenlabs_api_key).');
  const n = notifier.channelsConfigured();
  add('notifications', 'Phone alerts', n.length > 0, n.join(', ') || 'none', 'Where alerts go also decides who can approve new AI apps, so it is set on the Mac: TubeDesk → Virality radar → Autopilot → Phone alerts (iMessage number, or a topic in the free ntfy app). Then test_notification.');
  const e = transcribe.engineStatus();
  add('transcription', 'Local transcription (Shorts, hook scoring)', !!e.whisper, e.whisper ? `whisper.cpp ${e.modelReady ? '+ model' : '(model downloads on first use)'}` : 'whisper.cpp not installed', 'On the Mac: brew install whisper-cpp');
  const r = ren.toolStatus();
  add('ffmpeg', 'ffmpeg (render, Shorts, thumbnails)', r.ready, r.ffmpeg || 'not found', 'On the Mac: brew install ffmpeg', true);
  const t = await remote.tunnelStatus();
  add('remote_access', 'Remote access for AI apps (ChatGPT, Claude web/phone…)', t.state === 'on', t.state === 'on' ? t.publicUrl : t.state, t.next);
  const tz = getSetting('timezone', '');
  add('timezone', 'Time zone', !!tz, tz || `not set (using ${Intl.DateTimeFormat().resolvedOptions().timeZone})`, `update_settings {timezone:"${Intl.DateTimeFormat().resolvedOptions().timeZone}"}`);
  const missing = items.filter(i => !i.ok);
  const next = missing.find(i => i.required) || missing[0] || null;
  res.json({ ready: !items.some(i => i.required && !i.ok), done: items.length - missing.length, total: items.length, next, items });
}));

setup.get('/setup/connect/:service', w(async (req, res) => {
  const s = req.params.service;
  if (s === 'google') {
    if (!getSetting('google_client_id')) return res.status(400).json({ error: 'Set google_client_id and google_client_secret first (setup_status explains how).' });
    return res.json({ service: s, url: authUrl(), openOn: 'the Mac running TubeDesk (the sign-in returns to http://localhost:4949)', next: 'Sign in with the Google account that owns the channel and allow access. TubeDesk links every channel on that account. Then call setup_status.' });
  }
  if (s === 'tiktok') {
    const st = social.tiktokStatus();
    if (!st.configured) return res.json({ service: s, steps: ['Create a free app at developers.tiktok.com (Login Kit + Content Posting API), redirect URI = a page you control (TubeDesk ships one in docs/).', 'update_settings {tt_client_key, tt_client_secret, tt_redirect_uri}', 'connect_account {service:"tiktok"} again for the sign-in link.'] });
    const { url } = social.tiktokAuthUrl();
    return res.json({ service: s, url, next: 'Open the link, approve, then copy the "code" from the page you land on and call tubedesk_api POST /api/social/tiktok/connect {code}.' });
  }
  if (s === 'instagram') {
    return res.json({ service: s, configured: pub.instagramStatus().configured, steps: [
      'Instagram account must be Professional (Creator or Business): Instagram app → Settings → Account type.',
      'developers.facebook.com → Create app (type Business) → add product "Instagram" → "API setup with Instagram login" → Generate token for your account (permissions: instagram_business_basic, instagram_business_content_publish, instagram_business_manage_insights).',
      'update_settings {ig_access_token:"<token>", ig_user_id:"<id shown next to the token>", ig_username:"<handle>"}. TubeDesk refreshes the token automatically.',
    ] });
  }
  res.status(400).json({ error: 'service must be google, tiktok or instagram' });
}));

// ---------- validated settings ----------
setup.get('/config', (req, res) => res.json({ groups: [...new Set(cfg.SCHEMA.map(s => s.group))], settings: cfg.describe(req.query.group || null) }));
setup.put('/config', w(async (req, res) => {
  const changed = cfg.apply(req.body || {}, { remote: isRemote(req) });
  const out = { changed };
  if (changed.some(c => c.key === 'yt_api_key') && getSetting('yt_api_key')) {
    try { await ytGet('videoCategories.list', { part: 'snippet', regionCode: 'US' }, { ttl: 0, noCache: true }); out.yt_api_key = 'works'; }
    catch (e) { out.yt_api_key = `saved, but YouTube rejected it: ${e.message}`; }
  }
  res.json(out);
}));

// ---------- tools over plain HTTP on the Mac (same tools as MCP) + OpenAPI ----------
const localRunner = req => createToolRunner(async (method, p, body) => {
  const port = Number(process.env.PORT || getSetting('port', 4949));
  const r = await fetch(`http://127.0.0.1:${port}${p}`, { method, body: body ? JSON.stringify(body) : undefined, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(isRemote(req) ? { 'x-tubedesk-origin': 'remote' } : {}) } });
  const text = await r.text(); let j; try { j = JSON.parse(text); } catch { j = { raw: text }; }
  if (!r.ok) throw new Error(j?.error || `${method} ${p} → ${r.status}`);
  return j;
});
setup.get('/tools', (req, res) => res.json(TOOLS));
setup.post('/tools/:name', w(async (req, res) => {
  if (!TOOLS.some(t => t.name === req.params.name)) return res.status(404).json({ error: `unknown tool ${req.params.name}` });
  try { res.json(await localRunner(req)(req.params.name, req.body || {})); } catch (e) { res.status(400).json({ error: e.message }); }
}));
setup.get('/openapi.json', (req, res) => res.json(openapi({ base: `http://localhost:${Number(process.env.PORT || getSetting('port', 4949))}`, profile: req.query.for || 'all' })));

// ---------- remote access management (Mac only; the guard blocks remote callers) ----------
setup.get('/remote/status', w(async (req, res) => {
  const t = await remote.tunnelStatus();
  const base = t.publicUrl;
  const out = {
    tunnel: t, publicUrl: base, mcpUrl: base ? `${base}/mcp` : null, openapiUrl: base ? `${base}/openapi.json` : null, openapiGptUrl: base ? `${base}/openapi.json?for=gpt` : null,
    localMcp: `node ${path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'mcp', 'server.js')}`, publicPort: remote.remotePort(),
  };
  if (isRemote(req)) return res.json(out); // remote callers don't see who else is connected
  res.json({ ...out, ...remote.connections(), pending: remote.pendingRequests() });
}));
setup.get('/remote/pending', (req, res) => res.json(remote.pendingRequests()));
setup.post('/remote/enable', w(async (req, res) => res.json(await remote.enableFunnel())));
setup.post('/remote/disable', w(async (req, res) => res.json(await remote.disableFunnel())));
setup.post('/remote/keys', (req, res) => res.json(remote.createApiKey(req.body?.name)));
setup.delete('/remote/keys/:id', (req, res) => res.json({ revoked: remote.revokeApiKey(req.params.id) }));
setup.post('/remote/clients/:id/revoke', (req, res) => res.json({ revoked: remote.revokeClient(req.params.id) }));
setup.post('/remote/requests/:id/:decision', (req, res) => {
  if (!['approve', 'deny'].includes(req.params.decision)) return res.status(400).json({ error: 'approve or deny' });
  try { res.json(remote.decideLocally(req.params.id, req.params.decision === 'approve')); } catch (e) { res.status(e.status || 400).json({ error: e.message }); }
});
