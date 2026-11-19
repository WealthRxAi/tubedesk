---
name: make-shorts
description: >
  This skill should be used when the user asks to "cut Shorts from this video", "make clips", "turn my video into Shorts",
  "repurpose this upload", "clip the best moments", "what Shorts are scheduled", or "cancel that Short",
  using TubeDesk's Shorts pipeline (local transcription, radar-scored moments, captioned 9:16 clips, best-slot scheduling).
metadata:
  version: "1.9.0"
---

# Shorts from long-form uploads

TubeDesk already cuts Shorts automatically when one of the user's long-form uploads breaks out. Use this skill to run it on demand or manage the queue.

## Steps

1. **Find the video.** Resolve the upload from the user's words via `channel_videos` (match title) or `radar_watch`. It must be the user's own long-form video.
2. **Check readiness.** `tubedesk_api GET /api/shorts/status` → transcriber (whisper.cpp), ffmpeg, Instagram connection, settings. If the transcriber is missing, tell the user to run `brew install whisper.cpp`.
3. **Cut.** `make_shorts` with `videoId`, `count` (default 3) and `autoPublish` (`false` when the user wants to review first). It takes a few minutes: it transcribes the source file locally, picks self-contained moments, scores each title on the radar as a Short, renders 1080×1920 clips with word captions and an on-screen hook, and — with autoPublish — schedules one per best Shorts slot on YouTube and Instagram.
   - "No source file": the original video file is not linked. Ask for its path on the Mac, then link it with `tubedesk_api POST /api/autopilot/assets` body `{ "videoId": "<id>", "kind": "source", "path": "<absolute path>" }` and cut again.
   - "already been cut": those moments are already Shorts; pass `force` only if the user explicitly wants duplicates.
4. **Report** each clip: title, length, radar score, on-screen hook, scheduled time (local) or "waiting for review", and the file path.

## Managing the queue

- List: `tubedesk_api GET /api/shorts/<channelId>`.
- Schedule a reviewed clip: `tubedesk_api POST /api/shorts/clip/<clipId>/schedule`.
- Publish now: `tubedesk_api POST /api/shorts/clip/<clipId>/publish-now`.
- Cancel: `tubedesk_api POST /api/shorts/clip/<clipId>/cancel` — a YouTube Short already uploaded for a future slot is kept private; anything already public is reported, not deleted. Relay the returned `notes`.
