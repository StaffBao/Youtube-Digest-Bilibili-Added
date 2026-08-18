/**
 * BACKGROUND SERVICE WORKER
 *
 * This is the "brain" of the extension. It runs in the background and handles:
 * 1. Opening the side panel when the user clicks the extension icon
 * 2. Fetching transcripts directly from the video platform (YouTube caption
 *    tracks or Bilibili's official subtitle API via the browser's own login
 *    state) — no third-party transcript service required
 * 3. Calling the user-configured OpenAI-compatible AI provider (default
 *    Alibaba DashScope / Qwen) to analyze the transcript
 * 4. Sending results back to the side panel
 *
 * Think of it like a backend server — it does the heavy lifting
 * so the UI (side panel) can stay fast and responsive.
 */

// Import safe defaults and validation helpers. Secret keys live in
// chrome.storage.local and are never part of the extension source.
importScripts("settings.js");

const DEBUG = false;
const AI_PROVIDER_IDLE_TIMEOUT_MS = 50_000;
const AI_PROVIDER_HARD_TIMEOUT_MS = 120_000;
const AI_PROVIDER_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const debugLog = (...args) => {
  if (DEBUG) console.log(...args);
};

// Storage access hardening.
//
// setAccessLevel() exists ONLY on chrome.storage.session — it controls
// whether content scripts may read the session area. It has never existed on
// chrome.storage.local, so the previous call
//   chrome.storage.local.setAccessLevel(...)
// threw "chrome.storage.local.setAccessLevel is not a function" at the top of
// this service worker and aborted registration (Chrome status code 15).
//
// Note: API keys and cached digests live in chrome.storage.local, which stays
// readable by this extension's content scripts — the storage API offers no way
// to restrict the local area. The session area already defaults to
// TRUSTED_CONTEXTS; we set it explicitly (with a guard) for defense in depth.
if (chrome.storage.session && chrome.storage.session.setAccessLevel) {
  chrome.storage.session
    .setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" })
    .catch((error) =>
      console.warn("[YouTube Digest] Could not restrict storage access:", error),
    );
}

async function getSettings() {
  const stored = await chrome.storage.local.get(YTD_SETTINGS.STORAGE_KEY);
  return YTD_SETTINGS.normalize(stored[YTD_SETTINGS.STORAGE_KEY]);
}

function isSupportedTabUrl(url) {
  const value = String(url || "");
  return (
    value.startsWith("https://www.youtube.com") ||
    value.startsWith("https://www.bilibili.com")
  );
}

const promptFileCache = new Map();

async function loadPromptSection(fileName, heading, variables = {}) {
  let markdown = promptFileCache.get(fileName);
  if (!markdown) {
    const response = await fetch(chrome.runtime.getURL(`prompts/${fileName}`));
    if (!response.ok) {
      throw new Error(`Could not load prompt file: ${fileName}`);
    }
    markdown = await response.text();
    promptFileCache.set(fileName, markdown);
  }

  const marker = `## ${heading}`;
  const markerIndex = markdown.indexOf(marker);
  if (markerIndex === -1) {
    throw new Error(`Prompt section not found: ${fileName}#${heading}`);
  }
  const sectionStart = markerIndex + marker.length;
  const nextSection = markdown.indexOf("\n## ", sectionStart);
  const section = markdown.slice(
    sectionStart,
    nextSection === -1 ? markdown.length : nextSection,
  );
  const fenceMatch = section.match(/```(?:[A-Za-z0-9_-]+)?\n([\s\S]*?)\n```/);
  if (!fenceMatch) {
    throw new Error(`Prompt section not found: ${fileName}#${heading}`);
  }

  let prompt = fenceMatch[1];
  for (const [key, value] of Object.entries(variables)) {
    prompt = prompt.split(`{${key}}`).join(String(value ?? ""));
  }
  return prompt;
}

async function requestAiCompletion({
  messages,
  maxTokens,
  temperature,
  responseFormat,
}) {
  const settings = await getSettings();
  if (!settings.aiApiKey) {
    const error = new Error(
      "AI API key not configured. Open YouTube Digest Settings.",
    );
    error.code = "NO_AI_KEY";
    throw error;
  }
  const body = {
    model: settings.aiModel,
    max_tokens: maxTokens,
    messages,
  };
  if (typeof temperature === "number") body.temperature = temperature;
  if (responseFormat) {
    body.response_format = responseFormat;
  }
  // Product features need bounded, predictable latency rather than reasoning
  // traces. OpenAI-compatible gateways ignore unknown fields, so this stays
  // harmless for Qwen/DashScope and any other compatible provider.
  body.thinking = { type: "disabled" };

  const controller = new AbortController();
  let timeoutKind = "";
  let idleTimeoutId;
  let hardTimeoutId;
  const abortForTimeout = (kind) => {
    if (controller.signal.aborted) return;
    timeoutKind = kind;
    controller.abort();
  };
  const resetIdleTimeout = () => {
    clearTimeout(idleTimeoutId);
    idleTimeoutId = setTimeout(
      () => abortForTimeout("idle"),
      AI_PROVIDER_IDLE_TIMEOUT_MS,
    );
  };

  hardTimeoutId = setTimeout(
    () => abortForTimeout("hard"),
    AI_PROVIDER_HARD_TIMEOUT_MS,
  );
  resetIdleTimeout();
  try {
    const response = await fetch(
      YTD_SETTINGS.chatCompletionsUrl(settings.aiBaseUrl),
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${settings.aiApiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      },
    );
    // Receiving headers proves the provider is still making progress. Some
    // providers may then send blank-line body chunks while a non-streaming
    // request queues.
    resetIdleTimeout();

    const data = await readBoundedAiResponse(response, resetIdleTimeout);
    if (!response.ok) {
      const errorData = data && typeof data === "object" ? data : {};
      const error = new Error(
        errorData.error?.message ||
          errorData.message ||
          `AI provider error: ${response.status}`,
      );
      error.status = response.status;
      throw error;
    }

    const text = data.choices?.[0]?.message?.content;
    if (typeof text !== "string" || !text.trim()) {
      const error = new Error("The AI provider returned an empty response.");
      error.code = "EMPTY_AI_RESPONSE";
      throw error;
    }

    return { text, settings };
  } catch (error) {
    if (timeoutKind === "idle") {
      const timeoutError = new Error(
        "The AI request was inactive for 50 seconds. Please Retry.",
      );
      timeoutError.code = "AI_IDLE_TIMEOUT";
      throw timeoutError;
    }
    if (timeoutKind === "hard") {
      const timeoutError = new Error(
        "The AI request exceeded the 120-second limit. Please Retry.",
      );
      timeoutError.code = "AI_HARD_TIMEOUT";
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(idleTimeoutId);
    clearTimeout(hardTimeoutId);
  }
}

async function readBoundedAiResponse(response, onActivity) {
  const reader = response.body?.getReader?.();
  if (reader) {
    const decoder = new TextDecoder();
    let responseText = "";
    let responseBytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      // Every received chunk is activity, including blank-line keepalives.
      onActivity();
      const byteLength = value?.byteLength ?? 0;
      responseBytes += byteLength;
      if (responseBytes > AI_PROVIDER_MAX_RESPONSE_BYTES) {
        await reader.cancel?.().catch(() => {});
        const error = new Error("AI response exceeded the 2 MiB limit.");
        error.code = "AI_RESPONSE_TOO_LARGE";
        throw error;
      }
      responseText += decoder.decode(value, { stream: true });
    }
    responseText += decoder.decode();
    return JSON.parse(responseText.trimStart());
  }

  // Some fetch implementations do not expose a readable stream. Preserve a
  // bounded body read for that case.
  if (typeof response.text === "function") {
    const responseText = await response.text();
    onActivity();
    const byteLength = new TextEncoder().encode(responseText).byteLength;
    if (byteLength > AI_PROVIDER_MAX_RESPONSE_BYTES) {
      const error = new Error("AI response exceeded the 2 MiB limit.");
      error.code = "AI_RESPONSE_TOO_LARGE";
      throw error;
    }
    return JSON.parse(responseText.trimStart());
  }

  // Legacy/test fetch shims may expose only json(). The hard and idle timers
  // still bound this fallback even though chunk-level activity is unavailable.
  const data = await response.json();
  onActivity();
  return data;
}

// ============================================================
// SIDE PANEL SETUP
// ============================================================

/**
 * When the user clicks the extension icon, open the side panel.
 * Chrome's Side Panel API lets us show a persistent panel alongside the page.
 */
chrome.action.onClicked.addListener((tab) => {
  // Re-enable + open without awaiting — preserves user gesture context
  chrome.sidePanel.setOptions({
    tabId: tab.id,
    path: "sidepanel.html",
    enabled: true,
  });
  chrome.sidePanel.open({ tabId: tab.id });
});

/**
 * Allow the side panel to open on any page, but it's designed for video tabs.
 */
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === "install") chrome.runtime.openOptionsPage();
});

/**
 * Keep the side panel scoped to supported video tabs only (YouTube +
 * Bilibili).
 *
 * Chrome side panels are "global" by default: once opened, the panel follows
 * you to every tab. To make YouTube Digest behave like a video-only tool, we
 * enable the panel on supported tabs and disable it everywhere else. Disabling
 * on a tab makes Chrome hide/close the panel for that tab, so it never lingers
 * on a new tab or some other website.
 *
 * We have to react to BOTH things that can change "what tab you're looking at":
 *   - onUpdated: the current tab navigates to a new URL
 *   - onActivated: you switch to (or open) a different tab
 */
function updatePanelForTab(tabId, url) {
  const supported = isSupportedTabUrl(url);
  // setOptions can reject if the tab just closed — ignore that harmlessly.
  chrome.sidePanel
    .setOptions({ tabId, path: "sidepanel.html", enabled: supported })
    .catch(() => {});
}

// A tab navigated to a new URL.
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!changeInfo.url) return; // ignore title/favicon-only updates
  updatePanelForTab(tabId, changeInfo.url);
});

// The user switched to a different tab (or opened a new one).
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    updatePanelForTab(tabId, tab.url);
  } catch (e) {
    // Tab vanished before we could read it — nothing to do.
  }
});

// ============================================================
// MESSAGE HANDLING
// ============================================================

/**
 * Listen for messages from the side panel and content script.
 * This is like a switchboard — different "actions" trigger different handlers.
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // We need to return true to indicate we'll respond asynchronously
  if (message.action === "fetchTranscript") {
    handleFetchTranscript(
      message.platform === "bilibili" ? "bilibili" : "youtube",
      message.videoId,
      message.tabId,
    )
      .then(sendResponse)
      .catch((err) => sendResponse({ error: err.message }));
    return true; // Keep the message channel open for async response
  }

  if (message.action === "analyzeTranscript") {
    // Pass video duration to help the AI validate timestamps
    handleAnalyzeTranscript(
      message.transcriptText,
      message.videoTitle,
      message.channelName,
      message.videoDescription,
      message.videoDuration,
    )
      .then(sendResponse)
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }

  if (message.action === "explainSelection") {
    // Explain selected text using the configured AI provider.
    handleExplainSelection(
      message.selectedText,
      message.transcriptContext,
      message.videoTitle,
    )
      .then(sendResponse)
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }

  if (message.action === "saveNote") {
    // Save a note at the current timestamp
    handleSaveNote(
      message.videoId,
      message.timestamp,
      message.videoTitle,
      message.channelName,
      message.platform === "bilibili" ? "bilibili" : "youtube",
      message.tabId || sender?.tab?.id || null,
    )
      .then(sendResponse)
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.action === "getNotes") {
    // Get all saved notes
    handleGetNotes(message.videoId)
      .then(sendResponse)
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.action === "deleteNote") {
    // Delete a specific note
    handleDeleteNote(message.noteId)
      .then(sendResponse)
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.action === "getVideoInfo") {
    handleGetVideoInfo(message.tabId)
      .then(sendResponse)
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }

  // Translation: send content to the configured AI provider.
  if (message.action === "translateContent") {
    handleTranslateContent(
      message.content,
      message.contentType,
      message.targetLanguage,
      message.videoTitle,
    )
      .then(sendResponse)
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  // Overview translation: translate chapter titles/summaries and quotes.
  if (message.action === "translateOverview") {
    handleTranslateOverview(message.analysis, message.videoTitle)
      .then(sendResponse)
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.action === "formatTranscriptForDocs") {
    handleFormatTranscriptForDocs(message.transcriptText)
      .then(sendResponse)
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.action === "checkConfig") {
    getSettings()
      .then((settings) =>
        sendResponse({
          hasAiKey: !!settings.aiApiKey,
          bilibiliEnabled: !!settings.enableBilibili,
        }),
      )
      .catch((error) => sendResponse({ error: error.message }));
    return true;
  }

  if (message.action === "openOptions") {
    chrome.runtime.openOptionsPage();
    sendResponse({ success: true });
    return false;
  }

  if (message.action === "openFolder") {
    const folderPath = message.path;
    if (folderPath) {
      // Use chrome.tabs to open file explorer (works on Windows/Mac/Linux)
      const fileUrl = `file:///${folderPath.replace(/\\/g, "/")}`;
      chrome.tabs.create({ url: fileUrl });
      sendResponse({ success: true });
    } else {
      sendResponse({ success: false, error: "No path provided" });
    }
    return false;
  }

  if (message.action === "openSidePanel") {
    const tabId = sender.tab?.id;
    debugLog("[YouTube Digest BG] openSidePanel requested from tab:", tabId);

    // Re-enable the panel (it may have been disabled by auto-close) and open it.
    // IMPORTANT: we call setOptions + open synchronously (no await between them)
    // to preserve the user gesture context. Chrome requires sidePanel.open()
    // to be called within a user gesture — awaiting anything first can expire it.
    if (tabId) {
      chrome.sidePanel.setOptions({
        tabId,
        path: "sidepanel.html",
        enabled: true,
      });
      chrome.sidePanel
        .open({ tabId })
        .then(() => {
          // Broadcast to side panel to start digest (in case it's already open)
          setTimeout(() => {
            chrome.runtime
              .sendMessage({ action: "startDigestFromButton" })
              .catch(() => {});
          }, 300);
        })
        .catch((err) => {
          console.error("[YouTube Digest BG] openSidePanel error:", err);
        });
    } else {
      // Fallback: find the active tab
      chrome.tabs
        .query({ active: true, lastFocusedWindow: true })
        .then((tabs) => {
          if (tabs[0]) {
            chrome.sidePanel.setOptions({
              tabId: tabs[0].id,
              path: "sidepanel.html",
              enabled: true,
            });
            chrome.sidePanel.open({ tabId: tabs[0].id }).catch((err) => {
              console.error(
                "[YouTube Digest BG] openSidePanel fallback error:",
                err,
              );
            });
          }
        });
    }

    sendResponse({ success: true });
    return false;
  }

  // Relay messages from side panel to content script
  if (message.action === "relayToContent") {
    debugLog("[YouTube Digest BG] Relay request:", message.payload?.action);
    (async () => {
      try {
        // Query specifically for supported video tabs to avoid side panel
        // context issues. Try multiple query strategies to find the right tab.
        let tabs = await chrome.tabs.query({
          active: true,
          lastFocusedWindow: true,
        });
        if (!tabs[0] || !isSupportedTabUrl(tabs[0].url)) {
          tabs = [];
        }
        debugLog(
          "[YouTube Digest BG] Active tab in last focused window:",
          tabs.length,
          tabs[0]?.url,
        );

        // If no supported tab found, try any active supported tab
        if (!tabs[0]) {
          const youtubeTabs = await chrome.tabs.query({
            url: "https://www.youtube.com/*",
            active: true,
          });
          const bilibiliTabs = await chrome.tabs.query({
            url: "https://www.bilibili.com/video/*",
            active: true,
          });
          tabs = youtubeTabs.length ? youtubeTabs : bilibiliTabs;
          debugLog("[YouTube Digest BG] Active video tabs:", tabs.length);
        }

        // Still nothing? Try any supported tab
        if (!tabs[0]) {
          const youtubeTabs = await chrome.tabs.query({
            url: "https://www.youtube.com/*",
          });
          const bilibiliTabs = await chrome.tabs.query({
            url: "https://www.bilibili.com/video/*",
          });
          tabs = youtubeTabs.length ? youtubeTabs : bilibiliTabs;
          debugLog("[YouTube Digest BG] Any video tabs:", tabs.length);
        }

        if (tabs[0]) {
          debugLog(
            "[YouTube Digest BG] Sending to tab:",
            tabs[0].id,
            "URL:",
            tabs[0].url,
          );
          let response = await chrome.tabs.sendMessage(
            tabs[0].id,
            message.payload,
          );

          // For getVideoInfo, PREFER YouTube's own player data over the
          // DOM scrape. The player's videoDetails is canonical: its `author`
          // is always THIS video's channel and its `shortDescription` is the
          // full text. The DOM scrape is unreliable — e.g. on a playlist page
          // it grabbed the playlist owner's name ("Zara Zhang") instead of the
          // real channel ("Replit and Stripe"), and its description is
          // truncated while the box is collapsed. We fall back to the DOM
          // only for fields the player didn't provide. This player shortcut
          // is YouTube-only; Bilibili info comes from its content script.
          if (
            message.payload?.action === "getVideoInfo" &&
            String(tabs[0].url || "").startsWith("https://www.youtube.com")
          ) {
            const playerInfo = await getPlayerVideoDetails(tabs[0].id);
            if (playerInfo) {
              response = {
                title: playerInfo.title || response?.title || "",
                channelName:
                  playerInfo.channelName || response?.channelName || "",
                duration: playerInfo.duration || response?.duration || 0,
                description:
                  playerInfo.description || response?.description || "",
              };
            }
          }

          debugLog("[YouTube Digest BG] Got response from content:", response);
          sendResponse({ success: true, response });
        } else {
          debugLog("[YouTube Digest BG] No video tab found");
          sendResponse({ success: false, error: "No video tab found" });
        }
      } catch (err) {
        console.error("[YouTube Digest BG] Relay error:", err.message);
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true; // Keep channel open for async response
  }
});

/**
 * Reads the current video's full details straight from YouTube's player.
 *
 * Content scripts live in an isolated world and can't touch the page's own
 * JavaScript. But with the "scripting" permission we can run a tiny function
 * in the page's MAIN world, where YouTube's player object lives. Its
 * getPlayerResponse() carries videoDetails with the FULL description —
 * unlike the DOM, which truncates it until the user clicks "...more".
 *
 * Returns null on any failure so callers can fall back to DOM scraping.
 */
async function getPlayerVideoDetails(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: () => {
        try {
          const player = document.getElementById("movie_player");
          const details = player?.getPlayerResponse?.()?.videoDetails;
          if (!details) return null;
          return {
            title: details.title || "",
            channelName: details.author || "",
            description: details.shortDescription || "",
            duration: Number(details.lengthSeconds) || 0,
          };
        } catch (e) {
          return null;
        }
      },
    });
    return results?.[0]?.result || null;
  } catch (e) {
    console.warn("[YouTube Digest BG] Player details unavailable:", e.message);
    return null;
  }
}

// ============================================================
// TRANSCRIPT SHARED HELPERS
// ============================================================

/**
 * Builds the internal transcript representation shared by every platform
 * source: timestamped entries, plain display text, and [MM:SS] text for AI.
 */
function buildTranscriptResult(rawEntries, language) {
  const transcript = [];
  let transcriptTextPlain = "";
  let transcriptTextTimestamped = "";

  for (const chunk of rawEntries) {
    const cleanText = String(chunk.text || "")
      .replace(/>> ?/g, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!cleanText) continue;

    const startSeconds = Math.max(0, Math.floor(Number(chunk.offsetMs || 0) / 1000));
    const minutes = Math.floor(startSeconds / 60);
    const seconds = startSeconds % 60;
    const timestamp = `${minutes}:${String(seconds).padStart(2, "0")}`;

    transcript.push({
      text: cleanText,
      start: startSeconds,
      duration: Math.max(0, Math.floor(Number(chunk.durationMs || 0) / 1000)),
      language: language || null,
    });

    transcriptTextPlain += cleanText + " ";
    transcriptTextTimestamped += `[${timestamp}] ${cleanText}\n`;
  }

  if (transcript.length === 0) {
    return {
      success: false,
      error: "EMPTY_TRANSCRIPT",
      message: "The video has subtitles, but they contain no text.",
    };
  }

  return {
    success: true,
    transcript,
    transcriptText: transcriptTextPlain.trim(),
    transcriptTextTimestamped: transcriptTextTimestamped.trim(),
    language: typeof language === "string" && language ? language : null,
  };
}

function parseYouTubeJson3(data) {
  const events = Array.isArray(data?.events) ? data.events : [];
  const rawEntries = [];
  for (const event of events) {
    if (!Array.isArray(event.segs) || event.segs.length === 0) continue;
    const text = event.segs
      .map((segment) => segment.utf8 || "")
      .join("")
      .replace(/\n/g, " ");
    if (!text.trim()) continue;
    rawEntries.push({
      text,
      offsetMs: Number(event.tStartMs) || 0,
      durationMs: Number(event.dDurationMs) || 0,
    });
  }
  return rawEntries;
}

function parseYouTubeSrv3(xmlText) {
  const rawEntries = [];
  const pattern =
    /<text start="([0-9.]+)"(?:\s+dur="([0-9.]+)")?[^>]*>([\s\S]*?)<\/text>/g;
  let match;
  while ((match = pattern.exec(xmlText))) {
    const text = match[3]
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, "&")
      .replace(/<[^>]+>/g, " ");
    rawEntries.push({
      text,
      offsetMs: Math.round(parseFloat(match[1]) * 1000),
      durationMs: Math.round(parseFloat(match[2] || "0") * 1000),
    });
  }
  return rawEntries;
}

function scoreYouTubeTrack(track) {
  const language = String(track?.lang || "").toLowerCase();
  const isAuto = track?.kind === "asr";
  const isTranslated = language.includes("-orig") || track?.isTranslated;
  let score = 0;
  if (isAuto) score -= 4;
  if (isTranslated) score -= 6;
  if (language.startsWith("zh")) score += 3;
  else if (language.startsWith("en")) score += 2;
  // Tracks listed first are the video's primary language in YouTube data.
  score -= (Number(track?.index) || 0) * 0.01;
  return score;
}

function rebuildTimedtextUrl(baseUrl, track) {
  const url = new URL(baseUrl, "https://www.youtube.com");
  url.searchParams.delete("kind");
  url.searchParams.set("lang", track.lang || url.searchParams.get("lang") || "en");
  if (track.name) url.searchParams.set("name", track.name);
  url.searchParams.set("fmt", "json3");
  return url.toString();
}

function timedtextVariants(track) {
  const variants = [];
  if (track?.baseUrl) {
    try {
      const direct = new URL(track.baseUrl, "https://www.youtube.com");
      direct.searchParams.set("fmt", "json3");
      variants.push(direct.toString());
      direct.searchParams.set("fmt", "srv3");
      variants.push(direct.toString());
    } catch (_error) {
      // Fall through to the rebuilt URL below.
    }
  }
  if (track?.baseUrl) {
    try {
      variants.push(rebuildTimedtextUrl(track.baseUrl, track));
    } catch (_error) {
      // Ignore malformed track URLs.
    }
  }
  return variants;
}

// ============================================================
// TRANSCRIPT DISPATCH — YouTube and Bilibili, direct platform fetch
// ============================================================

/**
 * Dispatches a transcript request to the right platform fetcher.
 *
 * @param {string} platform - "youtube" or "bilibili"
 * @param {string} videoId - YouTube video ID or Bilibili BV id
 * @param {number} tabId - The tab showing the video page
 */
async function handleFetchTranscript(platform, videoId, tabId) {
  if (platform === "bilibili") {
    // Defense in depth: refuse Bilibili fetches when the mode is disabled.
    const settings = await getSettings();
    if (!settings.enableBilibili) {
      return {
        success: false,
        error: "Bilibili mode is disabled in YouTube Digest Settings.",
      };
    }
    return handleFetchBilibiliTranscript(videoId, tabId);
  }
  return handleFetchYouTubeTranscript(tabId);
}

/**
 * Reads the video page's own player data in the MAIN world to discover
 * subtitle sources. Content scripts live in an isolated world, so page
 * globals (ytInitialPlayerResponse / __INITIAL_STATE__) are only reachable
 * through chrome.scripting. Returns null on any failure.
 */
async function runMainWorldScript(tabId, func) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func,
    });
    return results?.[0]?.result ?? null;
  } catch (error) {
    debugLog("[YouTube Digest BG] MAIN world script failed:", error.message);
    return null;
  }
}

// ============================================================
// YOUTUBE TRANSCRIPTS — direct platform fetch (no Supadata)
// ============================================================

/**
 * Discovers the video's caption tracks from the YouTube player itself, then
 * downloads and parses the best track directly from YouTube's timedtext
 * endpoint. No third-party transcript service or extra account is needed.
 *
 * @param {number} tabId - The tab showing the YouTube video
 * @returns {Object} - { success, transcript, transcriptText, language } or { success: false, error }
 */
async function handleFetchYouTubeTranscript(tabId) {
  try {
    const pageTracks = tabId
      ? await runMainWorldScript(tabId, () => {
          try {
            const player = document.getElementById("movie_player");
            const response =
              window.ytInitialPlayerResponse ||
              player?.getPlayerResponse?.() ||
              null;
            const list =
              response?.captions?.playerCaptionsTracklistRenderer
                ?.captionTracks;
            if (!Array.isArray(list)) return [];
            return list
              .map((track) => ({
                lang: track.languageCode || track.vssId || "",
                kind: track.kind || "",
                name:
                  track.name?.simpleText ||
                  (Array.isArray(track.name?.runs)
                    ? track.name.runs.map((run) => run.text).join("")
                    : "") ||
                  "",
                baseUrl: track.baseUrl || "",
              }))
              .filter((track) => track.baseUrl);
          } catch (_error) {
            return [];
          }
        })
      : [];

    const tracks = Array.isArray(pageTracks) ? pageTracks : [];
    if (tracks.length === 0) {
      return {
        success: false,
        error: "NO_TRANSCRIPT",
        message:
          "No subtitle tracks found for this YouTube video. If subtitles exist, reopen the video page and try again.",
      };
    }

    const ordered = tracks
      .map((track, index) => ({ track, index }))
      .sort(
        (a, b) =>
          scoreYouTubeTrack({ ...b.track, index: b.index }) -
          scoreYouTubeTrack({ ...a.track, index: a.index }),
      );

    for (const { track, index } of ordered) {
      const variants = timedtextVariants({ ...track, index });
      for (const variant of variants) {
        try {
          const response = await fetch(variant, { credentials: "include" });
          if (!response.ok) continue;
          const contentType = String(
            response.headers.get("content-type") || "",
          );
          const body = await response.text();
          const rawEntries = contentType.includes("json")
            ? parseYouTubeJson3(JSON.parse(body))
            : parseYouTubeSrv3(body);
          if (rawEntries.length === 0) continue;
          const language = track.lang || track.langCode || null;
          return buildTranscriptResult(rawEntries, language);
        } catch (variantError) {
          debugLog(
            "[YouTube Digest BG] timedtext variant failed:",
            variantError.message,
          );
        }
      }
    }

    return {
      success: false,
      error: "NO_TRANSCRIPT",
      message:
        "Could not download subtitles from YouTube for this video. Reopen the video page and try again.",
    };
  } catch (error) {
    console.error("Transcript fetch error:", error);
    return {
      success: false,
      error: error.message || "Failed to fetch transcript",
    };
  }
}

// ============================================================
// BILIBILI TRANSCRIPTS — official subtitle API with login state
// ============================================================

function scoreBilibiliSubtitle(subtitle) {
  const lan = String(subtitle?.lan || "").toLowerCase();
  if (lan.startsWith("zh")) return 2;
  if (lan.startsWith("ai-zh")) return 1;
  if (lan.startsWith("en")) return 0;
  return -1;
}

function normalizeSubtitleUrl(url) {
  const value = String(url || "").trim();
  if (!value) return "";
  if (value.startsWith("//")) return `https:${value}`;
  return value;
}

async function fetchJson(url) {
  const response = await fetch(url, {
    credentials: "include",
    headers: { Referer: "https://www.bilibili.com/" },
  });
  if (!response.ok) {
    throw new Error(`Request failed with status ${response.status}`);
  }
  return response.json();
}

/**
 * Fetches a Bilibili transcript through Bilibili's own player/subtitle API.
 * The request runs with the browser's Bilibili login cookies, which Bilibili
 * requires for subtitle access. No third-party service is involved.
 *
 * @param {string} bvid - The BV id of the video
 * @param {number} tabId - The tab showing the video page
 */
async function handleFetchBilibiliTranscript(bvid, tabId) {
  try {
    const safeBvid = String(bvid || "").trim();
    if (!/^BV[0-9A-Za-z]{10}$/.test(safeBvid)) {
      return {
        success: false,
        error: "INVALID_BVID",
        message: "Invalid Bilibili video link.",
      };
    }

    // First try the video page's own player state — it already carries the
    // subtitle list for the exact part (cid) the viewer has open.
    const pageState = tabId
      ? await runMainWorldScript(tabId, () => {
          try {
            const initial =
              window.__INITIAL_STATE__ ||
              document.defaultView?.__INITIAL_STATE__ ||
              null;
            const videoData = initial?.videoData;
            const list = videoData?.subtitle?.subtitles;
            if (!Array.isArray(list)) return { subtitles: [], cid: "" };
            return {
              cid: String(videoData?.cid || ""),
              subtitles: list
                .map((item) => ({
                  lang: item?.lan || item?.lan_doc || "",
                  url: item?.subtitle_url || "",
                }))
                .filter((item) => item.url),
            };
          } catch (_error) {
            return { subtitles: [], cid: "" };
          }
        })
      : null;

    let subtitles = (pageState?.subtitles || [])
      .map((item) => ({
        lang: item.lang,
        url: normalizeSubtitleUrl(item.url),
      }))
      .filter((item) => item.url);
    let subtitleLanguage =
      subtitles.length === 1 ? subtitles[0].lang || null : null;

    if (subtitles.length === 0) {
      let resolvedCid = String(pageState?.cid || "").trim();
      if (!/^\d{1,20}$/.test(resolvedCid)) {
        const view = await fetchJson(
          `https://api.bilibili.com/x/player/pagelist?bvid=${encodeURIComponent(safeBvid)}`,
        );
        const firstPage = Array.isArray(view?.data) ? view.data[0] : null;
        resolvedCid = String(firstPage?.cid || "");
      }
      if (!resolvedCid) {
        return {
          success: false,
          error: "NO_TRANSCRIPT",
          message: "Could not resolve this Bilibili video.",
        };
      }

      const player = await fetchJson(
        `https://api.bilibili.com/x/player/wbi/v2?bvid=${encodeURIComponent(safeBvid)}&cid=${encodeURIComponent(resolvedCid)}`,
      );
      const listed = Array.isArray(player?.data?.subtitle?.subtitles)
        ? player.data.subtitle.subtitles
        : [];
      subtitles = listed
        .map((item) => ({
          lang: item?.lan || item?.lan_doc || "",
          url: normalizeSubtitleUrl(item?.subtitle_url),
        }))
        .filter((item) => item.url);
    }

    if (subtitles.length === 0) {
      return {
        success: false,
        error: "BILI_LOGIN_REQUIRED",
        message:
          "Bilibili subtitles require a logged-in Bilibili account in this browser. Log in on bilibili.com, reopen the video, and try again. If you are already logged in, this video may not have subtitles.",
      };
    }

    const ordered = [...subtitles].sort(
      (a, b) => scoreBilibiliSubtitle(b) - scoreBilibiliSubtitle(a),
    );

    for (const subtitle of ordered) {
      try {
        const data = await fetchJson(subtitle.url);
        const body = Array.isArray(data?.body) ? data.body : [];
        const rawEntries = body
          .filter((item) => item && typeof item.content === "string")
          .map((item) => ({
            text: item.content,
            offsetMs: Math.round((Number(item.from) || 0) * 1000),
            durationMs: Math.max(
              0,
              Math.round(((Number(item.to) || 0) - (Number(item.from) || 0)) * 1000),
            ),
          }));
        if (rawEntries.length === 0) continue;
        const language =
          subtitleLanguage || subtitle.lang || data?.lan || null;
        return buildTranscriptResult(rawEntries, language);
      } catch (subtitleError) {
        debugLog(
          "[YouTube Digest BG] Bilibili subtitle source failed:",
          subtitleError.message,
        );
      }
    }

    return {
      success: false,
      error: "NO_TRANSCRIPT",
      message: "Could not download subtitles for this Bilibili video.",
    };
  } catch (error) {
    console.error("Bilibili transcript error:", error);
    return {
      success: false,
      error: error.message || "Failed to fetch Bilibili transcript",
    };
  }
}

// ============================================================
// JSON HELPER
// ============================================================

/**
 * Parses JSON returned by an LLM, tolerating the small mistakes they sometimes
 * make. Some models occasionally emit a trailing
 * comma before a ] or }, or wraps the JSON in prose / code fences. Plain
 * JSON.parse throws on those, which is what caused the "Unexpected token ']'"
 * error on the Overview tab. This function strips fences, isolates the outer
 * JSON object, removes trailing commas, and only then parses.
 *
 * @param {string} text - The raw text from the model
 * @returns {Object} - The parsed object (throws if still unparseable)
 */
function parseLooseJson(text) {
  let cleaned = (text || "").trim();

  // Strip ```json ... ``` style code fences
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "");
  }

  // Isolate the outermost { ... } in case the model added a sentence around it
  const firstBrace = cleaned.indexOf("{");
  const lastBrace = cleaned.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    cleaned = cleaned.slice(firstBrace, lastBrace + 1);
  }

  try {
    return JSON.parse(cleaned);
  } catch (firstError) {
    // Most common LLM slip: a trailing comma right before a } or ].
    // e.g. ["a", "b", ]  ->  ["a", "b" ]
    const repaired = cleaned.replace(/,(\s*[}\]])/g, "$1");
    return JSON.parse(repaired);
  }
}

// ============================================================
// AI ANALYSIS
// ============================================================

/**
 * Sends the transcript to the configured AI provider for analysis.
 *
 * The prompt asks the model to produce chapters covering the whole video
 * and 3-5 key quotes with timestamps.
 *
 * @param {string} transcriptText - The full transcript as plain text
 * @param {string} videoTitle - The video title
 * @param {string} channelName - The channel name
 * @returns {Object} - { success, analysis } or { success: false, error }
 */
async function handleAnalyzeTranscript(
  transcriptText,
  videoTitle,
  channelName,
  videoDescription,
  videoDuration,
) {
  try {
    const settings = await getSettings();
    if (!settings.aiApiKey) {
      return {
        success: false,
        error: "NO_AI_KEY",
        message: "AI API key not configured. Open YouTube Digest Settings.",
      };
    }

    // Convert duration to MM:SS format for context
    // The transcript text is already prefixed with [M:SS] markers. Its LAST
    // marker is the most reliable signal of where the content actually ends —
    // more trustworthy than the duration metadata, which is sometimes missing
    // or wrong. We use the larger of (metadata duration, last transcript stamp).
    let lastTranscriptSeconds = 0;
    const stampMatches = transcriptText.match(/\[(\d+):(\d{2})\]/g) || [];
    if (stampMatches.length) {
      const last =
        stampMatches[stampMatches.length - 1].match(/\[(\d+):(\d{2})\]/);
      lastTranscriptSeconds = parseInt(last[1]) * 60 + parseInt(last[2]);
    }

    const effectiveSeconds = Math.max(
      Math.floor(videoDuration || 0),
      lastTranscriptSeconds,
    );
    const durationMinutes = Math.floor(effectiveSeconds / 60);
    const durationSeconds = Math.floor(effectiveSeconds % 60);
    const durationFormatted = `${durationMinutes}:${String(durationSeconds).padStart(2, "0")}`;
    const maxTimestampSeconds = effectiveSeconds;

    // The "last chapter must be after" threshold (75% in) forces the model to
    // cover the WHOLE video instead of front-loading chapters near the start.
    // We do NOT prescribe a chapter count — the model picks the natural splits.
    const lateThresholdSeconds = Math.floor(effectiveSeconds * 0.75);
    const lateThreshold = `${Math.floor(lateThresholdSeconds / 60)}:${String(
      lateThresholdSeconds % 60,
    ).padStart(2, "0")}`;

    const promptVariables = {
      durationFormatted,
      lateThreshold,
      maxTimestampSeconds,
      videoTitle: videoTitle || "Unknown",
      channelName: channelName || "Unknown",
      videoDescription: videoDescription || "No description available",
      transcriptText,
    };
    const systemPrompt = await loadPromptSection(
      "analysis.md",
      "System prompt",
      promptVariables,
    );
    const userPrompt = await loadPromptSection(
      "analysis.md",
      "User prompt",
      promptVariables,
    );

    debugLog("[YouTube Digest] Requesting video analysis", settings.aiModel);
    const { text: responseText } = await requestAiCompletion({
      maxTokens: 8192,
      responseFormat: { type: "json_object" },
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    });

    // Parse the JSON, tolerating trailing commas / stray prose
    let analysis = parseLooseJson(responseText);

    // Treat every model response as untrusted data. Rebuild the supported
    // schema and derive display timestamps from validated numeric seconds.
    analysis = validateAndFixTimestamps(analysis, maxTimestampSeconds);

    return {
      success: true,
      analysis: analysis,
    };
  } catch (error) {
    console.error("Analysis error:", error);
    if (error.status === 401) {
      return {
        success: false,
        error: "INVALID_AI_KEY",
        message: "The AI provider rejected the API key.",
      };
    }
    if (error.status === 429) {
      return {
        success: false,
        error: "RATE_LIMITED",
        message: "The AI provider rate-limited this request. Try again shortly.",
      };
    }
    return {
      success: false,
      error: error.message || "Failed to analyze transcript",
    };
  }
}

/**
 * Translates an Overview analysis (chapters + key quotes) into Simplified Chinese.
 * This is a single-shot translation — the entire analysis fits in one API call
 * because the data is small (typically < 2000 characters total).
 *
 * @param {Object} analysis - { chapters: [{title, summary}], keyQuotes: [{quote}] }
 * @param {string} videoTitle - Video title for translation context
 * @returns {Object} - { success, translatedAnalysis } or { success: false, error }
 */
async function handleTranslateOverview(analysis, videoTitle) {
  try {
    const settings = await getSettings();
    if (!settings.aiApiKey) {
      return {
        success: false,
        error: "NO_AI_KEY",
        message: "AI API key not configured. Open YouTube Digest Settings.",
      };
    }

    const chapters = Array.isArray(analysis?.chapters) ? analysis.chapters : [];
    const keyQuotes = Array.isArray(analysis?.keyQuotes) ? analysis.keyQuotes : [];

    if (!chapters.length && !keyQuotes.length) {
      return { success: true, translatedAnalysis: { chapters: [], keyQuotes: [] } };
    }

    const systemPrompt = [
      "You are a professional translator specializing in video content.",
      "Translate the following video analysis into Simplified Chinese (简体中文).",
      "",
      "TRANSLATION RULES:",
      "- Use natural, modern colloquial Simplified Chinese. Avoid stiff 书面语.",
      "- Do NOT translate: proper nouns, brand names, technical terms commonly kept in English (API, AI, etc.).",
      "- Keep common terms like AI, API, GitHub, Claude Code in English when that is the natural usage.",
      "- Put readable spaces between Chinese and adjacent English words or digits.",
      `- The video title is "${videoTitle || "Unknown"}" — use it as context for names and terminology.`,
      "",
      "Return a JSON object with exactly this shape:",
      '{"chapters":[{"title":"translated title","summary":"translated summary"}],"keyQuotes":[{"quote":"translated quote"}]}',
      "- The arrays must match the input lengths exactly, in the same order.",
      "- Output only valid JSON. No markdown fences, commentary, or extra keys.",
    ].join("\n");

    const userPrompt = JSON.stringify({
      chapters: chapters.map((ch) => ({
        title: ch.title || "",
        summary: ch.summary || "",
      })),
      keyQuotes: keyQuotes.map((q) => ({ quote: q.quote || "" })),
    });

    debugLog("[YouTube Digest] Translating overview", settings.aiModel);
    const { text: responseText } = await requestAiCompletion({
      maxTokens: 4096,
      responseFormat: { type: "json_object" },
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    });

    let parsed;
    try {
      parsed = JSON.parse(responseText);
    } catch {
      // Try stripping markdown fences
      const cleaned = responseText
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/```\s*$/, "")
        .trim();
      parsed = JSON.parse(cleaned);
    }

    const translatedChapters = Array.isArray(parsed?.chapters) ? parsed.chapters : [];
    const translatedQuotes = Array.isArray(parsed?.keyQuotes) ? parsed.keyQuotes : [];

    // Validate: output arrays must match input lengths
    if (translatedChapters.length !== chapters.length) {
      console.warn(
        `[YouTube Digest] Overview translation: expected ${chapters.length} chapters, got ${translatedChapters.length}`,
      );
    }
    if (translatedQuotes.length !== keyQuotes.length) {
      console.warn(
        `[YouTube Digest] Overview translation: expected ${keyQuotes.length} quotes, got ${translatedQuotes.length}`,
      );
    }

    return {
      success: true,
      translatedAnalysis: {
        chapters: chapters.map((_, i) => ({
          title: translatedChapters[i]?.title || chapters[i].title,
          summary: translatedChapters[i]?.summary || chapters[i].summary,
        })),
        keyQuotes: keyQuotes.map((_, i) => ({
          quote: translatedQuotes[i]?.quote || keyQuotes[i].quote,
        })),
      },
    };
  } catch (error) {
    console.error("Overview translation error:", error);
    if (error.status === 401) {
      return {
        success: false,
        error: "INVALID_AI_KEY",
        message: "The AI provider rejected the API key.",
      };
    }
    if (error.status === 429) {
      return {
        success: false,
        error: "RATE_LIMITED",
        message: "The AI provider rate-limited this request. Try again shortly.",
      };
    }
    return {
      success: false,
      error: error.message || "Failed to translate overview",
    };
  }
}

/**
 * Validates all timestamps in the analysis and fixes any that exceed video duration.
 * This is a safety net to prevent hallucinated timestamps from reaching the UI.
 *
 * @param {Object} analysis - The parsed analysis from the AI provider
 * @param {number} maxSeconds - Maximum valid timestamp in seconds
 * @returns {Object} - Analysis with validated timestamps
 */
function validateAndFixTimestamps(analysis, maxSeconds) {
  const safeMax =
    Number.isFinite(Number(maxSeconds)) && Number(maxSeconds) > 0
      ? Number(maxSeconds)
      : Number.MAX_SAFE_INTEGER;

  // Helper to format seconds as MM:SS
  const formatTimestamp = (seconds) => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${String(secs).padStart(2, "0")}`;
  };

  const safeString = (value, maxLength) =>
    typeof value === "string" ? value.trim().slice(0, maxLength) : "";
  const safeSeconds = (value) => {
    const seconds = Number(value);
    if (!Number.isFinite(seconds) || seconds < 0 || seconds > safeMax) {
      return null;
    }
    return Math.floor(seconds);
  };

  const chapters = (Array.isArray(analysis?.chapters) ? analysis.chapters : [])
    .slice(0, 100)
    .map((chapter) => {
      const seconds = safeSeconds(chapter?.timestampSeconds);
      const title = safeString(chapter?.title, 300);
      if (seconds === null || !title) return null;
      return {
        title,
        summary: safeString(chapter?.summary, 1500),
        timestampSeconds: seconds,
        timestamp: formatTimestamp(seconds),
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.timestampSeconds - b.timestampSeconds);

  const keyQuotes = (
    Array.isArray(analysis?.keyQuotes) ? analysis.keyQuotes : []
  )
    .slice(0, 50)
    .map((quote) => {
      const seconds = safeSeconds(quote?.timestampSeconds);
      const text = safeString(quote?.quote, 3000);
      if (seconds === null || !text) return null;
      return {
        quote: text,
        timestampSeconds: seconds,
        timestamp: formatTimestamp(seconds),
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.timestampSeconds - b.timestampSeconds);

  const keyMoments = (
    Array.isArray(analysis?.keyMoments) ? analysis.keyMoments : []
  )
    .map(safeSeconds)
    .filter((seconds) => seconds !== null)
    .slice(0, 100);

  return { chapters, keyQuotes, keyMoments };
}

// ============================================================
// VIDEO INFO EXTRACTION
// ============================================================

/**
 * Gets video info (title, channel, description) from the active video tab.
 * We do this by asking the content script to read the page.
 */
async function handleGetVideoInfo(tabId) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, {
      action: "getVideoInfo",
    });
    return response;
  } catch (error) {
    return { title: "", channelName: "", description: "" };
  }
}

// ============================================================
// NOTE MANAGEMENT
// ============================================================

/**
 * Saves a note at the current timestamp.
 * Fetches the transcript if needed, finds the relevant line, and cleans it up.
 */
async function handleSaveNote(
  videoId,
  timestamp,
  videoTitle,
  channelName,
  platform,
) {
  try {
    const videoPlatform = platform === "bilibili" ? "bilibili" : "youtube";
    const canonicalVideoUrl =
      videoPlatform === "bilibili"
        ? YTD_SETTINGS.canonicalBilibiliUrl(videoId)
        : YTD_SETTINGS.canonicalYouTubeUrl(videoId);
    const safeTimestamp = Math.max(0, Math.floor(Number(timestamp) || 0));

    // First, try to get the transcript from the digest cache. The side panel
    // saves digests to chrome.storage.LOCAL — this used to look in
    // storage.session (the wrong store), so it missed every time and
    // refetched the transcript on every saved note.
    let transcript = null;
    try {
      const cached = await chrome.storage.local.get(`digest_${videoId}`);
      if (cached[`digest_${videoId}`]?.transcript) {
        transcript = cached[`digest_${videoId}`].transcript;
        debugLog("[YouTube Digest] Using cached transcript for note");
      }
    } catch (e) {
      debugLog("[YouTube Digest] No cached transcript, fetching...");
    }

    if (!transcript) {
      // Without the page's player data we cannot re-fetch platform
      // subtitles from here. The digest cache is the source of truth for
      // note cleanup; if it is missing, we still save the raw timestamp.
      transcript = [];
    }

    // Find the transcript line at the current timestamp
    // Look for the line that contains this timestamp (or the closest one before)
    let matchedLine = null;
    let matchedIndex = 0;
    let contextLines = [];
    let beforeLine = null; // a few sentences before
    let afterLine = null; // a few sentences after

    for (let i = 0; i < transcript.length; i++) {
      const line = transcript[i];
      if (
        line.start <= safeTimestamp &&
        (!transcript[i + 1] || transcript[i + 1].start > safeTimestamp)
      ) {
        matchedLine = line;
        matchedIndex = i;

        // Build a buffer of 2 lines before and 4 lines after the target.
        // This gives the model enough text to find a natural sentence boundary
        // and complete a thought that spans multiple short caption chunks.
        const beforeLines = [];
        for (let j = 1; j <= 2 && i - j >= 0; j++) {
          beforeLines.unshift(transcript[i - j].text);
        }
        if (beforeLines.length > 0) {
          beforeLine = beforeLines.join(" ");
        }

        const afterLines = [];
        for (let j = 1; j <= 4 && i + j < transcript.length; j++) {
          afterLines.push(transcript[i + j].text);
        }
        if (afterLines.length > 0) {
          afterLine = afterLines.join(" ");
        }

        // Get broader context (8 lines before and 12 lines after) for understanding
        const startIdx = Math.max(0, i - 8);
        const endIdx = Math.min(transcript.length - 1, i + 12);
        for (let j = startIdx; j <= endIdx; j++) {
          contextLines.push(transcript[j].text);
        }
        break;
      }
    }

    if (!matchedLine && transcript.length > 0) {
      // Fallback: use the last line if timestamp is beyond transcript
      matchedLine = transcript[transcript.length - 1];
      matchedIndex = transcript.length - 1;

      // Get buffer sentence (only before, since we're at the end)
      const beforeLines = [];
      for (let j = 1; j <= 2 && matchedIndex - j >= 0; j++) {
        beforeLines.unshift(transcript[matchedIndex - j].text);
      }
      if (beforeLines.length > 0) {
        beforeLine = beforeLines.join(" ");
      }

      const startIdx = Math.max(0, matchedIndex - 8);
      for (let j = startIdx; j <= matchedIndex; j++) {
        contextLines.push(transcript[j].text);
      }
    }

    let cleanedText = matchedLine ? matchedLine.text : "";
    if (matchedLine) {
      // Clean up the text with the configured AI provider.
      cleanedText = await cleanupNoteText(
        matchedLine.text,
        beforeLine,
        afterLine,
        contextLines.join(" "),
        videoTitle,
      );
    }

    // Format timestamp as MM:SS
    const minutes = Math.floor(safeTimestamp / 60);
    const seconds = safeTimestamp % 60;
    const formattedTimestamp = `${minutes}:${String(seconds).padStart(2, "0")}`;

    // Create timestamped URL
    const timestampedUrl =
      videoPlatform === "bilibili"
        ? `${canonicalVideoUrl}?t=${safeTimestamp}`
        : `${canonicalVideoUrl}&t=${safeTimestamp}s`;

    // Create the note object
    const note = {
      id: `note_${Date.now()}`,
      videoId: videoId,
      platform: videoPlatform,
      videoTitle:
        typeof videoTitle === "string"
          ? videoTitle.slice(0, 500)
          : "Untitled Video",
      channelName:
        typeof channelName === "string" ? channelName.slice(0, 300) : "",
      timestamp: formattedTimestamp,
      timestampSeconds: safeTimestamp,
      timestampedUrl: timestampedUrl,
      text: cleanedText,
      rawText: matchedLine ? matchedLine.text : "",
      createdAt: Date.now(),
    };

    // Save to storage
    await saveNoteToStorage(note);

    // Notify side panel to refresh notes list
    chrome.runtime.sendMessage({ action: "noteSaved", note }).catch(() => {});

    return { success: true, note };
  } catch (error) {
    console.error("[YouTube Digest] Save note error:", error);
    return { success: false, error: error.message };
  }
}

/**
 * Cleans up transcript lines using the configured AI provider.
 * Takes the target line plus buffer sentences (1 before, 1 after).
 * Uses JSON output to prevent any preambles from appearing.
 */
async function cleanupNoteText(
  targetText,
  beforeText,
  afterText,
  fullContext,
  videoTitle,
) {
  const settings = await getSettings();
  if (!settings.aiApiKey) {
    return [beforeText, targetText, afterText].filter(Boolean).join(" ");
  }

  try {
    debugLog("[YouTube Digest] Requesting note cleanup");
    const variables = {
      videoTitle: videoTitle || "Unknown",
      fullContext,
      beforeText: beforeText || "(none)",
      targetText,
      afterText: afterText || "(none)",
    };
    const systemPrompt = await loadPromptSection(
      "note-cleanup.md",
      "System prompt",
      variables,
    );
    const userPrompt = await loadPromptSection(
      "note-cleanup.md",
      "User prompt",
      variables,
    );
    const { text: resultText } = await requestAiCompletion({
      maxTokens: 512,
      responseFormat: { type: "json_object" },
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    });

    let result = resultText.trim() || targetText;

    // Parse the JSON response (tolerating trailing commas / fences).
    try {
      const parsed = parseLooseJson(result);
      if (typeof parsed.quote === "string" && parsed.quote.trim()) {
        return parsed.quote.trim().slice(0, 3000);
      }
    } catch (parseError) {
      console.warn(
        "[YouTube Digest] JSON parse failed for note, stripping preambles:",
        parseError,
      );
      result = result.replace(
        /^(Here'?s?( the)?( cleaned)?( version)?:?\s*)/i,
        "",
      );
      result = result.replace(
        /^(The cleaned (quote|text|version)( is)?:?\s*)/i,
        "",
      );
      result = result.replace(/^(I will.*?:?\s*)/i, "");
      result = result.replace(/^(Cleaned:?\s*)/i, "");
      result = result.replace(/^["']|["']$/g, "");
    }

    return result.slice(0, 3000);
  } catch (e) {
    console.error("[YouTube Digest] Cleanup error:", e);
  }

  // Return combined raw text if cleanup fails
  return [beforeText, targetText, afterText].filter(Boolean).join(" ");
}

/**
 * Saves a note to chrome.storage.local
 */
async function saveNoteToStorage(note) {
  const result = await chrome.storage.local.get("ytd_notes");
  const notes = result.ytd_notes || [];
  notes.unshift(note); // Add to beginning (newest first)

  // Keep only last 100 notes to prevent storage bloat
  if (notes.length > 100) {
    notes.splice(100);
  }

  await chrome.storage.local.set({ ytd_notes: notes });
}

/**
 * Gets notes from storage, optionally filtered by video ID
 */
async function handleGetNotes(videoId) {
  try {
    const result = await chrome.storage.local.get("ytd_notes");
    let notes = result.ytd_notes || [];

    if (videoId) {
      notes = notes.filter((n) => n.videoId === videoId);
    }

    return { success: true, notes };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

/**
 * Deletes a note by ID
 */
async function handleDeleteNote(noteId) {
  try {
    const result = await chrome.storage.local.get("ytd_notes");
    let notes = result.ytd_notes || [];
    notes = notes.filter((n) => n.id !== noteId);
    await chrome.storage.local.set({ ytd_notes: notes });
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

async function handleExplainSelection(
  selectedText,
  transcriptContext,
  videoTitle,
) {
  try {
    const settings = await getSettings();
    if (!settings.aiApiKey) {
      return {
        success: false,
        error: "NO_AI_KEY",
        message: "AI API key not configured.",
      };
    }

    const variables = {
      videoTitle: videoTitle || "Unknown",
      selectedText,
      transcriptContext: transcriptContext || "None",
    };
    const systemPrompt = await loadPromptSection(
      "explain.md",
      "System prompt",
      variables,
    );
    const userPrompt = await loadPromptSection(
      "explain.md",
      "User prompt",
      variables,
    );

    debugLog("[YouTube Digest] Requesting selection explanation");
    const { text: explanation } = await requestAiCompletion({
      maxTokens: 1024,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    });

    return {
      success: true,
      explanation: explanation.trim(),
    };
  } catch (error) {
    console.error("Explain selection error:", error);
    return {
      success: false,
      error: error.message || "Failed to explain selection",
    };
  }
}

// ============================================================
// TRANSLATION — Translate transcript batches into Simplified Chinese
// ============================================================
// Uses a low temperature for consistent, natural translations.

/**
 * Shared base rules that every translation prompt includes.
 * These ensure translations sound natural rather than machine-translated.
 *
 * @param {string} targetLanguage - Must be 'zh'
 * @returns {Promise<string>} - The base translation rules
 */
async function getTranslationBaseRules(targetLanguage) {
  if (targetLanguage !== "zh") {
    throw new Error(`Unsupported translation target: ${targetLanguage}`);
  }
  const langName = "Simplified Chinese";
  const langSpecific = await loadPromptSection(
    "translation.md",
    "Chinese rules",
  );
  return loadPromptSection("translation.md", "Shared base rules", {
    langName,
    langSpecific,
  });
}

function validateTranscriptBatchRequest(content) {
  const segments = content?.segments;
  if (!Array.isArray(segments) || segments.length < 1 || segments.length > 4) {
    throw new Error("Transcript translation requires 1 to 4 segments");
  }

  const seenIds = new Set();
  let totalCharacters = 0;
  const normalized = segments.map((segment) => {
    const id = typeof segment?.id === "string" ? segment.id.trim() : "";
    const text = typeof segment?.text === "string" ? segment.text.trim() : "";
    if (!/^[A-Za-z0-9:_-]{1,128}$/.test(id) || seenIds.has(id)) {
      throw new Error("Transcript translation segment IDs must be unique and stable");
    }
    if (!text || text.length > 4000) {
      throw new Error("Transcript translation segment text is invalid or too long");
    }
    seenIds.add(id);
    totalCharacters += text.length;
    return { id, text };
  });
  if (totalCharacters > 12000) {
    throw new Error("Transcript translation batch is too large");
  }
  return normalized;
}

function looksLikeChineseTranslation(text, sourceText) {
  const latinLetters = (sourceText.match(/[A-Za-z]/g) || []).length;
  if (latinLetters < 20) return true;
  return /[\u3400-\u9fff]/.test(text);
}

/**
 * Aligns untrusted model output by exact stable ID. Missing, duplicated,
 * unknown, empty, or clearly non-Chinese values become explicit row errors.
 */
function normalizeTranslatedSegmentBatch(parsed, sourceSegments) {
  const candidates = Array.isArray(parsed?.segments) ? parsed.segments : [];
  const sourceById = new Map(sourceSegments.map((segment) => [segment.id, segment]));
  const translatedById = new Map();

  candidates.forEach((candidate) => {
    if (
      typeof candidate?.id !== "string" ||
      typeof candidate?.text !== "string" ||
      !sourceById.has(candidate.id) ||
      translatedById.has(candidate.id)
    ) {
      return;
    }
    const text = candidate.text.trim();
    const source = sourceById.get(candidate.id);
    if (text && looksLikeChineseTranslation(text, source.text)) {
      translatedById.set(candidate.id, text);
    }
  });

  return {
    segments: sourceSegments.map((source) => ({
      id: source.id,
      text: translatedById.get(source.id) || "",
      error: translatedById.has(source.id)
        ? ""
        : "Missing or invalid Chinese translation",
    })),
  };
}

/**
 * Translates content using the configured AI provider.
 * @param {Object} content - JSON object containing semantic transcript segments
 * @param {string} contentType - Must be 'transcriptBatch'
 * @param {string} targetLanguage - 'zh' for Simplified Chinese
 * @param {string} videoTitle - The video title (for context)
 * @returns {Object} - { success, translatedContent } or { success: false, error }
 */
async function handleTranslateContent(
  content,
  contentType,
  targetLanguage,
  videoTitle,
) {
  try {
    if (targetLanguage !== "zh") {
      return {
        success: false,
        error: `Unsupported translation target: ${String(targetLanguage)}`,
      };
    }
    if (contentType !== "transcriptBatch") {
      return {
        success: false,
        error: `Unsupported translation content type: ${String(contentType)}`,
      };
    }

    const settings = await getSettings();
    if (!settings.aiApiKey) {
      return { success: false, error: "AI API key not configured" };
    }

    const sourceSegments = validateTranscriptBatchRequest(content);
    const langName = "Simplified Chinese";
    const baseRules = await getTranslationBaseRules(targetLanguage);
    const systemPrompt = await loadPromptSection(
      "translation.md",
      "Transcript batch translation",
      {
        langName,
        videoTitle: videoTitle || "Unknown",
        baseRules,
      },
    );
    const userContent = JSON.stringify({ segments: sourceSegments });
    const translationOptions = {
      temperature: 0.2,
      maxTokens: 1536,
      responseFormat: { type: "json_object" },
    };
    let result = await callAiTranslation(
      systemPrompt,
      userContent,
      translationOptions,
    );

    // JSON mode can rarely return an empty content string. The prompt
    // already requires JSON, so retry once without response_format.
    if (!result.success && result.code === "EMPTY_AI_RESPONSE") {
      result = await callAiTranslation(systemPrompt, userContent, {
        temperature: translationOptions.temperature,
        maxTokens: translationOptions.maxTokens,
      });
    }
    if (!result.success) return result;

    const parsed = parseLooseJson(result.text);
    const aligned = normalizeTranslatedSegmentBatch(parsed, sourceSegments);
    if (!aligned.segments.some((segment) => segment.text)) {
      return {
        success: false,
        error: "Translation returned no valid Chinese segments",
      };
    }
    return { success: true, translatedContent: aligned };
  } catch (error) {
    console.error("[YouTube Digest] Translation error:", error);
    return { success: false, error: error.message || "Translation failed" };
  }
}

/**
 * Makes a single AI call for translation.
 * Uses temperature 0.3 for consistent, predictable translations.
 *
 * @param {string} systemPrompt - The system-level instructions
 * @param {string} userContent - The user message (content to translate)
 * @returns {Object} - { success, text } or { success: false, error }
 */
async function callAiTranslation(
  systemPrompt,
  userContent,
  { temperature = 0.3, maxTokens = 8192, responseFormat } = {},
) {
  try {
    const { text } = await requestAiCompletion({
      temperature,
      maxTokens,
      responseFormat,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userContent },
      ],
    });

    return { success: true, text };
  } catch (error) {
    if (error.status === 429) {
      return {
        success: false,
        error: "Rate limited — try again in a moment",
        code: "RATE_LIMITED",
      };
    }
    return { success: false, error: error.message, code: error.code };
  }
}

async function handleFormatTranscriptForDocs(transcriptText) {
  const settings = await getSettings();
  if (!settings.aiApiKey) {
    return {
      success: false,
      error: "NO_AI_KEY",
      message: "AI API key not configured. Open YouTube Digest Settings.",
    };
  }

  const systemPrompt = `你是一位专业的文稿编辑。请将以下视频字幕整理成格式化的逐字稿。

要求：
1. 添加正确的标点符号（句号、逗号、问号、感叹号等）
2. 按语义逻辑分段（每段3-8句，段落间用空行分隔）
3. 删除口语填充词（如“然后”“就是说”“那个”“嗯”“呃”等），但保留原意
4. 保持口语的自然流畅感，不要过度书面化
5. 全程使用简体中文输出（除非原文为其他语言）

输出格式：
- 纯文本，段落间用空行分隔
- 不要添加标题、编号或其他标记
- 直接输出格式化后的内容，不要加 markdown 代码块`;

  const { text } = await requestAiCompletion({
    maxTokens: 8192,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: `请将以下内容整理成格式化的逐字稿：\n\n${transcriptText}` },
    ],
  });

  return { success: true, formattedText: text };
}

// Pure validators are exposed for the repository's Node tests only.
globalThis.__YTD_TRANSLATION_TESTING__ = {
  requestAiCompletion,
  callAiTranslation,
  validateTranscriptBatchRequest,
  normalizeTranslatedSegmentBatch,
  handleTranslateContent,
};
