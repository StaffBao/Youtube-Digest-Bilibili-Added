# Privacy

Effective: August 14, 2026

YouTube Digest is a GitHub-only, bring-your-own-endpoint Chrome extension. It has no YouTube Digest account, developer-operated backend, analytics, advertising, or telemetry.

## Data the extension handles

Depending on the feature you use, YouTube Digest handles:

- the video ID and canonical URL of the active YouTube or Bilibili video;
- transcript text and timestamps;
- video metadata such as title, channel/author, description, and duration;
- text you select in the transcript and nearby transcript context;
- transcript context around a timestamped note;
- content you ask to translate;
- notes you save;
- your AI endpoint configuration, including the base URL, model name, and API key; and
- cached transcript, digest, and translation results.

## Where data goes

### Video platforms (transcripts only)

Transcripts are fetched directly from each platform's own caption endpoints, with no third-party transcript service:

- **YouTube**: the extension reads the player's caption track list from the open video page and downloads the selected timedtext subtitle file directly from YouTube.
- **Bilibili**: the extension reads the subtitle list from the open video page (or Bilibili's official player API) and downloads the subtitle JSON from Bilibili. These requests are sent with your browser's own Bilibili login cookies (`credentials: include`), because Bilibili only returns subtitles to logged-in accounts. No Bilibili password or token is read or stored by the extension beyond what the browser already holds.

### Your configured AI endpoint

AI feature content is sent to the OpenAI-compatible Chat Completions endpoint you configure in Settings (base URL + API key + model). The default is Alibaba Cloud DashScope (Qwen), but any compatible endpoint works. Depending on the feature:

- transcript plus relevant title, channel, description, or duration for an overview;
- selected text plus nearby transcript context for an explanation;
- small semantic transcript batches currently needed for progressive Chinese translation, or requested overview or explanation content;
- nearby transcript context and video metadata when polishing a saved note.

Requests go directly from the extension to the video platform or your configured AI endpoint. They are authenticated with your browser login (Bilibili) or the API key you supply. YouTube Digest's developer does not proxy or receive these requests.

Those services process data under their own terms, privacy policies, retention practices, and account settings. Do not send confidential, personal, or regulated content unless their terms and your obligations permit it.

## Permissions

Because the AI endpoint is user-configurable, the extension requests broad HTTPS host access (`https://*/*`). This access is used only to reach (1) the AI endpoint you configured and (2) the caption endpoints of YouTube and Bilibili while a video page is open. The extension does not use host access to read or monitor unrelated sites.

Other permissions:

- `sidePanel`: display the YouTube Digest interface beside the video page.
- `storage`: store settings, keys, notes, and cached results locally.
- `tabs`: identify and interact with the active YouTube or Bilibili tab.
- `scripting`: read the video page's own player data (caption tracks / subtitle list) and coordinate page controls.

## Local storage and retention

YouTube Digest uses Chrome's local extension storage, not a YouTube Digest cloud service.

- AI settings (base URL, model, API key) remain on the device in Chrome's extension storage.
- Saved notes remain until you delete them or remove/clear the extension's data. The extension keeps up to 100 notes.
- Recent transcript, digest, and per-segment translation cache entries are stored locally. The cache is limited to 20 videos, and entries older than 30 days are removed when the side panel opens.

Chrome extension storage is not a password vault. Anyone with sufficient access to your browser profile or device may be able to recover locally stored keys or content. Use scoped keys where providers support them, set spending limits, and rotate or revoke a key if the device or browser profile is compromised.

To remove data:

- delete individual saved notes in YouTube Digest;
- use the Options page to clear cached digests, delete all notes, or reset all extension data;
- remove the extension or clear its stored data from Chrome to delete all local settings, keys, notes, and cache entries; and
- revoke the API key in your provider's console to stop its future use.

Clearing local data does not delete information already processed or retained by the video platforms or your AI provider. Use each service's controls for service-side requests.

## No sale or advertising use

YouTube Digest does not sell personal information, build advertising profiles, or share data with data brokers. It does not include analytics SDKs.

## Changes

Privacy-relevant changes will be documented in this file and in the repository history. Review updates before installing a new version.

## Questions

This repository does not provide a public support or issue channel. Review this policy, the source code, and each provider's documentation before using the extension. For a vulnerability or accidental secret exposure, follow the private process in [SECURITY.md](SECURITY.md).
