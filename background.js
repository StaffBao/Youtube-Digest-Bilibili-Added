/**
 * BACKGROUND SERVICE WORKER
 *
 * This is the "brain" of the extension. It runs in the background and handles:
 * 1. Opening the side panel when the user clicks the extension icon
 * 2. Fetching transcripts (YouTube captions via the Supadata API, or Bilibili's
 *    official subtitle API via the browser's own login state)
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
const DOC_CHUNK_SIZE = 7000;
const DOC_IDLE_TIMEOUT_MS = 120_000;
const DOC_HARD_TIMEOUT_MS = 300_000;
// Concurrency for the whole-text phases (format / full-document translate), whose
// chunks are DOC_CHUNK_SIZE-sized. Deliberately separate from the segment path
// below: 7000-12000 char chunks are far heavier per request, so raising this one
// buys little and risks provider rate limits.
const DOC_PARALLEL_WORKERS = 3;
// Segment-batch envelope for translateSegmentsById. Char-budget-driven: the old
// 4-segment cap bound first for typical 60-120 char subtitle lines, wasting ~90%
// of the budget and turning a 400-segment video into ~100 requests. 1800 input
// chars yields roughly 1500-2500 output tokens, comfortably inside maxTokens and
// the DOC_IDLE_TIMEOUT_MS budget for a non-streamed completion. The segment cap is
// only a safety valve against pathological input (hundreds of word-length rows).
const DOC_TRANSLATE_BATCH_CHARS = 1800;
const DOC_TRANSLATE_BATCH_MAX_SEGMENTS = 40;
// Segment batches are small, so more of them can be in flight at once.
const DOC_TRANSLATE_PARALLEL_WORKERS = 5;
/* Serialized-character budget per overview-translation request. Sized so the
   Chinese reply stays well inside maxTokens even for chapter-dense videos. */
const OVERVIEW_TRANSLATE_BATCH_CHARS = 2500;
// Retry budget shared by both doc pipelines (see withAiRetry).
const AI_MAX_RETRIES = 3;
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
      console.warn("[Youtube Bilibili Digest] Could not restrict storage access:", error),
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

/**
 * Parses a Retry-After header into milliseconds, accepting both the
 * delta-seconds and HTTP-date forms. Returns 0 when absent or unusable.
 * Mirrors the side panel's parseRetryAfterMs; a service worker cannot import it.
 */
function parseRetryAfterMs(value) {
  const raw = String(value || "").trim();
  if (!raw) return 0;
  if (/^\d+$/.test(raw)) return Number(raw) * 1000;
  const dateMs = Date.parse(raw);
  if (!Number.isNaN(dateMs)) return Math.max(0, dateMs - Date.now());
  return 0;
}

const RETRYABLE_AI_ERROR_CODES = new Set([
  "EMPTY_AI_RESPONSE",
  "AI_IDLE_TIMEOUT",
  "AI_HARD_TIMEOUT",
]);

/**
 * True when an AI failure is worth another attempt: provider rate limiting,
 * server faults, timeouts, empty completions, and transport-level network
 * errors. Auth and request-shape failures (401/403/404/400) are deliberately
 * NOT retryable — retrying an invalid key only burns the backoff budget and
 * delays the real error reaching the user.
 */
function isRetryableAiError(error) {
  const status = Number(error && error.status) || 0;
  if (status === 429 || status >= 500) return true;
  if (error && RETRYABLE_AI_ERROR_CODES.has(error.code)) return true;
  return /timed out|inactive|failed to fetch|network/i.test(
    String((error && error.message) || ""),
  );
}

/**
 * Runs an AI call with bounded retries and exponential backoff
 * (2000 * 3^n ms, capped at 20000ms, +/-20% jitter). A server-supplied
 * Retry-After wins over the computed delay. Same policy as the ASR path's
 * transcribeAsrChunkWithRetry, so both pipelines back off identically when a
 * provider rate-limits us.
 */
async function withAiRetry(callOnce) {
  let attempt = 0;
  for (;;) {
    try {
      return await callOnce();
    } catch (error) {
      if (!isRetryableAiError(error) || attempt >= AI_MAX_RETRIES) throw error;
      const retryAfterMs = Number(error && error.retryAfterMs) || 0;
      let delayMs;
      if (retryAfterMs > 0) {
        delayMs = retryAfterMs;
      } else {
        const base = Math.min(20000, 2000 * Math.pow(3, attempt));
        const jitter = base * 0.2 * (Math.random() * 2 - 1);
        delayMs = Math.max(0, Math.round(base + jitter));
      }
      attempt++;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

async function requestAiCompletion({
  messages,
  maxTokens,
  temperature,
  responseFormat,
  idleTimeoutMs,
  hardTimeoutMs,
}) {
  const effectiveIdle = idleTimeoutMs || AI_PROVIDER_IDLE_TIMEOUT_MS;
  const effectiveHard = hardTimeoutMs || AI_PROVIDER_HARD_TIMEOUT_MS;
  const settings = await getSettings();
  if (!settings.aiApiKey) {
    const error = new Error(
      "AI API key not configured. Open Youtube Bilibili Digest Settings.",
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
      effectiveIdle,
    );
  };

  hardTimeoutId = setTimeout(
    () => abortForTimeout("hard"),
    effectiveHard,
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
      error.retryAfterMs = parseRetryAfterMs(
        response.headers?.get?.("Retry-After"),
      );
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
      const idleSec = Math.round(effectiveIdle / 1000);
      const timeoutError = new Error(
        `The AI request was inactive for ${idleSec} seconds. Please Retry.`,
      );
      timeoutError.code = "AI_IDLE_TIMEOUT";
      throw timeoutError;
    }
    if (timeoutKind === "hard") {
      const hardSec = Math.round(effectiveHard / 1000);
      const timeoutError = new Error(
        `The AI request exceeded the ${hardSec}-second limit. Please Retry.`,
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
 * you to every tab. To make Youtube Bilibili Digest behave like a video-only tool, we
 * enable the panel on supported tabs and disable it everywhere else. Disabling
 * on a tab makes Chrome hide/close the panel for that tab, so it never lingers
 * on a new tab or some other website.
 *
 * We have to react to BOTH things that can change "what tab you're looking at":
 *   - onUpdated: the current tab navigates to a new URL
 *   - onActivated: you switch to (or open) a different tab
 */
function updatePanelForTab(tabId, url) {
  const supported = isSupportedTabUrl(url) || panelBusyFromPort;
  // setOptions can reject if the tab just closed — ignore that harmlessly.
  chrome.sidePanel
    .setOptions({ tabId, path: "sidepanel.html", enabled: supported })
    .catch(() => {});
}

// Busy state reported by the side panel over a long-lived port. While the
// panel is mid-transcription / mid-generation, switching to a non-video tab
// must NOT disable the panel, or the work running in its JS context dies.
let panelBusyFromPort = false;
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "panel-lifetime") return;
  port.onMessage.addListener((msg) => {
    panelBusyFromPort = !!msg?.busy;
  });
  // Panel closed or crashed — reset so the auto-close behavior can't get
  // stuck off forever.
  port.onDisconnect.addListener(() => {
    panelBusyFromPort = false;
  });
});

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
      message.preferLang,
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
      message.outputLanguage,
      message.languageTimeline,
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
    handleFormatTranscriptForDocs(
      message.transcriptText,
      message.modes,
      message.videoTitle,
    )
      .then(sendResponse)
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  // v10: restore Chinese punctuation on unbroken AI subtitle runs. The model
  // may only insert punctuation; normalizePunctuatedBatch is the guard.
  if (message.action === "punctuateTranscript") {
    handlePunctuateTranscript(message.content, message.videoTitle)
      .then(sendResponse)
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  // v11: translate the user's timestamp notes into the video's own language for
  // the Docs export - the reverse direction of formatTranscriptForDocs.
  if (message.action === "translateDocSegments") {
    handleTranslateDocSegments(
      message.segments,
      message.videoTitle,
      message.targetLanguage,
    )
      .then(sendResponse)
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.action === "checkConfig") {
    getSettings()
      .then((settings) =>
        sendResponse({
          hasAiKey: !!settings.aiApiKey,
          hasSupadataKey: !!settings.supadataApiKey,
          bilibiliEnabled: !!settings.enableBilibili,
          asrEnabled: !!settings.asrEnabled,
          asrConfigured: !!(settings.asrApiKey || settings.aiApiKey),
          asrModel: settings.asrModel,
        }),
      )
      .catch((error) => sendResponse({ error: error.message }));
    return true;
  }

  // ASR fallback: discover the video's audio stream URL so the side panel
  // can download the audio and transcribe it when no subtitles exist.
  if (message.action === "getAudioStream") {
    handleGetAudioStream(
      message.platform === "bilibili" ? "bilibili" : "youtube",
      message.videoId,
      message.tabId,
    )
      .then(sendResponse)
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  // [v4] ASR audio relay: forward the request to the bilibili.com content
  // script, which calls the playurl API and downloads audio inside the page
  // context (carries browser cookies + UA, fresh CDN signatures). The chunk
  // action pulls one 8MiB slice of a previously downloaded audio file — the
  // full audio can't travel in a single message (64MiB cap).
  if (
    message.action === "fetchBilibiliAudio" ||
    message.action === "fetchAudioChunk"
  ) {
    chrome.tabs.sendMessage(message.tabId, message, (response) => {
      if (chrome.runtime.lastError) {
        sendResponse({ success: false, error: chrome.runtime.lastError.message });
      } else {
        sendResponse(response);
      }
    });
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
    debugLog("[Youtube Bilibili Digest BG] openSidePanel requested from tab:", tabId);

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
          console.error("[Youtube Bilibili Digest BG] openSidePanel error:", err);
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
                "[Youtube Bilibili Digest BG] openSidePanel fallback error:",
                err,
              );
            });
          }
        });
    }

    sendResponse({ success: true });
    return false;
  }

/*
 * v15: a tab can lack a live content script — opened before the extension was
 * loaded, or its isolated world discarded. "Receiving end does not exist" is
 * that signature. Inject content.js once and retry once; content.js removes
 * stale buttons itself (injectNoteButton), and a single retry bounds the
 * duplicate-listener risk of re-injecting into a live tab.
 */
async function sendToContentTab(tabId, payload) {
  try {
    return await chrome.tabs.sendMessage(tabId, payload);
  } catch (error) {
    const text = String((error && error.message) || error);
    if (!/Receiving end does not exist/i.test(text)) throw error;
    console.warn(
      "[Youtube Bilibili Digest BG] No content script in tab",
      tabId,
      "- injecting content.js and retrying once",
    );
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content.js"],
    });
    return await chrome.tabs.sendMessage(tabId, payload);
  }
}

/* Real watch/video pages first; generic platform pages (home, results) only as
   a fallback, so a stale non-watch tab never wins the relay. */
function preferWatchTabs(list) {
  const isWatch = (tab) => {
    const url = String(tab?.url || "");
    return url.includes("/watch") || url.includes("/video/");
  };
  return [...(Array.isArray(list) ? list : [])].sort(
    (a, b) => (isWatch(b) ? 1 : 0) - (isWatch(a) ? 1 : 0),
  );
}

  // Relay messages from side panel to content script
  if (message.action === "relayToContent") {
    debugLog("[Youtube Bilibili Digest BG] Relay request:", message.payload?.action);
    (async () => {
      let tabs = [];
      try {
        // Query specifically for supported video tabs to avoid side panel
        // context issues. Try multiple query strategies to find the right tab.
        tabs = await chrome.tabs.query({
          active: true,
          lastFocusedWindow: true,
        });
        if (!tabs[0] || !isSupportedTabUrl(tabs[0].url)) {
          tabs = [];
        }
        debugLog(
          "[Youtube Bilibili Digest BG] Active tab in last focused window:",
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
          tabs = preferWatchTabs(youtubeTabs.length ? youtubeTabs : bilibiliTabs);
          debugLog("[Youtube Bilibili Digest BG] Active video tabs:", tabs.length);
        }

        // Still nothing? Try any supported tab
        if (!tabs[0]) {
          const youtubeTabs = await chrome.tabs.query({
            url: "https://www.youtube.com/*",
          });
          const bilibiliTabs = await chrome.tabs.query({
            url: "https://www.bilibili.com/video/*",
          });
          tabs = preferWatchTabs(youtubeTabs.length ? youtubeTabs : bilibiliTabs);
          debugLog("[Youtube Bilibili Digest BG] Any video tabs:", tabs.length);
        }

        if (tabs[0]) {
          debugLog(
            "[Youtube Bilibili Digest BG] Sending to tab:",
            tabs[0].id,
            "URL:",
            tabs[0].url,
          );
          let response = await sendToContentTab(tabs[0].id, message.payload);

          // For getVideoInfo, PREFER YouTube's own player data over the
          // DOM scrape. The player's videoDetails is canonical: its `author`
          // is always THIS video's channel and its `shortDescription` is the
          // full text. The DOM scrape is unreliable — e.g. on a playlist page
          // it grabbed the playlist owner's name instead of the channel of the
          // video actually being watched, and its description is
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

          debugLog("[Youtube Bilibili Digest BG] Got response from content:", response);
          sendResponse({ success: true, response });
        } else {
          debugLog("[Youtube Bilibili Digest BG] No video tab found");
          sendResponse({ success: false, error: "No video tab found" });
        }
      } catch (err) {
        console.error(
          "[Youtube Bilibili Digest BG] Relay error:",
          err.message,
          "tab:",
          tabs[0]?.id,
          "url:",
          tabs[0]?.url,
        );
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
    console.warn("[Youtube Bilibili Digest BG] Player details unavailable:", e.message);
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

/*
 * MAIN-world reader for YouTube's adaptive audio formats. Kept as a named
 * function so the audio path can invoke it a second time after a delay:
 * YouTube frequently omits streamingData until playback has started.
 */
function readYouTubeAdaptiveAudioFormats() {
  try {
    const player = document.getElementById("movie_player");
    // Prefer the player's live state — it reflects SPA navigations and may
    // have streamingData populated only after the player fully initialises,
    // whereas window.ytInitialPlayerResponse is a snapshot from the initial
    // page HTML that can be stale or missing streamingData entirely.
    const response =
      player?.getPlayerResponse?.() ||
      window.ytInitialPlayerResponse ||
      null;
    let list = response?.streamingData?.adaptiveFormats;
    // Fallback: some YouTube responses only carry combined formats (audio
    // multiplexed with video). Extract audio tracks from those.
    if (!Array.isArray(list) || list.length === 0) {
      list = response?.streamingData?.formats;
    }
    if (!Array.isArray(list)) return [];
    return list
      .filter(
        (format) =>
          String(format.mimeType || "").startsWith("audio/") &&
          format.url,
      )
      .map((format) => ({
        mimeType: format.mimeType,
        bitrate: Number(format.averageBitrate || format.bitrate) || 0,
        url: format.url,
      }));
  } catch (_error) {
    return [];
  }
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
 * @param {string} preferLang - Optional: "non-zh" sentinel or a language prefix
 */
async function handleFetchTranscript(platform, videoId, tabId, preferLang) {
  if (platform === "bilibili") {
    // Defense in depth: refuse Bilibili fetches when the mode is disabled.
    const settings = await getSettings();
    if (!settings.enableBilibili) {
      return {
        success: false,
        error: "Bilibili mode is disabled in Youtube Bilibili Digest Settings.",
      };
    }
    return handleFetchBilibiliTranscript(videoId, tabId, preferLang);
  }
  // v11: forward preferLang to the YouTube path too - it now honours the same
  // "non-zh" sentinel / language-prefix rules as the Bilibili path.
  return handleFetchYouTubeTranscript(tabId, preferLang, videoId);
}

/**
 * v11: Moves the track matching the caller's language preference to the front of
 * an already-scored list. Shared by the YouTube and Bilibili fetchers so the two
 * paths can never drift apart.
 *
 * - `"non-zh"` (case-insensitive) is a sentinel meaning "any language that is
 *   NOT Simplified Chinese". The Docs tab sends it for a non-Chinese-original
 *   video whose only subtitle track is a machine `ai-zh` one: the
 *   original-language track (ja / ko / fr / ...) must be found without
 *   hardcoding `en`. The first track whose lang matches neither `zh*` nor
 *   `ai-zh*` wins.
 * - Any other non-empty value is a concrete language-code prefix: the first
 *   track whose lang starts with that prefix wins.
 * - A falsy value leaves the order untouched, byte-for-byte identical to what
 *   the platform scorers produced.
 *
 * @param {Array} ordered - Tracks already sorted by their platform scorer
 * @param {string} preferLang - "non-zh" sentinel, a language prefix, or falsy
 * @param {string} langField - Name of the language property on each track
 * @returns {Array} A new array with the preferred track (if any) moved first
 */
function reorderTracksByLangPreference(ordered, preferLang, langField = "lang") {
  const list = Array.isArray(ordered) ? [...ordered] : [];
  if (!preferLang || list.length === 0) return list;

  const wanted = String(preferLang).toLowerCase();
  const wantsNonChinese = wanted === "non-zh";
  const wantedIndex = list.findIndex((item) => {
    const lang = String(item?.[langField] || "");
    return wantsNonChinese
      ? !/^(zh|ai-zh)/i.test(lang)
      : lang.toLowerCase().startsWith(wanted);
  });
  if (wantedIndex > 0) {
    return [
      list[wantedIndex],
      ...list.slice(0, wantedIndex),
      ...list.slice(wantedIndex + 1),
    ];
  }
  return list;
}

/**
 * Reads the video page's own player data in the MAIN world to discover
 * subtitle sources. Content scripts live in an isolated world, so page
 * globals (ytInitialPlayerResponse / __INITIAL_STATE__) are only reachable
 * through chrome.scripting. Returns null on any failure.
 */
async function runMainWorldScript(tabId, func, ...args) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func,
      args: args.length > 0 ? args : undefined,
    });
    return results?.[0]?.result ?? null;
  } catch (error) {
    debugLog("[Youtube Bilibili Digest BG] MAIN world script failed:", error.message);
    return null;
  }
}

// ============================================================
// ASR FALLBACK — audio stream discovery
// ============================================================

/**
 * Finds the direct audio stream URL of a video when the platform offers no
 * subtitles. The side panel downloads this audio, resamples it, and sends it
 * in chunks to the user-configured ASR endpoint.
 *
 * YouTube: audio-only adaptive formats live in ytInitialPlayerResponse.
 * Bilibili: audio streams live in the playurl API's DASH payload and the CDN
 * requires a bilibili.com Referer, which extension fetches can attach.
 *
 * @returns {Object} - { success, audioUrl, platform } or { success: false, error }
 */
async function handleGetAudioStream(platform, videoId, tabId) {
  try {
    if (platform === "bilibili") {
      const safeBvid = String(videoId || "").trim();
      if (!/^BV[0-9A-Za-z]{10}$/.test(safeBvid)) {
        return { success: false, error: "INVALID_BVID" };
      }

      let cid = tabId
        ? String(
            (await runMainWorldScript(tabId, () => {
              try {
                return (
                  window.__INITIAL_STATE__?.videoData?.cid ||
                  document.defaultView?.__INITIAL_STATE__?.videoData?.cid ||
                  ""
                );
              } catch (_error) {
                return "";
              }
            })) || "",
          )
        : "";

      if (!/^\d{1,20}$/.test(cid)) {
        const view = await fetchJson(
          `https://api.bilibili.com/x/player/pagelist?bvid=${encodeURIComponent(safeBvid)}`,
        );
        const firstPage = Array.isArray(view?.data) ? view.data[0] : null;
        cid = String(firstPage?.cid || "");
      }
      if (!cid) {
        return { success: false, error: "NO_AUDIO_STREAM", message: "Could not resolve this Bilibili video." };
      }

      const playback = await fetchJson(
        `https://api.bilibili.com/x/player/playurl?bvid=${encodeURIComponent(safeBvid)}&cid=${encodeURIComponent(cid)}&fnval=16`,
      );
      const audioStreams = Array.isArray(playback?.data?.dash?.audio)
        ? playback.data.dash.audio
        : [];
      if (audioStreams.length === 0) {
        return { success: false, error: "NO_AUDIO_STREAM", message: "No audio stream found for this Bilibili video." };
      }
      const best = [...audioStreams].sort(
        (a, b) => (Number(b.bandwidth) || 0) - (Number(a.bandwidth) || 0),
      )[0];
      const audioUrl = normalizeSubtitleUrl(best?.baseUrl || best?.base_url)
        // Bilibili's CDN serves the same files over https; force it so the
        // extension's https-only host permissions (and CORS exemption) apply.
        .replace(/^http:\/\//i, "https://");
      if (!audioUrl) {
        return { success: false, error: "NO_AUDIO_STREAM", message: "No audio stream URL found for this Bilibili video." };
      }
      return { success: true, audioUrl, platform: "bilibili" };
    }

    // YouTube: read adaptive audio formats from the player response.
    // Retry up to 4 times with 2s delays — YouTube frequently omits
    // streamingData until the player has fully initialised (and may need
    // playback to start before PO Token is generated and streamingData is
    // populated). Attempt to trigger playback before each retry.
    let audioFormats = [];
    for (let attempt = 0; attempt < 4 && audioFormats.length === 0; attempt++) {
      if (attempt > 0 && tabId) {
        // Try to trigger playback so YouTube populates streamingData.
        await runMainWorldScript(tabId, () => {
          try {
            const p = document.getElementById("movie_player");
            if (p && typeof p.playVideo === "function") p.playVideo();
          } catch (_e) {
            // Player not ready yet; retry will follow.
          }
        });
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
      const formats = tabId
        ? await runMainWorldScript(tabId, readYouTubeAdaptiveAudioFormats)
        : [];
      audioFormats = Array.isArray(formats) ? formats : [];
    }
    if (audioFormats.length === 0) {
      // Diagnostics: under PO Token enforcement YouTube typically ships
      // adaptiveFormats WITHOUT plain `url` fields (only signatureCipher),
      // which this reader cannot decipher. Log the breakdown so failures
      // are explainable from the service worker console alone.
      if (tabId) {
        const diag = await runMainWorldScript(tabId, () => {
          try {
            const player = document.getElementById("movie_player");
            const resp =
              player?.getPlayerResponse?.() ||
              window.ytInitialPlayerResponse ||
              null;
            const list =
              resp?.streamingData?.adaptiveFormats ||
              resp?.streamingData?.formats ||
              [];
            const audio = list.filter((f) =>
              String(f.mimeType || "").startsWith("audio/"),
            );
            return {
              hasStreamingData: !!resp?.streamingData,
              totalFormats: list.length,
              audioFormats: audio.length,
              audioWithUrl: audio.filter((f) => !!f.url).length,
              audioCipheredOnly: audio.filter((f) => !f.url && !!f.signatureCipher).length,
            };
          } catch (e) {
            return { error: e.message };
          }
        });
        console.warn(
          "[Youtube Bilibili Digest BG] Audio stream diagnostics:",
          JSON.stringify(diag),
        );
      }
      return {
        success: false,
        error: "NO_AUDIO_STREAM",
        message:
          "No audio stream found for this YouTube video. Play the video once first (YouTube may not expose audio stream addresses before playback), then try again; if it still fails, reopen the video page.",
      };
    }
    // AAC-in-MP4 decodes reliably in the browser; prefer it, then highest bitrate.
    const preferred =
      audioFormats.find((format) => format.mimeType.includes("mp4")) ||
      [...audioFormats].sort((a, b) => b.bitrate - a.bitrate)[0];
    return { success: true, audioUrl: preferred.url, platform: "youtube" };
  } catch (error) {
    console.error("Audio stream discovery error:", error);
    return {
      success: false,
      error: error.message || "Failed to locate the audio stream",
    };
  }
}

// ============================================================
// YOUTUBE TRANSCRIPTS — Supadata API (upstream author's approach)
// ============================================================

/**
 * Fetches the transcript for a YouTube video using the Supadata API, the
 * same service the upstream YouTube Digest extension relies on. Supadata
 * resolves YouTube's caption tracks server-side (manual tracks AND AI
 * generated auto-captions), which sidesteps the PO-Token / bot-check
 * enforcement that blocks every direct in-browser timedtext download.
 *
 * API Docs: https://docs.supadata.ai
 *
 * @param {string} videoId - The YouTube video ID (e.g., "dQw4w9WgXcQ")
 * @param {string} preferLang - Optional hint: "non-zh" sentinel or a language prefix
 * @returns {Object} - { success, transcript, transcriptText, transcriptTextTimestamped, language, availableSubtitles } or { success: false, error }
 */
async function fetchYouTubeTranscriptViaSupadata(videoId, preferLang) {
  const settings = await getSettings();
  if (!settings.supadataApiKey) {
    return {
      success: false,
      error: "NO_SUPADATA_KEY",
      message:
        "Supadata API key not configured. Open Youtube Bilibili Digest Settings to fetch YouTube transcripts. (Bilibili works without it.)",
    };
  }

  try {
    // Share only the canonical watch URL. This strips playlist, referral,
    // timestamp, and other browsing parameters from the active tab URL.
    const canonicalVideoUrl = YTD_SETTINGS.canonicalYouTubeUrl(videoId);
    // Using the universal transcript endpoint with text=false to get
    // timestamped chunks, not plain text.
    const apiUrl = new URL("https://api.supadata.ai/v1/transcript");
    apiUrl.searchParams.set("url", canonicalVideoUrl);
    apiUrl.searchParams.set("text", "false");
    // Prefer the requested language when it is a concrete code; the "non-zh"
    // sentinel cannot be expressed as a preference, so fall back to the
    // upstream default.
    const langHint = String(preferLang || "").trim().toLowerCase();
    apiUrl.searchParams.set(
      "lang",
      /^[a-z]{2,3}(-[a-z]{2,8})?$/.test(langHint) ? langHint : "en",
    );
    // Caption-only product scope: never fall back to paid AI transcription.
    apiUrl.searchParams.set("mode", "native");

    // Make the API request
    const response = await fetch(apiUrl.toString(), {
      method: "GET",
      headers: {
        "x-api-key": settings.supadataApiKey,
      },
    });

    // Handle async jobs (for videos > 20 minutes, Supadata returns a job ID)
    if (response.status === 202) {
      const jobData = await response.json();
      // Poll for the result
      return await pollSupadataTranscriptJob(
        jobData.jobId,
        settings.supadataApiKey,
      );
    }

    if (response.status === 206) {
      return {
        success: false,
        error: "NO_TRANSCRIPT",
        message: "No native subtitle track is available for this video.",
      };
    }

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      if (response.status === 401) {
        return {
          success: false,
          error: "INVALID_SUPADATA_KEY",
          message:
            "Your Supadata API key is invalid. Open Youtube Bilibili Digest Settings.",
        };
      }
      if (response.status === 404) {
        return {
          success: false,
          error: "NO_TRANSCRIPT",
          message: "No subtitles found for this video.",
        };
      }
      if (response.status === 429) {
        return {
          success: false,
          error: "RATE_LIMITED",
          message:
            "Supadata rate limit reached. Please wait a minute and try again.",
        };
      }
      throw new Error(
        errorData.message || `Supadata API error: ${response.status}`,
      );
    }

    const data = await response.json();
    const result = parseSupadataTranscript(data);
    if (result.success) {
      console.warn(
        `[Youtube Bilibili Digest BG] Supadata transcript ok: ${result.transcript.length} segment(s), lang=${result.language || "?"}`,
      );
    }
    return result;
  } catch (error) {
    console.error("[Youtube Bilibili Digest BG] Supadata fetch error:", error);
    return {
      success: false,
      error: error.message || "Failed to fetch transcript",
    };
  }
}

/**
 * Parses a Supadata transcript payload into the extension's internal shape.
 * Supadata returns: { content: [{ text, offset, duration, lang }], lang, availableLangs }
 *
 * @param {Object} data - The Supadata transcript payload
 * @returns {Object} - Same contract as fetchYouTubeTranscriptViaSupadata
 */
function parseSupadataTranscript(data) {
  const transcript = [];
  let transcriptTextPlain = ""; // Plain text for display/export
  let transcriptTextTimestamped = ""; // Timestamped text for AI analysis

  if (data.content && Array.isArray(data.content)) {
    for (const chunk of data.content) {
      if (chunk.text) {
        // Clean up caption artifacts:
        // ">>" = speaker change marker from YouTube auto-captions
        const cleanText = chunk.text.replace(/>> ?/g, "").trim();
        if (!cleanText) continue; // Skip if nothing left after cleanup

        // offset is in milliseconds, convert to seconds
        const startSeconds = Math.floor((chunk.offset || 0) / 1000);
        const minutes = Math.floor(startSeconds / 60);
        const seconds = startSeconds % 60;
        const timestamp = `${minutes}:${String(seconds).padStart(2, "0")}`;

        transcript.push({
          text: cleanText,
          start: startSeconds,
          duration: Math.floor((chunk.duration || 0) / 1000),
          language: chunk.lang || data.lang || null,
        });

        // Plain text without timestamps (for display/export)
        transcriptTextPlain += cleanText + " ";

        // Timestamped text for the AI (format: [MM:SS] text)
        transcriptTextTimestamped += `[${timestamp}] ${cleanText}\n`;
      }
    }
  }

  if (transcript.length === 0) {
    return {
      success: false,
      error: "EMPTY_TRANSCRIPT",
      message: "Supadata returned an empty transcript for this video.",
    };
  }

  // Expose the track list so the side panel's language detection keeps its
  // tracksKnown signal, exactly as the old direct-fetch path did.
  const availableLangs = Array.isArray(data.availableLangs)
    ? data.availableLangs
        .map((entry) => ({
          lang: String(
            (entry && (entry.lang || entry.languageCode)) || entry || "",
          ),
          name: String((entry && (entry.name || entry.languageName)) || ""),
        }))
        .filter((entry) => entry.lang)
    : null;

  return {
    success: true,
    transcript: transcript,
    transcriptText: transcriptTextPlain.trim(), // For display
    transcriptTextTimestamped: transcriptTextTimestamped.trim(), // For AI
    language: typeof data.lang === "string" ? data.lang : null,
    availableSubtitles: availableLangs,
  };
}

/**
 * Polls for transcript job completion (for long videos).
 * Supadata processes videos > 20 minutes asynchronously.
 *
 * @param {string} jobId - The job ID returned by the initial request
 * @param {string} supadataApiKey - The configured Supadata API key
 * @returns {Object} - Same format as fetchYouTubeTranscriptViaSupadata
 */
async function pollSupadataTranscriptJob(jobId, supadataApiKey) {
  const maxAttempts = 60; // Max 60 seconds of polling
  const pollInterval = 1000; // Poll every 1 second

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    // Wait before polling
    await new Promise((resolve) => setTimeout(resolve, pollInterval));

    const response = await fetch(
      `https://api.supadata.ai/v1/transcript/${encodeURIComponent(jobId)}`,
      {
        headers: { "x-api-key": supadataApiKey },
      },
    );

    if (!response.ok) {
      throw new Error(`Job polling failed: ${response.status}`);
    }

    const data = await response.json();

    if (data.status === "completed") {
      return parseSupadataTranscript(data);
    }

    if (data.status === "failed") {
      throw new Error("Transcript processing failed");
    }

    // Status is 'queued' or 'active' — keep polling
  }

  throw new Error("Transcript processing timed out");
}

/**
 * YouTube transcript entry point. Since v16 this is a pure Supadata call:
 * the service resolves caption tracks (manual and AI-generated) server-side,
 * so no page injection, timedtext download, or DOM scraping is involved.
 * Bilibili keeps its own direct path and never needs a Supadata key.
 *
 * @param {number} tabId - Kept for dispatcher signature compatibility
 * @param {string} preferLang - Optional: "non-zh" sentinel or a language prefix
 * @param {string} videoId - YouTube video ID
 * @returns {Object} - { success, transcript, transcriptText, language, availableSubtitles } or { success: false, error }
 */
async function handleFetchYouTubeTranscript(tabId, preferLang, videoId) {
  void tabId; // Supadata only needs the video ID.
  const result = await fetchYouTubeTranscriptViaSupadata(videoId, preferLang);
  if (!result.success) {
    console.warn(
      `[Youtube Bilibili Digest BG] Supadata transcript failed: ${result.error} ${result.message || ""}`,
    );
  }
  return result;
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
async function handleFetchBilibiliTranscript(bvid, tabId, preferLang) {
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

      // [v1] Distinguish "login required" (code -101/-401) from "no subtitles"
      // (code 0 with empty list). Many Bilibili videos simply have no subtitles
      // — that is NOT a login issue.
      const playerCode = player?.code;
      const loginRequired = (playerCode === -101 || playerCode === -401);

      const listed = Array.isArray(player?.data?.subtitle?.subtitles)
        ? player.data.subtitle.subtitles
        : [];
      subtitles = listed
        .map((item) => ({
          lang: item?.lan || item?.lan_doc || "",
          url: normalizeSubtitleUrl(item?.subtitle_url),
        }))
        .filter((item) => item.url);

      if (subtitles.length === 0) {
        if (loginRequired) {
          return {
            success: false,
            error: "BILI_LOGIN_REQUIRED",
            message:
              "Bilibili subtitles require a logged-in Bilibili account in this browser. Log in on bilibili.com, reopen the video, and try again.",
          };
        }
        return {
          success: false,
          error: "NO_SUBTITLES",
          message: "This video does not have subtitles.",
        };
      }
    }

    let ordered = [...subtitles].sort(
      (a, b) => scoreBilibiliSubtitle(b) - scoreBilibiliSubtitle(a),
    );

    // v10 (preferLang): when the caller asks for a specific language, move a
    // track whose `lan` starts with that prefix to the front.
    // v11: "non-zh" is a sentinel for "any language that is NOT Simplified
    // Chinese". The Docs tab sends it when a non-Chinese-original video only
    // carries Bilibili's machine `ai-zh` track, so the original-language track
    // (ja / ko / fr / ...) can be selected without hardcoding `en`. When
    // preferLang is absent the ordering is byte-for-byte identical to v9.
    ordered = reorderTracksByLangPreference(ordered, preferLang, "lang");
    const availableSubtitles = ordered.map((item) => ({ lang: item.lang }));

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
        const result = buildTranscriptResult(rawEntries, language);
        if (result && result.success) {
          result.availableSubtitles = availableSubtitles;
        }
        return result;
      } catch (subtitleError) {
        debugLog(
          "[Youtube Bilibili Digest BG] Bilibili subtitle source failed:",
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
function extractBalancedJsonObject(text) {
  const start = String(text || "").indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escaped) { escaped = false; continue; }
    if (inString) {
      if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function parseLooseJson(text) {
  let cleaned = (text || "").trim();

  // Strip ```json ... ``` style code fences
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "");
  }

  // Isolate the first BALANCED top-level { ... }. A firstBrace→lastIndexOf("}")
  // slice breaks when the model's trailing prose (or a concatenated second
  // object) itself contains a `}`, which made translation batches throw
  // "Unexpected non-whitespace character after JSON".
  const objectText = extractBalancedJsonObject(cleaned);
  if (objectText) cleaned = objectText;

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
  outputLanguage,
  languageTimeline,
) {
  try {
    const settings = await getSettings();
    if (!settings.aiApiKey) {
      return {
        success: false,
        error: "NO_AI_KEY",
        message: "AI API key not configured. Open Youtube Bilibili Digest Settings.",
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
      outputLanguage: outputLanguage || "English",
      languageTimeline: languageTimeline || "(none)",
    };
    const systemPrompt = await loadPromptSection(
      "analysis.html",
      "System prompt",
      promptVariables,
    );
    const userPrompt = await loadPromptSection(
      "analysis.html",
      "User prompt",
      promptVariables,
    );

    debugLog("[Youtube Bilibili Digest] Requesting video analysis", settings.aiModel);
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
      analysisLanguage: outputLanguage || "English",
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
        message: "AI API key not configured. Open Youtube Bilibili Digest Settings.",
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
      "- The analysis may MIX languages (a video can switch spoken language mid-way). Any item ALREADY written in Simplified Chinese must be copied through VERBATIM — do not re-translate, rephrase, or polish it.",
      `- The video title is "${videoTitle || "Unknown"}" — use it as context for names and terminology.`,
      "",
      "Return a JSON object with exactly this shape:",
      '{"chapters":[{"title":"translated title","summary":"translated summary"}],"keyQuotes":[{"quote":"translated quote"}]}',
      "- Translate ONLY the items given in the request, and return them in the same order.",
      "- The returned arrays must match the request's array lengths exactly.",
      "- Output only valid JSON. No markdown fences, commentary, or extra keys.",
    ].join("\n");

    /*
     * v15 fix: the previous single-shot call capped output at 4096 tokens and
     * back-filled any missing tail items with the English original, which is how
     * a long video ended up half-Chinese half-English with no visible error.
     * Translate in batches sized to fit the output budget instead. A batch whose
     * reply does not match its input length is split in half and retried once;
     * an item that still fails is reported in `missing` and left EMPTY, never
     * substituted with the source language.
     */
    const translatedChapters = new Array(chapters.length).fill(null);
    const translatedQuotes = new Array(keyQuotes.length).fill(null);
    const missing = { chapters: [], keyQuotes: [] };

    const packBatches = (items, kind) => {
      const batches = [];
      let current = [];
      let currentChars = 0;
      items.forEach((item, index) => {
        const size = JSON.stringify(item || {}).length;
        if (current.length && currentChars + size > OVERVIEW_TRANSLATE_BATCH_CHARS) {
          batches.push({ items: current, kind, offset: index - current.length });
          current = [];
          currentChars = 0;
        }
        current.push(item);
        currentChars += size;
      });
      if (current.length) {
        batches.push({ items: current, kind, offset: items.length - current.length });
      }
      return batches;
    };

    const translateBatch = async (items, kind) => {
      const payload = JSON.stringify(
        kind === "chapters"
          ? {
              chapters: items.map((ch) => ({
                title: ch.title || "",
                summary: ch.summary || "",
              })),
            }
          : { keyQuotes: items.map((q) => ({ quote: q.quote || "" })) },
      );
      const { text } = await withAiRetry(() =>
        requestAiCompletion({
          maxTokens: 8192,
          responseFormat: { type: "json_object" },
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: payload },
          ],
        }),
      );
      const parsed = parseLooseJson(text);
      if (kind === "chapters") {
        return Array.isArray(parsed?.chapters) ? parsed.chapters : [];
      }
      return Array.isArray(parsed?.keyQuotes) ? parsed.keyQuotes : [];
    };

    /* Index-cursor pool; a failed batch appends its two halves, so the queue
       grows dynamically and the loop still terminates (splits stop at size 1). */
    const queue = [
      ...packBatches(chapters, "chapters"),
      ...packBatches(keyQuotes, "keyQuotes"),
    ];
    let nextIndex = 0;
    async function worker() {
      while (nextIndex < queue.length) {
        const job = queue[nextIndex++];
        let got = [];
        try {
          got = await translateBatch(job.items, job.kind);
        } catch (error) {
          console.error(
            "[Youtube Bilibili Digest] Overview translation batch failed:",
            error,
          );
          got = [];
        }
        if (got.length === job.items.length) {
          const target =
            job.kind === "chapters" ? translatedChapters : translatedQuotes;
          got.forEach((row, i) => {
            target[job.offset + i] = row || null;
          });
          continue;
        }
        console.warn(
          `[Youtube Bilibili Digest] Overview translation: batch of ${job.items.length} ${job.kind} returned ${got.length}; splitting and retrying`,
        );
        if (job.items.length > 1) {
          const mid = Math.ceil(job.items.length / 2);
          queue.push({
            items: job.items.slice(0, mid),
            kind: job.kind,
            offset: job.offset,
          });
          queue.push({
            items: job.items.slice(mid),
            kind: job.kind,
            offset: job.offset + mid,
          });
          continue;
        }
        missing[job.kind].push(job.offset);
      }
    }
    const workerCount = Math.min(DOC_TRANSLATE_PARALLEL_WORKERS, queue.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));

    return {
      success: true,
      translatedAnalysis: {
        chapters: chapters.map((_, i) => ({
          title: translatedChapters[i]?.title || "",
          summary: translatedChapters[i]?.summary || "",
        })),
        keyQuotes: keyQuotes.map((_, i) => ({
          quote: translatedQuotes[i]?.quote || "",
        })),
      },
      missing,
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
        debugLog("[Youtube Bilibili Digest] Using cached transcript for note");
      }
    } catch (e) {
      debugLog("[Youtube Bilibili Digest] No cached transcript, fetching...");
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
    console.error("[Youtube Bilibili Digest] Save note error:", error);
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
    debugLog("[Youtube Bilibili Digest] Requesting note cleanup");
    const variables = {
      videoTitle: videoTitle || "Unknown",
      fullContext,
      beforeText: beforeText || "(none)",
      targetText,
      afterText: afterText || "(none)",
    };
    const systemPrompt = await loadPromptSection(
      "note-cleanup.html",
      "System prompt",
      variables,
    );
    const userPrompt = await loadPromptSection(
      "note-cleanup.html",
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
        "[Youtube Bilibili Digest] JSON parse failed for note, stripping preambles:",
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
    console.error("[Youtube Bilibili Digest] Cleanup error:", e);
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
      "explain.html",
      "System prompt",
      variables,
    );
    const userPrompt = await loadPromptSection(
      "explain.html",
      "User prompt",
      variables,
    );

    debugLog("[Youtube Bilibili Digest] Requesting selection explanation");
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
    "translation.html",
    "Chinese rules",
  );
  return loadPromptSection("translation.html", "Shared base rules", {
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
      "translation.html",
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
    console.error("[Youtube Bilibili Digest] Translation error:", error);
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

function splitTranscriptForDocs(text, chunkSize = DOC_CHUNK_SIZE) {
  if (text.length <= chunkSize) return [text];
  const chunks = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= chunkSize) {
      chunks.push(remaining);
      break;
    }
    let splitAt = remaining.lastIndexOf("\n", chunkSize);
    if (splitAt <= 0 || splitAt < chunkSize - 2000) {
      // transcriptText is usually one long line with no newlines, so v9 always
      // fell through to a hard cut that could slice a sentence in half. Fall
      // back to punctuation boundaries instead: last sentence-end mark after
      // the 55% window, then a clause mark, then a hard cut as last resort.
      const windowText = remaining.slice(0, chunkSize);
      const lowerBound = Math.floor(chunkSize * 0.55);
      let cut = -1;
      let match;
      // A period only ends a sentence at a boundary (followed by whitespace or
      // end-of-string), so decimals, URLs and version numbers are never sliced.
      const sentenceRe = /(?:[!?。！？]|\.(?=\s|$))/g;
      while ((match = sentenceRe.exec(windowText))) {
        if (match.index >= lowerBound) cut = match.index + 1;
      }
      if (cut <= 0) {
        const clauseRe = /[,，;；]/g;
        while ((match = clauseRe.exec(windowText))) {
          if (match.index >= lowerBound) cut = match.index + 1;
        }
      }
      splitAt = cut > 0 ? cut : chunkSize;
    }
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\s+/, "");
  }
  return chunks;
}

// v10: decouple the doc chunk size by script. Chinese packs more meaning per
// character, so keep the smaller 7000 window; latin text can safely carry 12000.
function docChunkSizeFor(text) {
  return isMostlyChinese(text) ? 7000 : 12000;
}

// Decides whether the transcript is primarily Chinese by comparing character
// class counts. Kana/Hangul/Latin count as foreign, so Japanese and Korean
// transcripts are treated as foreign and get a Chinese translation pass.
function isMostlyChinese(text) {
  const sample = text.slice(0, 5000);
  const cjk = (sample.match(/[\u4e00-\u9fff]/g) || []).length;
  const kana = (sample.match(/[\u3040-\u30ff]/g) || []).length;
  const hangul = (sample.match(/[\uac00-\ud7af]/g) || []).length;
  const latin = (sample.match(/[a-zA-Z]/g) || []).length;
  return cjk >= kana + hangul + latin;
}

async function handleFormatTranscriptForDocs(transcriptText, modes, videoTitle) {
  const settings = await getSettings();
  if (!settings.aiApiKey) {
    return {
      success: false,
      error: "NO_AI_KEY",
      message: "AI API key not configured. Open Youtube Bilibili Digest Settings.",
    };
  }

  // v10 tri-state normalization. When `modes` is omitted (v9 callers) the
  // behaviour is byte-for-byte identical to v9: always format, always run the
  // whole-text translation pass for non-Chinese sources, never build the
  // paragraph-aligned bilingual pass.
  const requested = Array.isArray(modes) && modes.length ? modes : null;
  const wantSource = requested ? requested.includes("source") : true;
  const wantZh = requested ? requested.includes("zh") : null;
  const wantBilingual = requested ? requested.includes("bilingual") : false;
  void wantSource; // formattedText is always produced; the panel gates download.

  const systemPrompt = `你是一位专业的文稿编辑。请将以下视频字幕整理成格式化的逐字稿。

最高优先级（语言，优先于以下所有格式要求）：
- 严格保持原文所用的语言，绝对不要翻译或转写成其他语言。
- 原文是英文就输出英文；是日文/韩文/其他语言就保持该语言；原文是中文才输出中文。

格式要求：
1. 添加符合原文语言习惯的正确标点符号
2. 按语义逻辑分段（每段3-8句，段落间用空行分隔）
3. 删除口语填充词（中文如“然后/就是说/那个/嗯/呃”，英文如 um/uh/you know/like/so 等），但保留原意
4. 保持口语的自然流畅感，不要过度书面化

输出格式：
- 纯文本，段落间用空行分隔
- 不要添加标题、编号或其他标记
- 直接输出格式化后的内容，不要加 markdown 代码块`;

  const runDocPool = async (chunks, prompt, phase) => {
    const parts = new Array(chunks.length);
    let nextIndex = 0;
    let completed = 0;
    let failed = null;
    const runOneChunk = (chunkText) =>
      requestAiCompletion({
        maxTokens: 8192,
        idleTimeoutMs: DOC_IDLE_TIMEOUT_MS,
        hardTimeoutMs: DOC_HARD_TIMEOUT_MS,
        messages: [
          { role: "system", content: prompt },
          { role: "user", content: chunkText },
        ],
      });
    async function worker() {
      while (!failed && nextIndex < chunks.length) {
        const i = nextIndex++;
        try {
          const result = await withAiRetry(() => runOneChunk(chunks[i]));
          parts[i] = result.text;
        } catch (e) {
          failed = failed || e;
          throw e;
        }
        completed++;
        if (chunks.length > 1) {
          chrome.runtime.sendMessage({
            action: "docsProgress",
            chunk: completed,
            total: chunks.length,
            phase,
          }).catch(() => {});
        }
      }
    }
    const workerCount = Math.min(DOC_PARALLEL_WORKERS, chunks.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
    if (failed) throw failed;
    return parts.join("\n\n");
  };

  const formatChunks = splitTranscriptForDocs(
    transcriptText,
    docChunkSizeFor(transcriptText),
  ).map(
    (chunk) => `请将以下内容整理成格式化的逐字稿：\n\n${chunk}`,
  );
  const formattedText = await runDocPool(formatChunks, systemPrompt, "format");

  // Product rules are driven by the SOURCE TEXT language, not by `modes`.
  // Chinese source: the formatted text already IS the Chinese transcript, so
  // no translation pass runs and no separate zh text is produced (v9 :2365-2367).
  if (isMostlyChinese(transcriptText)) {
    return {
      success: true,
      formattedText,
      formattedTextZh: "",
      bilingualParagraphs: null,
    };
  }

  // Non-Chinese source: optionally build the paragraph-aligned bilingual pass.
  const pairs = wantBilingual
    ? await buildBilingualParagraphs(formattedText, videoTitle)
    : null;

  let formattedTextZh;
  // v10 F4: only reuse the aligned bilingual targets when EVERY paragraph was
  // translated. Otherwise fall through to the whole-text translation pass so
  // the Chinese transcript stays clean; the bilingual doc still shows honest
  // placeholder rows for the missing segments.
  const pairsComplete =
    Array.isArray(pairs) && pairs.every((pair) => pair.target);
  if (pairsComplete) {
    formattedTextZh = pairs.map((pair) => pair.target).join("\n\n");
  } else if (wantZh === false) {
    // Caller explicitly asked for no Chinese transcript.
    formattedTextZh = "";
  } else {
    // wantZh === true, or wantZh === null (modes omitted → exact v9 behaviour):
    // run the v9 whole-text translation pass.
    const translatePrompt = `你是一位专业的翻译。请将以下视频逐字稿翻译成流畅自然的简体中文。

要求：
1. 保持原文的段落结构（段落间空行分隔）
2. 翻译准确、口语化、自然流畅
3. 专有名词保留原文或采用通用译名
4. 直接输出译文，不要加任何标记或说明`;

    const translateChunks = splitTranscriptForDocs(
      formattedText,
      docChunkSizeFor(formattedText),
    ).map(
      (chunk) => `请将以下内容翻译成简体中文：\n\n${chunk}`,
    );
    formattedTextZh = await runDocPool(
      translateChunks,
      translatePrompt,
      "translate",
    );
  }

  return {
    success: true,
    formattedText,
    formattedTextZh,
    bilingualParagraphs: pairs || null,
  };
}

// ============================================================
// v10 — PUNCTUATION RESTORATION (R2)
// ============================================================

/**
 * Removes every punctuation / whitespace character so two strings can be
 * compared by their bare CJK+latin character sequence. This is the guard that
 * proves the model ONLY inserted punctuation and never rewrote the transcript.
 */
function stripPunctuationForCompare(text) {
  return String(text || "").replace(
    /[\s，。！？；：、“”‘’《》…—.,!?;:"'`()（）\[\]【】]/g,
    "",
  );
}

/**
 * v10 F17 guard: proves the model only INSERTED characters. Compares the two
 * strings by their non-whitespace character sequences; every non-whitespace
 * character of the source must appear in the output in order (the output may
 * add extra characters between them). This catches models that delete existing
 * source punctuation/symbols (e.g. 《》, quotes) to slip past
 * stripPunctuationForCompare, which ignores exactly those characters.
 */
function isInsertionOnly(sourceText, outputText) {
  const src = String(sourceText || "").replace(/\s+/g, "");
  const out = String(outputText || "").replace(/\s+/g, "");
  let i = 0;
  for (let k = 0; k < out.length && i < src.length; k++) {
    if (out[k] === src[i]) i++;
  }
  return i === src.length;
}

/**
 * Aligns untrusted punctuation output by exact stable ID. A candidate is only
 * accepted when it is non-empty AND its punctuation-stripped form is identical
 * to the source's stripped form; anything else becomes an explicit row error.
 * Never guesses by position.
 */
function normalizePunctuatedBatch(parsed, sourceSegments) {
  const candidates = Array.isArray(parsed?.segments) ? parsed.segments : [];
  const sourceById = new Map(
    sourceSegments.map((segment) => [segment.id, segment]),
  );
  const punctuatedById = new Map();

  candidates.forEach((candidate) => {
    if (
      typeof candidate?.id !== "string" ||
      typeof candidate?.text !== "string" ||
      !sourceById.has(candidate.id) ||
      punctuatedById.has(candidate.id)
    ) {
      return;
    }
    const text = candidate.text.trim();
    const source = sourceById.get(candidate.id);
    if (
      text &&
      stripPunctuationForCompare(text) ===
        stripPunctuationForCompare(source.text) &&
      isInsertionOnly(source.text, text)
    ) {
      punctuatedById.set(candidate.id, text);
    }
  });

  return {
    segments: sourceSegments.map((source) => ({
      id: source.id,
      text: punctuatedById.get(source.id) || "",
      error: punctuatedById.has(source.id)
        ? ""
        : "Punctuation output altered the transcript text",
    })),
  };
}

/**
 * Restores Chinese punctuation on 1–4 unbroken subtitle segments. The model may
 * only insert punctuation; normalizePunctuatedBatch rejects any rewrite so the
 * panel can safely fall back to its local heuristic.
 */
async function handlePunctuateTranscript(content, videoTitle) {
  try {
    const settings = await getSettings();
    if (!settings.aiApiKey) {
      return { success: false, error: "AI API key not configured" };
    }

    const sourceSegments = validateTranscriptBatchRequest(content);
    const systemPrompt = await loadPromptSection(
      "punctuate.html",
      "System prompt",
      { videoTitle: videoTitle || "Unknown" },
    );
    const userPrompt = await loadPromptSection("punctuate.html", "User prompt", {
      videoTitle: videoTitle || "Unknown",
      segmentsJson: JSON.stringify({ segments: sourceSegments }),
    });

    const { text } = await requestAiCompletion({
      temperature: 0.1,
      maxTokens: 4096,
      responseFormat: { type: "json_object" },
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    });

    const parsed = parseLooseJson(text);
    const aligned = normalizePunctuatedBatch(parsed, sourceSegments);
    if (!aligned.segments.some((segment) => segment.text)) {
      return {
        success: false,
        error: "Punctuation restoration returned no valid segments",
      };
    }
    return { success: true, segments: aligned.segments };
  } catch (error) {
    console.error("[Youtube Bilibili Digest] Punctuate error:", error);
    return { success: false, error: error.message || "Punctuation failed" };
  }
}

// ============================================================
// v10 — PARAGRAPH-ALIGNED BILINGUAL PASS (R3)
// ============================================================

/**
 * Splits formatted transcript text into paragraphs on blank lines — identical
 * boundary to buildWordHtml so paragraph count matches the Word output.
 */
function splitFormattedParagraphs(text) {
  return String(text || "")
    .split(/\n\n+/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0);
}

/**
 * Splits a single oversized paragraph (>4000 chars) at sentence boundaries so
 * every piece fits the batch contract. IDs use the `p{i}-{n}` form (hyphen,
 * never a dot) to satisfy /^[A-Za-z0-9:_-]{1,128}$/.
 */
function splitOversizedParagraph(paragraph, index) {
  const pieces = [];
  let rest = String(paragraph || "");
  const MAX = 4000;
  while (rest.length > MAX) {
    const windowText = rest.slice(0, MAX);
    const lowerBound = Math.floor(MAX * 0.55);
    let cut = -1;
    let match;
    const sentenceRe = /[.!?。！？]/g;
    while ((match = sentenceRe.exec(windowText))) {
      if (match.index >= lowerBound) cut = match.index + 1;
    }
    if (cut <= 0) {
      const clauseRe = /[,，;；]/g;
      while ((match = clauseRe.exec(windowText))) {
        if (match.index >= lowerBound) cut = match.index + 1;
      }
    }
    if (cut <= 0) cut = MAX;
    pieces.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) pieces.push(rest);
  return pieces
    .filter((piece) => piece.length > 0)
    .map((piece, partIndex) => ({
      id: `p${index}-${partIndex + 1}`,
      text: piece,
    }));
}

/**
 * Packs {id,text} paragraphs into batches of at most
 * DOC_TRANSLATE_BATCH_MAX_SEGMENTS segments and DOC_TRANSLATE_BATCH_CHARS
 * characters, whichever binds first. For typical subtitle-length rows the
 * character budget is the binding constraint.
 *
 * Note this envelope is independent of validateTranscriptBatchRequest, which
 * guards the panel's translateContent path and is not called here.
 */
function packParagraphBatches(paragraphs) {
  const batches = [];
  let current = [];
  let currentChars = 0;
  for (const segment of paragraphs) {
    const length = segment.text.length;
    if (
      current.length > 0 &&
      (current.length >= DOC_TRANSLATE_BATCH_MAX_SEGMENTS ||
        currentChars + length > DOC_TRANSLATE_BATCH_CHARS)
    ) {
      batches.push(current);
      current = [];
      currentChars = 0;
    }
    current.push(segment);
    currentChars += length;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/**
 * v11: ID-exact alignment for the reverse-direction note pass. It keeps the
 * contract of normalizeTranslatedSegmentBatch - match by exact ID only, report
 * an explicit per-row error when a row is missing, never guess by position - but
 * drops the "output must look Chinese" heuristic, which only applies when the
 * target language IS Simplified Chinese.
 */
function normalizeDocNoteBatch(parsed, sourceSegments) {
  const candidates = Array.isArray(parsed?.segments) ? parsed.segments : [];
  const sourceById = new Map(
    sourceSegments.map((segment) => [segment.id, segment]),
  );
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
    if (text) {
      translatedById.set(candidate.id, text);
    }
  });

  return {
    segments: sourceSegments.map((source) => ({
      id: source.id,
      text: translatedById.get(source.id) || "",
      error: translatedById.has(source.id)
        ? ""
        : "Missing or invalid translation",
    })),
  };
}

/**
 * v11: ID-keyed translation core, extracted from buildBilingualParagraphs so the
 * timestamp-note pass can reuse it. Input is already [{id, text}]; output is
 * [{id, source, target, error}] in the input's order.
 *
 * Packs the segments into char-budget-driven batches (see packParagraphBatches),
 * runs a bounded pool of DOC_TRANSLATE_PARALLEL_WORKERS, retries a failed batch
 * with exponential backoff via withAiRetry, broadcasts `docsProgress` per batch,
 * and NEVER aborts the whole pass: a segment that still fails keeps target "" so
 * the caller can print an explicit placeholder instead of shifting translations
 * out of alignment.
 *
 * @param {Array} segments - [{id, text}] with stable, unique ids
 * @param {Object} options - { videoTitle, phase, targetLanguage }
 *   targetLanguage omitted or "zh" loads doc-paragraph-translate.html (the
 *   hand-tuned Simplified-Chinese prompt); any other value loads
 *   doc-note-translate.html and is passed to it as a template variable.
 */
async function translateSegmentsById(segments, options = {}) {
  const withIds = Array.isArray(segments) ? segments : [];
  if (withIds.length === 0) return [];

  const videoTitle = options?.videoTitle;
  const phase = options?.phase || "align";
  const targetLanguage = String(options?.targetLanguage || "").trim();
  const toChinese = !targetLanguage || targetLanguage.toLowerCase() === "zh";
  const promptFile = toChinese
    ? "doc-paragraph-translate.html"
    : "doc-note-translate.html";
  // The zh path passes exactly the variables it passed before the extraction, so
  // the prompt text reaching the model is byte-for-byte identical to v10.
  const promptVars = toChinese
    ? { videoTitle: videoTitle || "Unknown" }
    : { videoTitle: videoTitle || "Unknown", targetLanguage };

  const batches = packParagraphBatches(withIds);
  const targetById = new Map();
  const errorById = new Map();

  const runOneBatch = async (batch) => {
    const systemPrompt = await loadPromptSection(
      promptFile,
      "System prompt",
      promptVars,
    );
    const userPrompt = await loadPromptSection(promptFile, "User prompt", {
      ...promptVars,
      segmentsJson: JSON.stringify({ segments: batch }),
    });
    const callOnce = () =>
      requestAiCompletion({
        temperature: 0.2,
        maxTokens: 8192,
        responseFormat: { type: "json_object" },
        idleTimeoutMs: DOC_IDLE_TIMEOUT_MS,
        hardTimeoutMs: DOC_HARD_TIMEOUT_MS,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
      });
    const result = await withAiRetry(callOnce);
    return parseLooseJson(result.text);
  };

  let nextIndex = 0;
  let completed = 0;
  async function worker() {
    while (nextIndex < batches.length) {
      const batch = batches[nextIndex++];
      try {
        const parsed = await runOneBatch(batch);
        const aligned = toChinese
          ? normalizeTranslatedSegmentBatch(parsed, batch)
          : normalizeDocNoteBatch(parsed, batch);
        aligned.segments.forEach((segment) => {
          if (segment.text) {
            targetById.set(segment.id, segment.text);
          } else {
            errorById.set(segment.id, segment.error || "Missing translation");
          }
        });
      } catch (error) {
        batch.forEach((segment) =>
          errorById.set(segment.id, error.message || "Translation failed"),
        );
      }
      completed++;
      chrome.runtime.sendMessage({
        action: "docsProgress",
        chunk: completed,
        total: batches.length,
        phase,
      }).catch(() => {});
    }
  }
  const workerCount = Math.min(DOC_TRANSLATE_PARALLEL_WORKERS, batches.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  return withIds.map((segment) => ({
    id: segment.id,
    source: segment.text,
    target: targetById.get(segment.id) || "",
    error: errorById.get(segment.id) || "",
  }));
}

/**
 * Translates each formatted paragraph independently and aligns the result by
 * stable ID, producing [{id, source, target, error}].
 *
 * v11: this is now only the paragraph splitter. The batching, worker pool,
 * retry, progress broadcast and ID alignment live in translateSegmentsById, but
 * the returned shape is unchanged because handleFormatTranscriptForDocs reads
 * pair.target both to decide whether the bilingual pass is complete and to
 * rebuild formattedTextZh.
 */
async function buildBilingualParagraphs(formattedText, videoTitle) {
  const paragraphs = splitFormattedParagraphs(formattedText);
  const withIds = [];
  paragraphs.forEach((paragraph, index) => {
    if (paragraph.length > 4000) {
      withIds.push(...splitOversizedParagraph(paragraph, index));
    } else {
      withIds.push({ id: `p${index}`, text: paragraph });
    }
  });
  if (withIds.length === 0) return [];

  return translateSegmentsById(withIds, { videoTitle });
}

/**
 * v11: Translates the user's handwritten timestamp notes into the video's own
 * language, so the Docs export can place the notes next to the non-Chinese
 * "original text" column. This is the reverse direction of
 * buildBilingualParagraphs: the notes are usually written in Chinese while the
 * target is whatever language the video was actually spoken in.
 *
 * Mirrors handlePunctuateTranscript: full try/catch, an explicit failure when no
 * AI key is configured, and { success, segments } on success. A single row that
 * the model drops is reported in that row's `error` field instead of failing the
 * whole call, exactly like the bilingual pass.
 *
 * @param {Array} segments - [{id, text}] note segments sent by the side panel
 * @param {string} videoTitle - Video title, used only as terminology context
 * @param {string} targetLanguage - Target language name or code
 * @returns {Object} - { success, segments } or { success: false, error }
 */
async function handleTranslateDocSegments(segments, videoTitle, targetLanguage) {
  try {
    const settings = await getSettings();
    if (!settings.aiApiKey) {
      return { success: false, error: "AI API key not configured" };
    }

    const cleaned = (Array.isArray(segments) ? segments : [])
      .map((segment) => ({
        id: typeof segment?.id === "string" ? segment.id.trim() : "",
        text: typeof segment?.text === "string" ? segment.text.trim() : "",
      }))
      .filter((segment) => segment.id && segment.text);
    if (cleaned.length === 0) {
      return { success: false, error: "No note segments to translate" };
    }

    const translated = await translateSegmentsById(cleaned, {
      videoTitle,
      // Deliberately distinct from the Docs "align" phase so a note pass can
      // never move the Docs progress indicator.
      phase: "notes",
      targetLanguage,
    });
    return { success: true, segments: translated };
  } catch (error) {
    console.error("[Youtube Bilibili Digest] Doc segment translation error:", error);
    return {
      success: false,
      error: error.message || "Note translation failed",
    };
  }
}

// Pure validators are exposed for the repository's Node tests only.
globalThis.__YTD_TRANSLATION_TESTING__ = {
  requestAiCompletion,
  callAiTranslation,
  validateTranscriptBatchRequest,
  normalizeTranslatedSegmentBatch,
  handleTranslateContent,
  stripPunctuationForCompare,
  isInsertionOnly,
  normalizePunctuatedBatch,
  splitFormattedParagraphs,
  splitOversizedParagraph,
  packParagraphBatches,
  // v11: exported so the repository's Node tests can cross-check them against the
  // side panel's own copies - the two sides must never disagree about what counts
  // as Chinese, nor about how a batch is aligned by ID.
  isMostlyChinese,
  translateSegmentsById,
  normalizeDocNoteBatch,
  reorderTracksByLangPreference,
};
