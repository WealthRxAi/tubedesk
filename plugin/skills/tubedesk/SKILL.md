---
name: tubedesk
description: >
  This skill should be used whenever the user asks about their YouTube, Instagram or TikTok channels or content —
  "how is my channel doing", "what should my next video be", "score these titles", "find outliers", "keyword research",
  "is my upload doing well", "why is my CTR low", "make a thumbnail", "upload this video", "schedule this", "cut Shorts",
  "best time to post" — or mentions TubeDesk, vidIQ-style research, the virality radar, or the TubeDesk tools.
  It explains how to drive the user's self-hosted TubeDesk through its MCP tools.
metadata:
  version: "1.9.0"
---

# Operating TubeDesk

TubeDesk is the user's own YouTube growth desk running on their Mac (default `http://localhost:4949`). The `tubedesk` MCP server in this plugin exposes it as tools. Use TubeDesk for every YouTube/Instagram/TikTok research, packaging, analytics and publishing task instead of any third-party creator tool.

## First call in a session

Call `list_channels` (owned channels first) before channel-specific work, unless the channel is already known in this conversation. Most tools default to the first owned channel when `channelId` is omitted — pass `channelId` explicitly whenever the user has more than one owned channel and the request names one. Match the channel the user means by title or handle; ask only when it is genuinely ambiguous.

If anything looks unconfigured (missing API key, no owned channel, channel not connected), call `setup_status` and work through its `next` steps: set values with `update_settings`, add channels with `add_channel`, and give the user the consent link from `connect_account` — opening that link on the Mac is the only step they do by hand.

If a tool returns "TubeDesk isn't running", say so in one line and give the restart command from the error. Do not fall back to guessing numbers.

## Tool map

| Need | Tools |
|---|---|
| Ideas | `daily_ideas` (radar-scored morning list; `run:true` rebuilds, 1–3 min), `outliers`, `keyword_research`, `similar_channels` |
| Packaging | `radar_score` (1–8 title/thumbnail variants + optional hook → ranked, predicted × usual views, fixes), `make_thumbnails` |
| After upload | `radar_watch` (pace vs usual launch curve), `ctr_report` (real impressions/CTR), `autopilot` (fix lagging packaging) |
| Whole picture | `portfolio` (every owned channel + Instagram, week vs last week) |
| Production | `voiceover`, `voiceover_short`, `render_video`, `media_transcode`, `media_probe`, `caption_timing`, `speech_segments`, `extract_frame`, `make_shorts` |
| Publishing | `publish_status`, `best_publish_time`, `publish_youtube`, `publish_instagram`, `publish_tiktok`, `publish_job` |
| Instagram / TikTok research | `ig_lookup`, `ig_track_account`, `ig_outliers`, `ig_hashtag`, `tiktok_videos` |
| Setup & configuration | `setup_status` (checklist + next step), `get_settings`, `update_settings`, `add_channel`, `connect_account`, `test_notification`, `remote_access` |
| Anything else | `tubedesk_api` (`GET /api/agent` lists every route) |

Workflows with exact steps live in the sibling skills: video-ideas, package-video, channel-checkup, publish-video, make-shorts. Load the matching one when the request fits.

## Rules

- **Numbers come from tools.** Never estimate views, CTR, subscriber counts or scores from memory. Quote what the tools return, with the unit (views/day, × the channel's usual, %).
- **Read the radar honestly.** `radar_score` returns a calibration verdict. When the channel is not calibrated or the verdict is "not predictive yet", present scores as directional and say so in one short clause. Offer `radar_calibrate` once if the channel has 20+ uploads and was never calibrated.
- **Respect the quota.** The free YouTube quota is 10,000 units/day; an upload costs 1,600, an uncached `outliers` search 100. Check `publish_status` before uploads and avoid repeated uncached searches for the same query.
- **Files are local absolute paths** on the user's Mac. When the user attaches a file in chat, it is not on their Mac — ask for the path on their machine or save it there first.
- **Publishing.** Publish when the user asks to publish, upload, post or schedule. Default to scheduling into the next best slot (`publishAt: "best"`) unless the user says "now" or names a time. Never make something public that the user asked to keep private, and never re-upload a video that already went up (check `publish_job` / `publish_status` first after an error).
- **Packaging changes on live videos** (`autopilot` action `run`) change a public video's title/thumbnail. Run them when the user asks; they auto-revert if CTR drops.
- **AI disclosure.** For realistic AI-generated or altered footage, set `containsSyntheticMedia: true` on YouTube and `disclose: true` on TikTok.

## Answer style

Lead with the verdict or the pick, then the evidence (2–4 numbers), then one next step. Use a short table when comparing 3+ options. Link videos as `https://youtu.be/<id>`.
