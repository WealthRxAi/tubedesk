// Instagram and TikTok accounts — one per brand, any number. Each account can be linked to one of your YouTube
// channels (the brand), so Shorts, reels radar, the all-channels board and publishing pick the right account
// without being told. The single-account settings (ig_* / tt_*) keep working: they mirror the default account.
//
// Code that talks to Instagram/TikTok runs inside `withAccount(platform, account, fn)`; ig()/tt() and friends read the
// current account from that context (AsyncLocalStorage), falling back to the default account.
import { AsyncLocalStorage } from 'node:async_hooks';
import { db, getSetting, setSetting } from '../db.js';

db.exec(`
CREATE TABLE IF NOT EXISTS social_accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  platform TEXT NOT NULL,             -- instagram | tiktok
  account_id TEXT NOT NULL,           -- Instagram user id / TikTok open_id
  username TEXT,
  display_name TEXT,
  token TEXT,                         -- access token
  refresh_token TEXT,                 -- TikTok
  token_expires_at TEXT,              -- TikTok access token expiry (ISO)
  token_refreshed_at TEXT,            -- Instagram long-lived token refresh time (ISO)
  channel_id TEXT,                    -- linked owned YouTube channel (the brand)
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(platform, account_id)
);
`);

const als = new AsyncLocalStorage();
export const PLATFORMS = ['instagram', 'tiktok', 'threads', 'facebook', 'linkedin'];
const assertPlatform = p => { if (!PLATFORMS.includes(p)) throw Object.assign(new Error(`platform must be one of ${PLATFORMS.join(', ')}`), { status: 400 }); };

// ---------- legacy single-account settings ⇄ default account ----------
const LEGACY = {
  instagram: { id: 'ig_user_id', token: 'ig_access_token', username: 'ig_username', refreshedAt: 'ig_token_refreshed_at' },
  tiktok: { id: 'tt_open_id', token: 'tt_access_token', refresh: 'tt_refresh_token', username: 'tt_username', display: 'tt_display_name', expires: 'tt_access_expires_at' },
};
/**
 * Pick up an account configured the old way (settings). The settings always mirror the default account, so when they
 * point somewhere else the user (or Settings) changed them on purpose: that account is stored and becomes the default,
 * as it was with a single account. Removing an account re-mirrors the settings, so a removed account never comes back.
 */
function syncLegacy(platform) {
  const L = LEGACY[platform];
  if (!L) return; // newer platforms never had single-account settings
  const id = getSetting(L.id, ''), token = getSetting(L.token, '');
  if (!id || !token) return;
  const row = db.prepare('SELECT * FROM social_accounts WHERE platform = ? AND account_id = ?').get(platform, id);
  const uname = getSetting(L.username, '');
  if (row && !row.username && uname) db.prepare('UPDATE social_accounts SET username = ? WHERE id = ?').run(uname, row.id);
  if (row && row.is_default && row.token === token) return;
  if (!row) {
    db.prepare('INSERT INTO social_accounts (platform, account_id, username, display_name, token, refresh_token, token_expires_at, token_refreshed_at, is_default) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)')
      .run(platform, id, getSetting(L.username, '') || null, L.display ? getSetting(L.display, '') || null : null, token, L.refresh ? getSetting(L.refresh, '') || null : null, L.expires ? getSetting(L.expires, '') || null : null, L.refreshedAt ? getSetting(L.refreshedAt, '') || null : null);
  } else if (row.token !== token) {
    db.prepare('UPDATE social_accounts SET token = ?, refresh_token = COALESCE(?, refresh_token) WHERE id = ?').run(token, L.refresh ? getSetting(L.refresh, '') || null : null, row.id);
  }
  const r = db.prepare('SELECT id FROM social_accounts WHERE platform = ? AND account_id = ?').get(platform, id);
  db.prepare('UPDATE social_accounts SET is_default = CASE WHEN id = ? THEN 1 ELSE 0 END WHERE platform = ?').run(r.id, platform);
}
/** Keep the legacy settings equal to the default account (older code paths and the Settings page read them). */
function mirrorDefault(platform) {
  const L = LEGACY[platform];
  if (!L) return;
  const d = db.prepare('SELECT * FROM social_accounts WHERE platform = ? AND is_default = 1').get(platform);
  const set = (k, v) => { if (k) setSetting(k, v ?? ''); };
  set(L.id, d?.account_id); set(L.token, d?.token); set(L.username, d?.username);
  set(L.refresh, d?.refresh_token); set(L.display, d?.display_name); set(L.expires, d?.token_expires_at); set(L.refreshedAt, d?.token_refreshed_at);
}

// ---------- reading ----------
const pub = r => r && ({ id: r.id, platform: r.platform, accountId: r.account_id, username: r.username, displayName: r.display_name, channelId: r.channel_id, isDefault: !!r.is_default, tokenRefreshedAt: r.token_refreshed_at, tokenExpiresAt: r.token_expires_at, createdAt: r.created_at });
export function list(platform = null) {
  for (const p of PLATFORMS) syncLegacy(p);
  const rows = platform ? db.prepare('SELECT * FROM social_accounts WHERE platform = ? ORDER BY is_default DESC, id').all(platform) : db.prepare('SELECT * FROM social_accounts ORDER BY platform, is_default DESC, id').all();
  const titles = Object.fromEntries(db.prepare("SELECT id, title FROM channels WHERE kind = 'owned'").all().map(c => [c.id, c.title]));
  return rows.map(r => ({ ...pub(r), channelTitle: r.channel_id ? titles[r.channel_id] || null : null }));
}
export function rows(platform) { syncLegacy(platform); return db.prepare('SELECT * FROM social_accounts WHERE platform = ? ORDER BY is_default DESC, id').all(platform); }

/**
 * Find an account by @username, account id, row id, or the YouTube channel (id, title or @handle) it is linked to.
 * No selector → the account in the current context, else the default. Throws with the list when nothing matches.
 */
export function resolve(platform, sel = null) {
  assertPlatform(platform);
  syncLegacy(platform);
  if (sel === null || sel === undefined || sel === '') {
    const ctx = als.getStore();
    if (ctx?.platform === platform && ctx.row) return db.prepare('SELECT * FROM social_accounts WHERE id = ?').get(ctx.row.id) || ctx.row;
    return db.prepare('SELECT * FROM social_accounts WHERE platform = ? ORDER BY is_default DESC, id LIMIT 1').get(platform) || null;
  }
  const s = String(sel).trim().replace(/^@/, '').toLowerCase();
  const all = db.prepare('SELECT * FROM social_accounts WHERE platform = ?').all(platform);
  let hit = all.find(r => (r.username || '').toLowerCase() === s) || all.find(r => r.account_id.toLowerCase() === s) || all.find(r => String(r.id) === s);
  if (!hit) {
    const ch = db.prepare("SELECT id FROM channels WHERE kind = 'owned' AND (lower(id) = ? OR lower(title) = ? OR lower(replace(handle, '@', '')) = ?)").get(s, s, s);
    if (ch) hit = all.find(r => r.channel_id === ch.id) || null;
    if (ch && !hit) return null; // the brand exists but has no account on this platform
  }
  if (!hit) throw Object.assign(new Error(`No ${platform} account "${sel}". Connected: ${all.map(r => '@' + (r.username || r.account_id)).join(', ') || 'none'}`), { status: 400 });
  return hit;
}
/** The account for a brand (owned YouTube channel id): the linked one, else the default. */
export function forChannel(platform, channelId) {
  syncLegacy(platform);
  return (channelId && db.prepare('SELECT * FROM social_accounts WHERE platform = ? AND channel_id = ?').get(platform, channelId))
    || db.prepare('SELECT * FROM social_accounts WHERE platform = ? ORDER BY is_default DESC, id LIMIT 1').get(platform) || null;
}
/**
 * The account a brand posts to on a platform: the one linked to that YouTube channel. If you have never linked any
 * account (one brand), the default account; once accounts are linked, a brand without one gets none — so one brand's
 * Shorts never land on another brand's profile.
 */
export function forBrand(platform, channelId) {
  syncLegacy(platform);
  const linked = channelId ? db.prepare('SELECT * FROM social_accounts WHERE platform = ? AND channel_id = ?').get(platform, channelId) : null;
  if (linked) return linked;
  const anyLinked = db.prepare('SELECT 1 FROM social_accounts WHERE platform = ? AND channel_id IS NOT NULL').get(platform);
  return anyLinked ? null : db.prepare('SELECT * FROM social_accounts WHERE platform = ? ORDER BY is_default DESC, id LIMIT 1').get(platform) || null;
}
export const current = platform => resolve(platform);
/** Run fn as this account. A missing account is an error, never a silent switch to the default. */
export function withAccount(platform, row, fn) {
  if (!row) throw Object.assign(new Error(`No ${platform} account for that brand — connect one (connect_account) or link one (link_social_account).`), { status: 400 });
  return als.run({ platform, row }, fn);
}
export async function eachAccount(platform, fn) {
  const out = [];
  for (const r of rows(platform)) out.push(await withAccount(platform, r, () => fn(r)));
  return out;
}

// ---------- writing ----------
export function upsert(platform, { accountId, username = null, displayName = null, token = null, refreshToken = null, tokenExpiresAt = null, tokenRefreshedAt = null, channelId = undefined }) {
  assertPlatform(platform);
  if (!accountId) throw new Error('account id is required');
  const existing = db.prepare('SELECT * FROM social_accounts WHERE platform = ? AND account_id = ?').get(platform, String(accountId));
  if (existing) {
    db.prepare(`UPDATE social_accounts SET username = COALESCE(?, username), display_name = COALESCE(?, display_name), token = COALESCE(?, token), refresh_token = COALESCE(?, refresh_token),
      token_expires_at = COALESCE(?, token_expires_at), token_refreshed_at = COALESCE(?, token_refreshed_at), channel_id = CASE WHEN ? THEN ? ELSE channel_id END WHERE id = ?`)
      .run(username, displayName, token, refreshToken, tokenExpiresAt, tokenRefreshedAt, channelId !== undefined ? 1 : 0, channelId ?? null, existing.id);
  } else {
    const hasDefault = db.prepare('SELECT 1 FROM social_accounts WHERE platform = ? AND is_default = 1').get(platform);
    db.prepare('INSERT INTO social_accounts (platform, account_id, username, display_name, token, refresh_token, token_expires_at, token_refreshed_at, channel_id, is_default) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(platform, String(accountId), username, displayName, token, refreshToken, tokenExpiresAt, tokenRefreshedAt, channelId ?? null, hasDefault ? 0 : 1);
  }
  const row = db.prepare('SELECT * FROM social_accounts WHERE platform = ? AND account_id = ?').get(platform, String(accountId));
  if (row.is_default) mirrorDefault(platform);
  return row;
}
/** Update the tokens of the account a request is running under (refreshes), keeping the default mirrored. */
export function updateTokens(platform, row, fields) {
  const r = row || resolve(platform);
  if (!r) return null;
  return upsert(platform, { accountId: r.account_id, ...fields });
}
/**
 * Link an account to a brand (an owned YouTube channel), or unlink it (no channel). A brand has one account per
 * platform: linking replaces the brand's previous account. With onlyIfFree (remote AI apps), only an unlinked account
 * may be linked, and only to a brand that has no account yet.
 */
export function link(platform, sel, channelId, { onlyIfFree = false } = {}) {
  const r = resolve(platform, sel);
  if (!r) throw Object.assign(new Error(`No ${platform} account "${sel}"`), { status: 400 });
  if (channelId) {
    const ch = db.prepare("SELECT id FROM channels WHERE kind = 'owned' AND (id = ? OR lower(title) = lower(?) OR lower(replace(handle, '@', '')) = lower(?))").get(channelId, channelId, String(channelId).replace(/^@/, ''));
    if (!ch) throw Object.assign(new Error(`"${channelId}" is not one of your channels`), { status: 400 });
    channelId = ch.id;
  }
  if (r.channel_id === (channelId || null)) return pub(r);
  if (onlyIfFree) {
    const taken = channelId && db.prepare('SELECT 1 FROM social_accounts WHERE platform = ? AND channel_id = ? AND id <> ?').get(platform, channelId, r.id);
    if (r.channel_id || !channelId || taken) throw Object.assign(new Error('Changing which account a brand posts to can only be done on the Mac running TubeDesk (Settings → Social accounts).'), { status: 403 });
  }
  const tx = db.transaction(() => {
    if (channelId) db.prepare('UPDATE social_accounts SET channel_id = NULL WHERE platform = ? AND channel_id = ? AND id <> ?').run(platform, channelId, r.id);
    db.prepare('UPDATE social_accounts SET channel_id = ? WHERE id = ?').run(channelId || null, r.id);
  });
  tx();
  return pub(db.prepare('SELECT * FROM social_accounts WHERE id = ?').get(r.id));
}
export function setDefault(platform, sel) {
  const r = resolve(platform, sel);
  if (!r) throw new Error(`No ${platform} account "${sel}"`);
  db.prepare('UPDATE social_accounts SET is_default = CASE WHEN id = ? THEN 1 ELSE 0 END WHERE platform = ?').run(r.id, platform);
  mirrorDefault(platform);
  return pub(db.prepare('SELECT * FROM social_accounts WHERE id = ?').get(r.id));
}
export function remove(platform, sel) {
  const r = resolve(platform, sel);
  if (!r) return false;
  db.prepare('DELETE FROM social_accounts WHERE id = ?').run(r.id);
  if (r.is_default) {
    const next = db.prepare('SELECT id FROM social_accounts WHERE platform = ? ORDER BY id LIMIT 1').get(platform);
    if (next) db.prepare('UPDATE social_accounts SET is_default = 1 WHERE id = ?').run(next.id);
  }
  mirrorDefault(platform); // the old settings now name the default again, so the removed account is not re-imported
  return true;
}
