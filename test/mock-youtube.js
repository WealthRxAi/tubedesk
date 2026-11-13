// Mock of the YouTube Data API v3 + Analytics API + suggest endpoint, with deterministic fixtures.
import http from 'node:http';

const CH = {
  UCowner00000000000000001: { id: 'UCowner00000000000000001', title: 'The Parent Plan', handle: '@TheParentPlan', subs: 1240, views: 184000, videos: 24, country: 'US' },
  UCcomp000000000000000002: { id: 'UCcomp000000000000000002', title: 'Caregiver Money', handle: '@CaregiverMoney', subs: 48000, views: 6200000, videos: 140, country: 'US' },
  UCcomp000000000000000003: { id: 'UCcomp000000000000000003', title: 'Elder Law Explained', handle: '@ElderLawExplained', subs: 9100, views: 900000, videos: 60, country: 'CA' },
};
const titles = ['Medicaid Pays This, Not This', '7 Mistakes Families Make With Assisted Living', 'How to Protect a Parent\'s House From Medicaid', 'What Happens When Savings Run Out', 'Power of Attorney Explained in 6 Minutes', 'Is a Trust Worth It for Aging Parents?', 'VA Aid and Attendance: Who Qualifies', 'The Nursing Home Bill Nobody Warns You About', 'I Read 40 Medicaid Denials — Here Is the Pattern', 'Assisted Living vs Memory Care Costs', 'Stop Paying for These Senior Services', 'Why Estate Recovery Shocks Families', 'Long-Term Care Insurance: Honest Review', 'Caregiver Burnout Costs More Than You Think', 'How to Talk to Parents About Money #shorts', 'The 5-Year Lookback Rule #shorts'];
function vid(chId, i) {
  const id = (chId.slice(2, 6) + String(i).padStart(7, '0')).padEnd(11, 'x').slice(0, 11);
  const short = i % 7 === 6;
  const base = CH[chId].subs * (0.4 + ((i * 37) % 10) / 10);
  const views = Math.round(i % 5 === 0 ? base * 6 : base);
  const pub = new Date(Date.now() - (i + 1) * 9 * 86400000).toISOString();
  return { id, channelId: chId, title: titles[i % titles.length] + (i >= titles.length ? ` (part ${Math.floor(i / titles.length) + 1})` : ''), short, views, likes: Math.round(views * 0.04), comments: Math.round(views * 0.004), pub, duration: short ? 'PT48S' : `PT${8 + (i % 6)}M${12 + i}S` };
}
function videoResource(v) {
  return { id: v.id, snippet: { publishedAt: v.pub, channelId: v.channelId, channelTitle: CH[v.channelId].title, title: TITLE_OVERRIDES[v.id] || v.title, description: `About ${v.title}.\n\n0:00 Intro\n1:10 The rule\n4:00 Example\n\nhttps://example.org/source`, tags: ['medicaid', 'aging parents', 'caregiving'], categoryId: '27', defaultLanguage: 'en', liveBroadcastContent: 'none', thumbnails: { high: { url: `${THUMB_BASE}/vi/${v.id}/hqdefault.jpg` }, maxres: { url: `${THUMB_BASE}/vi/${v.id}/maxresdefault.jpg` } } }, statistics: { viewCount: String(v.views), likeCount: String(v.likes), commentCount: String(v.comments) }, contentDetails: { duration: v.duration }, status: { privacyStatus: 'public', selfDeclaredMadeForKids: false } };
}
function channelResource(c) {
  return { id: c.id, snippet: { title: c.title, customUrl: c.handle, description: `${c.title} — money and legal help for families caring for aging parents.`, country: c.country, publishedAt: '2025-06-01T00:00:00Z', thumbnails: { high: { url: `https://yt3.ggpht.com/${c.id}=s240` } } }, statistics: { subscriberCount: String(c.subs), viewCount: String(c.views), videoCount: String(c.videos) }, contentDetails: { relatedPlaylists: { uploads: 'UU' + c.id.slice(2) } }, brandingSettings: { channel: { country: c.country } } };
}
export const calls = [];
// Videos uploaded through the mock (resumable upload) and their current status, so tests can check unscheduling.
export const UPLOADED = { n: 0 };
// Reporting API state: tests can change how many daily reports exist and the CTR each video gets.
// Title changes made through videos.update persist, like on YouTube (tests can also set them to simulate the owner).
export const TITLE_OVERRIDES = {};
const ptDay = ms => new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
// Instagram reels: older ones form the baseline; tests add a fresh one to trigger a breakout.
export const IG = { media: [{ id: 'IGR0000', caption: 'Reel 0: the form that saves $40K', ageH: 20, views: 1900 },
  ...Array.from({ length: 12 }, (_, i) => ({ id: 'IGR' + String(i + 1).padStart(4, '0'), caption: `Reel ${i + 1}: caregiving money tip`, ageH: 24 * (8 + i * 5), views: 2000 + ((i * 733) % 1500) }))] };
export const EL = { mp3: Buffer.from([0xff, 0xfb, 0x90, 0x00, 0, 0, 0, 0]) }; // tests swap in a real MP3 when ffmpeg is present
export const REPORTING = { jobs: [], days: 40, ctr: (i) => (i % 5 === 0 ? 8.5 : i === 1 ? 1.6 : 4.2) };
// Video thumbnails are served by the mock itself so tests never touch the network.
let THUMB_BASE = 'https://i.ytimg.com';
// 1×1 white JPEG
const JPEG = Buffer.from('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/yQALCAABAAEBAREA/8wABgAQEAX/2gAIAQEAAD8A0s8g/9k=', 'base64');

export function startMock(port = 0) {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const q = Object.fromEntries(u.searchParams);
    calls.push({ path: u.pathname, q, method: req.method, auth: req.headers.authorization || null });
    const json = (o, code = 200) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    // --- ElevenLabs (voiceover) ---
    if (u.pathname.startsWith('/el/')) {
      const p = u.pathname.slice(4);
      if (req.headers['xi-api-key'] !== 'ELKEY') return json({ detail: { status: 'invalid_api_key', message: 'Invalid API key' } }, 401);
      if (p === 'v1/voices') return json({ voices: [{ voice_id: 'V1', name: 'Rachel', category: 'premade', preview_url: 'https://x/p.mp3' }, { voice_id: 'V2', name: 'Sal', category: 'cloned' }] });
      if (p === 'v1/user/subscription') return json({ tier: 'starter', character_count: 1200, character_limit: 30000, next_character_count_reset_unix: 1800000000 });
      if (/^v1\/text-to-speech\/[^/]+\/with-timestamps$/.test(p)) {
        let b = ''; req.on('data', d => b += d);
        return req.on('end', () => {
          const body = JSON.parse(b); calls.at(-1).elBody = body; calls.at(-1).voice = p.split('/')[2];
          const text = body.text; const chars = [...text]; const st = [], en = [];
          chars.forEach((c, i) => { st.push(+(i * 0.06).toFixed(3)); en.push(+((i + 1) * 0.06).toFixed(3)); });
          return json({ audio_base64: EL.mp3.toString('base64'), alignment: { characters: chars, character_start_times_seconds: st, character_end_times_seconds: en } });
        });
      }
      return json({ detail: 'unknown ' + p }, 404);
    }
    // --- HeyGen (voiceover with the user's cloned voice) ---
    if (u.pathname.startsWith('/hg/')) {
      const p = u.pathname.slice(4);
      if (req.headers['x-api-key'] !== 'HGKEY') return json({ error: { message: 'Unauthorized' } }, 401);
      if (p === 'v2/voices') return json({ data: { voices: [{ voice_id: 'stock1', name: 'Abigail', language: 'English', gender: 'female' }, { voice_id: 'clone9', name: 'Salman clone', language: 'English', gender: 'male', is_clone: true, preview_audio: 'https://x/c.mp3' }] } });
      if (p === 'v2/user/remaining_quota') return json({ data: { remaining_quota: 5400, details: { api: 5400 } } });
      if (p === 'v3/models/audio/tts') {
        let b = ''; req.on('data', d => b += d);
        return req.on('end', () => {
          const body = JSON.parse(b); calls.at(-1).hgBody = body;
          if (body.voice_id !== 'clone9') return json({ error: { message: 'voice not found' } }, 400);
          const words = body.text.split(/\s+/).filter(Boolean).map((w, i) => ({ text: w, start_time: i * 0.4, end_time: i * 0.4 + 0.35 }));
          return json({ data: { audio_url: `${THUMB_BASE}/hg-audio.mp3`, duration: words.length * 0.4, original_words: body.with_timestamps ? words : undefined } });
        });
      }
      return json({ error: { message: 'unknown ' + p } }, 404);
    }
    if (u.pathname === '/hg-audio.mp3') { res.writeHead(200, { 'content-type': 'audio/mpeg' }); return res.end(EL.mp3); }
    // --- Higgsfield (thumbnail backgrounds) ---
    if (u.pathname.startsWith('/hf/')) {
      const p = u.pathname.slice(4);
      if (req.headers['hf-api-key'] !== 'HFKEY' || req.headers['hf-secret'] !== 'HFSECRET') return json({ detail: 'unauthorized' }, 401);
      if (p.startsWith('v1/text2image/')) { let b = ''; req.on('data', d => b += d); return req.on('end', () => { calls.at(-1).hfBody = JSON.parse(b); json({ id: 'req1', status: 'queued' }); }); }
      if (p === 'v1/requests/req1') { const n = calls.filter(c => c.path === '/hf/v1/requests/req1').length; return n < 2 ? json({ id: 'req1', status: 'in_progress' }) : json({ id: 'req1', status: 'completed', images: [{ url: `${THUMB_BASE}/hf-image.jpg` }] }); }
      return json({ detail: 'unknown ' + p }, 404);
    }
    if (u.pathname === '/hf-image.jpg') { res.writeHead(200, { 'content-type': 'image/png' }); return res.end(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')); }
    if (u.pathname.startsWith('/vi/')) { res.writeHead(200, { 'content-type': 'image/jpeg' }); return res.end(JPEG); }
    // --- YouTube Reporting API (reach reports: impressions + CTR) ---
    if (u.pathname.startsWith('/reporting/')) {
      if (!req.headers.authorization) return json({ error: { message: 'Login Required' } }, 401);
      if (u.pathname === '/reporting/v1/jobs' && req.method === 'POST') { let b = ''; req.on('data', d => b += d); return req.on('end', () => { const j = JSON.parse(b); REPORTING.jobs.push({ id: 'job-reach-1', reportTypeId: j.reportTypeId, name: j.name, createTime: new Date().toISOString() }); json(REPORTING.jobs.at(-1)); }); }
      if (u.pathname === '/reporting/v1/jobs') return json({ jobs: REPORTING.jobs });
      if (/^\/reporting\/v1\/jobs\/[^/]+\/reports$/.test(u.pathname)) {
        const reports = [];
        for (let d = 1; d <= REPORTING.days; d++) {
          const day = ptDay(Date.now() - d * 86400000);
          reports.push({ id: 'rep-' + day, jobId: 'job-reach-1', startTime: day + 'T07:00:00Z', endTime: day + 'T07:00:00Z', createTime: new Date().toISOString(), downloadUrl: `${THUMB_BASE}/reporting/download/${day}` });
        }
        // two pages, to exercise pagination
        if (!q.pageToken) return json({ reports: reports.slice(0, 5), nextPageToken: reports.length > 5 ? 'p2' : undefined });
        return json({ reports: reports.slice(5) });
      }
      if (u.pathname.startsWith('/reporting/download/')) {
        const day = u.pathname.split('/').pop();
        const lines = ['date,channel_id,video_id,live_or_on_demand,subscribed_status,country_code,video_thumbnail_impressions,video_thumbnail_impressions_ctr'];
        for (let i = 0; i < 24; i++) {
          const v = vid('UCowner00000000000000001', i);
          if (ptDay(Date.parse(v.pub)) > day) continue;
          const ctr = REPORTING.ctr(i, v);
          lines.push(`${day.replace(/-/g, '')},UCowner00000000000000001,${v.id},on_demand,subscribed,US,${600 + i * 10},${ctr}`);
          lines.push(`${day.replace(/-/g, '')},UCowner00000000000000001,${v.id},on_demand,unsubscribed,US,${400 + i * 10},${ctr}`);
        }
        res.writeHead(200, { 'content-type': 'text/csv' }); return res.end(lines.join('\n'));
      }
    }
    // --- publishing mocks: YouTube resumable upload + thumbnails, Instagram Graph API ---
    if (u.pathname.endsWith('/upload/videos') || u.pathname.endsWith('/upload/videos/session')) {
      if (u.pathname.endsWith('/session')) { let n = 0; req.on('data', d => n += d.length); return req.on('end', () => { calls.at(-1).bytes = n; const id = 'NEWVID' + String(++UPLOADED.n).padStart(5, '0'); UPLOADED[id] = { privacyStatus: UPLOADED.lastInit?.status?.privacyStatus || 'private', publishAt: UPLOADED.lastInit?.status?.publishAt, selfDeclaredMadeForKids: false, uploadStatus: 'uploaded', embeddable: true, license: 'youtube', publicStatsViewable: true }; json({ id, status: UPLOADED[id] }); }); }
      let b = ''; req.on('data', d => b += d);
      return req.on('end', () => { calls.at(-1).body = JSON.parse(b || '{}'); UPLOADED.lastInit = calls.at(-1).body; calls.at(-1).xlen = req.headers['x-upload-content-length']; res.writeHead(200, { location: `http://127.0.0.1:${server.address().port}/upload/videos/session`, 'content-type': 'application/json' }); res.end('{}'); });
    }
    if (u.pathname.endsWith('/upload/thumbnails/set')) { req.on('data', () => {}); return req.on('end', () => json({ items: [{ default: { url: 'x' } }] })); }
    if (u.pathname.includes('/ig/')) {
      const p = u.pathname.split('/ig/')[1];
      if (p === 'me') return json({ id: '17841400000000001', username: 'salstack.ai', account_type: 'BUSINESS', media_count: 12 });
      if (p === '17841400000000001' && /business_discovery/.test(q.fields || '')) {
        const u = (q.fields.match(/username\(([^)]+)\)/) || [])[1];
        if (u === 'nobody') return json({ error: { message: '(#110) Could not find the user', code: 110 } }, 400);
        const media = Array.from({ length: 10 }, (_, i) => ({ id: `bd_${u}_${i}`, caption: `post ${i} #ai`, media_type: i % 3 === 0 ? 'IMAGE' : 'VIDEO', media_product_type: i % 3 === 0 ? 'FEED' : 'REELS', timestamp: new Date(Date.now() - i * 2 * 86400e3).toISOString().replace(/\.\d{3}Z$/, '+0000'), permalink: `https://www.instagram.com/p/${u}${i}/`, thumbnail_url: 'https://example.test/t.jpg', like_count: i === 2 ? 9000 : 300 + i, comments_count: i === 2 ? 400 : 10 }));
        return json({ business_discovery: { id: 'bd1', username: u, name: 'Creator ' + u, biography: 'bio', website: 'https://x.test', profile_picture_url: 'https://example.test/p.jpg', followers_count: 120000, follows_count: 50, media_count: 321, media: { data: media } } });
      }
      if (p === 'ig_hashtag_search') return json({ data: [{ id: 'HT_' + q.q }] });
      if (/^HT_.*\/(top|recent)_media$/.test(p)) return json({ data: Array.from({ length: 5 }, (_, i) => ({ id: `ht${i}`, caption: `#${q.q || 'tag'} post ${i}`, media_type: 'VIDEO', media_product_type: 'REELS', permalink: `https://www.instagram.com/p/ht${i}/`, timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, '+0000'), like_count: 1000 * (i + 1), comments_count: 50 })) });
      if (p === 'refresh_access_token') return json({ access_token: 'IG_REFRESHED', token_type: 'bearer', expires_in: 5184000 });
      if (p.endsWith('/media') && req.method === 'GET') return json({ data: IG.media.map(m => ({ id: m.id, caption: m.caption, media_type: 'VIDEO', media_product_type: 'REELS', timestamp: new Date(Date.now() - m.ageH * 3600000).toISOString().replace(/\.\d+Z$/, '+0000'), permalink: `https://www.instagram.com/reel/${m.id}/`, thumbnail_url: `${THUMB_BASE}/vi/${m.id}/ig.jpg`, like_count: Math.round(m.views * 0.05), comments_count: Math.round(m.views * 0.004) })).slice(0, Number(q.limit || 25)) });
      if (/\/insights$/.test(p)) { const m = IG.media.find(x => x.id === p.split('/')[0]); if (!m) return json({ error: { message: 'no media' } }, 400); return json({ data: [['views', m.views], ['reach', Math.round(m.views * 0.7)], ['saved', Math.round(m.views * 0.01)], ['shares', Math.round(m.views * 0.008)], ['total_interactions', Math.round(m.views * 0.07)]].map(([name, v]) => ({ name, period: 'lifetime', values: [{ value: v }] })) }); }
      if (p.endsWith('/media')) { calls.at(-1).igMedia = q; return json({ id: 'CONTAINER1' }); }
      if (p === 'CONTAINER1') { calls.at(-1).poll = (calls.at(-1).poll || 0); const n = calls.filter(c => c.path.endsWith('/ig/CONTAINER1')).length; return json({ status_code: n >= 2 ? 'FINISHED' : 'IN_PROGRESS', status: 'ok' }); }
      if (p.endsWith('/media_publish')) return json({ id: 'IGMEDIA1' });
      if (p === 'IGMEDIA1') return json({ permalink: 'https://www.instagram.com/reel/ABC123/' });
      return json({ error: { message: 'unknown ig path ' + p } }, 400);
    }
    if (u.pathname.includes('/tt/')) {
      const p = u.pathname.split('/tt/')[1];
      let b = ''; req.on('data', d => b += d);
      return req.on('end', () => {
        const body = (() => { try { return JSON.parse(b || '{}'); } catch { return Object.fromEntries(new URLSearchParams(b)); } })();
        calls.at(-1).ttBody = body;
        if (p === 'oauth/token/') return json({ access_token: 'TT_ACCESS_' + (body.grant_type || ''), refresh_token: 'TT_REFRESH', open_id: 'open123', expires_in: 86400, scope: 'user.info.basic,video.list,video.publish' });
        if (!/^Bearer TT_ACCESS_/.test(req.headers.authorization || '')) return json({ error: { code: 'access_token_invalid', message: 'bad token' } }, 401);
        if (p === 'user/info/') return json({ data: { user: { open_id: 'open123', username: 'salstack', display_name: 'SalStack', follower_count: 1500, following_count: 10, likes_count: 9000, video_count: 3 } }, error: { code: 'ok' } });
        if (p === 'video/list/') return json({ data: { videos: [1, 2, 3].map(i => ({ id: 'v' + i, title: 'tt ' + i, create_time: Math.floor(Date.now() / 1000) - i * 86400 * 3, duration: 30, cover_image_url: 'https://example.test/c.jpg', share_url: 'https://www.tiktok.com/@salstack/video/v' + i, view_count: i === 2 ? 50000 : 1000, like_count: 100, comment_count: 5, share_count: 7 })), cursor: 0, has_more: false }, error: { code: 'ok' } });
        if (p === 'post/publish/creator_info/query/') return json({ data: { creator_username: 'salstack', privacy_level_options: ['PUBLIC_TO_EVERYONE', 'SELF_ONLY'], max_video_post_duration_sec: 600 }, error: { code: 'ok' } });
        if (p === 'post/publish/video/init/') { calls.at(-1).ttInit = body; return json({ data: { publish_id: 'pub1', upload_url: `http://127.0.0.1:${server.address().port}/tt-upload` }, error: { code: 'ok' } }); }
        if (p === 'post/publish/status/fetch/') return json({ data: { status: 'PUBLISH_COMPLETE', publicaly_available_post_id: ['7000000000000000001'] }, error: { code: 'ok' } });
        return json({ error: { code: 'not_found', message: 'unknown ' + p } }, 404);
      });
    }
    if (u.pathname === '/tt-upload') { let n = 0; req.on('data', d => n += d.length); return req.on('end', () => { calls.at(-1).ttBytes = n; calls.at(-1).range = req.headers['content-range']; res.writeHead(201); res.end(); }); }
    if (u.pathname.endsWith('/complete/search')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify([q.q, [q.q + ' explained', q.q + ' for beginners', 'how does ' + q.q + ' work', q.q + ' 2026', q.q + ' vs trust'].map(s => [s])])); }
    if (u.pathname.endsWith('/reports')) {
      const dims = (q.dimensions || '').split(',').filter(Boolean);
      const metrics = q.metrics.split(',');
      const rows = [];
      const start = new Date(q.startDate), end = new Date(q.endDate);
      const mk = (vals) => metrics.map((m, i) => vals[m] ?? (100 + i * 10));
      if (!dims.length) rows.push(mk({ views: 52000, estimatedMinutesWatched: 210000, averageViewDuration: 242, averageViewPercentage: 41.2, subscribersGained: 410, subscribersLost: 35, likes: 2100, comments: 240, shares: 90 }));
      else if (dims[0] === 'day') for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) rows.push([d.toISOString().slice(0, 10), ...mk({ views: 1500 + (d.getUTCDate() * 37) % 900, estimatedMinutesWatched: 6000, subscribersGained: 14, subscribersLost: 1, estimatedRevenue: 4.2, estimatedAdRevenue: 4, cpm: 12, playbackBasedCpm: 8, monetizedPlaybacks: 900 })]);
      else if (dims[0] === 'video') for (let i = 0; i < 10; i++) { const v = vid('UCowner00000000000000001', i); rows.push([v.id, ...mk({ views: v.views, estimatedMinutesWatched: v.views * 4, averageViewDuration: 240, averageViewPercentage: 40, likes: v.likes, comments: v.comments, subscribersGained: 20 - i, subscribersLost: 2 })]); }
      else if (dims[0] === 'elapsedVideoTimeRatio') for (let i = 0; i <= 100; i += 2) rows.push([i / 100, ...mk({ audienceWatchRatio: Math.max(0.05, 1 - i / 130 - (i === 10 ? 0.08 : 0)), relativeRetentionPerformance: 0.5 })]);
      else if (dims[0] === 'insightTrafficSourceType') [['YT_SEARCH', 20000], ['RELATED_VIDEO', 15000], ['SUBSCRIBER', 6000], ['EXT_URL', 2000], ['NO_LINK_OTHER', 9000]].forEach(([t, v]) => rows.push([t, ...mk({ views: v, estimatedMinutesWatched: v * 4 })]));
      else if (dims[0] === 'insightTrafficSourceDetail') ['medicaid for parents', 'assisted living cost', 'power of attorney'].forEach((t, i) => rows.push([t, ...mk({ views: 5000 - i * 1200 })]));
      else if (dims[0] === 'country') [['US', 30000], ['CA', 5000], ['GB', 4000], ['AU', 2000]].forEach(([c, v]) => rows.push([c, ...mk({ views: v, estimatedMinutesWatched: v * 4, averageViewDuration: 240 })]));
      else if (dims[0] === 'ageGroup') for (const a of ['age25-34', 'age35-44', 'age45-54', 'age55-64']) for (const g of ['female', 'male']) rows.push([a, g, ...mk({ viewerPercentage: g === 'female' ? 14 : 10 })]);
      else if (dims[0] === 'deviceType') [['MOBILE', 30000], ['DESKTOP', 15000], ['TV', 7000]].forEach(([d, v]) => rows.push([d, ...mk({ views: v })]));
      else if (dims[0] === 'creatorContentType') [['videoOnDemand', 40000], ['shorts', 12000]].forEach(([d, v]) => rows.push([d, ...mk({ views: v, estimatedMinutesWatched: v * 3 })]));
      return json({ columnHeaders: [...dims, ...metrics].map(n => ({ name: n })), rows });
    }
    if (u.pathname.endsWith('/channels')) {
      let items = [];
      if (q.mine) items = [channelResource(CH.UCowner00000000000000001)];
      else if (q.id) items = q.id.split(',').map(i => CH[i]).filter(Boolean).map(channelResource);
      else if (q.forHandle) items = Object.values(CH).filter(c => c.handle.toLowerCase() === q.forHandle.toLowerCase()).map(channelResource);
      return json({ items, pageInfo: { totalResults: items.length } });
    }
    if (u.pathname.endsWith('/playlistItems')) {
      const chId = 'UC' + q.playlistId.slice(2); const n = Math.min(CH[chId]?.videos || 0, 60);
      const page = Number(q.pageToken || 0); const items = [];
      for (let i = page * 50; i < Math.min(n, page * 50 + 50); i++) items.push({ contentDetails: { videoId: vid(chId, i).id } });
      return json({ items, nextPageToken: (page + 1) * 50 < n ? String(page + 1) : undefined });
    }
    if (u.pathname.endsWith('/videos')) {
      if (req.method === 'PUT') { let b = ''; req.on('data', d => b += d); return req.on('end', () => { const j = JSON.parse(b); calls.at(-1).body = j; if (j.snippet?.title) TITLE_OVERRIDES[j.id] = j.snippet.title; if (j.status && UPLOADED[j.id]) UPLOADED[j.id] = { ...j.status, uploadStatus: 'processed' }; json(j); }); }
      if (q.id && UPLOADED[q.id]) return json({ items: [{ id: q.id, status: UPLOADED[q.id] }] });
      if (q.chart) { const items = []; for (let i = 0; i < 20; i++) items.push(videoResource(vid('UCcomp000000000000000002', i))); return json({ items }); }
      const ids = q.id.split(','); const items = [];
      for (const id of ids) { for (const chId of Object.keys(CH)) for (let i = 0; i < 60; i++) { const v = vid(chId, i); if (v.id === id) items.push(videoResource(v)); } }
      return json({ items });
    }
    if (u.pathname.endsWith('/search')) {
      const items = [];
      if (q.type === 'channel') for (const c of Object.values(CH)) items.push({ id: { channelId: c.id }, snippet: { channelId: c.id, title: c.title } });
      else for (const chId of Object.keys(CH)) for (let i = 0; i < 8; i++) { const v = vid(chId, i); items.push({ id: { videoId: v.id }, snippet: { channelId: chId, title: v.title } }); }
      return json({ items, pageInfo: { totalResults: 48213 } });
    }
    if (u.pathname.endsWith('/videoCategories')) return json({ items: [{ id: '27', snippet: { title: 'Education', assignable: true } }, { id: '22', snippet: { title: 'People & Blogs', assignable: true } }] });
    if (u.pathname.endsWith('/commentThreads')) {
      const items = [];
      const texts = ['Does Medicaid pay for assisted living in Florida?', 'Thank you, this saved my family so much stress', 'What about if my mom owns a house with my brother?', 'Great video', 'How long is the lookback period in Texas?', '@TheParentPlan can you cover VA benefits?', 'This is exactly what the social worker never told us'];
      for (let i = 0; i < 40; i++) items.push({ id: 'Ugz' + String(i).padStart(10, '0'), snippet: { videoId: q.videoId || vid('UCowner00000000000000001', i % 5).id, totalReplyCount: i % 3 === 0 ? 1 : 0, topLevelComment: { snippet: { authorDisplayName: 'Viewer ' + i, authorChannelId: { value: 'UCviewer' + i }, authorProfileImageUrl: '', textOriginal: texts[i % texts.length], likeCount: (i * 7) % 23, publishedAt: new Date(Date.now() - i * 3600000).toISOString() } } }, replies: i % 3 === 0 ? { comments: [{ id: 'r' + i, snippet: { authorDisplayName: 'The Parent Plan', authorChannelId: { value: 'UCowner00000000000000001' }, textOriginal: 'Thanks!', likeCount: 1, publishedAt: new Date().toISOString() } }] } : undefined });
      return json({ items });
    }
    if (u.pathname.endsWith('/comments')) { let b = ''; req.on('data', d => b += d); return req.on('end', () => json({ id: 'newreply', snippet: JSON.parse(b).snippet })); }
    if (u.pathname.endsWith('/captions')) return json({ items: [{ id: 'cap1', snippet: { language: 'en', trackKind: 'standard' } }] });
    if (u.pathname.includes('/captions/')) { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('1\n00:00:00,000 --> 00:00:04,000\nMedicaid pays for care, not room and board.\n\n2\n00:00:04,000 --> 00:00:09,000\nHere is what that means for your parent.\n\n3\n00:00:09,000 --> 00:00:30,000\nThe rule everyone misses is the five year lookback.\n'); }
    if (u.pathname.endsWith('/playlists')) { if (req.method === 'POST') { let b = ''; req.on('data', d => b += d); return req.on('end', () => json({ id: 'PLnew', ...JSON.parse(b) })); } return json({ items: [{ id: 'PL1', snippet: { title: 'Medicaid basics', description: '', thumbnails: {} }, contentDetails: { itemCount: 4 }, status: { privacyStatus: 'public' } }] }); }
    if (u.pathname.endsWith('/token')) return json({ access_token: 'tok', expires_in: 3600 });
    json({ error: { message: 'mock: unknown ' + u.pathname, errors: [{ reason: 'notFound' }] } }, 404);
  });
  return new Promise(resolve => server.listen(port, '127.0.0.1', () => { THUMB_BASE = `http://127.0.0.1:${server.address().port}`; resolve({ server, port: server.address().port }); }));
}

if (process.argv[1] && process.argv[1].endsWith('mock-youtube.js')) startMock(Number(process.env.MOCK_PORT || 4999)).then(({ port }) => console.log('mock youtube on', port));
