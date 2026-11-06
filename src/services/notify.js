// Phone notifications for alerts that need action: iMessage from the Mac TubeDesk runs on (free, no account),
// ntfy push (free app, no account), or any webhook (Slack, Discord, n8n…). Quiet hours hold messages and send
// them when the quiet window ends. Every message is logged in notify_log.
import { spawn } from 'node:child_process';
import { db, getSetting } from '../db.js';

db.exec(`
CREATE TABLE IF NOT EXISTS notify_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT,
  title TEXT NOT NULL,
  body TEXT,
  url TEXT,
  status TEXT NOT NULL DEFAULT 'queued',   -- queued | sent | failed | held
  channels TEXT,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  sent_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_notify_status ON notify_log(status, id);
`);

// Alert kinds that reach the phone by default. Everything else stays in the in-app Alerts list.
export const DEFAULT_KINDS = ['radar_breakout', 'radar_competitor_breakout', 'radar_lagging', 'autopilot', 'autopilot_revert', 'ideas_daily', 'breakout'];

export function config() {
  return {
    imessageTo: getSetting('notify_imessage_to', ''),
    ntfyTopic: getSetting('notify_ntfy_topic', ''),
    ntfyServer: getSetting('notify_ntfy_server', 'https://ntfy.sh'),
    webhookUrl: getSetting('notify_webhook_url', ''),
    kinds: String(getSetting('notify_kinds', DEFAULT_KINDS.join(','))).split(',').map(s => s.trim()).filter(Boolean),
    quiet: getSetting('notify_quiet', '22-7'), // local hours start-end; empty = never quiet
    imessageAvailable: process.platform === 'darwin',
  };
}
export function channelsConfigured(c = config()) {
  const out = [];
  if (c.imessageTo && c.imessageAvailable) out.push('imessage');
  if (c.ntfyTopic) out.push('ntfy');
  if (c.webhookUrl) out.push('webhook');
  return out;
}

export function inQuietHours(date = new Date(), spec = config().quiet) {
  const m = /^(\d{1,2})-(\d{1,2})$/.exec(String(spec || '').trim());
  if (!m) return false;
  const a = Number(m[1]) % 24, b = Number(m[2]) % 24, h = date.getHours();
  if (a === b) return false;
  return a < b ? h >= a && h < b : h >= a || h < b;
}

// AppleScript receives the text and recipient as argv, so message content is never interpreted as script.
const APPLESCRIPT_NEW = `on run argv
  set msg to item 1 of argv
  set target to item 2 of argv
  tell application "Messages"
    set svc to 1st account whose service type = iMessage
    send msg to participant target of svc
  end tell
end run`;
const APPLESCRIPT_OLD = `on run argv
  set msg to item 1 of argv
  set target to item 2 of argv
  tell application "Messages"
    set svc to 1st service whose service type = iMessage
    send msg to buddy target of svc
  end tell
end run`;
function osascript(script, args) {
  return new Promise((resolve, reject) => {
    const bin = process.env.TUBEDESK_OSASCRIPT || '/usr/bin/osascript';
    const p = spawn(bin, ['-', ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
    let err = '';
    p.stderr.on('data', d => { err += d; });
    p.on('error', reject);
    p.on('close', code => code === 0 ? resolve() : reject(new Error(err.trim() || `osascript exited ${code}`)));
    p.stdin.end(script);
  });
}
async function sendImessage(to, text) {
  try { await osascript(APPLESCRIPT_NEW, [text, to]); }
  catch (e) {
    try { await osascript(APPLESCRIPT_OLD, [text, to]); }
    catch { throw new Error(`iMessage failed: ${e.message}. Open Messages on this Mac, sign in with your Apple ID, and allow TubeDesk/Terminal to control Messages (System Settings → Privacy & Security → Automation).`); }
  }
}
async function sendNtfy(c, { title, body, url, priority }) {
  const res = await fetch(`${c.ntfyServer.replace(/\/$/, '')}/${encodeURIComponent(c.ntfyTopic)}`, {
    method: 'POST', body: body || title, signal: AbortSignal.timeout(15_000),
    headers: { Title: title.replace(/[^\x20-\x7E]/g, '').slice(0, 250), Priority: String(priority || 3), Tags: 'tv', ...(url ? { Click: url } : {}) },
  });
  if (!res.ok) throw new Error(`ntfy ${res.status}`);
}
async function sendWebhook(c, msg) {
  const text = `${msg.title}${msg.body ? '\n' + msg.body : ''}${msg.url ? '\n' + msg.url : ''}`;
  const res = await fetch(c.webhookUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(15_000),
    body: JSON.stringify({ text, content: text.slice(0, 1900), title: msg.title, message: msg.body, url: msg.url, kind: msg.kind, source: 'tubedesk' }) });
  if (!res.ok) throw new Error(`webhook ${res.status}`);
}

async function deliver(row, c = config()) {
  const chans = channelsConfigured(c);
  if (!chans.length) { db.prepare("UPDATE notify_log SET status = 'failed', error = ? WHERE id = ?").run('No phone channel configured', row.id); return { sent: [], errors: ['No phone channel configured'] }; }
  const msg = { title: row.title, body: row.body, url: row.url, kind: row.kind, priority: /breakout|autopilot/.test(row.kind || '') ? 4 : 3 };
  const sent = [], errors = [];
  for (const ch of chans) {
    try {
      if (ch === 'imessage') await sendImessage(c.imessageTo, [msg.title, msg.body, msg.url].filter(Boolean).join('\n'));
      if (ch === 'ntfy') await sendNtfy(c, msg);
      if (ch === 'webhook') await sendWebhook(c, msg);
      sent.push(ch);
    } catch (e) { errors.push(`${ch}: ${e.message}`); }
  }
  db.prepare("UPDATE notify_log SET status = ?, channels = ?, error = ?, sent_at = CASE WHEN ? > 0 THEN datetime('now') ELSE sent_at END WHERE id = ?")
    .run(sent.length ? 'sent' : 'failed', sent.join(','), errors.join(' | ') || null, sent.length, row.id);
  return { sent, errors };
}

/** Queue a phone notification; sends now unless quiet hours (then it is held and flushed later). */
export async function notify({ kind = 'info', title, body = '', url = null, force = false }) {
  const c = config();
  if (!force && !c.kinds.includes(kind)) return { skipped: 'kind not enabled for phone' };
  if (!channelsConfigured(c).length) return { skipped: 'no phone channel configured' };
  const r = db.prepare('INSERT INTO notify_log (kind, title, body, url, status) VALUES (?, ?, ?, ?, ?)').run(kind, String(title).slice(0, 300), String(body || '').slice(0, 1500), url, 'queued');
  const row = db.prepare('SELECT * FROM notify_log WHERE id = ?').get(r.lastInsertRowid);
  if (!force && inQuietHours(new Date(), c.quiet)) { db.prepare("UPDATE notify_log SET status = 'held' WHERE id = ?").run(row.id); return { held: true, id: row.id }; }
  return { id: row.id, ...(await deliver(row, c)) };
}

/** Send messages held during quiet hours (called hourly). Several held messages go out as one digest. */
export async function flushHeld() {
  const c = config();
  if (inQuietHours(new Date(), c.quiet)) return { flushed: 0 };
  const held = db.prepare("SELECT * FROM notify_log WHERE status = 'held' ORDER BY id").all();
  if (!held.length) return { flushed: 0 };
  if (held.length === 1) { await deliver(held[0], c); return { flushed: 1 }; }
  const digest = { id: 0, kind: 'digest', title: `TubeDesk: ${held.length} alerts overnight`, body: held.map(h => '• ' + h.title).join('\n').slice(0, 1500), url: null };
  const r = db.prepare("INSERT INTO notify_log (kind, title, body, status) VALUES ('digest', ?, ?, 'queued')").run(digest.title, digest.body);
  const res = await deliver({ ...digest, id: r.lastInsertRowid }, c);
  db.prepare(`UPDATE notify_log SET status = ?, sent_at = datetime('now') WHERE id IN (${held.map(() => '?').join(',')})`).run(res.sent.length ? 'sent' : 'failed', ...held.map(h => h.id));
  return { flushed: held.length, ...res };
}

/** Called for every in-app alert: forwards the kinds the user wants on the phone. */
export function onAlert(alert) {
  const c = config();
  if (!c.kinds.includes(alert.kind) || !channelsConfigured(c).length) return;
  let payload = {};
  try { payload = JSON.parse(alert.payload_json || '{}'); } catch { /* ignore */ }
  const url = payload.url || (payload.videoId ? `https://youtu.be/${payload.videoId}` : null);
  notify({ kind: alert.kind, title: alert.title, url }).catch(e => console.error('[notify]', e.message));
}

export async function test() {
  const c = config();
  const chans = channelsConfigured(c);
  if (!chans.length) throw Object.assign(new Error(c.imessageTo && !c.imessageAvailable ? 'iMessage only works when TubeDesk runs on a Mac. Add an ntfy topic or webhook instead.' : 'Add an iMessage number/Apple ID, an ntfy topic or a webhook URL first.'), { status: 400 });
  return notify({ kind: 'test', title: 'TubeDesk test: phone alerts are working', body: 'Breakouts, lagging uploads, autopilot changes and your daily idea list will arrive here.', force: true });
}

export function log(limit = 50) { return db.prepare('SELECT * FROM notify_log ORDER BY id DESC LIMIT ?').all(limit); }
