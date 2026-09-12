/**
 * Shared, non-secret configuration helpers.
 *
 * API keys are stored in chrome.storage.local by options.js. This file contains
 * defaults and validation only, so it is safe to publish.
 *
 * Local remix (Qwen-ready fork):
 * - YouTube transcripts come from the Supadata API (optional key), the same
 *   service the upstream YouTube Digest extension uses. Bilibili subtitles
 *   are still fetched directly with the browser's own Bilibili login, so
 *   users who never open YouTube need no Supadata key at all.
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
    // Optional Supadata API key, used only for YouTube transcripts. Bilibili
    // subtitles are fetched directly and never need this key.
    supadataApiKey: "",
    // Optional ASR fallback: when a video has no platform subtitles, the
    // user may opt in to AI speech recognition. Off by default.
    asrEnabled: false,
    asrBaseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    asrApiKey: "",
    asrModel: "qwen3-asr-flash",
    // ASR request protocol shape. "chat-audio" keeps the existing DashScope-
    // compatible /chat/completions + input_audio path; "whisper-multipart"
    // targets OpenAI/Groq-compatible /audio/transcriptions multipart uploads.
    // The default reproduces current behavior, so existing users need no
    // migration.
    asrProtocol: "chat-audio",
    // Optional BCP-47 style source-language hint for the ASR request. Empty
    // means the ASR service auto-detects the language, which is the current
    // behavior; existing users are unaffected and no migration is needed.
    asrLanguage: "",
    // Export document format. "doc" keeps the existing Word-compatible HTML
    // pseudo-.doc file; "docx" selects a real OOXML document. The default
    // reproduces current behavior, so existing users need no migration.
    docsFormat: "doc",
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

  function sanitizeAsrBaseUrl(input) {
    const trimmed = String(input || "").trim().replace(/\/+$/, "");
    if (!trimmed) return DEFAULTS.asrBaseUrl;
    const withoutChat = trimmed.replace(/\/chat\/completions$/i, "");
    if (!/^https?:\/\/[^\s]+$/.test(withoutChat)) return DEFAULTS.asrBaseUrl;
    return withoutChat;
  }

  function sanitizeAsrModel(input) {
    const trimmed = String(input || "").trim();
    if (!trimmed) return DEFAULTS.asrModel;
    if (!/^[\w.\-:/]{1,128}$/.test(trimmed)) return DEFAULTS.asrModel;
    return trimmed;
  }

  // Whitelist the ASR request protocol; unknown values fall back to the
  // current default so old settings keep working unchanged.
  function sanitizeAsrProtocol(input) {
    const trimmed = String(input || "").trim();
    const allowed = ["chat-audio", "whisper-multipart"];
    if (!allowed.includes(trimmed)) return DEFAULTS.asrProtocol;
    return trimmed;
  }

  // Validate an optional BCP-47 style language hint. Empty is legal and means
  // "auto-detect"; falling back to empty (never a concrete language) avoids
  // misjudging non-Chinese source audio.
  function sanitizeAsrLanguage(input) {
    const trimmed = String(input || "").trim().toLowerCase();
    if (!trimmed) return "";
    if (!/^[a-z]{2}(-[a-z0-9]{2,10})?$/.test(trimmed)) return "";
    // R6: return ONLY the ISO 639-1 primary subtag. Do not revert this to
    // `return trimmed;`: the ASR services reject a region subtag outright.
    // DashScope qwen3-asr documents asr_options.language as one of 26
    // two-letter codes (zh/yue/en/ja/de/ko/ru/fr/pt/ar/it/es/hi/id/th/tr/uk/
    // vi/cs/da/fil/fi/is/ms/no/pl/sv) and answers "ja-jp" with HTTP 400
    // InternalError.Algo.InvalidParameter "Language code 'ja-jp' is not
    // recognized"; OpenAI/Groq whisper /audio/transcriptions also wants
    // ISO-639-1, so truncating improves the whisper-multipart branch too.
    // The regex above stays as it is on purpose: it rejects plainly invalid
    // input ("english", three-segment "zh-Hans-CN"), while this split only
    // normalizes an already-valid tag. Two different jobs, both required.
    return trimmed.split("-")[0];
  }

  // Whitelist the export document format; unknown values fall back to the
  // current default so old settings keep working unchanged.
  function sanitizeDocsFormat(input) {
    const trimmed = String(input || "").trim();
    const allowed = ["doc", "docx"];
    if (!allowed.includes(trimmed)) return DEFAULTS.docsFormat;
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
      supadataApiKey:
        typeof input.supadataApiKey === "string"
          ? input.supadataApiKey.trim()
          : "",
      asrEnabled:
        typeof input.asrEnabled === "boolean"
          ? input.asrEnabled
          : DEFAULTS.asrEnabled,
      asrBaseUrl: sanitizeAsrBaseUrl(input.asrBaseUrl),
      asrApiKey: typeof input.asrApiKey === "string" ? input.asrApiKey.trim() : "",
      asrModel: sanitizeAsrModel(input.asrModel),
      asrProtocol: sanitizeAsrProtocol(input.asrProtocol),
      asrLanguage: sanitizeAsrLanguage(input.asrLanguage),
      docsFormat: sanitizeDocsFormat(input.docsFormat),
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
    sanitizeAsrBaseUrl,
    sanitizeAsrModel,
    sanitizeAsrProtocol,
    sanitizeAsrLanguage,
    sanitizeDocsFormat,
    chatCompletionsUrl,
    canonicalYouTubeUrl,
    canonicalBilibiliUrl,
  };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = YTD_SETTINGS;
}
