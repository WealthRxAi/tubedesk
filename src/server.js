import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getSetting, DATA_DIR } from './db.js';
import { api, oauthCallback } from './routes/api.js';
import { startScheduler } from './jobs/scheduler.js';
import { servePublic } from './services/publish.js';

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
  if (proxied && !req.path.startsWith('/public/media/')) return res.status(403).send('Not available through the public URL.');
  if (!local && getSetting('allow_lan', '0') !== '1') return res.status(403).send('TubeDesk only accepts local connections (set allow_lan=1 in Settings to expose on your LAN).');
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
app.use(express.static(path.join(__dirname, '..', 'public'), { extensions: ['html'] }));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

const PORT = Number(process.env.PORT || getSetting('port', 4949));
app.listen(PORT, '0.0.0.0', () => {
  console.log(`TubeDesk running at http://localhost:${PORT}`);
  if (process.env.TUBEDESK_NO_SCHEDULER !== '1') startScheduler();
});
