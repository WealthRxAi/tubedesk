import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { db, getSetting, setSetting, allSettings, DATA_DIR } from '../db.js';
import { quotaToday, quotaHistory, cacheClear, YouTubeError } from '../youtube/client.js';
import { authUrl, consumeState, exchangeCode, fetchEmail, saveTokens, clearTokens } from '../youtube/oauth.js';
import { ytGet } from '../youtube/client.js';
import * as ch from '../services/channels.js';
import * as an from '../services/analytics.js';
import * as disc from '../services/discovery.js';
import * as pack from '../services/packaging.js';
import * as com from '../services/comments.js';
import * as coach from '../services/coach.js';
import * as comp from '../services/competitors.js';
import * as misc from '../services/misc.js';
import * as ai from '../services/ai.js';
import * as scores from '../services/scores.js';
import * as stats from '../services/stats.js';
import * as estimate from '../services/estimate.js';
import { runDailySnapshot } from '../jobs/scheduler.js';

export const api = Router();
const w = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const SECRET_KEYS = ['yt_api_key', 'google_client_secret', 'anthropic_api_key'];

// ---------- status & settings ----------
api.get('/status', w(async (req, res) => {
  const s = allSettings();
  res.json({
    configured: { apiKey: !!s.yt_api_key, oauth: !!(s.google_client_id && s.google_client_secret) },
    ai: await ai.status(), quota: quotaToday(), channels: ch.listChannels().length,
    lastSnapshot: s.last_snapshot ? JSON.parse(s.last_snapshot) : null, version: '1.1.0', dataDir: DATA_DIR,
  });
}));
api.get('/settings', (req, res) => {
  const s = allSettings();
  for (const k of SECRET_KEYS) if (s[k]) s[k] = '••••' + s[k].slice(-4);
  res.json(s);
});
api.put('/settings', (req, res) => {
  for (const [k, v] of Object.entries(req.body || {})) {
    if (SECRET_KEYS.includes(k) && String(v).startsWith('••••')) continue;
    setSetting(k, v);
  }
  res.json({ ok: true });
});
api.post('/settings/test-key', w(async (req, res) => {
  const r = await ytGet('videoCategories.list', { part: 'snippet', regionCode: 'US' }, { ttl: 0, noCache: true });
  res.json({ ok: true, categories: r.items?.length || 0 });
}));
api.get('/quota', (req, res) => res.json({ today: quotaToday(), history: quotaHistory(14), ai: ai.usage(30) }));
api.post('/cache/clear', (req, res) => res.json({ cleared: cacheClear(req.body?.prefix || '') }));
// Exit cleanly; the macOS LaunchAgent (KeepAlive) or any process manager relaunches with the current code. Local-only like every route.
api.post('/system/restart', (req, res) => { res.json({ restarting: true }); setTimeout(() => process.exit(0), 300); });
api.post('/snapshot/run', w(async (req, res) => res.json(await runDailySnapshot({ log: () => {} }))));

// ---------- OAuth ----------
api.get('/oauth/url', (req, res) => res.json({ url: authUrl() }));

// ---------- channels ----------
api.get('/channels', (req, res) => res.json(ch.listChannels(req.query.kind || null)));
api.post('/channels', w(async (req, res) => {
  const c = await ch.addChannel(req.body.input, req.body.kind || 'owned');
  await ch.syncVideos(c.id, { maxVideos: Number(req.body.maxVideos || 200) });
  res.json(ch.getChannel(c.id));
}));
api.get('/channels/:id', (req, res) => { const c = ch.getChannel(req.params.id); c ? res.json(c) : res.status(404).json({ error: 'not found' }); });
api.delete('/channels/:id', (req, res) => res.json({ removed: ch.removeChannel(req.params.id) }));
api.post('/channels/:id/kind', (req, res) => res.json(ch.setKind(req.params.id, req.body.kind)));
api.post('/channels/:id/disconnect', (req, res) => { clearTokens(req.params.id); res.json(ch.getChannel(req.params.id)); });
api.post('/channels/:id/sync', w(async (req, res) => {
  await ch.refreshChannel(req.params.id, { force: true });
  res.json(await ch.syncVideos(req.params.id, { maxVideos: Number(req.body?.maxVideos || 500), force: !!req.body?.force }));
}));
api.get('/channels/:id/videos', (req, res) => res.json(ch.listVideos(req.params.id, { ...req.query, limit: Number(req.query.limit || 200), offset: Number(req.query.offset || 0) })));
api.get('/channels/:id/history', (req, res) => res.json(ch.channelHistory(req.params.id, Number(req.query.days || 90))));
api.get('/channels/:id/report-card', (req, res) => res.json(comp.reportCard(req.params.id)));
api.get('/channels/:id/forecast', (req, res) => res.json(comp.forecast(req.params.id, { days: Number(req.query.days || 90) })));
api.get('/channels/:id/health', (req, res) => res.json(pack.channelHealth(req.params.id)));
api.get('/channels/:id/segments', (req, res) => res.json(an.performanceSegments(req.params.id)));
api.get('/channels/:id/publish-slots', (req, res) => res.json(an.publishSlots(req.params.id)));
api.get('/channels/:id/backup', (req, res) => {
  res.setHeader('Content-Disposition', `attachment; filename="tubedesk-backup-${req.params.id}.json"`);
  res.json(misc.channelBackup(req.params.id));
});
api.get('/channels/:id/export/videos.csv', (req, res) => {
  const { videos } = ch.listVideos(req.params.id, { limit: 5000 });
  res.setHeader('Content-Type', 'text/csv'); res.setHeader('Content-Disposition', `attachment; filename="videos-${req.params.id}.csv"`);
  res.send(misc.toCsv(videos.map(v => ({ id: v.id, title: v.title, published_at: v.published_at, format: v.is_short ? 'short' : 'long', duration_sec: v.duration_sec, views: v.view_count, likes: v.like_count, comments: v.comment_count, tags: v.tags.join('|'), url: 'https://youtu.be/' + v.id }))));
});
api.get('/channels/:id/playlists', w(async (req, res) => res.json(await misc.listPlaylists(req.params.id, { owned: req.query.owned === '1' }))));
api.post('/channels/:id/playlists', w(async (req, res) => res.json(await misc.createPlaylist(req.params.id, req.body))));
api.post('/channels/:id/playlists/:pid/items', w(async (req, res) => res.json(await misc.addToPlaylist(req.params.id, req.params.pid, req.body.videoId))));
api.get('/playlists/:pid/items', w(async (req, res) => res.json(await misc.playlistItems(req.params.pid, req.query.channelId || null))));

// ---------- videos ----------
api.get('/videos/:id', w(async (req, res) => {
  let v = ch.getVideo(req.params.id);
  if (!v) { const [f] = await ch.fetchVideosByIds([req.params.id]); if (!f) return res.status(404).json({ error: 'not found' }); v = f; }
  res.json({ ...v, history: ch.videoHistory(req.params.id, 365), metadataHistory: ch.metadataHistory(req.params.id), format: disc.formatLabel(v.title) });
}));
api.get('/videos/:id/checklist', (req, res) => res.json(pack.optimizationChecklist(req.params.id)));
api.get('/videos/:id/age-comparison', (req, res) => { const v = ch.getVideo(req.params.id); res.json(v ? an.uploadAgeComparison(v.channel_id, req.params.id) : null); });
api.get('/videos/:id/similar', w(async (req, res) => res.json(await disc.similarVideos(req.params.id, { country: req.query.country || getSetting('default_country', 'US') }))));
api.get('/videos/lookup/:id', w(async (req, res) => { const [v] = await ch.fetchVideosByIds([req.params.id]); res.json(v || null); }));

// ---------- owner analytics ----------
api.get('/analytics/:id/overview', w(async (req, res) => res.json(await an.overview(req.params.id, Number(req.query.days || 28)))));
api.get('/analytics/:id/revenue', w(async (req, res) => res.json(await an.revenue(req.params.id, Number(req.query.days || 28)))));
api.get('/analytics/:id/top', w(async (req, res) => res.json(await an.topVideos(req.params.id, Number(req.query.days || 28)))));
api.get('/analytics/:id/retention/:vid', w(async (req, res) => res.json(await an.retention(req.params.id, req.params.vid))));
api.get('/analytics/:id/traffic', w(async (req, res) => res.json(await an.trafficSources(req.params.id, Number(req.query.days || 28)))));
api.get('/analytics/:id/geo', w(async (req, res) => res.json(await an.geography(req.params.id, Number(req.query.days || 28)))));
api.get('/analytics/:id/demographics', w(async (req, res) => res.json(await an.demographics(req.params.id, Number(req.query.days || 28)))));
api.get('/analytics/:id/devices', w(async (req, res) => res.json(await an.devices(req.params.id, Number(req.query.days || 28)))));
api.get('/analytics/:id/subscribers', w(async (req, res) => res.json(await an.subscribers(req.params.id, Number(req.query.days || 90)))));
api.get('/analytics/:id/watch-hours', w(async (req, res) => res.json(await an.watchHours(req.params.id))));
api.get('/analytics/:id/content-types', w(async (req, res) => res.json(await an.contentTypeBreakdown(req.params.id, Number(req.query.days || 28)))));
api.post('/analytics/:id/studio-import', w(async (req, res) => res.json(misc.importStudioCsv(req.params.id, req.body.csv, req.body.period || ''))));
api.get('/analytics/:id/studio', (req, res) => res.json(misc.studioData(req.params.id)));

// ---------- discovery ----------
api.get('/keywords/explore', w(async (req, res) => res.json(await disc.keywordExplore(req.query.q, { country: req.query.country || getSetting('default_country', 'US'), deep: req.query.deep !== '0' }))));
api.get('/keywords/competition', w(async (req, res) => res.json(await disc.keywordCompetition(req.query.q, { country: req.query.country || getSetting('default_country', 'US') }))));
api.get('/keywords/rising', w(async (req, res) => res.json(await disc.risingSuggestions(req.query.q, { country: req.query.country || getSetting('default_country', 'US') }))));
api.get('/keywords/history', (req, res) => res.json(disc.keywordHistory(req.query.q, req.query.country || getSetting('default_country', 'US'))));
api.get('/outliers/local', (req, res) => {
  const ids = String(req.query.channels || '').split(',').filter(Boolean);
  res.json(disc.localOutliers(ids, { format: req.query.format || 'long', minX: Number(req.query.minX || 2), days: Number(req.query.days || 365) }));
});
api.get('/outliers/search', w(async (req, res) => res.json(await disc.searchOutliers(req.query.q, { country: req.query.country || getSetting('default_country', 'US'), publishedWithinDays: Number(req.query.days || 90), maxSubscribers: req.query.maxSubs ? Number(req.query.maxSubs) : null, format: req.query.format || 'all', order: req.query.order || 'viewCount' }))));
api.get('/trending', w(async (req, res) => res.json(await disc.trending({ country: req.query.country || getSetting('default_country', 'US'), categoryId: req.query.category || '' }))));
api.get('/categories', w(async (req, res) => res.json(await disc.categories(req.query.country || getSetting('default_country', 'US')))));
api.get('/niche/channels', w(async (req, res) => res.json(await disc.nicheChannels(req.query.q, { country: req.query.country || getSetting('default_country', 'US') }))));
api.post('/titles/patterns', (req, res) => res.json(disc.titlePatterns(req.body.titles || [])));

// ---------- competitors & alerts ----------
api.get('/competitors/:owned', (req, res) => res.json(comp.listCompetitors(req.params.owned)));
api.post('/competitors/:owned', w(async (req, res) => res.json(await comp.addCompetitor(req.params.owned, req.body.input, req.body.note || ''))));
api.delete('/competitors/:owned/:cid', (req, res) => res.json({ removed: comp.removeCompetitor(req.params.owned, req.params.cid) }));
api.get('/competitors/:owned/compare', (req, res) => res.json(comp.compare(req.params.owned, Number(req.query.days || 30))));
api.get('/competitors/:owned/feed', (req, res) => res.json(comp.uploadFeed(req.params.owned, { days: Number(req.query.days || 14) })));
api.post('/competitors/:owned/refresh', w(async (req, res) => res.json(await comp.refreshAll(req.params.owned))));
api.get('/alerts/:owned', (req, res) => res.json(comp.listAlerts(req.params.owned, { unreadOnly: req.query.unread === '1' })));
api.post('/alerts/:owned/read-all', (req, res) => res.json({ updated: comp.markAllRead(req.params.owned) }));
api.post('/alerts/read/:id', (req, res) => res.json({ updated: comp.markRead(req.params.id) }));

// ---------- packaging ----------
api.post('/packaging/title/analyze', (req, res) => res.json(pack.analyzeTitle(req.body.title, { keyword: req.body.keyword || '' })));
api.post('/packaging/description/analyze', (req, res) => res.json(pack.analyzeDescription(req.body.description, { keyword: req.body.keyword || '' })));
api.post('/packaging/chapters/validate', (req, res) => res.json(pack.validateChapters(req.body.text)));
api.post('/packaging/tags', w(async (req, res) => res.json(await pack.suggestTags({ ...req.body, country: req.body.country || getSetting('default_country', 'US') }))));
api.post('/packaging/titles/generate', w(async (req, res) => res.json(await pack.generateTitles(req.body))));
api.post('/packaging/description/generate', w(async (req, res) => res.json(await pack.generateDescription(req.body))));
api.post('/packaging/thumbnail/critique', w(async (req, res) => res.json(await pack.critiqueThumbnail(req.body))));
api.post('/packaging/translate', w(async (req, res) => res.json(await pack.translateMetadata(req.body))));
api.post('/packaging/ab-plan', w(async (req, res) => res.json(await pack.abTestPlan(req.body))));
api.post('/packaging/hook', w(async (req, res) => res.json(await pack.hookReview(req.body))));
api.get('/packaging/staged/:channel', (req, res) => res.json(pack.listStaged(req.params.channel, req.query.status || 'staged')));
api.post('/packaging/staged', (req, res) => res.json(pack.stageEdit(req.body)));
api.delete('/packaging/staged/:id', (req, res) => res.json({ discarded: pack.discardStaged(req.params.id) }));
api.post('/packaging/apply/:channel/:video', w(async (req, res) => res.json(await pack.applyStaged(req.params.channel, req.params.video))));
api.post('/packaging/thumbnail/set', w(async (req, res) => {
  const { channelId, videoId, imagePath, imageUrl } = req.body;
  const file = imagePath || await pack.downloadImage(imageUrl);
  res.json(await pack.setThumbnail(channelId, videoId, file));
}));
api.post('/packaging/thumbnail/upload', w(async (req, res) => {
  // body: { dataUrl, name }
  const m = /^data:(image\/\w+);base64,(.+)$/.exec(req.body.dataUrl || '');
  if (!m) return res.status(400).json({ error: 'dataUrl required' });
  const dir = path.join(DATA_DIR, 'thumbs'); fs.mkdirSync(dir, { recursive: true });
  const ext = m[1] === 'image/png' ? '.png' : '.jpg';
  const file = path.join(dir, `${Date.now()}-${(req.body.name || 'thumb').replace(/[^\w.-]/g, '_')}${ext}`);
  fs.writeFileSync(file, Buffer.from(m[2], 'base64'));
  res.json({ path: file, url: '/data/thumbs/' + path.basename(file) });
}));

// ---------- comments ----------
api.get('/comments', w(async (req, res) => {
  const threads = await com.fetchThreads({ videoId: req.query.video || null, channelId: req.query.channel || null, ownerChannelId: req.query.owner || req.query.channel || null, maxPages: Number(req.query.pages || 3), order: req.query.order || 'time', searchTerms: req.query.search || '' });
  const filtered = com.filterThreads(threads, { filter: req.query.filter || 'all', q: req.query.q || '' });
  res.json({ total: threads.length, shown: filtered.length, threads: filtered, terms: com.termFrequencies(threads.map(t => t.text)), questionClusters: com.clusterQuestions(threads) });
}));
api.post('/comments/ai-clusters', w(async (req, res) => res.json(await com.aiClusterQuestions(req.body.threads || [], req.body.channelContext || ''))));
api.post('/comments/reply-drafts', w(async (req, res) => res.json(await com.replyDrafts(req.body.thread, { channelContext: req.body.channelContext || '' }))));
api.post('/comments/reply', w(async (req, res) => res.json(await com.postReply(req.body.channelId, req.body.parentId, req.body.text))));
api.post('/comments/giveaway', (req, res) => res.json(com.pickWinner(req.body.threads || [], req.body)));
api.get('/comments/templates', (req, res) => res.json(com.templates.list()));
api.post('/comments/templates', (req, res) => res.json({ id: com.templates.create(req.body.name, req.body.body) }));
api.put('/comments/templates/:id', (req, res) => res.json({ updated: com.templates.update(req.params.id, req.body.name, req.body.body) }));
api.delete('/comments/templates/:id', (req, res) => res.json({ removed: com.templates.remove(req.params.id) }));

// ---------- AI coach & production ----------
api.get('/coach/:id/context', (req, res) => res.json({ context: coach.channelContext(req.params.id) }));
api.post('/coach/:id/ask', w(async (req, res) => res.json(await coach.coach(req.params.id, req.body.question, { mode: req.body.mode || 'quick', extra: req.body.extra || '' }))));
api.post('/coach/:id/ideas', w(async (req, res) => res.json(await coach.dailyIdeas(req.params.id, req.body))));
api.post('/coach/idea-generator', w(async (req, res) => res.json(await coach.ideaGenerator(req.body))));
api.post('/coach/:id/audit', w(async (req, res) => res.json(await coach.audit(req.params.id))));
api.post('/coach/:id/weekly-plan', w(async (req, res) => res.json(await coach.weeklyPlan(req.params.id, req.body))));
api.post('/coach/:id/beginner', w(async (req, res) => res.json(await coach.beginnerNextSteps(req.params.id))));
api.post('/coach/validate-idea', w(async (req, res) => res.json(await coach.validateIdea(req.body))));
api.get('/coach/lessons', (req, res) => res.json(coach.LESSONS));
api.get('/transcript/:channel/:video', w(async (req, res) => res.json(await coach.ownedTranscript(req.params.channel, req.params.video))));
api.post('/transcript/parse', (req, res) => res.json({ segments: coach.parseSrt(req.body.srt || ''), text: coach.srtToText(req.body.srt || '') }));
api.post('/production/chapters', w(async (req, res) => res.json(await coach.chaptersFromTranscript(req.body))));
api.post('/production/clips', w(async (req, res) => res.json(await coach.clipMoments(req.body))));
api.post('/production/script', w(async (req, res) => res.json(await coach.scriptWriter(req.body))));
api.post('/production/repurpose', w(async (req, res) => res.json(await coach.repurpose(req.body))));
api.post('/production/score-script', w(async (req, res) => res.json(await coach.scoreScript(req.body))));
api.get('/safety-checklist', (req, res) => res.json(misc.SAFETY_CHECKLIST));

// ---------- boards, blueprints, saved, calculators ----------
api.get('/boards/:channel', (req, res) => res.json(misc.boards.list(req.params.channel)));
api.post('/boards/:channel', (req, res) => res.json({ id: misc.boards.create(req.params.channel, req.body.name) }));
api.delete('/boards/id/:id', (req, res) => res.json({ removed: misc.boards.remove(req.params.id) }));
api.get('/boards/id/:id/items', (req, res) => res.json(misc.boards.items(req.params.id)));
api.post('/boards/id/:id/items', (req, res) => res.json({ id: misc.boards.addItem(req.params.id, req.body.kind, req.body.ref, req.body.note || '') }));
api.put('/boards/items/:id', (req, res) => res.json({ updated: misc.boards.updateNote(req.params.id, req.body.note) }));
api.delete('/boards/items/:id', (req, res) => res.json({ removed: misc.boards.removeItem(req.params.id) }));
api.get('/blueprints/:channel', (req, res) => res.json(misc.blueprints.list(req.params.channel)));
api.post('/blueprints/:channel', (req, res) => res.json({ id: misc.blueprints.create(req.params.channel, req.body) }));
api.put('/blueprints/id/:id', (req, res) => res.json({ updated: misc.blueprints.update(req.params.id, req.body) }));
api.delete('/blueprints/id/:id', (req, res) => res.json({ removed: misc.blueprints.remove(req.params.id) }));
api.get('/saved/:channel', (req, res) => res.json(misc.saved.list(req.params.channel, req.query.kind || null)));
api.post('/saved/:channel', (req, res) => res.json({ id: misc.saved.create(req.params.channel, req.body.kind, req.body.title, req.body.body) }));
api.delete('/saved/id/:id', (req, res) => res.json({ removed: misc.saved.remove(req.params.id) }));
api.get('/calc/rpm-bands', (req, res) => res.json(misc.RPM_BANDS));
api.post('/calc/earnings', (req, res) => res.json(misc.earningsScenario(req.body)));
api.post('/calc/valuation', (req, res) => res.json(misc.valuationScenario(req.body)));
api.post('/export/csv', (req, res) => { res.setHeader('Content-Type', 'text/csv'); res.setHeader('Content-Disposition', `attachment; filename="${(req.body.name || 'export').replace(/[^\w.-]/g, '_')}.csv"`); res.send(misc.toCsv(req.body.rows || [], req.body.columns || null)); });

// ---------- scores & demand index ----------
api.get('/scores/video/:id', (req, res) => { const s = scores.videoScore(req.params.id); s ? res.json(s) : res.status(404).json({ error: 'not synced' }); });
api.get('/scores/channel/:id', (req, res) => { const s = scores.channelScore(req.params.id); s ? res.json(s) : res.status(404).json({ error: 'not found' }); });
api.get('/scores/channel/:id/videos', (req, res) => res.json(scores.videoScoresForChannel(req.params.id)));
api.get('/keywords/demand', w(async (req, res) => res.json(await scores.demandIndex(req.query.q, { country: req.query.country || getSetting('default_country', 'US') }))));

// ---------- browser extension ----------
// Watch page: public stats for any video + outlier context from a cheap sample of that channel's recent uploads (≤ 3 units when uncached).
// Recent uploads of a channel (≤50, 1 quota unit for the playlist page + 1 for stats; cached 6h).
async function recentUploads(c, excludeId = null) {
  if (!c?.uploads_playlist) return [];
  const page = await ytGet('playlistItems.list', { part: 'contentDetails', playlistId: c.uploads_playlist, maxResults: 50 }, { ttl: 6 * 3600 });
  const ids = (page.items || []).map(i => i.contentDetails.videoId).filter(id => id !== excludeId).slice(0, 50);
  return ids.length ? ch.fetchVideosByIds(ids) : [];
}
function channelSummary(c, uploads) {
  const now = Date.now();
  const long = uploads.filter(v => !v.is_short), shorts = uploads.filter(v => v.is_short);
  const span = uploads.length > 1 ? Math.max(7, (new Date(uploads[0].published_at) - new Date(uploads[uploads.length - 1].published_at)) / 86400000) : 30;
  const medLong = stats.median(long.map(v => v.view_count)) || 0, medShort = stats.median(shorts.map(v => v.view_count)) || 0;
  const recent = uploads.map(v => {
    const age = Math.max(1, (now - new Date(v.published_at)) / 86400000);
    const med = v.is_short ? medShort : medLong;
    return { id: v.id, title: v.title, thumbnail: v.thumbnail, view_count: v.view_count, published_at: v.published_at, is_short: v.is_short, ageDays: Math.round(age), vpd: v.view_count / age, outlierX: med ? v.view_count / med : null, est: estimate.estVideoRevenue(v) };
  });
  return {
    uploadsPerWeek: Math.round(uploads.length / span * 7 * 10) / 10, medianLongViews: medLong, medianShortViews: medShort,
    avgViewsPerVideo: c.video_count ? Math.round(c.view_count / c.video_count) : null, viewsPerSub: c.subscriber_count ? c.view_count / c.subscriber_count : null,
    ageDays: c.published_at ? Math.round((now - new Date(c.published_at)) / 86400000) : null,
    monthly: estimate.estChannelMonthly(c, uploads), recent: recent.slice(0, 12), breakouts: recent.filter(r => r.outlierX >= 3).slice(0, 5),
  };
}
api.get('/ext/video/:id', w(async (req, res) => {
  const [v] = await ch.fetchVideosByIds([req.params.id]);
  if (!v) return res.status(404).json({ error: 'video not found' });
  const [c] = await ch.fetchChannelsByIds([v.channel_id]);
  const peers = await recentUploads(c, v.id);
  let baseline = null;
  if (peers.length) {
    const same = peers.filter(p => !!p.is_short === !!v.is_short);
    baseline = { sample: same.length, medianViews: stats.median(same.map(p => p.view_count)) || 0, medianVpd: stats.median(same.map(p => p.view_count / Math.max(1, (Date.now() - new Date(p.published_at)) / 86400000))) || 0 };
  }
  const ageMs = Date.now() - new Date(v.published_at), age = Math.max(1, ageMs / 86400000);
  const owned = ch.listChannels('owned').map(x => x.id);
  const tracked = db.prepare('SELECT 1 FROM channels WHERE id = ?').get(v.channel_id);
  const titleA = pack.analyzeTitle(v.title), descA = pack.analyzeDescription(v.description || '', { keyword: v.title.split(/[|:\-–(]/)[0].trim() });
  res.json({
    video: v, channel: c || null, ageDays: Math.round(age), ageHours: Math.max(1, Math.round(ageMs / 3600000)), vpd: v.view_count / age, vph: v.view_count / Math.max(1, ageMs / 3600000),
    outlierX: baseline?.medianViews ? v.view_count / baseline.medianViews : null, velocityX: baseline?.medianVpd ? (v.view_count / age) / baseline.medianVpd : null, baseline,
    subsRatio: c?.subscriber_count ? v.view_count / c.subscriber_count : null, engagement: v.view_count ? (v.like_count + v.comment_count) / v.view_count : 0,
    likeRate: v.view_count ? v.like_count / v.view_count : 0, commentRate: v.view_count ? v.comment_count / v.view_count : 0,
    est: estimate.estVideoRevenue(v), channelSummary: c ? channelSummary(c, peers.concat([v]).sort((a, b) => new Date(b.published_at) - new Date(a.published_at))) : null,
    titleScore: titleA.score, descScore: descA.score, seoScore: Math.round(titleA.score * 0.5 + descA.score * 0.3 + Math.min(100, (v.tags?.length || 0) * 8) * 0.2),
    format: disc.formatLabel(v.title), isOwned: owned.includes(v.channel_id), isTracked: !!tracked, ownedChannels: ch.listChannels('owned').map(x => ({ id: x.id, title: x.title })),
  });
}));
// Channel page: public stats, est. monthly revenue, upload cadence, recent uploads with outlier multipliers.
api.get('/ext/channel', w(async (req, res) => {
  const ref = String(req.query.ref || '').trim(); if (!ref) return res.status(400).json({ error: 'ref required' });
  const item = await ch.resolveChannel(ref);
  const c = ch.channelFromResource(item);
  const uploads = await recentUploads(c);
  const owned = ch.listChannels('owned').map(x => x.id);
  const tracked = db.prepare('SELECT 1 FROM channels WHERE id = ?').get(c.id);
  res.json({ channel: c, summary: channelSummary(c, uploads), isOwned: owned.includes(c.id), isTracked: !!tracked });
}));
// Batch chips for thumbnails on home/search/related/channel grids: 1 unit per 50 videos (+1 per 50 channels), cached.
api.get('/ext/videos', w(async (req, res) => {
  const ids = [...new Set(String(req.query.ids || '').split(',').map(s => s.trim()).filter(s => /^[\w-]{11}$/.test(s)))].slice(0, 50);
  if (!ids.length) return res.json({ videos: {} });
  const vids = await ch.fetchVideosByIds(ids);
  const chans = await ch.fetchChannelsByIds([...new Set(vids.map(v => v.channel_id))]);
  const byCh = Object.fromEntries(chans.map(c => [c.id, c]));
  const now = Date.now(), out = {};
  for (const v of vids) {
    const ageMs = now - new Date(v.published_at), age = Math.max(1, ageMs / 86400000), c = byCh[v.channel_id];
    const avg = c?.video_count ? c.view_count / c.video_count : null;
    out[v.id] = { views: v.view_count, likes: v.like_count, comments: v.comment_count, ageDays: Math.round(age), vpd: v.view_count / age, vph: v.view_count / Math.max(1, ageMs / 3600000), is_short: v.is_short, duration_sec: v.duration_sec,
      subs: c?.subscriber_count ?? null, vsChannelAvg: avg ? v.view_count / avg : null, est: estimate.estVideoRevenue(v) };
  }
  res.json({ videos: out });
}));
// Search page: demand index + cached competition if we already have it (never spends 100 units from the extension).
api.get('/ext/keyword', w(async (req, res) => {
  const q = String(req.query.q || '').trim(); if (!q) return res.json(null);
  const country = req.query.country || getSetting('default_country', 'US');
  const demand = await scores.demandIndex(q, { country });
  const hist = disc.keywordHistory(q, country);
  res.json({ demand, competition: hist.length ? hist[hist.length - 1] : null, openUrl: `/#/keywords?q=${encodeURIComponent(q)}&mode=compete` });
}));
api.get('/ext/summary', w(async (req, res) => {
  const owned = ch.listChannels('owned');
  const out = [];
  for (const c of owned) {
    const hist = ch.channelHistory(c.id, 2);
    const latest = db.prepare('SELECT id, title, view_count, published_at FROM videos WHERE channel_id = ? ORDER BY published_at DESC LIMIT 1').get(c.id);
    const unread = db.prepare('SELECT COUNT(*) AS n FROM alerts WHERE channel_id = ? AND read = 0').get(c.id).n;
    out.push({ id: c.id, title: c.title, thumbnail: c.thumbnail, subs: c.subscriber_count, views: c.view_count, subsDelta: hist.length > 1 ? hist[hist.length - 1].subs - hist[0].subs : null, latest, unreadAlerts: unread, score: scores.channelScore(c.id)?.score ?? null });
  }
  res.json({ channels: out, quota: quotaToday() });
}));
api.post('/ext/track', w(async (req, res) => {
  const owned = req.body.ownedId || ch.listChannels('owned')[0]?.id;
  if (!owned) return res.status(400).json({ error: 'Add an owned channel in TubeDesk first' });
  res.json(await comp.addCompetitor(owned, req.body.channelId));
}));
api.post('/ext/save', w(async (req, res) => {
  const owned = req.body.ownedId || ch.listChannels('owned')[0]?.id;
  if (!owned) return res.status(400).json({ error: 'Add an owned channel in TubeDesk first' });
  let boards = misc.boards.list(owned);
  if (!boards.length) { misc.boards.create(owned, 'Inspiration'); boards = misc.boards.list(owned); }
  const id = misc.boards.addItem(boards[0].id, 'video', req.body.ref, req.body.note || 'saved from YouTube');
  res.json({ id, board: boards[0].name });
}));

// ---------- error handler ----------
api.use((err, req, res, next) => {
  const status = err.status && err.status >= 400 && err.status < 600 ? err.status : 500;
  if (status >= 500) console.error('[api]', req.method, req.path, err);
  res.status(status).json({ error: err.message, reason: err.reason || err.name, endpoint: err.endpoint });
});

// OAuth callback lives outside /api
export function oauthCallback() {
  const r = Router();
  r.get('/oauth/callback', w(async (req, res) => {
    const { code, state, error } = req.query;
    if (error) return res.status(400).send(`Google returned an error: ${error}`);
    if (!consumeState(state)) return res.status(400).send('OAuth state mismatch or expired; start again from Channels.');
    const tokens = await exchangeCode(code);
    const email = await fetchEmail(tokens.access_token);
    // Discover the channel(s) this Google account owns and attach the tokens to each.
    const res2 = await fetch((process.env.YT_API_BASE || 'https://www.googleapis.com/youtube/v3') + '/channels?part=snippet,statistics,contentDetails,brandingSettings&mine=true&maxResults=50', { headers: { Authorization: `Bearer ${tokens.access_token}` } });
    const j = await res2.json();
    if (!res2.ok) return res.status(500).send(`Could not list channels: ${j?.error?.message}`);
    const ids = [];
    for (const item of j.items || []) {
      ch.upsertChannel(ch.channelFromResource(item), 'owned');
      saveTokens(item.id, tokens);
      db.prepare('UPDATE channels SET oauth_email = ? WHERE id = ?').run(email, item.id);
      ids.push(item.id);
      ch.syncVideos(item.id, { maxVideos: 500 }).catch(e => console.error('[sync]', e.message));
    }
    res.redirect(`/#/channels?connected=${ids.join(',')}`);
  }));
  return r;
}

export { YouTubeError };
