/**
 * Shared, non-secret configuration helpers.
 *
 * API keys are stored in chrome.storage.local by options.js. This file contains
 * defaults and validation only, so it is safe to publish.
 *
 * Local remix (Qwen-ready fork):
 * - Supadata has been removed entirely. Transcripts are fetched directly from
 *   the video platform (YouTube caption tracks / Bilibili official subtitle
 *   API using the browser's own login state), so no transcript API key is
 *   needed.
 * - The AI provider is fully user-configurable through any OpenAI-compatible
 *   endpoint: base URL + API key + model name. Defaults point at Alibaba
 *   Cloud DashScope (Qwen) but any compatible gateway works.
 */
var YTD_SETTINGS = (() => {
  const STORAGE_KEY = "ytd_settings";
  const DEFAULTS = Object.freeze({
    provider: "openai-compatible",
    aiApiKey: "",
    aiBaseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    aiModel: "qwen-plus",
    enableBilibili: true,
  });

  function sanitizeBaseUrl(input) {
    const trimmed = String(input || "").trim().replace(/\/+$/, "");
    if (!trimmed) return DEFAULTS.aiBaseUrl;
    // The chat completions path is appended at request time; users may paste
    // a URL that already ends with /chat/completions or /v1.
    const withoutChat = trimmed.replace(/\/chat\/completions$/i, "");
    if (!/^https?:\/\/[^\s]+$/.test(withoutChat)) return DEFAULTS.aiBaseUrl;
    return withoutChat;
  }

  function sanitizeModel(input) {
    const trimmed = String(input || "").trim();
    if (!trimmed) return DEFAULTS.aiModel;
    if (!/^[\w.\-:/]{1,128}$/.test(trimmed)) return DEFAULTS.aiModel;
    return trimmed;
  }

  function normalize(input = {}) {
    // Legacy "custom" provider entries predate the three-field design. They
    // carried an old base URL and model name we cannot trust, so reset them
    // to the defaults and clear the AI key; the user enters fresh values.
    const isLegacyCustom = !!input && input.provider === "custom";
    return {
      provider: DEFAULTS.provider,
      aiApiKey:
        isLegacyCustom || typeof input.aiApiKey !== "string"
          ? ""
          : input.aiApiKey.trim(),
      aiBaseUrl: sanitizeBaseUrl(isLegacyCustom ? undefined : input.aiBaseUrl),
      aiModel: sanitizeModel(isLegacyCustom ? undefined : input.aiModel),
      enableBilibili:
        typeof input.enableBilibili === "boolean"
          ? input.enableBilibili
          : DEFAULTS.enableBilibili,
    };
  }

  function migrateLegacyCustom(input = {}) {
    return {
      settings: normalize(input),
      migrated: !!input && input.provider === "custom",
    };
  }

  function chatCompletionsUrl(baseUrl) {
    return `${sanitizeBaseUrl(baseUrl)}/chat/completions`;
  }

  function canonicalYouTubeUrl(videoId) {
    const normalized = String(videoId || "").trim();
    if (!/^[A-Za-z0-9_-]{6,20}$/.test(normalized)) {
      throw new Error("Invalid YouTube video ID.");
    }
    return `https://www.youtube.com/watch?v=${normalized}`;
  }

  function canonicalBilibiliUrl(bvid) {
    const normalized = String(bvid || "").trim();
    if (!/^BV[0-9A-Za-z]{10}$/.test(normalized)) {
      throw new Error("Invalid Bilibili BV ID.");
    }
    return `https://www.bilibili.com/video/${normalized}`;
  }

  return {
    STORAGE_KEY,
    DEFAULTS,
    normalize,
    migrateLegacyCustom,
    sanitizeBaseUrl,
    sanitizeModel,
    chatCompletionsUrl,
    canonicalYouTubeUrl,
    canonicalBilibiliUrl,
  };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = YTD_SETTINGS;
}
