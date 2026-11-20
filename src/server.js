import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, getSetting, DATA_DIR } from './db.js';
import { api, oauthCallback } from './routes/api.js';
import { startScheduler } from './jobs/scheduler.js';
import { servePublic, recoverJobs, adoptLegacyInstagram } from './services/publish.js';
import { recoverAfterRestart } from './services/clips.js';
import { createPublicApp } from './public-server.js';
import { remotePort, autoEnable, isOwnerDevice } from './services/remote.js';
import { connectAll, autoConnectEnabled } from './services/ai-clients.js';
import { markHealthy } from './services/updater.js';

// A forgotten .catch() somewhere must not take the whole desk down (Node exits on unhandled rejections by default).
process.on('unhandledRejection', e => console.error('[unhandled]', e?.stack || e));
// A real crash leaves state unknown: log it and exit so launchd starts a clean process.
process.on('uncaughtException', e => { console.error('[crash]', e?.stack || e); try { db.close(); } catch { /* */ } process.exit(1); });
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { try { db.pragma('wal_checkpoint(TRUNCATE)'); db.close(); } catch { /* */ } process.exit(0); });

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '25mb' }));
app.use(express.text({ type: 'text/csv', limit: '25mb' }));

// Public media leases: the only route reachable through a tunnel/reverse proxy. Unguessable 36-hex tokens that expire with the publish job.
app.get('/public/media/:token', (req, res) => {
  const file = servePublic(String(req.params.token).replace(/\.[a-z0-9]+$/i, ''));
  if (!file) return res.status(404).send('expired');
  res.sendFile(file);
});

// Local-only by default: refuse non-loopback clients unless explicitly allowed. Requests that arrive through a
// Cloudflare tunnel or reverse proxy (X-Forwarded-For / CF-Connecting-IP set) may only fetch /public/media.
app.use((req, res, next) => {
  const ip = req.socket.remoteAddress || '';
  const local = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
  const proxied = !!(req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for']);
  // The owner's own phone/laptop through `tailscale serve` (tailnet only, Tailscale-verified login): the full app.
  const ownerDevice = local && proxied && !req.headers['cf-connecting-ip'] && isOwnerDevice(req);
  if (proxied && !ownerDevice && !req.path.startsWith('/public/media/')) return res.status(403).send('Not available through the public URL.');
  const lan = getSetting('allow_lan', '0') === '1';
  if (!local && !lan) return res.status(403).send('TubeDesk only accepts local connections (set allow_lan=1 in Settings to expose on your LAN).');
  // DNS rebinding: a web page can point its own hostname at 127.0.0.1. Only answer requests addressed to this machine.
  const host = String(req.headers.host || '').toLowerCase();
  const phoneHost = String(getSetting('phone_host', '') || '').toLowerCase();
  if (!lan && !/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host) && !(ownerDevice && phoneHost && (host === phoneHost || host === phoneHost.replace(/:8443$/, '')))) return res.status(421).send('Unexpected Host header.');
  // CSRF: browsers send Origin on cross-site requests. State-changing requests must come from TubeDesk's own pages,
  // the browser extension or youtube.com (extension content scripts); local tools (curl, MCP, scripts) send no Origin.
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    const origin = req.headers.origin;
    const site = req.headers['sec-fetch-site'];
    let sameOrigin = false;
    try { sameOrigin = !!origin && (new URL(origin).host.toLowerCase() === host || (ownerDevice && new URL(origin).host.toLowerCase() === phoneHost)); } catch { /* malformed */ }
    const trustedOrigin = !origin || sameOrigin || /^(chrome|moz)-extension:\/\//.test(origin) || /^https:\/\/(www\.)?youtube\.com$/.test(origin);
    if (!trustedOrigin || (site === 'cross-site' && !sameOrigin && !/^(chrome|moz)-extension:|^https:\/\/(www\.)?youtube\.com$/.test(origin || ''))) return res.status(403).json({ error: 'Cross-site request refused.' });
  }
  // Calls relayed for remote AI apps may only use the API (which applies its own remote rules).
  if (req.headers['x-tubedesk-origin'] === 'remote' && !req.path.startsWith('/api/')) return res.status(403).json({ error: 'Remote apps can only use the TubeDesk API.' });
  next();
});

// CORS for the browser extension (chrome-extension:// origins) and youtube.com content scripts.
app.use((req, res, next) => {
  const origin = req.headers.origin || '';
  if (/^(chrome|moz)-extension:\/\//.test(origin) || /^https:\/\/(www\.)?youtube\.com$/.test(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
  }
  next();
});

app.use('/api', api);
app.use(oauthCallback());
app.use('/data/thumbs', express.static(path.join(DATA_DIR, 'thumbs')));
app.use('/data/clips', express.static(path.join(DATA_DIR, 'clips')));
app.use('/data/voiceovers', express.static(path.join(DATA_DIR, 'voiceovers')));
app.use('/data/renders', express.static(path.join(DATA_DIR, 'renders')));
app.use('/data/made', express.static(path.join(DATA_DIR, 'made')));
app.use(express.static(path.join(__dirname, '..', 'public'), { extensions: ['html'] }));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

const PORT = Number(process.env.PORT || getSetting('port', 4949));
const server = app.listen(PORT, getSetting('allow_lan', '0') === '1' ? '0.0.0.0' : '127.0.0.1', () => {
  console.log(`TubeDesk running at http://localhost:${PORT}`);
  // After an automatic update: staying up 3 minutes means the new version is good (the boot guard stands down).
  setTimeout(() => { if (markHealthy()) console.log('[update] new version is healthy'); }, Number(process.env.TUBEDESK_HEALTHY_AFTER_MS || 180_000)).unref();
  // Uploads a previous run left half-done are settled or marked failed — never re-sent automatically.
  try { recoverJobs(); recoverAfterRestart(); } catch (e) { console.error('restart recovery:', e.message); }
  if (process.env.TUBEDESK_NO_SCHEDULER !== '1') startScheduler();
  adoptLegacyInstagram().catch(e => console.error('instagram:', e.message));
  // Zero-config: connect TubeDesk to every AI app on this Mac, and turn remote access on once Tailscale is signed in.
  if (process.env.TUBEDESK_NO_AUTOCONNECT !== '1') {
    if (autoConnectEnabled()) connectAll().then(r => console.log('AI apps:', r.filter(x => x.installed).map(x => `${x.name} ${x.status}`).join(', ') || 'none found')).catch(e => console.error('AI apps:', e.message));
    const tick = () => autoEnable().catch(e => console.error('remote access:', e.message));
    tick(); setInterval(tick, 10 * 60e3).unref();
  }
});
// Loopback on IPv6 too, so "localhost" connects at once whichever address the browser tries first.
if (getSetting('allow_lan', '0') !== '1') app.listen(PORT, '::1').on('error', () => { /* no IPv6 loopback: fine */ });
// Port taken (an old copy still running): say so plainly and exit non-zero so launchd retries shortly.
server.on('error', e => { console.error(e.code === 'EADDRINUSE' ? `Port ${PORT} is already in use — another TubeDesk is running. Retrying via launchd.` : e.message); process.exit(1); });

// The public listener for remote AI apps (Tailscale Funnel forwards here). Loopback only: nothing on the network can
// reach it except through the tunnel, and it serves only MCP/OAuth/tool routes, all behind tokens.
if (process.env.TUBEDESK_NO_PUBLIC !== '1') {
  const pport = remotePort();
  createPublicApp().listen(pport, '127.0.0.1', () => console.log(`TubeDesk AI endpoint on http://127.0.0.1:${pport} (public through Tailscale Funnel when enabled)`))
    .on('error', e => console.error(`AI endpoint not started on port ${pport}: ${e.message}`));
}
