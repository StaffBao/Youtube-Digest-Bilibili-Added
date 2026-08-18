# YouTube Digest

[English](README.md) | [简体中文](README.zh-CN.md)

Turn every YouTube and Bilibili video into a resource for deep learning. YouTube Digest brings transcripts, bilingual translation, AI overviews, explanations, and timestamped notes into one Chrome side panel, so you can study ideas and language without losing your place.

- Turn captions into a readable, searchable learning resource.
- Learn languages with the original transcript, a Simplified Chinese translation, or an aligned bilingual view.
- Build understanding with an AI overview, chapters, key quotes, and selected-text explanations.
- Navigate long videos by clicking timestamps in the transcript, overview, or notes.
- Save polished timestamped notes for later study.
- Keep control of your data with your own AI endpoint, local Chrome storage, and no analytics or telemetry.

YouTube Digest is a bring-your-own-endpoint project installed locally from GitHub. It is not available through the Chrome Web Store and does not run a developer-operated server.

## Install with your coding agent

You do not need to understand the code or use the command line. Send this message to your coding agent:

> Download or clone this project into a permanent folder I choose, tell me its exact full path, and use that same folder for Chrome's Load unpacked step. If I need a suggestion during this first installation, offer `~/Documents/youtube-digest` on macOS or Linux, or `%USERPROFILE%\Documents\youtube-digest` on Windows, but do not assume either path. Walk me through installation and setup in simple terms.

Your agent should:

1. Ask where you want to keep the project, download or clone it there, and tell you the exact full path.
2. Walk you through selecting the exact project folder you chose in Chrome with **Load unpacked**.
3. Show you where to enter the API base URL, API key, and model name in the extension's **Settings** page.
4. Open a YouTube or Bilibili video with captions and confirm the transcript and translation work.

Keep this folder in the same place after installation. Moving or deleting the source folder breaks the unpacked extension until you load it again from the new location.

Never paste an API key into an AI chat, source file, screenshot, or public message. Enter keys yourself, directly in the YouTube Digest Settings page. Your coding agent can point to the correct field without seeing the key.

## Install manually

If you prefer to do it yourself:

1. Choose a permanent folder and unzip or clone the project there. Optional suggestions are `~/Documents/youtube-digest` on macOS or Linux, or `%USERPROFILE%\Documents\youtube-digest` on Windows. You may use a different folder.
2. In Chrome, open `chrome://extensions`.
3. Turn on **Developer mode**.
4. Click **Load unpacked**.
5. Select the exact project folder you chose, which must contain `manifest.json`.
6. Pin YouTube Digest from Chrome's Extensions menu if you want quick access.

Because this is an unpacked extension, it does not update automatically. After downloading an update or changing local files, click **Reload** on the YouTube Digest card at `chrome://extensions`, then refresh open video tabs. Moving or deleting the source folder breaks the unpacked extension until you load it again from the new location.

## Set up your AI endpoint

YouTube Digest needs no transcript API key. Captions are read directly from the video page: YouTube caption tracks are downloaded from YouTube itself, and Bilibili subtitles are fetched with your browser's own Bilibili login. Nothing to sign up for, no credits, no third-party transcript service.

For AI features (overviews, explanations, translation, note polishing), configure any OpenAI-compatible Chat Completions endpoint in Settings:

1. **API base URL**: the Chat Completions base URL of your provider. The default is Alibaba Cloud DashScope (Qwen):

   ```text
   https://dashscope.aliyuncs.com/compatible-mode/v1
   ```

2. **API key**: the key issued by your provider. For DashScope, create one in the Bailian console and paste it into Settings.
3. **Model**: the model name your endpoint accepts, for example `qwen-plus` (the default), `qwen-max`, `deepseek-chat`, or `gpt-4o-mini`.

Open **Settings** from the side panel. You can also open the YouTube Digest **Options** page from its card at `chrome://extensions` or by right-clicking its toolbar icon. Paste the key only into the Settings field. Never paste a key into an AI chat, repository file, screenshot, or public message.

YouTube Digest sends every AI request in non-thinking mode where the gateway supports it, for responsive, predictable interactions. Keys and settings are stored in Chrome's local extension storage on your device. Release builds do not include or use `config.js`.

## Enable Bilibili mode

Bilibili support is on by default and can be toggled in Settings:

1. Sign in to `bilibili.com` in the same browser first. Bilibili only returns subtitles to logged-in accounts.
2. Open a `bilibili.com/video/...` watch page. The Digest button and side panel work the same way as on YouTube.
3. If a video has no subtitles or you are not logged in, the panel explains that instead of failing silently.

## Use YouTube Digest

1. Open a standard YouTube watch page with captions, or a Bilibili video page while signed in.
2. Click the YouTube Digest extension icon to open the side panel.
3. Read the timestamped transcript, or choose **Original**, **中文**, or **双语**.
4. Open **Overview** when you want AI-generated chapters and key quotes.
5. Select transcript text when you want an AI explanation.
6. Save a note from the player or a key quote, then revisit it from **Notes**.

## What works today

- Google Chrome 116 or newer, using the Side Panel API.
- Standard `youtube.com/watch` video pages and `bilibili.com/video` pages.
- Native subtitle tracks read directly from each platform. YouTube Digest prefers human-authored tracks and Chinese or English when available, and may show another native language.
- Original, Simplified Chinese, and aligned bilingual transcript views.
- AI overviews, selected-text explanations, translation, and automatic note polishing through any OpenAI-compatible endpoint you configure.
- Local notes and a local cache for recent transcript and digest results.

Shorts, live streams, private or access-restricted videos, and videos without an available native transcript may not work. Firefox, Safari, mobile browsers, and other Chromium browsers are not currently tested or supported.

YouTube Digest does not request AI-generated transcripts and does not perform local audio transcription when native captions are unavailable.

## AI usage costs

Transcript retrieval is free: it uses each platform's own caption endpoints. AI usage is billed by whichever OpenAI-compatible provider you configure. Costs depend on your provider's pricing, your chosen model, and how much you use overviews, explanations, translation, and note polishing. Translation is lazy and progressive: cached segments are reused, and only rows you scroll into view incur requests. Set spending limits in your provider account.

## Remix it with your coding agent

This is a personal remix project. Upstream issues and pull requests are not accepted. If something breaks or you want a new feature, download or fork your own copy and ask your coding agent to fix, remix, or personalize it for you.

YouTube Digest uses plain HTML, CSS, and JavaScript with no build step, so it is a friendly starting point for agent-assisted projects. Ideas to try:

- Add more translation languages and let each person choose a learning language.
- Create customized summary templates for lectures, interviews, tutorials, reviews, or research talks.
- Build a vocabulary notebook that saves a word, its sentence, meaning, and video timestamp.
- Export notes and vocabulary to Markdown, CSV, Anki, or another study tool.
- Add personal topic filters that highlight the chapters most relevant to a goal.
- Add optional local-model support for a different privacy and cost tradeoff.
- Improve accessibility with keyboard navigation, font controls, and higher-contrast themes.

Ask your agent to preserve the bring-your-own-key model, keep secrets out of source files, run the checks below, and test the remix on real videos.

If you need a provider that does not follow the OpenAI Chat Completions API, first open the exact YouTube Digest project folder that Chrome loaded through **Load unpacked** in your coding agent. Then open YouTube Digest Settings and use **Copy customization prompt**. Replace the `[PROVIDER]` placeholder before sending it. Do not include any API key in the prompt or chat. After the agent updates your local copy, enter the key yourself in the Settings field it identifies.

## Privacy and data flow

YouTube Digest makes provider requests directly from the extension:

1. It downloads captions from YouTube's own timedtext endpoints, or from Bilibili's subtitle API using your browser's login cookies.
2. It sends the transcript and relevant video metadata to the AI endpoint you configured when you request AI features.
3. Focused features send only the content they need, such as selected text with context or small transcript batches for translation.
4. It stores keys, settings, notes, and recent cache entries locally in Chrome.

There is no YouTube Digest account system, advertising, analytics, or telemetry. Your configured AI provider still receives data under its own terms and privacy policy. See [PRIVACY.md](PRIVACY.md) for details.

## Troubleshooting

### The Digest button is missing on a YouTube video

- At `chrome://extensions`, find YouTube Digest and click **Reload**, then refresh the YouTube tab.
- Confirm that you are on a standard `https://www.youtube.com/watch?...` page, not a Short, embed, or live page.
- The current version automatically follows YouTube when its responsive action bar changes. Wait a moment after the page finishes loading.
- If it is still missing, ask your coding agent to inspect the content script on that exact video page.

### The side panel does not open

- Confirm that you are on a standard `https://www.youtube.com/watch?...` page or a `https://www.bilibili.com/video/...` page.
- At `chrome://extensions`, confirm YouTube Digest is enabled and click **Reload**.
- Refresh the video tab after reloading the extension.
- Ask your coding agent to inspect the extension if the problem continues.

### YouTube Digest asks for setup

- Open **Settings** and save an API base URL, API key, and model. The defaults point at Alibaba Cloud DashScope with `qwen-plus`; you only need to paste your key if you use DashScope.
- If Settings says a legacy custom provider was removed, enter the three fields again. The old AI key was cleared so it could not be reused with the wrong service.

### No transcript is found

- Confirm the video is public and has native captions.
- YouTube videos without captions cannot produce a transcript. YouTube Digest will not fall back to generated transcription.
- For Bilibili, confirm you are signed in to `bilibili.com` in the same browser; subtitles are only returned for logged-in accounts, and many videos simply have no subtitles.

### AI requests fail

- A `401` or `403` usually means the API key is invalid for the configured base URL.
- A `404` usually means the base URL or model name is wrong for your provider.
- A `429` usually means a rate or spending limit was reached.
- If you adapted a local copy for a non-compatible model, use the Settings customization prompt again and ask your coding agent to inspect that local implementation.

Never share API keys, private transcripts, or personal notes in chats, screenshots, or logs.

## Checks for coding agents

Ask your coding agent to run these commands after changing the project:

```bash
npm test
npm run check
npm run package
```

The agent should also reload the unpacked extension in Chrome and test several real YouTube and Bilibili videos. Automated checks do not prove that live provider requests and platform interactions work.

## License

MIT. See [LICENSE](LICENSE).
