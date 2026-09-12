# Youtube Bilibili Digest

[English](README.md) | [简体中文](README.zh-CN.md) · Current version: **17.0.0**

Turn every YouTube and Bilibili video into a resource for deep learning. Transcripts, bilingual translation, AI overviews, explanations, and timestamped notes — all in one Chrome side panel, so you can study ideas and language without losing your place.

A bring-your-own-endpoint project installed locally from GitHub. Not on the Chrome Web Store, and no developer-operated server.

> Full documentation: [README.html](README.html) (English) · [README.zh-CN.html](README.zh-CN.html) (中文) · [PRIVACY.html](PRIVACY.html) · [SECURITY.md](SECURITY.md)

## Features

- **Transcripts** in the original language, Simplified Chinese, or an aligned bilingual view — copy them, or export the mode you are viewing to `Transcript_{title}_原文.txt` / `_中文.txt` / `_双语.txt`.
- **AI overview** with chapters and key quotes, plus its own Original / 中文 / 双语 switch. The Original overview follows the language actually spoken in each part of the video: every chapter is written in the language spoken during that chapter's time range, so a video that switches language mid-way (for example a Chinese intro and an English interview) gets chapters in each part's language. The 中文 view translates only the non-Chinese chapters, keeping Chinese chapters verbatim at no cost, and the bilingual view is offered only when the overview is not entirely Chinese, skipping the duplicate line for chapters already in Chinese. After you adopt a foreign original transcript for an ai-zh video, the old overview is discarded and rebuilt from the new transcript the next time you open the Overview tab. Overview translation runs in batches, and any chapter it cannot translate is marked as untranslated rather than silently showing the source language.
- **Selected-text explanations** for any passage in the transcript.
- **Timestamped notes** with automatic polishing, filtered by This Video or All Notes; press `n` on the video page to save one.
- **Word export** (`.doc` / `.docx`) combining a video info header, the transcript, the AI overview, and your notes — in original, Chinese, or aligned bilingual modes.
- **AI subtitle generation (ASR)** for videos with no native captions, off by default.
- **Punctuation repair** for transcripts that arrive unpunctuated.
- **Follow playback** auto-scrolling, and click-to-seek timestamps everywhere.
- No analytics, no telemetry, no account system. Keys stay in local Chrome storage.

## Install

1. Clone or download this repository into a permanent folder.
2. Open `chrome://extensions` and turn on **Developer mode**.
3. Click **Load unpacked** and select the folder containing `manifest.json`.
4. Open **Settings** from the side panel and enter your API base URL, API key, and model.

Keep the folder where it is — moving or deleting it breaks the unpacked extension until you load it again. After any update, click **Reload** on the extension card and refresh open video tabs.

Requires Chrome 116 or newer (Side Panel API). Standard `youtube.com/watch` and `bilibili.com/video` pages only; Shorts, live streams, and private or restricted videos may not work.

## Configure

The Settings page is arranged as cards, and its own interface switches between English and 中文:

| Card | Purpose |
|---|---|
| **Transcript provider** | Holds the Supadata API key for YouTube captions and the **Enable Bilibili mode** toggle (Bilibili captions come from the platform itself, no key) |
| **AI provider** | Base URL, API key, model name |
| **AI subtitle generation (ASR)** | Optional transcription fallback, off by default |
| **Local data** | Clear cached digests, delete all notes, or reset everything |
| **Local remix** | Collapsed card with an editable prompt for non-OpenAI-compatible providers |

Defaults point at Alibaba Cloud DashScope (Qwen):

```
base URL  https://dashscope.aliyuncs.com/compatible-mode/v1
model     qwen-plus
```

Any OpenAI-compatible Chat Completions endpoint works. For Bilibili, sign in to `bilibili.com` in the same browser first — subtitles and stream addresses are only returned to logged-in accounts.

> Never paste an API key into a chat, issue, screenshot, or source file. Enter it only in the extension's Settings page.

## AI subtitle generation (ASR)

When a video has no native captions, enable the ASR card in Settings and the side panel offers a **Generate AI Subtitles** button. Audio is downloaded from the platform's own media CDN, resampled in your browser, and sent in chunks to the ASR endpoint you configured. The result flows through the same translation, overview, notes, and export pipeline.

Two request protocols are supported: the DashScope/Qwen audio conversation protocol (`chat/completions`, default, model `qwen3-asr-flash`) and the OpenAI/Groq-compatible Whisper `multipart` protocol (`/audio/transcriptions`). Timestamps from the default protocol are estimated; the Whisper protocol returns the model's own when the endpoint supports them.

Nothing is sent anywhere until you opt in. The original-language transcript is transcribed from the video's own audio, never back-translated from Chinese subtitles.

### Limits that report themselves

- Videos longer than **4 hours** are refused for ASR.
- Audio is resampled to **16 kHz** mono in chunks of up to **180 seconds**, at most **4 in flight**, with a **240-second** per-request timeout.
- Chat-style AI requests abort after **50 seconds** idle or **120 seconds** total; responses over **2 MiB** are rejected.
- Word export uses a more generous budget: **120 s** idle, **300 s** hard, **3** parallel workers, ~**7000**-character chunks.
- Export-time segment translation (a plain-text transcript exported in 中文 or 双语 mode, the bilingual Word document, and note translation) runs in batches of ~**1800 characters**, up to **5 in flight**, retrying a rate-limited or failed batch up to **3 times** with exponential backoff and honouring `Retry-After`. Authentication errors are not retried, and a batch that still fails leaves those segments untranslated instead of aborting the export. The side panel's live 中文 / 双语 view uses a separate viewport-driven path and is unaffected.

### Bilibili videos with only Chinese AI subtitles

Bilibili often publishes a single machine-generated Chinese track (`ai-zh`) for a video whose audio is another language. If the video also offers a free original-language track, the extension re-requests and adopts it automatically — a platform track costs nothing. If it does not, a notice appears above the transcript with a **转写原文** button; ASR is billed by audio duration, so it never runs on its own. A video detected as genuinely Chinese is told so instead of being transcribed, with a **仍然转写** override for Chinese-titled foreign videos (detection reads the title's script).

After an original is adopted: **Original** shows it, **中文** shows the platform's `ai-zh` track verbatim for free, and **双语** pairs the original with a fresh translation — the only mode that spends tokens, and only when opened. Both transcripts are cached per video.

### Troubleshooting

- **Cannot reach the video page** — the extension could not talk to the tab's content script. Refresh the video tab; the extension also re-injects its content script and retries once on its own. This error state deliberately does not offer ASR, since ASR needs the same unreachable page state.
- **Subtitle or audio requests come back empty** — play the video for a few seconds and retry: YouTube may not expose subtitle downloads or audio stream addresses before playback starts. If it persists, refresh the tab; each subtitle request's HTTP status and body size is logged to the service-worker console.

## Privacy in one paragraph

Requests go directly from the extension to the video platform or to the endpoint you configured. The developer does not proxy or receive them. Host access (`https://*/*`) is used only to reach your AI endpoint, your ASR endpoint, the Supadata API for YouTube captions, Bilibili's caption and player APIs, and — when ASR is enabled — the platforms' own media CDNs (`googlevideo.com`, `bilivideo`). Settings, keys, notes, and cache live in local Chrome storage: notes cap at 100, the cache at 20 videos with a 30-day expiry. No audio is ever written to storage. Exporting a plain-text transcript in 中文 or 双语 mode — or generating a Word document — sends the whole transcript to your AI endpoint for translation in one pass, not just the rows you scrolled past; already-translated segments are reused from the local cache. Full details in [PRIVACY.html](PRIVACY.html).

## A note on internal naming

Identifiers in the source keep the upstream `YTD_` / `ytd_` prefix (`YTD_SETTINGS`, `ytd_notes`, and similar). `YTD` is short for *YouTube Digest*, the name of the original project this one is derived from (by ZaraZhang); later features followed the same convention. These prefixes are internal only — renaming them would mean touching dozens of call sites, and a missed one fails silently. Everything user-facing says **Youtube Bilibili Digest**.

## Verifying changes

There is no build step, no package manager, and no test suite — the files in this repository are exactly what Chrome loads, so verification is manual:

1. Reload the unpacked extension and confirm the service worker registers with no errors.
2. Check the console on the side panel, the options page, and a video page.
3. Confirm `manifest.json` still parses as valid JSON.
4. Run one real YouTube video and one real Bilibili video end to end: transcript, translation, overview, a note, and a Word export.
5. If you touched the ASR path, also test a video with no native subtitles.
6. After editing JavaScript that contains Chinese text, search for stray curly quotes (`“ ” ‘ ’`) — one smart quote replacing a string delimiter breaks the service worker without an obvious error.

## Remix it

This is a personal remix project; upstream issues and pull requests are not accepted. Fork your own copy and make it yours. Plain HTML, CSS, and JavaScript, no build step. Preserve the bring-your-own-key model and keep secrets out of source files.

## Credits

Derivative of **Zara Zhang**'s original YouTube Digest project, maintained by **@StaffBao** on GitHub. Added here: Bilibili support, YouTube transcripts via Supadata (your own key) and Bilibili captions read directly from the platform, bring-your-own-endpoint AI configuration, optional ASR subtitle generation, bilingual keynotes, and Word export.

## License

MIT — see [LICENSE.html](LICENSE.html). Copyright is held by Zara Zhang (the original work) and by StaffBao (this derivative).
