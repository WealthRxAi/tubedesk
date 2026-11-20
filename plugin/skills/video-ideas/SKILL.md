---
name: video-ideas
description: >
  This skill should be used when the user asks "what should my next video be", "give me video ideas",
  "find me topics", "what's working in my niche", "find outliers", "do keyword research on X",
  "what are competitors doing that's blowing up", or wants ideas for a YouTube channel, Shorts, or Instagram reels,
  using TubeDesk.
metadata:
  version: "2.0.0"
---

# Video ideas with evidence

Produce ideas the user can film this week, each backed by evidence from TubeDesk and pre-scored on the virality radar.

## Steps

1. **Pick the channel.** Use the channel named, otherwise the first owned channel from `list_channels`.
2. **Start from today's list.** Call `daily_ideas`. If it is empty or older than today, call it with `run: true` (takes 1–3 minutes; say so before calling). Each idea already carries 3 radar-ranked titles, thumbnail text, a hook and its evidence (competitor breakouts, the channel's own winners, real search terms, new autocomplete suggestions, unanswered viewer questions).
3. **Widen when the user names a topic** or wants more than the list:
   - `keyword_research` with the topic → demand index (0–100, relative, not search volume) and the autocomplete tree. Prefer phrasings with demand ≥ 40 and evidence of small channels ranking.
   - `outliers` with the topic (`format: "short"` for Shorts) → videos beating their own channel's median. An outlier from a channel smaller than the user's is the strongest signal. Each uncached call costs 100 quota units; run at most 3 different queries.
   - `similar_channels` when the user asks who to learn from, then add promising ones as competitors with `tubedesk_api` `POST /api/competitors/<ownedChannelId>` body `{ "input": "<channel id or @handle>" }`.
   - For Instagram: `ig_outliers` (tracked accounts) and `ig_hashtag`.
4. **Score new angles.** For any idea not already from `daily_ideas`, write 3–5 truthful title variants and call `radar_score` with `format` matching the idea (long or short) and the opening hook if drafted.
5. **Rank and present** the top 5: best title, radar score and predicted × usual views, the one-line evidence (with the video link or search term), thumbnail text (≤ 4 words), and a 1-sentence hook. Mark the single pick.

## Quality bar

- Every idea cites at least one piece of evidence from a tool result. Drop ideas with none.
- Titles must be truthful to the planned video — no promises the video will not deliver.
- Prefer ideas that fit the channel's proven formats (its own outliers in `channel_videos` sorted by outlier ×).
- Do not repeat an idea the channel already published; check `channel_videos` titles when in doubt.
