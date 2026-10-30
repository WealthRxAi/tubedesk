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
  return { id: v.id, snippet: { publishedAt: v.pub, channelId: v.channelId, channelTitle: CH[v.channelId].title, title: v.title, description: `About ${v.title}.\n\n0:00 Intro\n1:10 The rule\n4:00 Example\n\nhttps://example.org/source`, tags: ['medicaid', 'aging parents', 'caregiving'], categoryId: '27', defaultLanguage: 'en', liveBroadcastContent: 'none', thumbnails: { high: { url: `https://i.ytimg.com/vi/${v.id}/hqdefault.jpg` }, maxres: { url: `https://i.ytimg.com/vi/${v.id}/maxresdefault.jpg` } } }, statistics: { viewCount: String(v.views), likeCount: String(v.likes), commentCount: String(v.comments) }, contentDetails: { duration: v.duration }, status: { privacyStatus: 'public', selfDeclaredMadeForKids: false } };
}
function channelResource(c) {
  return { id: c.id, snippet: { title: c.title, customUrl: c.handle, description: `${c.title} — money and legal help for families caring for aging parents.`, country: c.country, publishedAt: '2025-06-01T00:00:00Z', thumbnails: { high: { url: `https://yt3.ggpht.com/${c.id}=s240` } } }, statistics: { subscriberCount: String(c.subs), viewCount: String(c.views), videoCount: String(c.videos) }, contentDetails: { relatedPlaylists: { uploads: 'UU' + c.id.slice(2) } }, brandingSettings: { channel: { country: c.country } } };
}
export const calls = [];

export function startMock(port = 0) {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const q = Object.fromEntries(u.searchParams);
    calls.push({ path: u.pathname, q, method: req.method, auth: req.headers.authorization || null });
    const json = (o, code = 200) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
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
      if (req.method === 'PUT') { let b = ''; req.on('data', d => b += d); return req.on('end', () => json(JSON.parse(b))); }
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
  return new Promise(resolve => server.listen(port, '127.0.0.1', () => resolve({ server, port: server.address().port })));
}

if (process.argv[1] && process.argv[1].endsWith('mock-youtube.js')) startMock(Number(process.env.MOCK_PORT || 4999)).then(({ port }) => console.log('mock youtube on', port));
