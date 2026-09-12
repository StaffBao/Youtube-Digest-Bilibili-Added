/*
 * Wrapped in an IIFE so a second injection (background's sendToContentTab retry)
 * re-runs this file in a fresh function scope instead of colliding on the
 * top-level `const DEBUG` / `let` bindings ("Identifier already declared").
 */
(() => {
/**
 * CONTENT SCRIPT
 *
 * This script runs ON the video page itself (YouTube or Bilibili). It can see
 * and modify the page DOM (the HTML elements).
 *
 * It handles:
 * 1. Extracting video info (title, channel/UP name) from the page
 * 2. Adding a "Digest" button to the action area (next to Share/Save)
 * 3. Injecting a "Note" overlay button on the video player
 *
 * Think of it like a robot sitting inside the video tab,
 * reading the page and making small visual changes.
 */

const DEBUG = false;
const debugLog = (...args) => {
  if (DEBUG) console.log(...args);
};

// ============================================================
// PLATFORM DETECTION
// ============================================================

function currentPlatform() {
  const host = window.location?.hostname || "";
  if (host.includes("bilibili.com")) return "bilibili";
  return "youtube";
}

function isVideoPage() {
  const pathname = window.location?.pathname || "";
  if (currentPlatform() === "bilibili") {
    return pathname.startsWith("/video/");
  }
  return pathname.includes("/watch");
}

// ============================================================
// GLOBAL STATE
// ============================================================

let ytdNoteButton = null;
let ytdNoteButtonTimer = null;
let ytdNoteKeyboardListenerAdded = false;
let ytdNoteButtonRetryTimer = null;
let ytdDigestButton = null;
let digestButtonObserver = null;
let digestButtonReconcileTimer = null;
let digestButtonResizeListenerAdded = false;

// ============================================================
// INITIALIZATION
// ============================================================

/**
 * When the page loads, inject our Digest button and Note button.
 * We wait a bit for the video site's UI to fully render.
 */
async function init() {
  // Bilibili mode can be turned off in settings. Skip all injection there.
  if (currentPlatform() === "bilibili") {
    try {
      const configStatus = await chrome.runtime.sendMessage({
        action: "checkConfig",
      });
      if (!configStatus?.bilibiliEnabled) return;
    } catch (_error) {
      // Background unavailable; proceed with injection rather than blocking.
    }
  }

  // Register the global "n" keyboard shortcut once
  if (!ytdNoteKeyboardListenerAdded) {
    document.addEventListener("keydown", handleNoteKeyboardShortcut);
    ytdNoteKeyboardListenerAdded = true;
  }

  // Try to inject the buttons immediately
  injectDigestButton();
  tryInjectNoteButton();

  // Also set up an observer to handle dynamic content loading
  // (both sites are SPAs, so elements appear/disappear as you navigate)
  setupButtonObserver();
  setupDigestButtonResizeListener();
  setupBilibiliNavigationWatch();
}

/**
 * Attempts to inject the note button. If the player container isn't ready yet,
 * retry a few times with a short delay. Video sites render the player
 * asynchronously after navigation, so a single immediate attempt can miss it.
 */
function tryInjectNoteButton() {
  if (!isVideoPage()) return;

  // Clear any existing retry so we don't stack timers
  if (ytdNoteButtonRetryTimer) {
    clearInterval(ytdNoteButtonRetryTimer);
    ytdNoteButtonRetryTimer = null;
  }

  let attempts = 0;
  const maxAttempts = 30; // ~3 seconds of retrying

  function attempt() {
    attempts++;
    const playerContainer = document.querySelector(
      "#movie_player.html5-video-player, #movie_player, .html5-video-player, " +
        "#bilibili-player .bpx-player-video-area, " +
        ".bpx-player-container, #bilibiliPlayer",
    );

    if (playerContainer) {
      injectNoteButton();
      if (ytdNoteButtonRetryTimer) {
        clearInterval(ytdNoteButtonRetryTimer);
        ytdNoteButtonRetryTimer = null;
      }
      return;
    }

    if (attempts >= maxAttempts) {
      debugLog(
        "[Youtube Bilibili Digest Content] Player container not found after retries, giving up",
      );
      if (ytdNoteButtonRetryTimer) {
        clearInterval(ytdNoteButtonRetryTimer);
        ytdNoteButtonRetryTimer = null;
      }
    }
  }

  attempt();
  if (!ytdNoteButton || !ytdNoteButton.isConnected) {
    ytdNoteButtonRetryTimer = setInterval(attempt, 100);
  }
}

// Run init when DOM is ready
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}

// ============================================================
// MESSAGE HANDLING
// ============================================================

// [v4] In-memory store for chunked audio transfer. Chrome's extension
// messaging caps a single message at 64MiB, and a full video's audio
// exceeds that after base64, so the audio is kept here and handed to the
// side panel in 8MiB chunks.
let audioTransferStore = null; // { id, bytes: Uint8Array, chunkSize, totalChunks }

/**
 * Listen for messages from the side panel or background script.
 * When they ask for video info, we read it from the page.
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  debugLog("[Youtube Bilibili Digest Content] Received message:", message.action, message);

  if (message.action === "getVideoInfo") {
    // Read video title and channel name from the page
    const info = extractVideoInfo();
    debugLog("[Youtube Bilibili Digest Content] Returning video info:", info);
    sendResponse(info);
    return false; // Synchronous response
  }

  if (message.action === "highlightMoments") {
    // Key moment markers disabled — chapters are shown in the side panel only.
    sendResponse({ success: true });
    return false;
  }

  if (message.action === "getCurrentTime") {
    // Return the current video playback time (used by auto-scroll)
    const video = findVideoElement();
    sendResponse({
      currentTime: video ? Math.floor(video.currentTime) : 0,
      paused: video ? video.paused : true,
    });
    return false;
  }

  if (message.action === "seekTo") {
    // Jump the video to a specific timestamp
    debugLog("[Youtube Bilibili Digest Content] Seeking to:", message.seconds);
    seekToTimestamp(message.seconds);
    sendResponse({ success: true });
    return false;
  }

  if (message.action === "showNoteSavedFeedback") {
    // Show brief feedback that note was saved
    showNoteSavedToast(message.note);
    sendResponse({ success: true });
    return false;
  }

  // YouTube timedtext relay: fetch the timedtext URL from the content script's
  // own context (same-origin with youtube.com) so YouTube doesn't reject the
  // request as cross-site. The background service worker's origin is
  // chrome-extension://, which YouTube's timedtext endpoint has been rejecting
  // since the 2025 PO Token enforcement.
  if (message.action === "fetchTimedtext") {
    const url = String(message.url || "");
    if (!url || !url.startsWith("https://www.youtube.com/")) {
      sendResponse({ success: false, error: "Invalid timedtext URL" });
      return false;
    }
    fetch(url, { credentials: "include" })
      .then(async (r) => ({
        success: r.ok,
        status: r.status,
        contentType: r.headers.get("content-type") || "",
        body: r.ok ? await r.text() : "",
      }))
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true; // async response
  }

  // [v4] ASR audio: call playurl API and download audio entirely inside the
  // page's content script. This runs in the bilibili.com context so the
  // request automatically carries the browser's cookies and Bilibili login
  // session — the CDN URL will have fresh signatures and is guaranteed valid.
  // Returns base64-encoded audio bytes to avoid structured-clone limits.
  if (message.action === "fetchBilibiliAudio") {
    const bvid = String(message.bvid || "").trim();
    if (!/^BV[0-9A-Za-z]{10}$/.test(bvid)) {
      sendResponse({ success: false, error: "INVALID_BVID" });
      return false;
    }
    // Resolve cid: first from __INITIAL_STATE__, then from pagelist API.
    let cid = "";
    try {
      cid =
        window.__INITIAL_STATE__?.videoData?.cid ||
        document.defaultView?.__INITIAL_STATE__?.videoData?.cid ||
        "";
    } catch (_) {}
    const resolveCid = cid
      ? Promise.resolve(cid)
      : fetch(
          `https://api.bilibili.com/x/player/pagelist?bvid=${encodeURIComponent(bvid)}`,
          { credentials: "include", headers: { Referer: "https://www.bilibili.com/" } },
        )
          .then((r) => r.json())
          .then((j) => String(Array.isArray(j?.data) ? j.data[0]?.cid || "" : ""))
          .catch(() => "");

    resolveCid
      .then((resolvedCid) => {
        if (!resolvedCid) {
          sendResponse({ success: false, error: "Could not resolve video cid." });
          return;
        }
        return fetch(
          `https://api.bilibili.com/x/player/playurl?bvid=${encodeURIComponent(bvid)}&cid=${encodeURIComponent(resolvedCid)}&fnval=16`,
          { credentials: "include", headers: { Referer: "https://www.bilibili.com/" } },
        )
          .then((r) => r.json())
          .then((j) => {
            const audioStreams = Array.isArray(j?.data?.dash?.audio)
              ? j.data.dash.audio
              : [];
            if (audioStreams.length === 0) {
              sendResponse({ success: false, error: "No audio stream found for this video." });
              return;
            }
            const best = [...audioStreams].sort(
              // v11: ASR only needs 16kHz mono, so when the panel sets
              // preferLowBitrate we pick the LOWEST-bandwidth DASH audio track to
              // save bandwidth and memory. The background relay forwards the
              // whole message object via chrome.tabs.sendMessage, so this flag
              // arrives untouched with NO background.js change. When the flag is
              // absent the comparator is byte-identical to today (highest first).
              !!message.preferLowBitrate
                ? (a, b) => (Number(a.bandwidth) || 0) - (Number(b.bandwidth) || 0)
                : (a, b) => (Number(b.bandwidth) || 0) - (Number(a.bandwidth) || 0),
            )[0];
            const rawUrl = best?.baseUrl || best?.base_url || "";
            const audioUrl = rawUrl.startsWith("//")
              ? `https:${rawUrl}`
              : rawUrl;
            if (!audioUrl) {
              sendResponse({ success: false, error: "Audio stream URL is empty." });
              return;
            }
            // Fetch audio in-page. credentials MUST be "omit": the CDN replies
            // with `Access-Control-Allow-Origin: *` (wildcard), which CORS
            // forbids for credentialed requests. Anti-hotlinking here relies
            // on the browser UA + Referer + URL signature, not cookies.
            return fetch(audioUrl, { credentials: "omit" })
              .then((r) => {
                if (!r.ok) return { error: "Audio CDN download error: HTTP " + r.status + " " + r.statusText };
                return r.arrayBuffer();
              })
              .then((buf) => {
                if (buf && buf.error) {
                  sendResponse({ success: false, error: buf.error });
                  return;
                }
                // Keep the raw bytes in the page; the side panel pulls them
                // back in chunks (see the fetchAudioChunk handler) because a
                // single response over 64MiB is rejected by Chrome messaging.
                const bytes = new Uint8Array(buf);
                const chunkSize = 8 * 1024 * 1024; // 8 MiB raw ≈ 11 MiB base64
                const totalChunks = Math.max(1, Math.ceil(bytes.length / chunkSize));
                const transferId =
                  "tx_" + Date.now().toString(36) + "_" +
                  Math.floor(Math.random() * 1e6).toString(36);
                audioTransferStore = {
                  id: transferId,
                  bytes,
                  chunkSize,
                  totalChunks,
                };
                sendResponse({
                  success: true,
                  transferId,
                  totalSize: bytes.length,
                  chunkSize,
                  totalChunks,
                });
              })
              .catch((err) => {
                sendResponse({
                  success: false,
                  error: "Audio CDN download error: " + String(err && err.message || err),
                });
              });
          });
      })
      .catch((err) => {
        sendResponse({
          success: false,
          error: "Bilibili API error: " + String(err && err.message || err),
        });
      });
    return true; // async response
  }

  // [v4] Pull one base64-encoded slice of a previously downloaded audio
  // file. The side panel calls this repeatedly to assemble the full audio
  // without ever exceeding the 64MiB per-message cap.
  if (message.action === "fetchAudioChunk") {
    const store = audioTransferStore;
    if (!store || store.id !== message.transferId) {
      sendResponse({
        success: false,
        error: "Audio transfer session expired. Please retry transcription.",
      });
      return false;
    }
    const index = Number(message.index);
    if (!Number.isInteger(index) || index < 0 || index >= store.totalChunks) {
      sendResponse({ success: false, error: "Invalid chunk index." });
      return false;
    }
    const start = index * store.chunkSize;
    const slice = store.bytes.subarray(
      start,
      Math.min(start + store.chunkSize, store.bytes.length),
    );
    let bin = "";
    for (let i = 0; i < slice.length; i += 8192) {
      bin += String.fromCharCode.apply(null, slice.subarray(i, i + 8192));
    }
    const isLast = index === store.totalChunks - 1;
    if (isLast) {
      // Sequential protocol: after the final chunk the session is done.
      audioTransferStore = null;
    }
    sendResponse({ success: true, index, data: btoa(bin), size: slice.length });
    return false;
  }

  // Unknown action - still send a response to prevent hanging
  debugLog("[Youtube Bilibili Digest Content] Unknown action:", message.action);
  sendResponse({ success: false, error: "Unknown action" });
  return false;
});

// ============================================================
// VIDEO ELEMENT ACCESS (platform-aware)
// ============================================================

function findVideoElement() {
  if (currentPlatform() === "bilibili") {
    return (
      document.querySelector(".bpx-player-video-area video") ||
      document.querySelector("#bilibili-player video") ||
      document.querySelector("video")
    );
  }
  return document.querySelector("video.html5-main-video") || document.querySelector("video");
}

// ============================================================
// DIGEST BUTTON INJECTION
// ============================================================

/**
 * Injects a "Digest" button into the video action bar.
 * The button appears next to Share, Save, etc. below the video.
 *
 * When clicked, it opens the Youtube Bilibili Digest side panel.
 */
function isVisibleDigestHost(element) {
  if (!element || !element.isConnected) return false;

  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return false;

  const style = window.getComputedStyle(element);
  return style.display !== "none" && style.visibility !== "hidden";
}

/**
 * YouTube keeps hidden copies of its responsive action toolbar in the DOM.
 * querySelector() can return one of those 0x0 copies before the toolbar the
 * viewer can actually see, so inspect every candidate and resolve the native
 * button group inside the visible action row for the current video.
 */
function findDigestButtonHost() {
  if (currentPlatform() === "bilibili") {
    return findBilibiliDigestHost();
  }

  const primaryActionRows = Array.from(
    document.querySelectorAll("ytd-watch-metadata #actions-inner"),
  );

  for (const actionRow of primaryActionRows) {
    if (!isVisibleDigestHost(actionRow)) continue;

    const visibleButtonGroup = Array.from(
      actionRow.querySelectorAll("#top-level-buttons-computed"),
    ).find(isVisibleDigestHost);
    if (visibleButtonGroup) return visibleButtonGroup;
  }

  const fallbackCandidates = Array.from(
    document.querySelectorAll(
      "ytd-watch-metadata #actions #top-level-buttons-computed, " +
        "ytd-watch-metadata #top-level-buttons-computed, " +
        "#primary #actions #top-level-buttons-computed",
    ),
  );

  return (
    fallbackCandidates.find(
      (candidate) =>
        isVisibleDigestHost(candidate) &&
        (candidate.closest("ytd-watch-metadata") ||
          candidate.closest("#primary")),
    ) || null
  );
}

/**
 * Bilibili's action row lives below the player. Resolve the visible toolbar
 * so the Digest button can join the like/coin/share group.
 */
function findBilibiliDigestHost() {
  const candidates = Array.from(
    document.querySelectorAll(
      ".video-toolbar-left, .video-toolbar, .toolbar, #arc_toolbar_report",
    ),
  );
  return candidates.find(isVisibleDigestHost) || null;
}

function createDigestButton() {
  const digestButton = document.createElement("button");
  digestButton.id = "ytd-digest-button";
  digestButton.type = "button";
  digestButton.setAttribute("aria-label", "Open Youtube Bilibili Digest");
  digestButton.innerHTML = `
    <span class="ytd-digest-icon" style="font-size: 11px;">▶</span>
    <span class="ytd-digest-label">Digest</span>
  `;

  // Style the button — rounded pill in our terracotta accent, sized to sit
  // comfortably among the site's native action buttons.
  digestButton.style.cssText = `
    display: inline-flex;
    align-items: center;
    gap: 7px;
    padding: 0 18px;
    height: 36px;
    border: none;
    border-radius: 18px;
    background: #c8674f;
    color: white;
    font-family: "Roboto", "Arial", sans-serif;
    font-size: 14px;
    font-weight: 600;
    cursor: pointer;
    margin-right: 8px;
    transition: background 0.2s, transform 0.1s, box-shadow 0.2s;
    box-shadow: 0 2px 8px rgba(200, 103, 79, 0.3);
    flex: 0 0 auto;
    align-self: center;
    width: max-content;
    min-width: max-content;
    max-width: max-content;
    white-space: nowrap;
  `;

  // Hover effects
  digestButton.addEventListener("mouseenter", () => {
    digestButton.style.background = "#b25742";
    digestButton.style.transform = "scale(1.02)";
  });

  digestButton.addEventListener("mouseleave", () => {
    digestButton.style.background = "#c8674f";
    digestButton.style.transform = "scale(1)";
  });

  // Click handler — open the side panel
  digestButton.addEventListener("click", async (e) => {
    e.preventDefault();
    e.stopPropagation();

    debugLog("[Youtube Bilibili Digest] Digest button clicked");

    // Send message to background script to open side panel
    try {
      const result = await chrome.runtime.sendMessage({
        action: "openSidePanel",
      });
      debugLog("[Youtube Bilibili Digest] openSidePanel response:", result);
    } catch (err) {
      console.error("[Youtube Bilibili Digest] Failed to open side panel:", err);
    }
  });

  ytdDigestButton = digestButton;
  return digestButton;
}

/**
 * Reconciles the Digest button with the currently visible action row.
 * This is intentionally idempotent because both sites rebuild their watch
 * page during navigation and at responsive breakpoints.
 */
function injectDigestButton() {
  const existingButtons = Array.from(
    document.querySelectorAll("#ytd-digest-button"),
  );

  if (!isVideoPage()) {
    existingButtons.forEach((button) => button.remove());
    ytdDigestButton = null;
    return false;
  }

  const actionsContainer = findDigestButtonHost();
  if (!actionsContainer) {
    debugLog("[Youtube Bilibili Digest Content] Visible actions container not found yet");
    return false;
  }

  let digestButton = existingButtons.find(
    (button) => button === ytdDigestButton,
  );

  if (!digestButton) {
    existingButtons.forEach((button) => button.remove());
    existingButtons.length = 0;
    digestButton = createDigestButton();
  }

  existingButtons.forEach((button) => {
    if (button !== digestButton) button.remove();
  });

  if (digestButton.parentElement !== actionsContainer) {
    if (currentPlatform() === "bilibili") {
      // Bilibili: append to the end so we don't disrupt the native toolbar
      // flex layout (like/coin/share/fav buttons).
      actionsContainer.insertBefore(digestButton, actionsContainer.firstChild);
    } else {
      // YouTube turns #actions-inner into a vertical flex column at narrow
      // breakpoints. A direct child there stretches into a full-width second
      // row, so keep Digest inside the native horizontal button group and
      // prepend it to preserve visibility when space is limited.
      actionsContainer.insertBefore(digestButton, actionsContainer.firstChild);
    }
  }

  debugLog("[Youtube Bilibili Digest Content] Digest button reconciled");
  return true;
}

function scheduleDigestButtonReconciliation(delay = 80) {
  if (digestButtonReconcileTimer) {
    clearTimeout(digestButtonReconcileTimer);
  }

  digestButtonReconcileTimer = setTimeout(() => {
    digestButtonReconcileTimer = null;
    injectDigestButton();
  }, delay);
}

function setupDigestButtonResizeListener() {
  if (digestButtonResizeListenerAdded) return;

  window.addEventListener("resize", () => {
    scheduleDigestButtonReconciliation(120);
  });
  digestButtonResizeListenerAdded = true;
}

/**
 * Sets up a MutationObserver to watch for dynamic content changes.
 * When the action buttons container appears (after navigation), we inject our button.
 */
function setupButtonObserver() {
  if (digestButtonObserver) return;

  digestButtonObserver = new MutationObserver(() => {
    if (!isVideoPage()) return;
    scheduleDigestButtonReconciliation();
    if (!ytdNoteButton || !ytdNoteButton.isConnected) {
      tryInjectNoteButton();
    }
  });

  // Watch the entire body for changes (SPAs rebuild large chunks of the DOM)
  digestButtonObserver.observe(document.body, { childList: true, subtree: true });
}

// ============================================================
// NOTE BUTTON (Overlay on Video Player)
// ============================================================

/**
 * Injects a "Note" button overlay on top of the video player.
 * The button appears when the mouse enters or moves over the player and hides
 * after the cursor stays still for more than 2 seconds or leaves the player.
 */
function injectNoteButton() {
  // Don't inject if we're not on a video page
  if (!isVideoPage()) return;

  // Don't inject if button already exists and is properly tracked.
  // If a stale button exists (e.g., from a previous content-script instance),
  // remove it and re-inject so event listeners are attached to the live one.
  const existingButton = document.getElementById("ytd-note-button");
  if (existingButton) {
    if (ytdNoteButton === existingButton && existingButton.isConnected) {
      return; // already injected and connected
    }
    existingButton.remove();
  }

  // Find the video player container. Both sites rebuild this dynamically, so
  // we try the most common selectors.
  const playerContainer = document.querySelector(
    "#movie_player.html5-video-player, " +
      "#movie_player, " +
      ".html5-video-player, " +
      "#bilibili-player .bpx-player-video-area, " +
      ".bpx-player-container, " +
      "#bilibiliPlayer",
  );

  if (!playerContainer) {
    debugLog(
      "[Youtube Bilibili Digest Content] Player container not found yet, will retry",
    );
    return;
  }

  // Ensure the player container has non-static positioning for the absolute
  // note button.
  playerContainer.style.position = "relative";

  debugLog("[Youtube Bilibili Digest Content] Injecting note button");

  // Create the note button — a soft rounded pill that floats over the player
  const noteButton = document.createElement("button");
  noteButton.id = "ytd-note-button";
  noteButton.innerHTML = `
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" style="margin-right: 7px;">
      <path d="M12 20h9"></path>
      <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path>
    </svg>
    <span>Note</span>
  `;

  // Soft rounded pill in the terracotta accent, with a gentle shadow.
  // Start hidden; visibility is controlled by mouse activity.
  noteButton.style.cssText = `
    position: absolute;
    top: 16px;
    right: 16px;
    z-index: 9999;
    display: flex;
    align-items: center;
    padding: 9px 16px;
    background: #c8674f;
    color: white;
    border: none;
    border-radius: 999px;
    font-family: system-ui, -apple-system, "Roboto", sans-serif;
    font-size: 13px;
    font-weight: 600;
    letter-spacing: 0.2px;
    cursor: pointer;
    transition: opacity 0.18s ease, transform 0.18s ease, background 0.18s ease, box-shadow 0.18s ease;
    opacity: 0;
    pointer-events: none;
    box-shadow: 0 4px 14px rgba(0,0,0,0.3);
  `;

  ytdNoteButton = noteButton;

  // Show button when mouse enters or moves over the player.
  // Hide after 2 seconds of idle or when the mouse leaves.
  playerContainer.addEventListener("mouseenter", () => {
    showNoteButton();
    resetNoteButtonTimer();
  });

  playerContainer.addEventListener("mousemove", () => {
    showNoteButton();
    resetNoteButtonTimer();
  });

  playerContainer.addEventListener("mouseleave", () => {
    clearTimeout(ytdNoteButtonTimer);
    ytdNoteButtonTimer = null;
    hideNoteButton();
  });

  // Hover effect — lift slightly
  noteButton.addEventListener("mouseenter", () => {
    noteButton.style.background = "#b25742";
    noteButton.style.boxShadow = "0 6px 18px rgba(0,0,0,0.35)";
    noteButton.style.transform = "translateY(-1px)";
  });

  noteButton.addEventListener("mouseleave", () => {
    noteButton.style.background = "#c8674f";
    noteButton.style.boxShadow = "0 4px 14px rgba(0,0,0,0.3)";
    noteButton.style.transform = "translateY(0)";
  });

  // Click handler — save the current moment as a note
  noteButton.addEventListener("click", async (e) => {
    e.preventDefault();
    e.stopPropagation();
    await saveCurrentNote();
  });

  playerContainer.appendChild(noteButton);

  debugLog("[Youtube Bilibili Digest Content] Note button injected");
}

function showNoteButton() {
  if (!ytdNoteButton) return;
  ytdNoteButton.style.opacity = "1";
  ytdNoteButton.style.pointerEvents = "auto";
}

function hideNoteButton() {
  if (!ytdNoteButton) return;
  ytdNoteButton.style.opacity = "0";
  ytdNoteButton.style.pointerEvents = "none";
}

function resetNoteButtonTimer() {
  clearTimeout(ytdNoteButtonTimer);
  ytdNoteButtonTimer = setTimeout(() => {
    hideNoteButton();
  }, 2000);
}

/**
 * Handles the "n" keyboard shortcut for saving a note.
 * Only triggers on video pages and when the user is not typing
 * in an input field.
 */
function handleNoteKeyboardShortcut(e) {
  if (!isVideoPage()) return;
  if (e.key !== "n" && e.key !== "N") return;

  // Ignore if the user is typing in an input/textarea/contenteditable
  const active = document.activeElement;
  if (
    active &&
    (active.tagName === "INPUT" ||
      active.tagName === "TEXTAREA" ||
      active.isContentEditable)
  ) {
    return;
  }

  // Prevent the site's own "n" shortcut (e.g. next video in playlist)
  e.preventDefault();
  e.stopPropagation();

  // Show brief visual feedback on the button, then save
  showNoteButton();
  resetNoteButtonTimer();
  saveCurrentNote();
}

/**
 * Resolves the stable video identifier for the current platform.
 */
function currentVideoIdentifier() {
  if (currentPlatform() === "bilibili") {
    const match = window.location.pathname.match(/\/video\/(BV[0-9A-Za-z]{10})/);
    return match ? match[1] : null;
  }
  return new URLSearchParams(window.location.search).get("v");
}

/**
 * Captures the current timestamp and saves it as a note.
 */
async function saveCurrentNote() {
  debugLog("[Youtube Bilibili Digest] Saving note");

  const video = findVideoElement();
  if (!video) {
    console.error("[Youtube Bilibili Digest] No video element found");
    return;
  }

  // Go back 3 seconds to capture what was just said (user reacts after hearing it)
  const currentTime = Math.max(0, Math.floor(video.currentTime) - 3);
  const videoInfo = extractVideoInfo();
  const videoId = currentVideoIdentifier();

  const noteButton = ytdNoteButton;
  const originalContent = noteButton ? noteButton.innerHTML : "";

  if (noteButton) {
    noteButton.innerHTML =
      '<span style="letter-spacing: 0.2px;">SAVING...</span>';
    noteButton.style.pointerEvents = "none";
  }

  try {
    const result = await chrome.runtime.sendMessage({
      action: "saveNote",
      platform: currentPlatform(),
      videoId: videoId,
      timestamp: currentTime,
      videoTitle: videoInfo.title,
      channelName: videoInfo.channelName,
    });

    if (result.success) {
      if (noteButton) {
        noteButton.innerHTML =
          '<span style="letter-spacing: 0.2px;">SAVED</span>';
        noteButton.style.background = "#7c8b6f";
      }
      showNoteSavedToast(result.note);
    } else {
      if (noteButton) {
        noteButton.innerHTML =
          '<span style="letter-spacing: 0.2px;">ERROR</span>';
      }
      console.error("[Youtube Bilibili Digest] Save note error:", result.error);
    }
  } catch (err) {
    if (noteButton) {
      noteButton.innerHTML =
        '<span style="letter-spacing: 0.2px;">ERROR</span>';
    }
    console.error("[Youtube Bilibili Digest] Save note exception:", err);
  }

  setTimeout(() => {
    if (noteButton) {
      noteButton.innerHTML = originalContent;
      noteButton.style.background = "#c8674f";
      noteButton.style.pointerEvents = "auto";
    }
  }, 2000);
}

/**
 * Shows a toast notification when a note is saved.
 */
function showNoteSavedToast(note) {
  // Remove existing toast
  const existing = document.getElementById("ytd-note-toast");
  if (existing) existing.remove();

  const toast = document.createElement("div");
  toast.id = "ytd-note-toast";
  toast.innerHTML = `
    <div style="font-weight: 700; margin-bottom: 6px; color: #c8674f;">📝 Note saved</div>
    <div style="font-size: 12px; color: #6b6258; margin-bottom: 8px;">${escapeHtmlForContent(note.timestamp)} — ${escapeHtmlForContent(note.videoTitle)}</div>
    <div style="font-size: 13px; line-height: 1.55; color: #2e2a24;">"${escapeHtmlForContent(note.text)}"</div>
    <div style="margin-top: 10px; font-size: 11px;">
      <a href="${escapeHtmlForContent(note.timestampedUrl)}" style="color: #c8674f; font-weight: 600; text-decoration: none;">🔗 Copy link</a>
    </div>
  `;

  toast.style.cssText = `
    position: fixed;
    bottom: 20px;
    right: 20px;
    z-index: 999999;
    background: #ffffff;
    border: 1px solid #ece5d9;
    border-radius: 14px;
    padding: 16px 20px;
    max-width: 350px;
    box-shadow: 0 12px 32px rgba(50, 42, 32, 0.2);
    font-family: system-ui, -apple-system, "Roboto", sans-serif;
    animation: ytdSlideIn 0.3s ease;
  `;

  // Add animation keyframes
  const style = document.createElement("style");
  style.textContent = `
    @keyframes ytdSlideIn {
      from { transform: translateX(100%); opacity: 0; }
      to { transform: translateX(0); opacity: 1; }
    }
  `;
  document.head.appendChild(style);

  // Copy link handler
  toast.querySelector("a").addEventListener("click", async (e) => {
    e.preventDefault();
    try {
      await navigator.clipboard.writeText(note.timestampedUrl);
      e.target.textContent = "✓ Copied!";
    } catch (err) {
      console.error("Copy failed:", err);
    }
  });

  document.body.appendChild(toast);

  // Auto-dismiss after 5 seconds
  setTimeout(() => {
    toast.style.animation = "ytdSlideIn 0.3s ease reverse";
    setTimeout(() => toast.remove(), 300);
  }, 5000);
}

// ============================================================
// VIDEO INFO EXTRACTION
// ============================================================

/**
 * Reads the video title, channel name, and description directly from the page.
 */
function extractVideoInfo() {
  if (currentPlatform() === "bilibili") {
    return extractBilibiliVideoInfo();
  }

  // The video title is in an h1 element inside the #title container
  const titleElement = document.querySelector(
    "h1.ytd-watch-metadata yt-formatted-string, #title h1 yt-formatted-string",
  );

  // The channel name is in the channel info section
  const channelElement = document.querySelector(
    "#channel-name yt-formatted-string a, ytd-channel-name yt-formatted-string a",
  );

  // Video duration from the video element
  const videoElement = document.querySelector("video.html5-main-video");

  // Video description — YouTube has this in a few possible places
  const descriptionElement = document.querySelector(
    "#description-inner, " +
      "ytd-watch-metadata #description yt-attributed-string, " +
      "#description yt-formatted-string, " +
      "ytd-expander#description yt-attributed-string",
  );

  return {
    title: titleElement?.textContent?.trim() || "",
    channelName: channelElement?.textContent?.trim() || "",
    duration: videoElement?.duration || 0,
    description: descriptionElement?.textContent?.trim() || "",
  };
}

/**
 * Reads Bilibili's video metadata from its watch page.
 */
function extractBilibiliVideoInfo() {
  const titleElement = document.querySelector("h1.video-title, h1[data-title], .video-title");
  const upElement = document.querySelector(
    ".up-name, a.up-name, .username, #v_upinfo .username",
  );
  const videoElement = findVideoElement();
  const descriptionElement = document.querySelector(
    "#v_desc, .desc, .video-desc",
  );

  return {
    title:
      titleElement?.textContent?.trim() ||
      document.title.replace(/_哔哩哔哩_bilibili$/, "").trim(),
    channelName: upElement?.textContent?.trim() || "",
    duration: videoElement?.duration || 0,
    description: descriptionElement?.textContent?.trim() || "",
  };
}

// ============================================================
// SEEK TO TIMESTAMP
// ============================================================

/**
 * Jumps the video to a specific timestamp (in seconds).
 * This is called when the user clicks a timestamp in the side panel.
 *
 * We simply set the video element's .currentTime property,
 * which is the standard HTML5 way to seek in a video.
 */
function seekToTimestamp(seconds) {
  const video = findVideoElement();
  if (!video) {
    console.error("[Youtube Bilibili Digest Content] No video element found for seek");
    return;
  }

  debugLog("[Youtube Bilibili Digest Content] Seeking to:", seconds);
  video.currentTime = seconds;
  // Also play the video if it's paused
  if (video.paused) {
    video.play().catch(() => {}); // Ignore autoplay errors
  }
}

function escapeHtmlForContent(text) {
  const div = document.createElement("div");
  div.textContent = text || "";
  return div.innerHTML;
}

// ============================================================
// PAGE NAVIGATION DETECTION
// ============================================================

/**
 * Both YouTube and Bilibili are SPAs. When the user clicks a new video the
 * page content is swapped without a full reload, so our content script stays
 * alive but must detect navigation and re-inject the buttons.
 */
function resetInjectedUi() {
  // Remove old buttons (they will be re-injected for the new video)
  document
    .querySelectorAll("#ytd-digest-button")
    .forEach((button) => button.remove());
  ytdDigestButton = null;
  if (digestButtonReconcileTimer) {
    clearTimeout(digestButtonReconcileTimer);
    digestButtonReconcileTimer = null;
  }

  const existingNoteButton = document.getElementById("ytd-note-button");
  if (existingNoteButton) existingNoteButton.remove();

  // Reset note button state
  ytdNoteButton = null;
  clearTimeout(ytdNoteButtonTimer);
  ytdNoteButtonTimer = null;
  if (ytdNoteButtonRetryTimer) {
    clearInterval(ytdNoteButtonRetryTimer);
    ytdNoteButtonRetryTimer = null;
  }

  // Remove any toasts
  const existingToast = document.getElementById("ytd-note-toast");
  if (existingToast) existingToast.remove();
}

// YouTube's SPA navigation hook
document.addEventListener("yt-navigate-finish", () => {
  resetInjectedUi();
  // Re-inject buttons for the new video (with a small delay for YouTube to render)
  setTimeout(() => {
    scheduleDigestButtonReconciliation(0);
    tryInjectNoteButton();
  }, 500);
});

/**
 * Bilibili does not fire a navigation event, so watch URL changes ourselves
 * and re-inject the buttons when the viewer moves to another video.
 */
let bilibiliLastHref = "";
function setupBilibiliNavigationWatch() {
  if (currentPlatform() !== "bilibili") return;
  bilibiliLastHref = window.location.href;

  window.addEventListener("popstate", handlePossibleBilibiliNavigation);
  const originalPushState = history.pushState;
  history.pushState = function (...args) {
    const result = originalPushState.apply(this, args);
    handlePossibleBilibiliNavigation();
    return result;
  };
}

function handlePossibleBilibiliNavigation() {
  if (window.location.href === bilibiliLastHref) return;
  bilibiliLastHref = window.location.href;

  resetInjectedUi();
  setTimeout(() => {
    scheduleDigestButtonReconciliation(0);
    tryInjectNoteButton();
  }, 500);
}
})();
