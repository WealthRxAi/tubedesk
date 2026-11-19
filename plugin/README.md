# TubeDesk plugin for Claude

Your self-hosted [TubeDesk](https://github.com/WealthRxAi/tubedesk) inside Claude — the way vidIQ's connector works, but on your own data, on your own Mac, free.

Ask Claude things like:

- "What should my next video be?" — today's radar-scored ideas plus outliers and keyword demand
- "Score these 5 titles" / "make thumbnails for this video" — virality radar ranking with predicted × usual views
- "How did my last upload do?" / "Why is my CTR down?" — live pace vs your usual launch curve, real impressions/CTR, autopilot fixes
- "How are all my channels doing this week?"
- "Turn this script into a Short and post it at the best time" — voiceover, captions, render, schedule to YouTube/Instagram/TikTok
- "Cut Shorts from my last video"

## What's inside

| Component | Purpose |
|---|---|
| MCP server `tubedesk` | 43 tools: setup and configuration, research, radar, analytics, autopilot, rendering, voiceover, thumbnails, Shorts, publishing, Instagram/TikTok research, plus `tubedesk_api` for any route |
| Skill `tubedesk` | How Claude operates TubeDesk: channel selection, quota, honest radar reading, publishing rules |
| Skill `video-ideas` | Evidence-backed, radar-scored video ideas |
| Skill `package-video` | Titles, thumbnails and hook, scored and refined |
| Skill `channel-checkup` | Diagnose the one lever that matters and act on it |
| Skill `publish-video` | Script → voiceover → render → best-slot publishing |
| Skill `make-shorts` | Cut, schedule and manage Shorts from long-form uploads |

## Install

TubeDesk must be installed and running on the same Mac (`./install-mac.sh` in the TubeDesk folder; it serves `http://localhost:4949`).

- **Claude desktop app:** TubeDesk → Settings → *TubeDesk inside Claude* → **Download the plugin**, then drag `tubedesk.plugin` into a chat and press Install. (Or build it yourself: `npm run plugin -- --zip` → `dist/tubedesk.plugin`.)
- **Claude Code:**
  ```
  /plugin marketplace add WealthRxAi/tubedesk
  /plugin install tubedesk@tubedesk
  ```

TubeDesk on another port or machine: set `TUBEDESK_URL` in `.mcp.json`.

`mcp/server.js` and `mcp/tools.js` here are copies of the repo's; `npm run plugin` keeps them identical (a test fails if they drift).

Using ChatGPT, Claude on the web or phone, Gemini or Grok instead? Those connect to TubeDesk's own HTTPS endpoint — see the main README, *Use TubeDesk from any AI*.
