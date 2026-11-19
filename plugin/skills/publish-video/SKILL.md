---
name: publish-video
description: >
  This skill should be used when the user asks to "upload this video", "publish to YouTube", "post this reel",
  "post to Instagram", "post to TikTok", "schedule this video", "post it at the best time", "make a Short from this script",
  "render this", or "add a voiceover", using TubeDesk's render, voiceover and publishing tools on the user's Mac.
metadata:
  version: "1.8.0"
---

# Producing and publishing

## Producing (when there is no finished file yet)

- **Script → finished Short:** `voiceover_short` with the script `text`, a `background` (absolute path to a clip or image), an optional `headline` and `music`. It voices the script (the user's HeyGen cloned voice by default), times word captions, ducks the music and renders a 9:16 MP4.
- **Custom edit:** `voiceover` (returns the MP3, word timings and caption groups) → `render_video` with a JSON timeline (call `tubedesk_api GET /api/render/schema` once for the track reference). Use `speech_segments` to cut on sentence boundaries.
- **Wrong size/format:** `media_transcode` with preset `short`, `reel`, `youtube` or `square`.
- **QA:** `media_probe` (duration, resolution, audio present) and `extract_frame` at 1 s and at the midpoint; look at the frames before publishing.

## Publishing

1. `publish_status` → which YouTube channels are authorized, uploads left today, Instagram/TikTok readiness. If the target is not ready, say exactly what to connect in TubeDesk → Settings and stop.
2. Packaging: if the user has no final title/thumbnail, run the package-video skill first (short version: 4 variants, one scoring round).
3. Timing: unless the user says "now" or names a time, schedule into the next best slot — `publish_youtube` with `publishAt: "best"` and `format` (`long` or `short`); for Instagram, `publish_instagram` with `publishAt: "best"` queues it for that slot. Report the slot in the user's local time.
4. Upload:
   - YouTube: `publish_youtube` with `file`, `title`, `description` (first 2 lines carry the hook and keyword), `tags` (5–10), `thumbnail` (long-form), `containsSyntheticMedia` for realistic AI footage, `madeForKids` as appropriate. Shorts: vertical ≤ 3 min, add `#Shorts` to the description.
   - Instagram: `publish_instagram` `kind: "reel"` with `caption` (hook line, 1–2 lines of value, 3–5 hashtags) and `cover` if available.
   - TikTok: `publish_tiktok` with `title` (caption) and `disclose` for AI content. Until TikTok audits the app, posts are private ("Only me") — say so.
5. Confirm with the returned URL / scheduled time. If a job fails, read `publish_job` for the log before retrying; never retry an upload that may already have gone through.

## Rules

- Publish only what the user asked to publish, to the platforms they named.
- Keep the user's privacy choice; "best" scheduling uploads YouTube videos as private until the slot.
- One upload costs 1,600 of 10,000 daily quota units — for several videos, spread them across slots instead of uploading all at once.
