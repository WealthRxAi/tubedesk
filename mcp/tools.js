// TubeDesk tool registry — one definition shared by the stdio MCP server (mcp/server.js), the Claude plugin, the
// remote MCP endpoint (/mcp) and the OpenAPI tools (/api/tools/:name, /openapi.json). No dependencies.
export const VERSION = '2.1.0';

/** The user's brands as plain text for the server instructions, so every AI knows them without asking. */
export function brandsText(b) {
  if (!b?.brands?.length) return '\n\nNo channels are set up yet: run setup_status and work through it.';
  const lines = b.brands.map(x => `- ${x.title}${x.handle ? ` (${x.handle})` : ''} — YouTube ${x.channelId}${x.connected ? '' : ' (not connected for analytics/uploads)'}${x.instagram ? `, Instagram @${x.instagram}` : ''}${x.tiktok ? `, TikTok @${x.tiktok}` : ''}${x.threads ? `, Threads @${x.threads}` : ''}${x.facebook ? `, Facebook Page ${x.facebook}` : ''}${x.linkedin ? `, LinkedIn ${x.linkedin}` : ''}`);
  const loose = [...(b.unlinked?.instagram || []).map(u => `Instagram @${u}`), ...(b.unlinked?.tiktok || []).map(u => `TikTok @${u}`)];
  return `\n\nThe user's brands (use these without asking which channel; "all channels" means every one — use portfolio):\n${lines.join('\n')}${loose.length ? `\nAccounts not linked to a brand yet: ${loose.join(', ')} (link_social_account).` : ''}`;
}

export const INSTRUCTIONS = base => `TubeDesk (${base}) is the user's own YouTube/Instagram/TikTok growth desk — use it (never vidIQ or other third-party creator tools) for everything about their channels and accounts: research, ideas, titles, thumbnails, analytics, publishing, Shorts. Start with setup_status if anything seems unconfigured, then list_channels. Before publishing, radar_score ranks title/thumbnail variants on the virality radar; after publishing, radar_watch shows whether the upload is beating its usual launch curve, ctr_report gives real impressions/CTR, autopilot fixes lagging uploads, daily_ideas is the morning idea list and portfolio is every channel on one board. render_video / voiceover_short produce MP4s; publish_youtube / publish_instagram / publish_tiktok post them (publishAt "best" schedules into the best slot). File arguments are absolute paths on the user's Mac. Research without quota: outlier_index (the user's own outlier database), niche_finder, title_formulas, similar_thumbnails; rank_tracker and competitor_audience for search ranks and competitors' viewers. make_video turns an idea into a finished Short; bulk_edit changes many videos at once (preview → apply → undo); publish_social posts to Threads, Facebook Pages and LinkedIn. health says what (if anything) needs fixing. get_settings / update_settings / connect_account configure TubeDesk itself. tubedesk_api reaches every other route (GET /api/agent lists them).`;

const q = o => { const u = new URLSearchParams(); for (const [k, v] of Object.entries(o || {})) if (v !== undefined && v !== null && v !== '') u.set(k, String(v)); const s = u.toString(); return s ? '?' + s : ''; };

export const TOOLS = [
  { name: 'render_video', description: 'Render an MP4 from a JSON timeline with ffmpeg: video/image/box/text/captions/audio/tone tracks, zoom, auto-timed captions from a script, ducked music, loudness normalization. Returns the job with the output path when wait=true (default). Call tubedesk_api GET /api/render/schema for the full track reference.',
    inputSchema: { type: 'object', required: ['tracks'], properties: { width: { type: 'integer', default: 1080 }, height: { type: 'integer', default: 1920 }, fps: { type: 'integer', default: 30 }, background: { type: 'string' }, duration: { type: 'number' }, loudness: { type: 'number', default: -14 }, output: { type: 'string', description: 'absolute output path (.mp4)' }, tracks: { type: 'array', items: { type: 'object' } }, wait: { type: 'boolean', default: true } } } },
  { name: 'media_transcode', description: 'Transcode a video to a platform preset (short/reel 1080x1920, youtube 1920x1080, square, contain) with H.264/AAC and loudness normalization.',
    inputSchema: { type: 'object', required: ['file'], properties: { file: { type: 'string' }, preset: { type: 'string', enum: ['short', 'reel', 'youtube', 'square', 'contain'], default: 'short' }, output: { type: 'string' }, width: { type: 'integer' }, height: { type: 'integer' }, fit: { type: 'string', enum: ['cover', 'contain'] }, trim: { type: 'object', properties: { start: { type: 'number' }, duration: { type: 'number' } } }, wait: { type: 'boolean', default: true } } } },
  { name: 'media_probe', description: 'Duration, resolution, fps, codecs, size of a media file.', inputSchema: { type: 'object', required: ['file'], properties: { file: { type: 'string' } } } },
  { name: 'speech_segments', description: 'Speech segments (start/end) of a voice track via pause detection — use to place cuts and B-roll on sentence boundaries.', inputSchema: { type: 'object', required: ['file'], properties: { file: { type: 'string' }, noiseDb: { type: 'number', default: -35 }, minPause: { type: 'number', default: 0.22 } } } },
  { name: 'caption_timing', description: 'Time a script (one line per spoken sentence/pause) against the voice track → word timings and 3–4-word caption groups ready for a captions track.', inputSchema: { type: 'object', required: ['file', 'script'], properties: { file: { type: 'string' }, script: { type: 'array', items: { type: 'string' } }, maxWords: { type: 'integer', default: 4 } } } },
  { name: 'extract_frame', description: 'Save a JPG frame from a video at a timestamp (for QA or a cover image).', inputSchema: { type: 'object', required: ['file'], properties: { file: { type: 'string' }, at: { type: 'number', default: 1 }, output: { type: 'string' }, width: { type: 'integer' } } } },
  { name: 'render_job', description: 'Get a render/transcode job by id; wait=true blocks until it finishes.', inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'string' }, wait: { type: 'boolean', default: false } } } },
  { name: 'publish_youtube', description: 'Upload a video file from this machine to the connected YouTube channel. Costs 1,600 API units (≈6 uploads/day on the free quota). Returns the job with the video URL when wait=true (default).',
    inputSchema: { type: 'object', required: ['file', 'title'], properties: {
      file: { type: 'string', description: 'Absolute path to an MP4/MOV on this machine' }, title: { type: 'string', maxLength: 100 }, description: { type: 'string', maxLength: 5000 },
      tags: { type: 'array', items: { type: 'string' } }, privacy: { type: 'string', enum: ['private', 'unlisted', 'public'], default: 'private' },
      publishAt: { type: 'string', description: 'ISO-8601 future time to schedule (privacy must be private), or "best" for the channel next best slot' }, format: { type: 'string', enum: ['long', 'short'], description: 'With publishAt "best": which history to learn the slot from' }, thumbnail: { type: 'string', description: 'Absolute path to JPG/PNG ≤2 MB' },
      playlistId: { type: 'string' }, categoryId: { type: 'string' }, language: { type: 'string' }, madeForKids: { type: 'boolean', default: false }, notifySubscribers: { type: 'boolean', default: true },
      containsSyntheticMedia: { type: 'boolean', description: 'true for AI-generated or altered realistic content (YouTube disclosure)' }, channelId: { type: 'string' }, wait: { type: 'boolean', default: true } } } },
  { name: 'publish_instagram', description: 'Publish a Reel (MP4/MOV, 9:16), an image, a carousel (2–10 images/videos in files) or a Story from this machine to the connected Instagram professional account. Free. Returns the job with the permalink when wait=true (default).',
    inputSchema: { type: 'object', properties: {
      file: { type: 'string', description: 'Absolute path on this machine' }, files: { type: 'array', items: { type: 'string' }, description: 'carousel: 2–10 absolute paths' }, kind: { type: 'string', enum: ['reel', 'image', 'carousel', 'story'], default: 'reel' }, caption: { type: 'string', maxLength: 2200 },
      shareToFeed: { type: 'boolean', default: true }, cover: { type: 'string', description: 'Absolute path to a JPG/PNG cover (reels)' }, thumbOffsetMs: { type: 'integer' },
      collaborators: { type: 'array', items: { type: 'string' } }, locationId: { type: 'string' }, account: { type: 'string', description: 'Which Instagram account: @username, or the brand\'s YouTube channel (title/@handle/id). Default: the account linked to the brand you are working on, else the default account.' }, publishAt: { type: 'string', description: 'ISO-8601 future time, or "best" for the next best slot: queued in TubeDesk and posted at that time (Instagram has no native scheduling)' }, wait: { type: 'boolean', default: true } } } },
  { name: 'publish_tiktok', description: 'Upload and publish a video (MP4/MOV/WebM) from this machine to the connected TikTok account. Until TikTok audits the app, the post is private ("Only me"). Returns the job with the URL when wait=true (default).',
    inputSchema: { type: 'object', required: ['file'], properties: { file: { type: 'string' }, title: { type: 'string', description: 'caption, hashtags allowed, ≤2200 chars' }, privacy: { type: 'string', enum: ['PUBLIC_TO_EVERYONE', 'MUTUAL_FOLLOW_FRIENDS', 'FOLLOWER_OF_CREATOR', 'SELF_ONLY'] }, allowComment: { type: 'boolean', default: true }, allowDuet: { type: 'boolean', default: false }, allowStitch: { type: 'boolean', default: false }, disclose: { type: 'boolean', description: 'AI-generated content label' }, account: { type: 'string', description: 'Which TikTok account: @username or the brand\'s YouTube channel. Default: the default account.' }, wait: { type: 'boolean', default: true } } } },
  { name: 'voiceover', description: 'Generate a voiceover from text with the user\'s HeyGen cloned voice (default) or ElevenLabs (keys in TubeDesk settings). Returns the MP3 path, duration, per-word timings and caption groups ready for a render_video captions track ({type:"captions", groups}).', inputSchema: { type: 'object', required: ['text'], properties: { text: { type: 'string' }, provider: { type: 'string', enum: ['heygen', 'elevenlabs'] }, voiceId: { type: 'string' }, model: { type: 'string' }, speed: { type: 'number', default: 1 }, maxWords: { type: 'integer', default: 4 } } } },
  { name: 'voiceover_short', description: 'Script → voiceover → ready 9:16 timeline (background clip/image, ducked voice, word captions, optional headline). render=true also renders the MP4 and returns its path.', inputSchema: { type: 'object', required: ['text', 'background'], properties: { text: { type: 'string' }, background: { type: 'string', description: 'absolute path to a video or image' }, headline: { type: 'string' }, music: { type: 'string' }, provider: { type: 'string', enum: ['heygen', 'elevenlabs'] }, voiceId: { type: 'string' }, render: { type: 'boolean', default: true } } } },
  { name: 'voiceover_voices', description: 'List voices on the configured provider (HeyGen clones first, or ElevenLabs), plus remaining quota.', inputSchema: { type: 'object', properties: { provider: { type: 'string', enum: ['heygen', 'elevenlabs'] } } } },
  { name: 'make_thumbnails', description: 'Thumbnail maker: frames from a video (or given images / an optional Higgsfield AI background) × headlines × styles → 1280×720 candidates ranked 0–100 by the thumbnail critic. Use the best file as `thumbnail` in publish_youtube.', inputSchema: { type: 'object', properties: { file: { type: 'string', description: 'absolute path to the video' }, title: { type: 'string' }, headlines: { type: 'array', items: { type: 'string' }, description: 'up to 3; use "|" to force a line break' }, styles: { type: 'array', items: { type: 'string', enum: ['bold', 'clean', 'alert', 'contrast'] } }, frames: { type: 'integer', default: 3 }, backgrounds: { type: 'array', items: { type: 'string' } }, aiPrompt: { type: 'string', description: 'optional Higgsfield text→image background (needs API key+secret in settings; costs credits)' }, score: { type: 'boolean', default: true }, max: { type: 'integer', default: 12 } } } },
  { name: 'similar_channels', description: 'Channels similar to one of yours: ranks channels that keep appearing for your best-performing title terms, scored by overlap × size fit. Marks ones already tracked as competitors.', inputSchema: { type: 'object', required: ['channelId'], properties: { channelId: { type: 'string' }, limit: { type: 'integer', default: 25 }, country: { type: 'string' } } } },
  { name: 'ig_track_account', description: 'Track a professional Instagram account (Creator/Business) by username: public profile, followers, last 50 posts with likes/comments; kept locally and re-synced daily for outlier detection.', inputSchema: { type: 'object', required: ['username'], properties: { username: { type: 'string' }, note: { type: 'string' } } } },
  { name: 'ig_lookup', description: 'One-off public lookup of a professional Instagram account (profile + recent posts) without tracking it.', inputSchema: { type: 'object', required: ['username'], properties: { username: { type: 'string' }, limit: { type: 'integer', default: 25 } } } },
  { name: 'ig_outliers', description: 'Instagram posts from tracked accounts that beat their own account\'s median engagement (likes+comments) by ≥ minX — the vidIQ outlier idea for Instagram. Views are not public on other accounts, so engagement is the signal.', inputSchema: { type: 'object', properties: { days: { type: 'integer', default: 90 }, minX: { type: 'number', default: 1.5 }, reelsOnly: { type: 'boolean', default: false }, username: { type: 'string' }, limit: { type: 'integer', default: 50 } } } },
  { name: 'ig_hashtag', description: 'Instagram hashtag research: top or recent media for a hashtag with engagement, reel share and median engagement (Instagram allows 30 unique hashtags per 7 days; results are cached 24h).', inputSchema: { type: 'object', required: ['tag'], properties: { tag: { type: 'string' }, kind: { type: 'string', enum: ['top', 'recent'], default: 'top' } } } },
  { name: 'tiktok_videos', description: 'Your TikTok videos with views, likes, comments, shares, views/day and × vs the account median. account = @username or the brand\'s YouTube channel (default: all accounts). sync=true pulls fresh numbers first.', inputSchema: { type: 'object', properties: { account: { type: 'string' }, sync: { type: 'boolean', default: false }, limit: { type: 'integer', default: 50 } } } },
  { name: 'publish_job', description: 'Get a publish job by id (status queued|running|done|failed, url, log). Set wait=true to block until it finishes.',
    inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'string' }, wait: { type: 'boolean', default: false }, timeoutSeconds: { type: 'integer', default: 600 } } } },
  { name: 'publish_status', description: 'Publishing readiness: authorized YouTube channels, uploads left today, Instagram configuration, recent jobs.', inputSchema: { type: 'object', properties: {} } },
  { name: 'list_channels', description: 'Owned and competitor channels tracked in TubeDesk (owned ones show whether they are authorized for uploads).', inputSchema: { type: 'object', properties: { kind: { type: 'string', enum: ['owned', 'competitor'] } } } },
  { name: 'channel_videos', description: 'Local catalogue of a channel: views, views/day, outlier × vs the channel median, format.', inputSchema: { type: 'object', required: ['channelId'], properties: { channelId: { type: 'string' }, limit: { type: 'integer', default: 50 }, sort: { type: 'string' } } } },
  { name: 'keyword_research', description: 'Autocomplete tree, competition evidence and demand index (0–100, not search volume) for a query.', inputSchema: { type: 'object', required: ['q'], properties: { q: { type: 'string' }, country: { type: 'string', default: 'US' } } } },
  { name: 'outliers', description: 'Videos performing far above their own channel median for a topic (search.list, 100 units per uncached query).', inputSchema: { type: 'object', required: ['q'], properties: { q: { type: 'string' }, days: { type: 'integer', default: 90 }, maxSubs: { type: 'integer' }, format: { type: 'string', enum: ['all', 'long', 'short'] } } } },
  { name: 'radar_score', description: 'Virality radar: score 1–8 title/thumbnail variants (plus optional opening hook) for a video idea BEFORE publishing. Returns each variant ranked with 8 axes (demand, proven-pattern fit, freshness, title craft, curiosity, emotion, thumbnail, hook), a 0–100 score, the predicted multiplier vs the channel\'s usual views with an 80% range, P(breakout ≥2×) and concrete fixes. Calibrated to the channel once radar_calibrate has run.',
    inputSchema: { type: 'object', required: ['variants'], properties: {
      channelId: { type: 'string', description: 'Owned channel id (defaults to the first owned channel)' },
      variants: { type: 'array', items: { type: 'object', required: ['title'], properties: { title: { type: 'string' }, thumbnailUrl: { type: 'string' }, thumbnailPath: { type: 'string', description: 'Image inside TubeDesk data/thumbs (POST /api/packaging/thumbnail/upload)' } } } },
      hook: { type: 'string', description: 'First ~30 seconds of the script' }, keyword: { type: 'string' }, format: { type: 'string', enum: ['long', 'short'], default: 'long' } } } },
  { name: 'radar_watch', description: 'Live breakout watch: new uploads (yours and tracked competitors\') with views vs the channel\'s usual launch curve at the same age (velocity index), status (breakout/rising/on-track/lagging/stalled) and retention when available. run=true takes a fresh reading first (≈2 quota units per channel).',
    inputSchema: { type: 'object', properties: { channelId: { type: 'string' }, run: { type: 'boolean', default: false } } } },
  { name: 'radar_calibrate', description: 'Backtest the radar on the channel\'s own history (plus tracked competitors) and store calibrated weights. Reports holdout accuracy (Spearman, top-quartile hit rate vs base rate). AI features are cached, so reruns are cheap.',
    inputSchema: { type: 'object', properties: { channelId: { type: 'string' }, aiLimit: { type: 'integer', default: 60 }, ai: { type: 'boolean', default: true } } } },
  { name: 'daily_ideas', description: 'Today\'s radar-scored video ideas for a channel, each with 3 title options ranked on the virality radar, thumbnail text, a hook and the evidence it came from (competitor breakouts, your winners, real search terms, new autocomplete suggestions). run=true builds a fresh list first (AI; ~1–3 minutes).',
    inputSchema: { type: 'object', properties: { channelId: { type: 'string' }, run: { type: 'boolean', default: false }, count: { type: 'integer', default: 8 } } } },
  { name: 'autopilot', description: 'Radar autopilot for lagging uploads. action "list" (default): every title/thumbnail change made or suggested, with diagnosis, before/after radar scores and the CTR grade. action "run" with videoId: diagnose → write truthful alternatives → score on the radar → swap in a clear winner (respects autopilot_mode auto/suggest/off). action "revert" with actionId: restore the original packaging.',
    inputSchema: { type: 'object', properties: { channelId: { type: 'string' }, action: { type: 'string', enum: ['list', 'run', 'revert'], default: 'list' }, videoId: { type: 'string' }, actionId: { type: 'integer' } } } },
  { name: 'ctr_report', description: 'Impressions and impressions CTR per video and per day from the YouTube Reporting API (daily, ~2-day delay), the channel\'s usual first-days CTR, and high-impression videos with low CTR (packaging fix candidates). sync=true pulls new reports first.',
    inputSchema: { type: 'object', properties: { channelId: { type: 'string' }, days: { type: 'integer', default: 28 }, sync: { type: 'boolean', default: false } } } },
  { name: 'make_shorts', description: 'Cut vertical Shorts from one of your long-form uploads: transcribes its source file locally (whisper.cpp), picks self-contained moments, scores each title on the virality radar, renders 1080×1920 clips with word-timed captions and an on-screen hook, and (autoPublish, default from settings) schedules them into your best Shorts slots on YouTube and Instagram. Runs automatically when an upload breaks out; use this to run it on demand. Takes a few minutes.',
    inputSchema: { type: 'object', required: ['videoId'], properties: { videoId: { type: 'string' }, count: { type: 'integer', default: 3 }, autoPublish: { type: 'boolean' }, force: { type: 'boolean', description: 'cut again even where moments were already cut (normally refused to avoid duplicate posts)' } } } },
  { name: 'portfolio', description: 'Every channel you own (+ Instagram) on one board: views and subs this week vs last, the latest upload\'s pace and CTR, monetization progress, open alerts, autopilot activity, today\'s top idea, queued Shorts. weekly=true also returns (and phones) the weekly summary text.',
    inputSchema: { type: 'object', properties: { weekly: { type: 'boolean', default: false } } } },
  { name: 'best_publish_time', description: 'Next best publish slots for a channel, learned from how your own uploads performed by local weekday and 3-hour block (shrunk toward neutral when data is thin). Use format "short" for Shorts. To schedule straight into the best slot, call publish_youtube with publishAt "best".',
    inputSchema: { type: 'object', properties: { channelId: { type: 'string' }, format: { type: 'string', enum: ['long', 'short'] }, count: { type: 'integer', default: 3 } } } },
  // ---------- configuration: an AI can set TubeDesk up end to end ----------
  { name: 'setup_status', description: 'Setup checklist for TubeDesk: YouTube API key, Google sign-in app, AI provider, owned channels (and whether each is connected for analytics/uploads), competitors, Instagram, TikTok, voiceover, phone alerts, local transcription, ffmpeg, remote access. Each item says ok/missing and the exact next step (which tool to call with what). Call this first when anything seems unconfigured.',
    inputSchema: { type: 'object', properties: {} } },
  { name: 'get_settings', description: 'TubeDesk settings with their meaning, type, allowed values and current value (secrets are masked; "set" tells whether a secret exists). Optionally filter by group: youtube, ai, radar, ideas, autopilot, shorts, publishing, instagram, tiktok, voiceover, notifications, schedule, system.',
    inputSchema: { type: 'object', properties: { group: { type: 'string' } } } },
  { name: 'update_settings', description: 'Change TubeDesk settings: pass {settings: {key: value, ...}} using keys from get_settings. Values are validated (types, allowed values, cron syntax); unknown keys are rejected. Setting yt_api_key also tests it against YouTube. Paths to programs on the Mac can only be changed from the Mac itself.',
    inputSchema: { type: 'object', required: ['settings'], properties: { settings: { type: 'object', additionalProperties: true } } } },
  { name: 'add_channel', description: 'Add a YouTube channel to TubeDesk by @handle, channel URL or channel id. kind "owned" for the user\'s own channels (then connect it with connect_account service "google" for analytics/uploads); kind "competitor" tracks it for an owned channel (ownedChannelId, defaults to the first owned channel). Syncs its videos.',
    inputSchema: { type: 'object', required: ['input'], properties: { input: { type: 'string' }, kind: { type: 'string', enum: ['owned', 'competitor'], default: 'owned' }, ownedChannelId: { type: 'string' }, note: { type: 'string' } } } },
  { name: 'connect_account', description: 'Start connecting an account that needs the owner\'s consent: "google" (YouTube analytics + uploads; one sign-in per channel — pick the brand account on Google\'s screen), "tiktok" (stats + publishing; one sign-in per brand account), "instagram" (publishing + reels radar; token per account → add_instagram_account). Returns the link to open on the Mac running TubeDesk, or the exact steps. Only the consent click is manual.',
    inputSchema: { type: 'object', required: ['service'], properties: { service: { type: 'string', enum: ['google', 'tiktok', 'instagram'] }, channel: { type: 'string', description: 'the brand (YouTube channel) this account belongs to' } } } },
  { name: 'test_notification', description: 'Send a test alert to the configured phone channels (iMessage, ntfy, webhook) and report which ones delivered.', inputSchema: { type: 'object', properties: {} } },
  { name: 'remote_access', description: 'How AI apps outside this Mac (ChatGPT, Claude web/phone, Gemini, Grok) reach TubeDesk: the public HTTPS address (Tailscale Funnel), the MCP connector URL, the OpenAPI URL, connected apps and whether the tunnel is up. action "enable" turns the tunnel on (only from the Mac).',
    inputSchema: { type: 'object', properties: { action: { type: 'string', enum: ['status', 'enable'], default: 'status' } } } },
  { name: 'brands', description: 'Every brand the user runs: each owned YouTube channel with its linked Instagram and TikTok accounts, whether it is connected for analytics/uploads, and which accounts are the defaults. Use it to know which channel/account a request is about without asking.',
    inputSchema: { type: 'object', properties: {} } },
  { name: 'add_instagram_account', description: 'Connect an Instagram professional account from an access token (Meta app → Instagram API with Instagram login → Generate token). TubeDesk looks up the account, stores it, refreshes the token automatically, and links it to the brand\'s YouTube channel when channel is given. Add one per brand.',
    inputSchema: { type: 'object', required: ['token'], properties: { token: { type: 'string' }, channel: { type: 'string', description: 'the brand\'s YouTube channel (title, @handle or id)' } } } },
  { name: 'link_social_account', description: 'Link an Instagram or TikTok account to a brand (one of the user\'s YouTube channels) so Shorts, reels radar, posting and the weekly board use the right account automatically. Also: makeDefault, or remove.',
    inputSchema: { type: 'object', required: ['platform', 'account'], properties: { platform: { type: 'string', enum: ['instagram', 'tiktok', 'threads', 'facebook', 'linkedin'] }, account: { type: 'string', description: '@username or account id' }, channel: { type: 'string', description: 'the YouTube channel (title, @handle or id); empty to unlink' }, makeDefault: { type: 'boolean' }, remove: { type: 'boolean' } } } },
  { name: 'health', description: 'TubeDesk check-up: database, backups, disk, YouTube quota, every channel\'s Google sign-in (incl. the 7-day "Testing" expiry), Instagram/TikTok tokens, scheduled jobs, publishing queue, ffmpeg/transcriber, alerts and updates — each problem with the exact fix. action "doctor" also texts new problems to the owner.',
    inputSchema: { type: 'object', properties: { action: { type: 'string', enum: ['check', 'doctor'], default: 'check' }, deep: { type: 'boolean', default: false } } } },
  { name: 'outlier_index', description: 'Search the user\'s own outlier database: every video TubeDesk has indexed from their niches (it grows daily from spare quota), ranked by views ÷ that channel\'s average. Free (no quota). action "crawl" grows it now; "add_query" adds a topic to crawl.',
    inputSchema: { type: 'object', properties: { action: { type: 'string', enum: ['search', 'crawl', 'add_query', 'stats'], default: 'search' }, q: { type: 'string', description: 'topic words (full-text)' }, minX: { type: 'number', default: 3 }, format: { type: 'string', enum: ['all', 'long', 'shorts'], default: 'all' }, days: { type: 'integer', default: 365 }, maxSubs: { type: 'integer' }, sort: { type: 'string', enum: ['x', 'views', 'vpd', 'recent'], default: 'x' }, limit: { type: 'integer', default: 30 }, query: { type: 'string', description: 'for add_query' }, now: { type: 'boolean', description: 'add_query: index it right away (102 units)' } } } },
  { name: 'niche_finder', description: 'Small or young channels in the outlier index pulling outsized views — topics with room for a newcomer (faceless-channel research). Free.',
    inputSchema: { type: 'object', properties: { q: { type: 'string' }, maxSubs: { type: 'integer', default: 100000 }, limit: { type: 'integer', default: 20 } } } },
  { name: 'title_formulas', description: 'Proven title structures ("I Tried [X] for [N] Days") mined from outliers in the index and tracked channels: how many outliers use each and their median multiple, with real examples. Use before writing titles.',
    inputSchema: { type: 'object', properties: { q: { type: 'string', description: 'niche/topic' }, minX: { type: 'number', default: 3 }, format: { type: 'string', enum: ['all', 'long', 'shorts'], default: 'all' }, limit: { type: 'integer', default: 15 } } } },
  { name: 'similar_thumbnails', description: 'Thumbnails that look like a given video\'s (or a local image you are designing), from every thumbnail TubeDesk has seen, with views and outlier multiple. Free.',
    inputSchema: { type: 'object', properties: { videoId: { type: 'string' }, file: { type: 'string', description: 'absolute path to a JPG/PNG on this Mac' }, limit: { type: 'integer', default: 20 } } } },
  { name: 'rank_tracker', description: 'Where the user\'s videos rank in YouTube search for their keywords, checked daily (100 units per keyword): list with 7-day change and the top results; add/remove keywords; check now.',
    inputSchema: { type: 'object', properties: { action: { type: 'string', enum: ['list', 'add', 'remove', 'check'], default: 'list' }, channelId: { type: 'string' }, keyword: { type: 'string' }, id: { type: 'integer', description: 'for remove' } } } },
  { name: 'competitor_audience', description: 'What competitors\' viewers ask for and complain about: questions and requests under their best recent videos, grouped by topic (~1 unit per video, cached a day). Great video ideas.',
    inputSchema: { type: 'object', properties: { channelId: { type: 'string' } } } },
  { name: 'bulk_edit', description: 'Edit titles, descriptions or tags across many of the user\'s videos at once. preview first (no changes; flags problems), then apply (51 units per video), undo puts old values back. ops: [{field: title|description|tags, action: set|append|prepend|replace|remove-line (text) or set|add|remove (tags), value, find, values}].',
    inputSchema: { type: 'object', properties: { action: { type: 'string', enum: ['preview', 'apply', 'undo', 'list'], default: 'preview' }, channelId: { type: 'string' }, videoIds: { type: 'array', items: { type: 'string' } }, q: { type: 'string', description: 'title contains' }, format: { type: 'string', enum: ['all', 'long', 'shorts'] }, since: { type: 'string' }, until: { type: 'string' }, ops: { type: 'array', items: { type: 'object' } }, batchId: { type: 'integer' } } } },
  { name: 'find_source_files', description: 'Find the original video file of each upload on this Mac (Movies, Downloads, Desktop, Documents — matched by exact length) so Shorts can be cut from any video and the autopilot can make thumbnails from frames.',
    inputSchema: { type: 'object', properties: { channelId: { type: 'string' } } } },
  { name: 'make_video', description: 'Make a finished vertical Short from an idea: AI script (hook first), titles scored on the virality radar, the user\'s own voice (HeyGen/ElevenLabs) with word-timed captions, background (your footage/image, "ai" for a Higgsfield image, or a clean branded card), render and cover. publish "schedule" queues it at the best slot on YouTube + the brand\'s Instagram/TikTok; "review" (default) just makes the file.',
    inputSchema: { type: 'object', properties: { channelId: { type: 'string' }, topic: { type: 'string' }, script: { type: 'string' }, title: { type: 'string' }, background: { type: 'string', description: 'absolute path to a video/image, "ai", or omit for a branded card' }, voiceProvider: { type: 'string', enum: ['heygen', 'elevenlabs'] }, publish: { type: 'string', enum: ['review', 'schedule', 'now'], default: 'review' }, wait: { type: 'boolean', default: true } } } },
  { name: 'publish_social', description: 'Post to Threads, a Facebook Page or LinkedIn (text, optionally one image or video from this Mac), from the brand\'s own account. Free official APIs. (X is not supported: its API charges for posting.)',
    inputSchema: { type: 'object', required: ['platform'], properties: { platform: { type: 'string', enum: ['threads', 'facebook', 'linkedin'] }, text: { type: 'string' }, file: { type: 'string' }, link: { type: 'string', description: 'Facebook link post' }, title: { type: 'string' }, account: { type: 'string', description: '@username/page or the brand\'s YouTube channel' }, wait: { type: 'boolean', default: true } } } },
  { name: 'add_social_account', description: 'Connect a Threads, Facebook Page or LinkedIn account from an access token (each platform\'s free developer app), linked to a brand. Instagram uses add_instagram_account; TikTok uses connect_account.',
    inputSchema: { type: 'object', required: ['platform', 'token'], properties: { platform: { type: 'string', enum: ['threads', 'facebook', 'linkedin'] }, token: { type: 'string' }, pageId: { type: 'string', description: 'Facebook: the Page id when the token is a user token' }, channel: { type: 'string', description: 'the brand\'s YouTube channel' } } } },
  { name: 'tubedesk_api', description: 'Call any TubeDesk REST endpoint (GET /api/... or POST /api/... with a JSON body). See GET /api/agent for the route list.',
    inputSchema: { type: 'object', required: ['path'], properties: { method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'DELETE'], default: 'GET' }, path: { type: 'string', description: 'e.g. /api/channels' }, body: { type: 'object' } } } },
];

/**
 * Build the tool runner around a transport: call(method, path, body) → parsed JSON, throwing on HTTP errors.
 */
export function createToolRunner(call) {
  async function firstOwned() {
    const owned = await call('GET', '/api/channels?kind=owned');
    if (!owned.length) throw new Error('No owned channel in TubeDesk yet — add one with add_channel (or setup_status for the full checklist).');
    return owned[0].id;
  }
  return async function runTool(name, a = {}) {
  switch (name) {
    case 'render_video': { const { wait = true, ...body } = a; return call('POST', `/api/render${wait ? '?wait=1&timeout=3600' : ''}`, body); }
    case 'media_transcode': { const { wait = true, ...body } = a; return call('POST', `/api/media/transcode${wait ? '?wait=1&timeout=3600' : ''}`, body); }
    case 'media_probe': return call('POST', '/api/media/probe', { file: a.file });
    case 'speech_segments': return call('POST', '/api/media/segments', a);
    case 'caption_timing': return call('POST', '/api/media/captions', a);
    case 'extract_frame': return call('POST', '/api/media/frame', a);
    case 'render_job': return call('GET', `/api/render/jobs/${encodeURIComponent(a.id)}${q({ wait: a.wait ? 1 : undefined, timeout: 3600 })}`);
    case 'publish_youtube': { const { wait = true, ...body } = a; return call('POST', `/api/publish/youtube${wait ? '?wait=1&timeout=1800' : ''}`, body); }
    case 'publish_instagram': { const { wait = true, ...body } = a; return call('POST', `/api/publish/instagram${wait ? '?wait=1&timeout=1800' : ''}`, body); }
    case 'publish_tiktok': { const { wait = true, ...body } = a; return call('POST', `/api/publish/tiktok${wait ? '?wait=1&timeout=1800' : ''}`, body); }
    case 'ig_track_account': return call('POST', '/api/social/ig/accounts', { username: a.username, note: a.note });
    case 'voiceover': return call('POST', '/api/media/voiceover', a);
    case 'voiceover_short': { const { render = true, ...body } = a; return call('POST', `/api/media/voiceover/short${render ? '?wait=1' : ''}`, { ...body, render }); }
    case 'voiceover_voices': { const voices = await call('GET', `/api/media/voiceover/voices${q({ provider: a.provider })}`); let quota = null; try { quota = await call('GET', `/api/media/voiceover/quota${q({ provider: a.provider })}`); } catch { /* optional */ } return { voices, quota }; }
    case 'make_thumbnails': { const { aiPrompt, ...body } = a; return call('POST', '/api/media/thumbnails', { ...body, ai: aiPrompt ? { prompt: aiPrompt } : null }); }
    case 'similar_channels': return call('GET', `/api/channels/${encodeURIComponent(a.channelId)}/similar-channels${q({ limit: a.limit, country: a.country })}`);
    case 'ig_lookup': return call('GET', `/api/social/ig/lookup${q({ username: a.username, limit: a.limit })}`);
    case 'ig_outliers': return call('GET', `/api/social/ig/outliers${q({ days: a.days, minX: a.minX, reels: a.reelsOnly ? 1 : undefined, username: a.username, limit: a.limit })}`);
    case 'ig_hashtag': return call('GET', `/api/social/ig/hashtag${q({ q: a.tag, kind: a.kind })}`);
    case 'tiktok_videos': { if (a.sync) await call('POST', '/api/social/tiktok/sync', { account: a.account }); return call('GET', `/api/social/tiktok/videos${q({ limit: a.limit, account: a.account })}`); }
    case 'publish_job': return call('GET', `/api/publish/jobs/${encodeURIComponent(a.id)}${q({ wait: a.wait ? 1 : undefined, timeout: a.timeoutSeconds })}`);
    case 'publish_status': return call('GET', '/api/publish/status');
    case 'list_channels': return call('GET', `/api/channels${q({ kind: a.kind })}`);
    case 'channel_videos': return call('GET', `/api/channels/${encodeURIComponent(a.channelId)}/videos${q({ limit: a.limit, sort: a.sort })}`);
    case 'keyword_research': { const [explore, demand] = await Promise.all([call('GET', `/api/keywords/explore${q({ q: a.q, country: a.country })}`), call('GET', `/api/keywords/demand${q({ q: a.q, country: a.country })}`)]); return { demand, explore }; }
    case 'outliers': return call('GET', `/api/outliers/search${q({ q: a.q, days: a.days, maxSubs: a.maxSubs, format: a.format })}`);
    case 'radar_score': return call('POST', '/api/radar/score', { ...a, channelId: a.channelId || await firstOwned() });
    case 'radar_watch': { const id = a.channelId || await firstOwned(); if (a.run) await call('POST', '/api/radar/watch/run'); return call('GET', `/api/radar/watch/${encodeURIComponent(id)}`); }
    case 'radar_calibrate': { const id = a.channelId || await firstOwned(); return call('POST', `/api/radar/calibrate/${encodeURIComponent(id)}?wait=1&timeout=3600`, { aiLimit: a.aiLimit, ai: a.ai }); }
    case 'daily_ideas': { const id = a.channelId || await firstOwned(); if (a.run) return call('POST', `/api/ideas/${encodeURIComponent(id)}/run`, { count: a.count }); return call('GET', `/api/ideas/${encodeURIComponent(id)}`); }
    case 'autopilot': {
      if (a.action === 'run') { if (!a.videoId) throw new Error('videoId is required for action "run"'); return call('POST', `/api/autopilot/run/${encodeURIComponent(a.videoId)}`, {}); }
      if (a.action === 'revert') { if (!a.actionId) throw new Error('actionId is required for action "revert"'); return call('POST', `/api/autopilot/actions/${a.actionId}/revert`, {}); }
      return call('GET', `/api/autopilot/${encodeURIComponent(a.channelId || await firstOwned())}`);
    }
    case 'ctr_report': { const id = a.channelId || await firstOwned(); if (a.sync) await call('POST', `/api/reach/${encodeURIComponent(id)}/sync`, {}); return call('GET', `/api/reach/${encodeURIComponent(id)}?days=${a.days || 28}`); }
    case 'make_shorts': return call('POST', `/api/shorts/make/${encodeURIComponent(a.videoId)}?wait=1`, { count: a.count, autoPublish: a.autoPublish, force: a.force === true });
    case 'portfolio': return a.weekly ? call('POST', '/api/portfolio/weekly-summary', { send: true }) : call('GET', '/api/portfolio');
    case 'best_publish_time': { const id = a.channelId || await firstOwned(); return call('GET', `/api/slots/${encodeURIComponent(id)}?count=${a.count || 3}${a.format ? '&format=' + a.format : ''}`); }
    case 'setup_status': return call('GET', '/api/setup');
    case 'get_settings': return call('GET', `/api/config${q({ group: a.group })}`);
    case 'update_settings': { if (!a.settings || typeof a.settings !== 'object') throw new Error('settings must be an object of key: value'); return call('PUT', '/api/config', a.settings); }
    case 'add_channel': {
      if ((a.kind || 'owned') === 'competitor') return call('POST', `/api/competitors/${encodeURIComponent(a.ownedChannelId || await firstOwned())}`, { input: a.input, note: a.note || '' });
      return call('POST', '/api/channels', { input: a.input, kind: 'owned' });
    }
    case 'connect_account': return call('GET', `/api/setup/connect/${encodeURIComponent(a.service)}${q({ channel: a.channel })}`);
    case 'test_notification': return call('POST', '/api/notify/test', {});
    case 'remote_access': return a.action === 'enable' ? call('POST', '/api/remote/enable', {}) : call('GET', '/api/remote/status');
    case 'brands': return call('GET', '/api/brands');
    case 'health': return a.action === 'doctor' ? call('POST', '/api/health/doctor', {}) : call('GET', `/api/health${q({ deep: a.deep ? 1 : undefined })}`);
    case 'outlier_index': {
      if (a.action === 'crawl') return call('POST', '/api/index/crawl?wait=1', {});
      if (a.action === 'add_query') return call('POST', '/api/index/queries', { query: a.query || a.q, now: a.now === true });
      if (a.action === 'stats') return call('GET', '/api/index/stats');
      return call('GET', `/api/index${q({ q: a.q, minX: a.minX, format: a.format, days: a.days, maxSubs: a.maxSubs, sort: a.sort, limit: a.limit || 30 })}`);
    }
    case 'niche_finder': return call('GET', `/api/niches${q({ q: a.q, maxSubs: a.maxSubs, limit: a.limit })}`);
    case 'title_formulas': return call('GET', `/api/formulas${q({ q: a.q, minX: a.minX, format: a.format, limit: a.limit || 15 })}`);
    case 'similar_thumbnails': return a.file ? call('POST', '/api/thumbnails/similar', { file: a.file, limit: a.limit }) : call('GET', `/api/thumbnails/similar${q({ videoId: a.videoId, limit: a.limit })}`);
    case 'rank_tracker': {
      if (a.action === 'add') return call('POST', '/api/ranks', { channelId: a.channelId || await firstOwned(), keyword: a.keyword });
      if (a.action === 'remove') return call('DELETE', `/api/ranks/${encodeURIComponent(a.id)}`);
      if (a.action === 'check') return call('POST', '/api/ranks/check', {});
      return call('GET', `/api/ranks${q({ channelId: a.channelId })}`);
    }
    case 'competitor_audience': return call('GET', `/api/competitor-audience/${encodeURIComponent(a.channelId || await firstOwned())}`);
    case 'bulk_edit': {
      if (a.action === 'apply') return call('POST', `/api/bulk/${encodeURIComponent(a.batchId)}/apply`, {});
      if (a.action === 'undo') return call('POST', `/api/bulk/${encodeURIComponent(a.batchId)}/undo`, {});
      const channelId = a.channelId || await firstOwned();
      if (a.action === 'list') return call('GET', `/api/bulk${q({ channelId })}`);
      return call('POST', '/api/bulk/preview', { channelId, videoIds: a.videoIds, q: a.q, format: a.format, since: a.since, until: a.until, ops: a.ops });
    }
    case 'find_source_files': return call('POST', '/api/sources/match', { channelId: a.channelId || null });
    case 'make_video': { const { wait = true, ...body } = a; return call('POST', `/api/make-video${wait ? '?wait=1' : ''}`, { ...body, channelId: a.channelId || await firstOwned() }); }
    case 'publish_social': { const { wait = true, platform, ...body } = a; return call('POST', `/api/publish/${encodeURIComponent(platform)}${wait ? '?wait=1&timeout=1800' : ''}`, body); }
    case 'add_social_account': return call('POST', `/api/social-accounts/${encodeURIComponent(a.platform)}`, { token: a.token, pageId: a.pageId, channel: a.channel || null });
    case 'add_instagram_account': return call('POST', '/api/social-accounts/instagram', { token: a.token, channel: a.channel || null });
    case 'link_social_account': {
      const p = encodeURIComponent(a.platform), acc = encodeURIComponent(String(a.account || '').replace(/^@/, ''));
      if (a.remove) return call('DELETE', `/api/social-accounts/${p}/${acc}`);
      let out = null;
      if (a.channel !== undefined) out = await call('POST', `/api/social-accounts/${p}/${acc}/link`, { channel: a.channel || null });
      if (a.makeDefault) out = await call('POST', `/api/social-accounts/${p}/${acc}/default`, {});
      return out || call('GET', `/api/social-accounts${q({ platform: a.platform })}`);
    }
    case 'tubedesk_api': {
      const raw = String(a.path || '');
      if (/\.\.|%2e|%2f|%5c|\\/i.test(raw)) throw new Error('path may not contain .. or encoded separators');
      const u = new URL(raw, 'http://tubedesk.local');
      if (u.origin !== 'http://tubedesk.local' || !u.pathname.startsWith('/api/')) throw new Error('path must start with /api/');
      const method = String(a.method || 'GET').toUpperCase();
      if (!['GET', 'POST', 'PUT', 'DELETE'].includes(method)) throw new Error('method must be GET, POST, PUT or DELETE');
      return call(method, u.pathname + u.search, a.body);
    }
    default: throw new Error(`unknown tool ${name}`);
  }
  };
}

/** JSON-RPC (MCP) message handling shared by stdio and HTTP. Returns the response object, or null for notifications. */
export async function handleMcpMessage(req, { runTool, base, serverName = 'tubedesk' }) {
  const { id, method, params } = req || {};
  const ok = result => (id === undefined || id === null ? null : { jsonrpc: '2.0', id, result });
  const fail = (code, message) => (id === undefined || id === null ? null : { jsonrpc: '2.0', id, error: { code, message } });
  try {
    if (method === 'initialize') {
      const supported = ['2025-06-18', '2025-03-26', '2024-11-05'];
      const protocolVersion = supported.includes(params?.protocolVersion) ? params.protocolVersion : supported[0];
      let brands = '';
      try { brands = brandsText(await Promise.race([runTool('brands', {}), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 2500))])); } catch { /* TubeDesk not running yet */ }
      return ok({ protocolVersion, capabilities: { tools: { listChanged: false } }, serverInfo: { name: serverName, title: 'TubeDesk', version: VERSION }, instructions: INSTRUCTIONS(base) + brands });
    }
    if (method === 'notifications/initialized' || method === 'initialized' || method?.startsWith('notifications/')) return null;
    if (method === 'ping') return ok({});
    if (method === 'tools/list') return ok({ tools: TOOLS });
    if (method === 'tools/call') {
      try { const r = await runTool(params?.name, params?.arguments || {}); return ok({ content: [{ type: 'text', text: JSON.stringify(r, null, 2) }], isError: false }); }
      catch (e) { return ok({ content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true }); }
    }
    if (method === 'resources/list') return ok({ resources: [] });
    if (method === 'resources/templates/list') return ok({ resourceTemplates: [] });
    if (method === 'prompts/list') return ok({ prompts: [] });
    return fail(-32601, `method not found: ${method}`);
  } catch (e) { return fail(-32000, e.message); }
}
