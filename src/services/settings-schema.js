// Every setting an AI (or a person) may change, with its meaning and validation. Used by GET/PUT /api/config and the
// get_settings / update_settings tools. Keys not listed here are internal (tokens, OAuth state, timestamps) and can't be
// written through /api/config. `local: true` keys point at programs or network exposure on the Mac: changing them would
// let whoever controls the setting run programs or open ports, so only a client on the Mac itself may change them.
import cron from 'node-cron';
import { getSetting, setSetting, allSettings } from '../db.js';

const S = (key, group, type, description, extra = {}) => ({ key, group, type, description, ...extra });
const bool = (key, group, description, def) => S(key, group, 'bool', description, { default: def });

export const SCHEMA = [
  // youtube
  S('yt_api_key', 'youtube', 'secret', 'YouTube Data API v3 key (Google Cloud → APIs & Services → Credentials). Required for everything.'),
  S('google_client_id', 'youtube', 'string', 'OAuth client ID (Desktop or Web app, redirect http://localhost:4949/oauth/callback) — needed to connect owned channels for analytics and uploads.'),
  S('google_client_secret', 'youtube', 'secret', 'OAuth client secret for google_client_id.'),
  S('yt_quota_limit', 'youtube', 'int', 'Daily YouTube API quota TubeDesk may use.', { default: 10000, min: 1000 }),
  S('yt_quota_reserve', 'youtube', 'int', 'Units kept back for uploads and urgent calls.', { default: 500, min: 0 }),
  S('default_country', 'youtube', 'string', 'Two-letter country for search, keywords and trends.', { default: 'US', pattern: '^[A-Z]{2}$' }),
  S('sync_depth_owned', 'youtube', 'int', 'How many videos to keep in sync per owned channel.', { default: 500, min: 50 }),
  S('sync_depth_competitor', 'youtube', 'int', 'How many videos to keep in sync per competitor.', { default: 50, min: 10 }),
  // ai
  S('ai_provider', 'ai', 'enum', 'Which AI writes ideas, titles and scores: the Claude Code CLI on this Mac (uses your Claude subscription), the Anthropic API, or none.', { values: ['claude-cli', 'anthropic', 'none'], default: 'claude-cli' }),
  S('anthropic_api_key', 'ai', 'secret', 'Anthropic API key (only for ai_provider "anthropic").'),
  S('anthropic_model', 'ai', 'string', 'Model for ai_provider "anthropic".', { default: 'claude-sonnet-4-5' }),
  S('claude_cli_model', 'ai', 'string', 'Model alias for the Claude Code CLI (blank = its default).'),
  S('claude_cli_path', 'ai', 'path', 'Path to the claude CLI.', { local: true, default: 'claude' }),
  // radar
  bool('radar_enabled', 'radar', 'Virality radar on.', '1'),
  S('radar_breakout_x', 'radar', 'number', 'Pace (× the usual launch curve) that counts as a breakout.', { default: 2, min: 1.2, max: 10 }),
  S('radar_watch_days', 'radar', 'int', 'Watch your uploads for this many days.', { default: 7, min: 1, max: 60 }),
  bool('radar_watch_competitors', 'radar', 'Watch tracked competitors\' new uploads.', '1'),
  S('radar_watch_competitor_days', 'radar', 'int', 'Watch competitor uploads for this many days.', { default: 3, min: 1, max: 30 }),
  bool('radar_watch_instagram', 'radar', 'Watch your Instagram reels.', '1'),
  S('radar_watch_ig_days', 'radar', 'int', 'Watch reels for this many days.', { default: 3, min: 1, max: 30 }),
  S('radar_ai_limit', 'radar', 'int', 'Max AI-scored items per calibration.', { default: 60, min: 0, max: 500 }),
  bool('radar_calibrate_ai', 'radar', 'Use AI features when calibrating.', '1'),
  S('radar_min_age_days', 'radar', 'int', 'Only learn from uploads at least this old.', { default: 14, min: 3 }),
  S('radar_hook_captions', 'radar', 'int', 'Caption downloads per calibration for hook scoring.', { default: 10, min: 0, max: 100 }),
  // ideas
  bool('ideas_enabled', 'ideas', 'Build the morning idea list.', '1'),
  S('ideas_count', 'ideas', 'int', 'Ideas per morning list.', { default: 8, min: 3, max: 20 }),
  bool('ideas_comments', 'ideas', 'Use unanswered viewer questions as an idea signal.', '1'),
  S('ideas_comment_pages', 'ideas', 'int', 'Comment pages read per recent upload.', { default: 2, min: 1, max: 10 }),
  // autopilot
  S('autopilot_mode', 'autopilot', 'enum', 'What the autopilot does with lagging uploads: change titles/thumbnails itself, only suggest, or nothing.', { values: ['auto', 'suggest', 'off'], default: 'auto' }),
  bool('autopilot_titles', 'autopilot', 'Autopilot may change titles.', '1'),
  bool('autopilot_thumbnails', 'autopilot', 'Autopilot may change thumbnails.', '1'),
  bool('autopilot_shorts', 'autopilot', 'Autopilot also acts on Shorts.', '0'),
  bool('autopilot_auto_revert', 'autopilot', 'Revert a change when CTR gets worse.', '1'),
  S('autopilot_min_hours', 'autopilot', 'int', 'Earliest age (hours) to act on an upload.', { default: 24, min: 6 }),
  S('autopilot_max_days', 'autopilot', 'int', 'Latest age (days) to act on an upload.', { default: 7, min: 1, max: 60 }),
  S('autopilot_min_gain', 'autopilot', 'int', 'Radar points a new title/thumbnail must win by.', { default: 8, min: 1, max: 50 }),
  S('autopilot_revert_drop', 'autopilot', 'number', 'CTR drop (fraction) that triggers a revert.', { default: 0.15, min: 0.01, max: 0.9 }),
  // shorts
  bool('clips_enabled', 'shorts', 'Cut Shorts automatically when a long-form upload breaks out.', '1'),
  S('clips_count', 'shorts', 'int', 'Shorts per breakout.', { default: 3, min: 1, max: 6 }),
  S('clips_publish', 'shorts', 'enum', 'After cutting: schedule automatically or wait for review.', { values: ['auto', 'review'], default: 'auto' }),
  S('clips_platforms', 'shorts', 'list', 'Where Shorts go: youtube, instagram, tiktok (comma-separated). Each brand posts to the Instagram/TikTok account linked to its YouTube channel.', { values: ['youtube', 'instagram', 'tiktok'], default: 'youtube,instagram,tiktok' }),
  S('clips_min_seconds', 'shorts', 'int', 'Shortest clip.', { default: 15, min: 5, max: 60 }),
  S('clips_max_seconds', 'shorts', 'int', 'Longest clip.', { default: 58, min: 10, max: 180 }),
  S('whisper_model_name', 'shorts', 'enum', 'Speech model for local transcription (downloads once).', { values: ['base.en', 'small.en', 'medium.en', 'small', 'medium'], default: 'small.en' }),
  S('whisper_language', 'shorts', 'string', 'Spoken language code (en, es, …).'),
  S('whisper_threads', 'shorts', 'int', 'CPU threads for transcription.', { default: 6, min: 1, max: 32 }),
  S('whisper_path', 'shorts', 'path', 'Path to whisper-cli (blank = auto-detect).', { local: true }),
  S('whisper_model', 'shorts', 'path', 'Path to a ggml model file (blank = automatic).', { local: true }),
  // publishing
  S('timezone', 'publishing', 'timezone', 'Your time zone (IANA, e.g. America/New_York) for schedules and best slots.'),
  S('default_publish_hour', 'publishing', 'int', 'Publish hour (local) when there is not enough history to learn the best slots.', { default: 15, min: 6, max: 23 }),
  S('ffmpeg_path', 'publishing', 'path', 'Path to ffmpeg (blank = auto-detect).', { local: true }),
  S('ffprobe_path', 'publishing', 'path', 'Path to ffprobe (blank = auto-detect).', { local: true }),
  S('cloudflared_path', 'publishing', 'path', 'Path to cloudflared (temporary public links for Instagram uploads).', { local: true }),
  S('public_base_url', 'publishing', 'url', 'Public URL that reaches TubeDesk (for Instagram media). Blank = the remote-access address or a temporary tunnel.', { local: true }),
  // instagram
  S('ig_access_token', 'instagram', 'secret', 'Instagram API (Instagram Login) access token for your professional account.', { local: true }),
  S('ig_user_id', 'instagram', 'string', 'Instagram professional account user id.', { local: true }),
  S('ig_username', 'instagram', 'string', 'Instagram username (display only).'),
  // tiktok
  S('tt_client_key', 'tiktok', 'string', 'TikTok developer app client key.'),
  S('tt_client_secret', 'tiktok', 'secret', 'TikTok developer app client secret.'),
  S('tt_redirect_uri', 'tiktok', 'url', 'Redirect URI registered in the TikTok app.'),
  bool('tt_audited', 'tiktok', 'Set to 1 once TikTok has audited the app (posts can then be public).', '0'),
  // voiceover
  S('voice_provider', 'voiceover', 'enum', 'Voiceover provider (blank = HeyGen when its key is set, else ElevenLabs).', { values: ['', 'heygen', 'elevenlabs'] }),
  S('heygen_api_key', 'voiceover', 'secret', 'HeyGen API key.'),
  S('heygen_voice_id', 'voiceover', 'string', 'HeyGen voice id (your cloned voice).'),
  S('heygen_model', 'voiceover', 'string', 'HeyGen TTS model (blank = default).'),
  S('elevenlabs_api_key', 'voiceover', 'secret', 'ElevenLabs API key.'),
  S('elevenlabs_voice_id', 'voiceover', 'string', 'ElevenLabs voice id.'),
  S('elevenlabs_model', 'voiceover', 'string', 'ElevenLabs model id (blank = default).'),
  S('higgsfield_api_key', 'voiceover', 'secret', 'Higgsfield API key (optional AI thumbnail backgrounds).'),
  S('higgsfield_api_secret', 'voiceover', 'secret', 'Higgsfield API secret.'),
  // notifications
  S('notify_imessage_to', 'notifications', 'string', 'Phone number or Apple ID that gets alerts by iMessage (sent from this Mac).', { local: true }),
  S('notify_ntfy_topic', 'notifications', 'secret', 'ntfy topic for push alerts (free ntfy app).', { local: true }),
  S('notify_ntfy_server', 'notifications', 'url', 'ntfy server.', { default: 'https://ntfy.sh', local: true }),
  S('notify_webhook_url', 'notifications', 'secret', 'Webhook (Slack/Discord/n8n) that receives alerts as JSON.', { local: true }),
  S('notify_quiet', 'notifications', 'string', 'Quiet hours "22-7" (held, then sent as a digest); "off" for none.', { default: '22-7', pattern: '^(off|\\d{1,2}-\\d{1,2})$' }),
  S('notify_kinds', 'notifications', 'list', 'Which alerts go to the phone (comma-separated).', { values: ['radar_breakout', 'radar_competitor_breakout', 'radar_lagging', 'ig_breakout', 'autopilot', 'autopilot_revert', 'ideas_daily', 'clips', 'publish_failed', 'weekly_summary', 'breakout'] }),
  // schedule
  S('snapshot_cron', 'schedule', 'cron', 'Daily stats snapshot.', { default: '15 6 * * *' }),
  S('radar_watch_cron', 'schedule', 'cron', 'Live breakout watch.', { default: '7 * * * *' }),
  S('radar_calibrate_cron', 'schedule', 'cron', 'Weekly radar calibration.', { default: '40 6 * * 0' }),
  S('reach_cron', 'schedule', 'cron', 'Daily CTR/impressions import.', { default: '25 7 * * *' }),
  S('ideas_cron', 'schedule', 'cron', 'Morning idea list.', { default: '50 6 * * *' }),
  S('weekly_summary_cron', 'schedule', 'cron', 'Weekly summary to the phone.', { default: '10 8 * * 1' }),
  // system
  S('allow_lan', 'system', 'bool', 'Accept connections from other devices on the LAN (not the internet).', { local: true, default: '0' }),
  S('port', 'system', 'int', 'Local port (restart needed).', { local: true, default: 4949 }),
  S('remote_port', 'system', 'int', 'Local port of the public AI endpoint that Tailscale Funnel forwards to (restart needed).', { local: true, default: 4950 }),
  S('tailscale_path', 'system', 'path', 'Path to the tailscale CLI (blank = auto-detect).', { local: true }),
  S('ai_autoconnect', 'system', 'bool', 'Connect TubeDesk to every AI app on this Mac (Claude, Claude Code, Codex, Cursor, Gemini, Copilot, Windsurf, LM Studio) at every start.', { local: true, default: '1' }),
  S('remote_auto', 'system', 'bool', 'Turn remote access on by itself once Tailscale is signed in.', { local: true, default: '1' }),
  S('auto_update', 'system', 'bool', 'Install new TubeDesk versions from GitHub by itself (fast-forward only, never over local edits; rolls back if the new version fails to start).', { local: true, default: '1' }),
  S('update_cron', 'schedule', 'cron', 'When to check for and install updates.', { default: '10 4 * * *' }),
  S('backup_cron', 'schedule', 'cron', 'Nightly database backup and housekeeping (7 daily + 8 weekly backups kept).', { default: '30 3 * * *' }),
  S('doctor_cron', 'schedule', 'cron', 'Morning check-up; problems are texted once a day.', { default: '20 8 * * *' }),
  S('index_enabled', 'research', 'bool', 'Grow the outlier index every morning from spare YouTube quota.', { default: '1' }),
  S('index_daily_units', 'research', 'number', 'Quota units the outlier index may spend per day (102 per topic searched).', { default: '1500', min: 0, max: 50000 }),
  S('index_reserve', 'research', 'number', 'Quota units always left free for everything else before the index crawls.', { default: '3000', min: 0, max: 100000 }),
  S('index_seeds', 'research', 'string', 'Extra topics for the outlier index, comma-separated (your channels\' topics are added automatically).'),
  S('rank_max_keywords', 'research', 'number', 'Most keywords the rank tracker checks daily (100 units each).', { default: '15', min: 0, max: 200 }),
  S('media_dirs', 'research', 'string', 'Folders searched for your uploads\' source files (default: Movies, Downloads, Desktop, Documents).', { local: true }),
  S('phone_access', 'system', 'bool', 'Serve TubeDesk privately to your own devices on your Tailscale network (your phone).', { local: true, default: '1' }),
  S('jobs_catchup_minutes', 'schedule', 'number', 'How often missed or failed scheduled jobs are retried.', { default: '10', min: 5, max: 120 }),
];
export const BY_KEY = Object.fromEntries(SCHEMA.map(s => [s.key, s]));
export const SECRET = new Set(SCHEMA.filter(s => s.type === 'secret').map(s => s.key));

const mask = v => (v ? '••••' + String(v).slice(-4) : '');

/** Settings with their schema; secrets masked. */
export function describe(group = null) {
  const all = allSettings();
  return SCHEMA.filter(s => !group || s.group === group).map(s => {
    const raw = all[s.key];
    const set = raw !== undefined && raw !== null && raw !== '';
    return { ...s, value: s.type === 'secret' ? (set ? mask(raw) : '') : (set ? raw : (s.default ?? '')), set, isDefault: !set };
  });
}

function validTimezone(tz) { try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; } }

/** Validate and normalise one value; throws a clear message. */
export function validate(key, value) {
  const s = BY_KEY[key];
  if (!s) throw new Error(`unknown setting "${key}" (see get_settings)`);
  if (value === null || value === undefined) return '';
  let v = typeof value === 'string' ? value.trim() : value;
  switch (s.type) {
    case 'bool': {
      if (v === true || v === 1 || /^(1|true|yes|on)$/i.test(String(v))) return '1';
      if (v === false || v === 0 || /^(0|false|no|off)$/i.test(String(v))) return '0';
      throw new Error(`${key} must be true/false`);
    }
    case 'int': case 'number': {
      if (v === '') return '';
      const n = Number(v);
      if (!Number.isFinite(n) || (s.type === 'int' && !Number.isInteger(n))) throw new Error(`${key} must be ${s.type === 'int' ? 'a whole number' : 'a number'}`);
      if (s.min !== undefined && n < s.min) throw new Error(`${key} must be ≥ ${s.min}`);
      if (s.max !== undefined && n > s.max) throw new Error(`${key} must be ≤ ${s.max}`);
      return String(n);
    }
    case 'enum':
      if (!s.values.includes(String(v))) throw new Error(`${key} must be one of: ${s.values.filter(Boolean).join(', ')}${s.values.includes('') ? ' (or blank)' : ''}`);
      return String(v);
    case 'list': {
      const items = (Array.isArray(v) ? v : String(v).split(',')).map(x => String(x).trim()).filter(Boolean);
      const bad = s.values ? items.filter(x => !s.values.includes(x)) : [];
      if (bad.length) throw new Error(`${key}: unknown ${bad.join(', ')} (allowed: ${s.values.join(', ')})`);
      return items.join(',');
    }
    case 'cron':
      if (!cron.validate(String(v))) throw new Error(`${key} must be a 5-field cron expression, e.g. "15 6 * * *"`);
      return String(v);
    case 'timezone':
      if (v && !validTimezone(String(v))) throw new Error(`${key} must be an IANA time zone like America/New_York`);
      return String(v);
    case 'url':
      if (v && !/^https?:\/\/[^\s]+$/i.test(String(v))) throw new Error(`${key} must be an http(s) URL`);
      return String(v);
    default: {
      v = String(v);
      if (s.pattern && v && !new RegExp(s.pattern).test(v)) throw new Error(`${key} has an invalid format`);
      if (v.length > 4000) throw new Error(`${key} is too long`);
      return v;
    }
  }
}

/**
 * Apply a batch of changes atomically: every key is validated first; nothing is written if one fails.
 * remote=true refuses keys marked local (program paths, ports, network exposure).
 */
export function apply(changes, { remote = false } = {}) {
  const out = {};
  const errors = [];
  for (const [k, raw] of Object.entries(changes || {})) {
    try {
      const s = BY_KEY[k];
      if (s?.local && remote) throw new Error(`${k} can only be changed on the Mac running TubeDesk (Settings page or a local AI client)`);
      if (s?.type === 'secret' && typeof raw === 'string' && raw.startsWith('••••')) continue; // masked echo: unchanged
      out[k] = validate(k, raw);
    } catch (e) { errors.push(e.message); }
  }
  if (errors.length) throw Object.assign(new Error(errors.join('; ')), { status: 400 });
  for (const [k, v] of Object.entries(out)) setSetting(k, v);
  return Object.keys(out).map(k => ({ key: k, value: SECRET.has(k) ? mask(getSetting(k)) : getSetting(k) }));
}
