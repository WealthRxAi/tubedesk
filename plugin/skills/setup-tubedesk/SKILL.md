---
name: setup-tubedesk
description: >
  This skill should be used when the user asks to "set up TubeDesk", "configure TubeDesk", "connect my channels",
  "add my Instagram", "connect TikTok", "connect all my brands", "make TubeDesk work in ChatGPT/Claude on my phone",
  or when setup_status shows missing items. The AI configures TubeDesk end to end — API keys, every channel, every
  brand's Instagram and TikTok, alerts and remote access — and only hands the user sign-in and consent screens.
metadata:
  version: "2.0.0"
---

# Setting TubeDesk up for the user

The user should not configure anything themselves. Do every step; pause only where a site requires the user's own password, a 2-factor code, or a consent click, and then say exactly what to click.

## Loop

1. Call `setup_status`. Work through `items` that are not ok, required ones first, then everything else — the user wants all of it.
2. After each step, call `setup_status` again and continue until every item is ok (or blocked on the user).
3. Finish with `brands` and a short table: each brand → YouTube connected, Instagram, TikTok.

## Doing the steps

Use the browser tools available in this session (the user's Chrome, or the built-in browser) for web consoles. Use the user's existing sign-ins; never type their passwords and never create or reveal secrets in chat — copy values straight into `update_settings` / `add_instagram_account`.

- **YouTube API key** (setup item "youtube_api_key"): console.cloud.google.com → create project "TubeDesk" (or reuse it) → APIs & Services → Library → enable *YouTube Data API v3*, *YouTube Analytics API* and *YouTube Reporting API* → Credentials → Create credentials → API key → restrict it to YouTube Data API v3 → `update_settings {yt_api_key}` (TubeDesk tests it and replies `works`).
- **Google sign-in app** (setup item "google_oauth"): same project → OAuth consent screen: External, app name TubeDesk, add the user's Google account as a test user → Credentials → Create OAuth client ID → Web application → Authorized redirect URI `http://localhost:4949/oauth/callback` → `update_settings {google_client_id, google_client_secret}`.
- **Channels**: `add_channel {input:"@handle", kind:"owned"}` for every channel the user owns (ask once for the list only if `brands` and the user's request don't make it clear). Then for each channel `connect_account {service:"google"}` → open the link on the Mac → pick the Google account → **pick that channel's brand account** on Google's chooser → "Advanced → Go to TubeDesk" (it is the user's own unverified app) → Allow. One sign-in per channel.
- **Competitors**: `similar_channels {channelId}` for each brand → `add_channel {kind:"competitor", ownedChannelId}` for the 3–5 best fits.
- **Instagram, per brand**: the account must be Professional (Creator/Business). developers.facebook.com → the user's Business app (create one once: type Business, add product Instagram → "API setup with Instagram login") → Add account → the user signs in to that brand's Instagram (use that brand's browser profile when the user has one) → Generate token → `add_instagram_account {token, channel:"<brand channel>"}`. One app serves every brand.
- **TikTok, per brand**: developers.tiktok.com app once (Login Kit + Content Posting API; redirect URI = the callback page from the TubeDesk repo's docs folder on the user's GitHub Pages) → `update_settings {tt_client_key, tt_client_secret, tt_redirect_uri}`. Then per brand `connect_account {service:"tiktok", channel:"<brand>"}` → open the link signed in as that brand's TikTok → approve → copy the `code` from the landing page → `tubedesk_api POST /api/social/tiktok/connect {code}`.
- **Accounts already connected but unlinked**: `link_social_account {platform, account, channel}`.
- **Voiceover**: HeyGen/ElevenLabs keys from the user's accounts (API settings pages) → `update_settings`.
- **Phone alerts**: only from an AI app on the Mac (remote apps can't change where alerts go): `update_settings {notify_imessage_to:"<the user's phone number>"}` → `test_notification`.
- **Time zone**: `update_settings {timezone}` from the user's locale.
- **Remote access** (ChatGPT / Claude on the web or phone): on the Mac, `brew install --cask tailscale`, open Tailscale and let the user sign in. TubeDesk turns remote access on by itself and texts the user a one-time Tailscale link if needed. Then `remote_access` gives the **MCP connector URL**.
- **Add TubeDesk to the user's AI apps on the web**:
  - claude.ai → Settings → Connectors → Add custom connector → name TubeDesk, URL = MCP connector URL → Connect. On the approval page, open `http://localhost:4949/#/settings` in another tab and press **Approve** (or enter the code from the user's phone).
  - chatgpt.com → Settings → Apps & Connectors → Advanced → Developer mode on → Create → MCP URL, OAuth → approve the same way.
- **AI apps on this Mac** connect themselves (Settings → *AI apps on this Mac*); nothing to do unless one shows an error.

## Rules

- Never paste tokens, keys or secrets into the conversation; move them directly into TubeDesk.
- Stop and hand over to the user for passwords, 2-factor codes, payment pages and any "I agree" for terms.
- Don't publish anything while setting up.
