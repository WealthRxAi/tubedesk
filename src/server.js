import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getSetting, DATA_DIR } from './db.js';
import { api, oauthCallback } from './routes/api.js';
import { startScheduler } from './jobs/scheduler.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '25mb' }));
app.use(express.text({ type: 'text/csv', limit: '25mb' }));

// Local-only by default: refuse non-loopback clients unless explicitly allowed.
app.use((req, res, next) => {
  const ip = req.socket.remoteAddress || '';
  const local = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
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
