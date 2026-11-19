---
name: channel-checkup
description: >
  This skill should be used when the user asks "how is my channel doing", "how did my last video do",
  "is my upload doing well", "why are my views down", "check my CTR", "weekly review", "how are all my channels",
  "am I close to monetization", or wants a channel diagnosis, using TubeDesk analytics, the live radar watch and the CTR feed.
metadata:
  version: "1.9.0"
---

# Channel checkup

Diagnose the one lever that matters most right now, with numbers, and act on it.

## Steps

1. **Big picture.** `portfolio` → every owned channel (+ Instagram): views and subscribers this week vs last, latest upload pace, 28-day CTR, monetization progress, open alerts, autopilot activity, queued Shorts. For a single named channel, focus on its card.
2. **Recent uploads.** `radar_watch` (`run: true` if the last reading is more than an hour old) → each recent upload's pace vs the channel's usual launch curve and its status (breakout / rising / on-track / lagging / stalled).
3. **Packaging vs content.** `ctr_report` (`sync: true` when the user wants the latest) → impressions and CTR per video and the channel's usual first-days CTR.
   - Low CTR with normal impressions → packaging problem.
   - Normal CTR with few impressions → topic/demand problem (go to the video-ideas skill).
   - Normal CTR and impressions but weak views/retention → content/hook problem.
4. **Act on it.**
   - Lagging upload with a packaging problem: `autopilot` action `run` with the `videoId` when the user asks to fix it (it scores alternatives on the radar, swaps in a clear winner, grades CTR and reverts if it gets worse). Otherwise list what it would do with `autopilot` (default action "list").
   - Breakout long-form upload: offer `make_shorts` on it (or note that Shorts were cut automatically if the Shorts queue shows them).
   - Monetization: report watch hours and subscribers vs 4,000 / 1,000 from the portfolio card.
5. **Report**: verdict first (one sentence), the 3–4 numbers that prove it, the single action taken or recommended, and what to watch next.

## Rules

- Compare against the channel's own baseline, never against generic benchmarks.
- Reach data from the Reporting API lags about 2 days; say so if the user asks about the last 48 hours.
- If a channel is not connected with Google (no owner analytics), say which numbers are missing and how to connect it: TubeDesk → Channels → Connect.
