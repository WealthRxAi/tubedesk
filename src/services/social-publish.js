// Publishing to Threads, Facebook Pages and LinkedIn through each platform's own free developer API, one account
// per brand (same accounts model as Instagram/TikTok). X is left out on purpose: its API charges for posting.
import fs from 'node:fs';
import path from 'node:path';
import { getSetting } from '../db.js';
import { fetchRetry } from '../lib/http.js';
import * as accounts from './accounts.js';
import { createJob, runJob, getJob, resolveFile, publicLease } from './publish.js';

const THREADS = () => process.env.THREADS_BASE || 'https://graph.threads.net/v1.0';
const FB = () => process.env.FB_GRAPH_BASE || 'https://graph.facebook.com/v21.0';
const LI = () => process.env.LINKEDIN_BASE || 'https://api.linkedin.com';
const VIDEO = new Set(['.mp4', '.mov', '.m4v']), IMAGE = new Set(['.jpg', '.jpeg', '.png']);
const err = (m, status = 400) => Object.assign(new Error(m), { status });
const wait = ms => new Promise(r => setTimeout(r, process.env.THREADS_BASE || process.env.FB_GRAPH_BASE || process.env.LINKEDIN_BASE ? 20 : ms));
// LinkedIn wants a dated API version (supported ~1 year): use the month two months back.
const liVersion = () => getSetting('linkedin_api_version', '') || (() => { const d = new Date(); d.setUTCMonth(d.getUTCMonth() - 2); return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}`; })();

async function call(base, pathname, { method = 'GET', token, params = {}, json, headers = {}, raw } = {}) {
  const u = new URL(pathname.startsWith('http') ? pathname : base + pathname);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, String(v));
  const h = { ...headers };
  if (token) h.Authorization = `Bearer ${token}`;
  if (json !== undefined) h['content-type'] = 'application/json';
  const res = await fetchRetry(u, { method, headers: h, body: raw ?? (json !== undefined ? JSON.stringify(json) : undefined) }, { timeoutMs: 120_000 });
  const text = await res.text();
  let body; try { body = text ? JSON.parse(text) : {}; } catch { body = { text }; }
  if (!res.ok) throw err(body?.error?.message || body?.message || `${new URL(base).hostname} ${res.status}`, res.status >= 500 ? 502 : 400);
  return { body, headers: res.headers };
}

// ---------- accounts ----------
/** Add (or refresh) an account from a token; optionally link it to a brand (YouTube channel). */
export async function addAccount(platform, { token, channel = null, pageId = null } = {}) {
  token = String(token || '').trim();
  if (token.length < 20) throw err('Paste the full access token.');
  let row;
  if (platform === 'threads') {
    const me = (await call(THREADS(), '/me', { token, params: { fields: 'id,username,name' } })).body;
    row = accounts.upsert('threads', { accountId: me.id, username: me.username, displayName: me.name, token, tokenRefreshedAt: new Date().toISOString() });
  } else if (platform === 'facebook') {
    // a Page token (never expires when made from a long-lived user token); a user token + pageId is exchanged for it
    let pageToken = token, page;
    if (pageId) { page = (await call(FB(), `/${pageId}`, { token, params: { fields: 'id,name,access_token' } })).body; pageToken = page.access_token || token; }
    else page = (await call(FB(), '/me', { token, params: { fields: 'id,name' } })).body;
    row = accounts.upsert('facebook', { accountId: page.id, username: page.name, displayName: page.name, token: pageToken, tokenRefreshedAt: new Date().toISOString() });
  } else if (platform === 'linkedin') {
    const me = (await call(LI(), '/v2/userinfo', { token })).body;
    row = accounts.upsert('linkedin', { accountId: me.sub, username: me.name || me.email || me.sub, displayName: me.name, token, tokenRefreshedAt: new Date().toISOString(), tokenExpiresAt: new Date(Date.now() + 60 * 86400e3).toISOString() });
  } else throw err('platform must be threads, facebook or linkedin');
  if (channel) accounts.link(platform, row.account_id, channel);
  return accounts.list(platform).find(a => a.accountId === row.account_id) || row;
}

/** Threads tokens last 60 days: refresh any older than 7 days (called every morning). */
export async function refreshThreadsTokens() {
  const out = [];
  for (const r of accounts.rows('threads')) {
    const age = (Date.now() - Date.parse(r.token_refreshed_at || 0)) / 86400e3;
    if (age < 7) continue;
    try {
      const j = (await call(THREADS(), '/refresh_access_token', { params: { grant_type: 'th_refresh_token', access_token: r.token } })).body;
      accounts.upsert('threads', { accountId: r.account_id, token: j.access_token, tokenRefreshedAt: new Date().toISOString() });
      out.push({ account: r.username, refreshed: true });
    } catch (e) { out.push({ account: r.username, error: e.message }); }
  }
  return out;
}

// ---------- publishing ----------
function pick(platform, account) {
  const row = accounts.resolve(platform, account || null);
  if (!row?.token) throw err(account ? `No ${platform} account "${account}" — add one first.` : `No ${platform} account yet — add one (add_social_account).`);
  return row;
}
function media(file) {
  if (!file) return null;
  const f = resolveFile(file, new Set([...VIDEO, ...IMAGE]));
  return { file: f, video: VIDEO.has(path.extname(f).toLowerCase()) };
}

/** Threads: text (500 chars), optionally one image or video. */
export function publishThreads({ text = '', file = null, account = null } = {}) {
  const row = pick('threads', account), m = media(file);
  if (!text && !m) throw err('Give text and/or a file.');
  if (text.length > 500) throw err('Threads posts are 500 characters at most.');
  const id = createJob('threads', m?.file || '', text.slice(0, 80), { text, account: row.account_id });
  runJob(id, async log => {
    log(`account @${row.username}`);
    const lease = m ? await publicLease([m.file], log) : null;
    try {
      const params = { text: text || undefined, media_type: m ? (m.video ? 'VIDEO' : 'IMAGE') : 'TEXT', ...(m ? { [m.video ? 'video_url' : 'image_url']: lease.urls[0] } : {}) };
      const c = (await call(THREADS(), `/${row.account_id}/threads`, { method: 'POST', token: row.token, params })).body;
      for (let i = 0; i < 90; i++) { // Threads asks for ~30 s before publishing; videos until FINISHED
        await wait(m?.video ? 6000 : 2000);
        const st = (await call(THREADS(), `/${c.id}`, { token: row.token, params: { fields: 'status,error_message' } })).body;
        if (st.status === 'FINISHED' || (!m?.video && i >= 1 && !st.status)) break;
        if (st.status === 'ERROR' || st.status === 'EXPIRED') throw new Error(`Threads could not process it: ${st.error_message || st.status}`);
      }
      const pub = (await call(THREADS(), `/${row.account_id}/threads_publish`, { method: 'POST', token: row.token, params: { creation_id: c.id } })).body;
      let url = null; try { url = (await call(THREADS(), `/${pub.id}`, { token: row.token, params: { fields: 'permalink' } })).body.permalink || null; } catch { /* optional */ }
      log(`published ${pub.id}`);
      return { id: pub.id, url };
    } finally { lease?.release(); }
  });
  return getJob(id);
}

/** Facebook Page: a text/link post, a photo, or a video. */
export function publishFacebook({ text = '', link = null, file = null, title = null, account = null } = {}) {
  const row = pick('facebook', account), m = media(file);
  if (!text && !m && !link) throw err('Give text, a link and/or a file.');
  const id = createJob('facebook', m?.file || '', (title || text).slice(0, 80), { text, link, account: row.account_id });
  runJob(id, async log => {
    log(`page ${row.username}`);
    const lease = m ? await publicLease([m.file], log) : null;
    try {
      let r;
      if (!m) r = (await call(FB(), `/${row.account_id}/feed`, { method: 'POST', token: row.token, params: { message: text || undefined, link: link || undefined } })).body;
      else if (!m.video) r = (await call(FB(), `/${row.account_id}/photos`, { method: 'POST', token: row.token, params: { url: lease.urls[0], caption: text || undefined } })).body;
      else r = (await call(FB(), `/${row.account_id}/videos`, { method: 'POST', token: row.token, params: { file_url: lease.urls[0], description: text || undefined, title: title || undefined } })).body;
      const postId = r.post_id || r.id;
      log(`published ${postId}`);
      return { id: postId, url: `https://www.facebook.com/${postId}` };
    } finally { lease?.release(); }
  });
  return getJob(id);
}

/** LinkedIn (your profile): text, optionally one image or video (uploaded straight to LinkedIn — no public URL needed). */
export function publishLinkedIn({ text = '', file = null, title = null, account = null } = {}) {
  const row = pick('linkedin', account), m = media(file);
  if (!text && !m) throw err('Give text and/or a file.');
  if (text.length > 3000) throw err('LinkedIn posts are 3,000 characters at most.');
  const author = `urn:li:person:${row.account_id}`;
  const H = { 'LinkedIn-Version': liVersion(), 'X-Restli-Protocol-Version': '2.0.0' };
  const id = createJob('linkedin', m?.file || '', (title || text).slice(0, 80), { text, account: row.account_id });
  runJob(id, async log => {
    log(`profile ${row.username}`);
    let mediaId = null;
    if (m && !m.video) {
      const init = (await call(LI(), '/rest/images', { method: 'POST', token: row.token, headers: H, params: { action: 'initializeUpload' }, json: { initializeUploadRequest: { owner: author } } })).body.value;
      await call(LI(), init.uploadUrl, { method: 'PUT', token: row.token, raw: fs.readFileSync(m.file), headers: { 'content-type': 'application/octet-stream' } });
      mediaId = init.image;
    } else if (m) {
      const size = fs.statSync(m.file).size;
      const init = (await call(LI(), '/rest/videos', { method: 'POST', token: row.token, headers: H, params: { action: 'initializeUpload' }, json: { initializeUploadRequest: { owner: author, fileSizeBytes: size, uploadCaptions: false, uploadThumbnail: false } } })).body.value;
      const fd = fs.openSync(m.file, 'r'); const etags = [];
      try {
        for (const part of init.uploadInstructions) {
          const buf = Buffer.alloc(part.lastByte - part.firstByte + 1); fs.readSync(fd, buf, 0, buf.length, part.firstByte);
          const r = await call(LI(), part.uploadUrl, { method: 'PUT', raw: buf, headers: { 'content-type': 'application/octet-stream' } });
          etags.push(r.headers.get('etag'));
        }
      } finally { fs.closeSync(fd); }
      await call(LI(), '/rest/videos', { method: 'POST', token: row.token, headers: H, params: { action: 'finalizeUpload' }, json: { finalizeUploadRequest: { video: init.video, uploadToken: init.uploadToken || '', uploadedPartIds: etags } } });
      mediaId = init.video;
      log('video uploaded; LinkedIn is processing it');
    }
    const post = { author, commentary: text, visibility: 'PUBLIC', distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] }, lifecycleState: 'PUBLISHED', isReshareDisabledByAuthor: false, ...(mediaId ? { content: { media: { id: mediaId, title: title || undefined } } } : {}) };
    const r = await call(LI(), '/rest/posts', { method: 'POST', token: row.token, headers: H, json: post });
    const urn = r.headers.get('x-restli-id') || r.body.id;
    log(`published ${urn}`);
    return { id: urn, url: urn ? `https://www.linkedin.com/feed/update/${urn}/` : null };
  });
  return getJob(id);
}

export function publish(platform, params) {
  if (platform === 'threads') return publishThreads(params);
  if (platform === 'facebook') return publishFacebook(params);
  if (platform === 'linkedin') return publishLinkedIn(params);
  throw err('platform must be threads, facebook or linkedin');
}
