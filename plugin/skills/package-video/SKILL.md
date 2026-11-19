---
name: package-video
description: >
  This skill should be used when the user asks to "write titles", "score my title", "which title is better",
  "make a thumbnail", "test thumbnails", "package this video", "improve my title and thumbnail", "rate my hook",
  or wants title/thumbnail options for a YouTube video or Short before publishing, using TubeDesk's virality radar.
metadata:
  version: "1.9.0"
---

# Packaging a video (title, thumbnail, hook)

## Steps

1. **Collect the facts.** What the video actually shows (from the user, a script, or `tubedesk_api GET /api/transcripts/<videoId>` for an existing upload), the target channel, format (long or short) and, if available, the video file path.
2. **Write title variants.** 6–8 truthful variants across different angles: outcome/number, mistake/warning, question, comparison, story. ≤ 60 characters where possible; front-load the keyword. Use `keyword_research` on the core phrase when the user cares about search.
3. **Make thumbnails** when a video file or images exist: `make_thumbnails` with `file` (or `backgrounds`), the best title, 2–3 `headlines` of ≤ 4 words (use `|` for a line break), `styles` `["bold","contrast"]`. It returns 1280×720 candidates ranked 0–100 by the thumbnail critic.
4. **Score together.** Call `radar_score` with up to 8 variants, pairing the top titles with the top thumbnail files (`thumbnailPath`) or URLs, plus the first ~30 seconds of script as `hook`, and the right `format`.
5. **Fix and rescore once.** Apply the top variant's listed fixes into 2–3 new variants and score again with the previous winner included. Stop after this round.
6. **Deliver**: the winning title, the winning thumbnail path, the hook line, its score, predicted × usual views with the range, and P(breakout). Show the runner-up in one line. If the radar verdict says it is not predictive yet, say the ranking is directional.

## Rules

- Never write a title the video does not deliver on; the radar rewards curiosity, not deception, and autopilot later grades real CTR.
- Thumbnail text must not repeat the title; it adds the emotion or the stakes.
- For Shorts, the first line on screen is the hook; keep it ≤ 6 words.
