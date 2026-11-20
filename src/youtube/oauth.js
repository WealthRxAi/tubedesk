// Google OAuth for owned channels. Tokens are stored per channel in SQLite (local machine only).
import crypto from 'node:crypto';
import { db, getSetting } from '../db.js';
import { fetchRetry } from '../lib/http.js';

export const SCOPES = [
  'https://www.googleapis.com/auth/youtube.readonly',
  'https://www.googleapis.com/auth/yt-analytics.readonly',
  'https://www.googleapis.com/auth/yt-analytics-monetary.readonly',
  'https://www.googleapis.com/auth/youtube.force-ssl', // metadata updates, comments, captions
  'https://www.googleapis.com/auth/userinfo.email',
];

const pendingStates = new Map(); // state -> createdAt

export function redirectUri() {
  const base = getSetting('public_base_url') || `http://localhost:${process.env.PORT || getSetting('port', 4949)}`;
  return `${base.replace(/\/$/, '')}/oauth/callback`;
}

export function authUrl() {
  const clientId = getSetting('google_client_id');
  if (!clientId) throw new Error('Google OAuth client ID not configured (Settings).');
  const state = crypto.randomBytes(16).toString('hex');
  pendingStates.set(state, Date.now());
  const u = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  u.searchParams.set('client_id', clientId);
  u.searchParams.set('redirect_uri', redirectUri());
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('scope', SCOPES.join(' '));
  u.searchParams.set('access_type', 'offline');
  u.searchParams.set('prompt', 'consent');
  u.searchParams.set('include_granted_scopes', 'true');
  u.searchParams.set('state', state);
  return u.toString();
}

export function consumeState(state) {
  const t = pendingStates.get(state);
  pendingStates.delete(state);
  return !!t && Date.now() - t < 15 * 60 * 1000;
}

async function tokenRequest(form) {
  const clientId = getSetting('google_client_id');
  const clientSecret = getSetting('google_client_secret');
  if (!clientId || !clientSecret) throw new Error('Google OAuth client ID/secret not configured (Settings).');
  const body = new URLSearchParams({ client_id: clientId, client_secret: clientSecret, ...form });
  const res = await fetchRetry(process.env.GOOGLE_TOKEN_URL || 'https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body }, { idempotent: form.grant_type === 'refresh_token' });
  const json = await res.json();
  if (!res.ok) throw new Error(`Token exchange failed: ${json.error_description || json.error || res.status}`);
  return json;
}

export async function exchangeCode(code) {
  const tok = await tokenRequest({ code, grant_type: 'authorization_code', redirect_uri: redirectUri() });
  return {
    access_token: tok.access_token,
    refresh_token: tok.refresh_token,
    expires_at: Date.now() + (tok.expires_in || 3600) * 1000 - 60_000,
    scope: tok.scope,
    connected_at: new Date().toISOString(),
  };
}

export async function fetchEmail(accessToken) {
  try {
    const res = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', { headers: { Authorization: `Bearer ${accessToken}` } });
    const j = await res.json();
    return j.email || null;
  } catch { return null; }
}

export function getTokens(channelId) {
  const row = db.prepare('SELECT oauth_json FROM channels WHERE id = ?').get(channelId);
  return row?.oauth_json ? JSON.parse(row.oauth_json) : null;
}
export function saveTokens(channelId, tokens) {
  db.prepare('UPDATE channels SET oauth_json = ? WHERE id = ?').run(JSON.stringify(tokens), channelId);
  if (tokens?.connected_at) db.prepare('DELETE FROM settings WHERE key = ?').run(`oauth_broken_${channelId}`); // a fresh sign-in fixes it
}
export function clearTokens(channelId) {
  db.prepare("UPDATE channels SET oauth_json = NULL, oauth_email = NULL WHERE id = ?").run(channelId);
}

export async function getAccessToken(channelId) {
  const tok = getTokens(channelId);
  if (!tok) throw new Error(`Channel ${channelId} is not authorized. Connect it with Google in Channels.`);
  if (tok.access_token && tok.expires_at > Date.now()) return tok.access_token;
  if (!tok.refresh_token) throw new Error('No refresh token stored; reconnect the channel.');
  let fresh;
  try { fresh = await tokenRequest({ refresh_token: tok.refresh_token, grant_type: 'refresh_token' }); }
  catch (e) {
    // invalid_grant = Google revoked or expired the sign-in (password change, access removed, or an OAuth app still
    // in "Testing", whose sign-ins expire after 7 days). Recorded so the health check can say exactly what to do.
    if (/invalid_grant|expired or revoked/i.test(e.message)) {
      const age = tok.connected_at ? (Date.now() - Date.parse(tok.connected_at)) / 86400000 : null;
      db.prepare("INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .run(`oauth_broken_${channelId}`, JSON.stringify({ at: new Date().toISOString(), error: e.message, ageDays: age && Math.round(age * 10) / 10 }));
      throw new Error(`Google sign-in for this channel has expired or was revoked — reconnect it (Channels → Connect with Google).${age !== null && age >= 6 && age <= 8 ? ' It lasted about 7 days, which means the Google Cloud OAuth app is still in "Testing": publish it (Google Auth Platform → Audience → Publish app) so sign-ins stop expiring.' : ''}`);
    }
    throw e;
  }
  const next = { ...tok, access_token: fresh.access_token, expires_at: Date.now() + (fresh.expires_in || 3600) * 1000 - 60_000 };
  saveTokens(channelId, next);
  db.prepare('DELETE FROM settings WHERE key = ?').run(`oauth_broken_${channelId}`);
  return next.access_token;
}

export function isAuthorized(channelId) {
  const t = getTokens(channelId);
  return !!(t && t.refresh_token);
}
