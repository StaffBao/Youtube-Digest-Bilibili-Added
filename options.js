const YTD_OPTIONS = (() => {
  const LANGUAGE_STORAGE_KEY = "ytd_options_language";
  const PREVIEW_STORAGE_PREFIX = "youtubeDigestPreview:";
  const SUPPORTED_LANGUAGES = new Set(["en", "zh-CN"]);

  const COPY = {
    en: {
      pageTitle: "Youtube Bilibili Digest Settings",
      languageGroupLabel: "Interface language",
      heading: "Bring your own AI endpoint",
      lede:
        "Settings stay in this Chrome profile. AI requests are sent only to the endpoint you configure below. This open-source extension has no developer server or analytics.",
      transcriptProvider: "Transcript provider",
      transcriptSummaryLabel: "Transcript source",
      transcriptDirectName: "YouTube via Supadata, Bilibili direct",
      transcriptBadge: "Supadata key optional",
      transcriptHelp:
        "YouTube captions (including AI auto-captions) are fetched through the Supadata transcript API, so a Supadata key is only needed if you use YouTube. Bilibili subtitles are fetched directly with your browser's own Bilibili login and never need this key.",
      supadataApiKeyLabel: "Supadata API key (YouTube only, optional)",
      supadataPlaceholder: "Paste your Supadata key",
      supadataHelp:
        "Used to fetch timestamped YouTube subtitles, including AI auto-captions. Leave empty if you only use Bilibili. ",
      supadataLink: "Create a Supadata account and key",
      supadataHelpSuffix: ". Supadata generates the key during onboarding.",
      bilibiliToggleLabel: "Enable Bilibili mode (bilibili.com video pages)",
      bilibiliHelp:
        "Turn on digests, translation, and notes for Bilibili videos. Sign in to bilibili.com in this browser first: subtitles are only available to logged-in accounts.",
      aiProvider: "AI provider",
      providerSummaryLabel: "Supported AI provider",
      providerName: "Any OpenAI-compatible endpoint",
      providerBadge: "Configurable in this version",
      aiBaseUrlLabel: "API base URL",
      aiBaseUrlPlaceholder:
        "https://dashscope.aliyuncs.com/compatible-mode/v1",
      aiBaseUrlHelp:
        "The Chat Completions base URL of your provider. The default is Alibaba Cloud DashScope (Qwen), and any OpenAI-compatible gateway works. ",
      aiBaseUrlLink: "DashScope OpenAI-compatible endpoint guide",
      aiBaseUrlHelpSuffix: ".",
      aiApiKeyLabel: "API key",
      aiApiKeyPlaceholder: "Paste your API key",
      aiApiKeyHelp:
        "Used for overviews, explanations, translation, and note polishing. ",
      aiApiKeyLink: "Create a DashScope API key",
      aiApiKeyHelpSuffix: ".",
      aiModelLabel: "Model",
      aiModelPlaceholder: "qwen-plus",
      aiModelHelp:
        "The model name accepted by your endpoint, for example qwen-plus, qwen-max, deepseek-chat, or gpt-4o-mini.",
      privacyNote:
        "When you use AI features, your configured endpoint receives the video transcript and relevant video context. Review your provider's terms and pricing before saving.",
      asrProvider: "AI subtitle generation (ASR)",
      asrSummaryLabel: "ASR fallback source",
      asrName: "Optional fallback for videos without subtitles",
      asrBadge: "Optional",
      asrToggleLabel:
        "Enable AI subtitle generation when no platform subtitles exist",
      asrHelp:
        "When a video has no subtitles from the platform, the extension can transcribe its audio track with an ASR model. Off by default; audio chunks are sent only to the endpoint you configure below.",
      asrBaseUrlLabel: "ASR API base URL",
      asrBaseUrlPlaceholder:
        "https://dashscope.aliyuncs.com/compatible-mode/v1",
      asrApiKeyLabel: "ASR API key",
      asrApiKeyPlaceholder: "Leave empty to reuse the AI API key above",
      asrApiKeyHelp:
        "Optional. Leave empty to reuse the AI provider API key above.",
      asrModelLabel: "ASR model",
      asrModelPlaceholder: "qwen3-asr-flash",
      asrModelHelp:
        "The ASR model name accepted by your endpoint, for example qwen3-asr-flash or qwen-audio-3.0-asr-flash.",
      asrProtocolLabel: "Request protocol",
      asrProtocolChatOption:
        "DashScope / Qwen audio chat (chat/completions, default)",
      asrProtocolWhisperOption:
        "OpenAI / Groq compatible (audio/transcriptions multipart)",
      asrProtocolHelp:
        "Chooses the request shape. Keep chat-audio for DashScope/Qwen audio-chat endpoints. Switch to whisper-multipart when the ASR base URL points to an OpenAI/Groq-compatible /audio/transcriptions gateway.",
      asrLanguageLabel: "Source language (optional)",
      asrLanguagePlaceholder:
        "Leave empty for auto-detect, e.g. en, ja, ko",
      asrLanguageHelp:
        "Empty is safest: the ASR service auto-detects the spoken language. Because this extension can transcribe any non-Chinese source language, forcing a language can misjudge the audio. Set an ISO 639-1 two-letter code such as en, ja, or ko only to force one language.",
      asrPrivacyNote:
        "When ASR runs, audio from the video is sent to your configured endpoint in chunks. Timestamps of generated subtitles are approximate. Review your provider's pricing before use.",
      saveSettings: "Save settings",
      localRemix: "Local remix",
      customizationTitle: "Need a provider that is not OpenAI-compatible?",
      customizationPurpose: "Edit and copy a safe prompt for your coding agent",
      agentBadge: "Coding agent ready",
      customizationIntro:
        "You can edit the prompt directly. Complete these three steps before copying:",
      customizationStepFolder:
        "Open the extracted Youtube Bilibili Digest project folder in your coding agent.",
      customizationStepReplace:
        "Replace [PROVIDER] with the service you want to use.",
      customizationStepKeys:
        "Never include API keys in the prompt or chat. Enter them yourself after the code is ready.",
      customizationPromptLabel: "Editable customization prompt",
      customizationReminderLabel: "Prompt reminder",
      customizationReminder:
        "Before copying, replace [PROVIDER] with the provider you want to use.",
      customizationPrompt:
        "Customize this local Youtube Bilibili Digest workspace to add support for [PROVIDER], which does not follow the OpenAI Chat Completions API. Work only in the current workspace. Before editing, verify that it contains manifest.json and that the manifest name is Youtube Bilibili Digest. If verification fails, stop and ask me to open the extracted Youtube Bilibili Digest project folder in my coding agent. Do not search other folders, edit a guessed copy, assume an installation path, or claim Chrome can reveal the absolute OS source path. Keep the existing OpenAI-compatible endpoint settings (API base URL, API key, model name) working unchanged. Add the new provider as an additional request adapter, with its own endpoint, request format, and retry behavior, so one provider does not affect another. Preserve bring-your-own-key and local Chrome storage. Never put API keys in source code, commits, logs, screenshots, this prompt, or chat; after the code is ready, tell me where to enter the key myself. Update README.html, README.zh-CN.html, PRIVACY.html, and SECURITY.html to match. This project has no build step, no package manager, and no test suite, so verify your change by reloading the unpacked extension in Chrome and exercising it on a real YouTube video, then explain those steps to me.",
      copyCustomizationPrompt: "Copy edited prompt",
      localData: "Local data",
      localDataHelp:
        "Digests, translations, and notes are stored only in this Chrome profile. You can remove them at any time.",
      clearCache: "Clear cached digests",
      deleteNotes: "Delete all notes",
      resetData: "Reset extension data",
      footer:
        'Read <a href="PRIVACY.html" target="_blank">PRIVACY.html</a> in the repository for the complete data-flow description.',
      migrationWarning:
        "Custom provider settings were removed safely. Your previous AI key was cleared. Enter your API base URL, API key, and model to continue.",
      saving: "Saving…",
      addAiKey: "Add an API key.",
      saved: "Saved. Reopen Youtube Bilibili Digest to use these settings.",
      saveFailed: "Could not save settings. Please try again.",
      copying: "Copying…",
      promptCopied: "Edited prompt copied.",
      copyFailed:
        "Could not copy the prompt. Select the prompt text and copy it manually.",
      clearedDigests: ({ count }) =>
        `Cleared ${count} cached digest${count === 1 ? "" : "s"}.`,
      notesDeleted: "Deleted all saved notes.",
      resetConfirm:
        "Delete API settings, cached digests, translations, and saved notes from this Chrome profile?",
      allDataDeleted: "All Youtube Bilibili Digest data was deleted.",
      settingsLoadFailed:
        "Could not load saved settings. You can still preview this page.",
    },
    "zh-CN": {
      pageTitle: "Youtube Bilibili Digest 设置",
      languageGroupLabel: "界面语言",
      heading: "使用你自己的 AI 接口",
      lede:
        "设置仅保存在当前 Chrome 个人资料中。AI 请求只会发送到你下方配置的接口。本开源扩展没有开发者服务器，也不使用分析服务。",
      transcriptProvider: "字幕服务",
      transcriptSummaryLabel: "字幕来源",
      transcriptDirectName: "YouTube 经 Supadata，Bilibili 直连",
      transcriptBadge: "Supadata 密钥可选",
      transcriptHelp:
        "YouTube 字幕（含 AI 自动字幕）通过 Supadata 字幕 API 获取，因此只有使用 YouTube 时才需要 Supadata 密钥。Bilibili 字幕使用你浏览器中已登录的 B站账号直接获取，永远不需要该密钥。",
      supadataApiKeyLabel: "Supadata API 密钥（仅 YouTube，可选）",
      supadataPlaceholder: "粘贴你的 Supadata 密钥",
      supadataHelp:
        "用于获取带时间戳的 YouTube 字幕（含 AI 自动字幕）。只使用 Bilibili 时可留空。",
      supadataLink: "创建 Supadata 账号并获取密钥",
      supadataHelpSuffix: "。Supadata 会在引导流程中生成密钥。",
      bilibiliToggleLabel: "启用 Bilibili 模式（bilibili.com 视频页）",
      bilibiliHelp:
        "为 B站视频启用摘要、翻译和笔记。请先在本浏览器登录 bilibili.com：字幕仅对已登录账号可用。",
      aiProvider: "AI 服务",
      providerSummaryLabel: "支持的 AI 服务",
      providerName: "任意 OpenAI 兼容接口",
      providerBadge: "当前版本可配置",
      aiBaseUrlLabel: "API 接口地址",
      aiBaseUrlPlaceholder:
        "https://dashscope.aliyuncs.com/compatible-mode/v1",
      aiBaseUrlHelp:
        "你的服务商提供的 Chat Completions 接口地址。默认为阿里云百炼 DashScope（Qwen），任何 OpenAI 兼容网关均可使用。",
      aiBaseUrlLink: "DashScope OpenAI 兼容接口文档",
      aiBaseUrlHelpSuffix: "。",
      aiApiKeyLabel: "API 密钥",
      aiApiKeyPlaceholder: "粘贴你的 API 密钥",
      aiApiKeyHelp: "用于生成概览、解释内容、翻译字幕和润色笔记。",
      aiApiKeyLink: "创建 DashScope API 密钥",
      aiApiKeyHelpSuffix: "。",
      aiModelLabel: "模型",
      aiModelPlaceholder: "qwen-plus",
      aiModelHelp:
        "你的接口可接受的模型名称，例如 qwen-plus、qwen-max、deepseek-chat 或 gpt-4o-mini。",
      privacyNote:
        "使用 AI 功能时，你配置的接口会收到视频字幕及相关视频上下文。保存前请查看该服务商的服务条款和价格。",
      asrProvider: "AI 字幕生成（ASR）",
      asrSummaryLabel: "ASR 兜底来源",
      asrName: "无字幕视频的可选兜底方案",
      asrBadge: "可选",
      asrToggleLabel: "当视频没有平台字幕时，启用 AI 字幕生成",
      asrHelp:
        "当视频没有平台提供的字幕时，插件可以用 ASR 模型转写音频轨道生成字幕。默认关闭；音频分块只会发送到你下方配置的接口。",
      asrBaseUrlLabel: "ASR 接口地址",
      asrBaseUrlPlaceholder:
        "https://dashscope.aliyuncs.com/compatible-mode/v1",
      asrApiKeyLabel: "ASR 密钥",
      asrApiKeyPlaceholder: "留空则复用上方的 AI 密钥",
      asrApiKeyHelp: "可选。留空则复用上方 AI 服务的密钥。",
      asrModelLabel: "ASR 模型",
      asrModelPlaceholder: "qwen3-asr-flash",
      asrModelHelp:
        "你的接口可接受的 ASR 模型名称，例如 qwen3-asr-flash 或 qwen-audio-3.0-asr-flash。",
      asrProtocolLabel: "请求协议",
      asrProtocolChatOption:
        "DashScope / Qwen 音频对话（chat/completions，默认）",
      asrProtocolWhisperOption:
        "OpenAI / Groq 兼容（audio/transcriptions multipart）",
      asrProtocolHelp:
        "决定请求的形状。DashScope/Qwen 音频对话接口请保持 chat-audio；当 ASR 接口地址指向 OpenAI/Groq 兼容的 /audio/transcriptions 网关时，切换为 whisper-multipart。",
      asrLanguageLabel: "原语言（可选）",
      asrLanguagePlaceholder: "留空 = 自动识别，例如 en、ja、ko",
      asrLanguageHelp:
        "留空最安全：由 ASR 服务自动识别语种。因为本扩展支持转写任意非中文原语言，强制指定语言可能导致误判。仅在需要强制某语言时填写 en、ja、ko 之类的 ISO 639-1 两字母语言码。",
      asrPrivacyNote:
        "启用 ASR 后，视频音频会分块发送到你配置的接口。生成的字幕时间戳为近似值。使用前请查看该服务商的计费说明。",
      saveSettings: "保存设置",
      localRemix: "本地改造",
      customizationTitle: "需要接入非 OpenAI 兼容的服务？",
      customizationPurpose: "编辑并复制一段可安全交给编程 Agent 的提示词",
      agentBadge: "可交给编程 Agent",
      customizationIntro: "你可以直接编辑提示词。复制前完成以下三步：",
      customizationStepFolder:
        "在编程 Agent 中打开 Youtube Bilibili Digest 解压后的项目文件夹。",
      customizationStepReplace: "把 [PROVIDER] 替换成你想使用的服务。",
      customizationStepKeys:
        "不要在提示词或聊天中加入 API 密钥。代码准备好后，请自行填写。",
      customizationPromptLabel: "可编辑的自定义提示词",
      customizationReminderLabel: "提示词提醒",
      customizationReminder: "复制前，请先把 [PROVIDER] 替换成你想使用的服务。",
      customizationPrompt:
        "请为当前本地 Youtube Bilibili Digest 工作区增加对 [PROVIDER] 的支持，该服务不遵循 OpenAI Chat Completions API。只在当前工作区中操作。编辑前，先确认其中包含 manifest.json，且 manifest 中的 name 是 Youtube Bilibili Digest。如果验证失败，请停止，并让我在编程 Agent 中打开 Youtube Bilibili Digest 解压后的项目文件夹。不要搜索其他文件夹，不要编辑猜测的副本，不要假设安装路径，也不要声称 Chrome 可以显示操作系统中的绝对源码路径。保持现有 OpenAI 兼容接口设置（API 接口地址、API 密钥、模型名称）继续可用、不做改动。把新服务作为额外的请求适配器加入，使用它自己的 endpoint、请求格式和重试逻辑，避免不同服务相互影响。保留用户自带密钥模式和 Chrome 本地存储。不要把 API 密钥写入源代码、提交记录、日志、截图、这段提示词或聊天；代码准备好后，请告诉我应该在哪里自行填写密钥。并同步更新 README.html、README.zh-CN.html、PRIVACY.html 和 SECURITY.html。本项目没有构建步骤、没有包管理器，也没有测试套件，请通过在 Chrome 中重新加载已解压的扩展、并在真实 YouTube 视频上实际运行来验证你的修改，最后向我说明这些步骤。",
      copyCustomizationPrompt: "复制编辑后的提示词",
      localData: "本地数据",
      localDataHelp:
        "摘要、翻译和笔记仅保存在当前 Chrome 个人资料中。你可以随时删除。",
      clearCache: "清除缓存的摘要",
      deleteNotes: "删除全部笔记",
      resetData: "重置扩展数据",
      footer:
        '完整数据流说明请参阅仓库中的 <a href="PRIVACY.html" target="_blank">PRIVACY.html</a>。',
      migrationWarning:
        "已安全移除自定义服务设置。你之前填写的 AI 密钥已清除。请输入 API 接口地址、API 密钥和模型以继续使用。",
      saving: "正在保存…",
      addAiKey: "请添加 API 密钥。",
      saved: "已保存。请重新打开 Youtube Bilibili Digest 以使用这些设置。",
      saveFailed: "无法保存设置，请重试。",
      copying: "正在复制…",
      promptCopied: "已复制编辑后的提示词。",
      copyFailed: "无法复制提示词。请选中提示词文本并手动复制。",
      clearedDigests: ({ count }) => `已清除 ${count} 条缓存摘要。`,
      notesDeleted: "已删除全部已保存的笔记。",
      resetConfirm:
        "要从当前 Chrome 个人资料中删除 API 设置、缓存摘要、翻译和已保存的笔记吗？",
      allDataDeleted: "已删除全部 Youtube Bilibili Digest 数据。",
      settingsLoadFailed: "无法加载已保存的设置，但你仍可预览此页面。",
    },
  };

  function normalizeLanguage(language) {
    return SUPPORTED_LANGUAGES.has(language) ? language : "en";
  }

  function translate(language, key, params = {}) {
    const normalizedLanguage = normalizeLanguage(language);
    const value = COPY[normalizedLanguage][key] ?? COPY.en[key] ?? "";
    return typeof value === "function" ? value(params) : value;
  }

  function createStorageAdapter(chromeApi, fallbackStorage) {
    const chromeStorage = chromeApi?.storage?.local;
    const memoryStorage = new Map();

    function fallbackKeys() {
      const keys = [];
      if (!fallbackStorage) return keys;
      try {
        for (let index = 0; index < fallbackStorage.length; index += 1) {
          const key = fallbackStorage.key(index);
          if (key?.startsWith(PREVIEW_STORAGE_PREFIX)) keys.push(key);
        }
      } catch (_error) {
        return [];
      }
      return keys;
    }

    function readFallbackValue(key) {
      try {
        const rawValue = fallbackStorage?.getItem(
          `${PREVIEW_STORAGE_PREFIX}${key}`,
        );
        if (rawValue !== null && rawValue !== undefined) {
          return JSON.parse(rawValue);
        }
      } catch (_error) {
        // Fall through to memory when localStorage is unavailable or malformed.
      }
      return memoryStorage.get(key);
    }

    function writeFallbackValue(key, value) {
      memoryStorage.set(key, value);
      try {
        fallbackStorage?.setItem(
          `${PREVIEW_STORAGE_PREFIX}${key}`,
          JSON.stringify(value),
        );
      } catch (_error) {
        // The in-memory copy keeps a restricted preview functional.
      }
    }

    return {
      async get(keys) {
        if (chromeStorage) return chromeStorage.get(keys);

        const requestedKeys =
          keys === null
            ? [
                ...new Set([
                  ...memoryStorage.keys(),
                  ...fallbackKeys().map((key) =>
                    key.slice(PREVIEW_STORAGE_PREFIX.length),
                  ),
                ]),
              ]
            : Array.isArray(keys)
              ? keys
              : [keys];

        return Object.fromEntries(
          requestedKeys
            .map((key) => [key, readFallbackValue(key)])
            .filter(([, value]) => value !== undefined),
        );
      },

      async set(items) {
        if (chromeStorage) return chromeStorage.set(items);
        for (const [key, value] of Object.entries(items)) {
          writeFallbackValue(key, value);
        }
      },

      async remove(keys) {
        if (chromeStorage) return chromeStorage.remove(keys);
        for (const key of Array.isArray(keys) ? keys : [keys]) {
          memoryStorage.delete(key);
          try {
            fallbackStorage?.removeItem(`${PREVIEW_STORAGE_PREFIX}${key}`);
          } catch (_error) {
            // Memory removal is sufficient for this preview session.
          }
        }
      },

      async clear() {
        if (chromeStorage) return chromeStorage.clear();
        memoryStorage.clear();
        for (const key of fallbackKeys()) {
          try {
            fallbackStorage.removeItem(key);
          } catch (_error) {
            // Continue clearing any remaining preview keys.
          }
        }
      },
    };
  }

  async function readPreferredLanguage(storage) {
    const stored = await storage.get(LANGUAGE_STORAGE_KEY);
    return normalizeLanguage(stored[LANGUAGE_STORAGE_KEY]);
  }

  async function persistPreferredLanguage(storage, language) {
    const normalizedLanguage = normalizeLanguage(language);
    await storage.set({ [LANGUAGE_STORAGE_KEY]: normalizedLanguage });
    return normalizedLanguage;
  }

  function updateLanguageButtonState(buttons, language) {
    const normalizedLanguage = normalizeLanguage(language);
    for (const button of buttons) {
      button.setAttribute(
        "aria-pressed",
        String(button.dataset.language === normalizedLanguage),
      );
    }
  }

  function updateLocalizedPrompt(textarea, prompt) {
    const selectionStart = textarea.selectionStart;
    const selectionEnd = textarea.selectionEnd;
    const selectionDirection = textarea.selectionDirection;
    const scrollTop = textarea.scrollTop;
    const scrollLeft = textarea.scrollLeft;

    textarea.value = prompt;

    if (
      Number.isInteger(selectionStart) &&
      Number.isInteger(selectionEnd) &&
      typeof textarea.setSelectionRange === "function"
    ) {
      textarea.setSelectionRange(
        Math.min(selectionStart, prompt.length),
        Math.min(selectionEnd, prompt.length),
        selectionDirection || "none",
      );
    }
    textarea.scrollTop = scrollTop;
    textarea.scrollLeft = scrollLeft;
  }

  function createPromptDrafts() {
    return {
      en: translate("en", "customizationPrompt"),
      "zh-CN": translate("zh-CN", "customizationPrompt"),
    };
  }

  function switchPromptDraft(
    drafts,
    currentLanguage,
    nextLanguage,
    currentValue,
  ) {
    const normalizedCurrentLanguage = normalizeLanguage(currentLanguage);
    const normalizedNextLanguage = normalizeLanguage(nextLanguage);
    drafts[normalizedCurrentLanguage] = String(currentValue ?? "");
    if (typeof drafts[normalizedNextLanguage] !== "string") {
      drafts[normalizedNextLanguage] = translate(
        normalizedNextLanguage,
        "customizationPrompt",
      );
    }
    return {
      language: normalizedNextLanguage,
      prompt: drafts[normalizedNextLanguage],
    };
  }

  async function copyPromptValue(clipboard, value) {
    await clipboard.writeText(value);
  }

  function getSafeLocalStorage(root) {
    try {
      return root.localStorage;
    } catch (_error) {
      return null;
    }
  }

  function initialize(root = globalThis) {
    const doc = root.document;
    const settingsApi = root.YTD_SETTINGS;
    if (!doc || !settingsApi) return;

    const storage = createStorageAdapter(
      root.chrome,
      getSafeLocalStorage(root),
    );
    const form = doc.getElementById("settingsForm");
    const aiBaseUrlInput = doc.getElementById("aiBaseUrl");
    const aiApiKeyInput = doc.getElementById("aiApiKey");
    const aiModelInput = doc.getElementById("aiModel");
    const supadataApiKeyInput = doc.getElementById("supadataApiKey");
    const enableBilibiliInput = doc.getElementById("enableBilibili");
    const asrEnabledInput = doc.getElementById("asrEnabled");
    const asrBaseUrlInput = doc.getElementById("asrBaseUrl");
    const asrApiKeyInput = doc.getElementById("asrApiKey");
    const asrModelInput = doc.getElementById("asrModel");
    const asrProtocolSelect = doc.getElementById("asrProtocol");
    const asrLanguageInput = doc.getElementById("asrLanguage");
    const customizationPrompt = doc.getElementById("customizationPrompt");
    const copyCustomizationPromptBtn = doc.getElementById(
      "copyCustomizationPromptBtn",
    );
    const copyStatus = doc.getElementById("copyStatus");
    const saveStatus = doc.getElementById("saveStatus");
    const dataStatus = doc.getElementById("dataStatus");
    const languageButtons = [...doc.querySelectorAll("[data-language]")];
    const statusStates = new Map();
    const promptDrafts = createPromptDrafts();
    let currentLanguage = "en";
    // W9: `docsFormat` is owned by the side panel's Docs tab, not by this page,
    // but chrome.storage.local.set overwrites the whole `ytd_settings` object.
    // Without carrying the stored value through, saving here silently reset the
    // user's ".docx" choice back to the "doc" default. Keep the last value seen
    // by loadSettings and write it back verbatim on save.
    let preservedDocsFormat = null;

    function renderStatus(element) {
      const state = statusStates.get(element);
      element.textContent = state
        ? translate(currentLanguage, state.key, state.params)
        : "";
    }

    function setStatus(element, key, params = {}) {
      statusStates.set(element, { key, params });
      renderStatus(element);
    }

    function applyPlaceholders() {
      for (const element of doc.querySelectorAll("[data-i18n-placeholder]")) {
        element.placeholder = translate(
          currentLanguage,
          element.dataset.i18nPlaceholder,
        );
      }
    }

    function applyLanguage(language) {
      const nextDraft = switchPromptDraft(
        promptDrafts,
        currentLanguage,
        language,
        customizationPrompt.value,
      );
      currentLanguage = nextDraft.language;
      doc.documentElement.lang = currentLanguage;
      doc.title = translate(currentLanguage, "pageTitle");

      for (const element of doc.querySelectorAll("[data-i18n]")) {
        element.textContent = translate(
          currentLanguage,
          element.dataset.i18n,
        );
      }
      for (const element of doc.querySelectorAll("[data-i18n-html]")) {
        element.innerHTML = translate(
          currentLanguage,
          element.dataset.i18nHtml,
        );
      }
      for (const element of doc.querySelectorAll("[data-i18n-aria-label]")) {
        element.setAttribute(
          "aria-label",
          translate(currentLanguage, element.dataset.i18nAriaLabel),
        );
      }

      applyPlaceholders();
      updateLocalizedPrompt(
        customizationPrompt,
        nextDraft.prompt,
      );
      updateLanguageButtonState(languageButtons, currentLanguage);
      for (const element of statusStates.keys()) renderStatus(element);
    }

    async function loadSettings() {
      try {
        const stored = await storage.get(settingsApi.STORAGE_KEY);
        const rawSettings = stored[settingsApi.STORAGE_KEY];
        // Read the foreign-owned key straight from storage (pre-migration) so a
        // legacy record still keeps its value.
        preservedDocsFormat =
          rawSettings && typeof rawSettings.docsFormat === "string"
            ? rawSettings.docsFormat
            : null;
        const migration = settingsApi.migrateLegacyCustom(
          stored[settingsApi.STORAGE_KEY],
        );
        const settings = migration.settings;

        aiBaseUrlInput.value = settings.aiBaseUrl;
        aiApiKeyInput.value = settings.aiApiKey;
        aiModelInput.value = settings.aiModel;
        supadataApiKeyInput.value = settings.supadataApiKey;
        enableBilibiliInput.checked = !!settings.enableBilibili;
        asrEnabledInput.checked = !!settings.asrEnabled;
        asrBaseUrlInput.value = settings.asrBaseUrl;
        asrApiKeyInput.value = settings.asrApiKey;
        asrModelInput.value = settings.asrModel;
        asrProtocolSelect.value = settings.asrProtocol;
        asrLanguageInput.value = settings.asrLanguage;
        if (migration.migrated) {
          await storage.set({ [settingsApi.STORAGE_KEY]: settings });
          setStatus(saveStatus, "migrationWarning");
        }
      } catch (_error) {
        setStatus(saveStatus, "settingsLoadFailed");
      }
    }

    async function loadOptions() {
      try {
        applyLanguage(await readPreferredLanguage(storage));
      } catch (_error) {
        applyLanguage("en");
      }
      await loadSettings();
    }

    async function saveSettings(event) {
      event.preventDefault();
      setStatus(saveStatus, "saving");

      const settings = settingsApi.normalize({
        aiBaseUrl: aiBaseUrlInput.value,
        aiApiKey: aiApiKeyInput.value,
        aiModel: aiModelInput.value,
        supadataApiKey: supadataApiKeyInput.value,
        enableBilibili: enableBilibiliInput.checked,
        asrEnabled: asrEnabledInput.checked,
        asrBaseUrl: asrBaseUrlInput.value,
        asrApiKey: asrApiKeyInput.value,
        asrModel: asrModelInput.value,
        asrProtocol: asrProtocolSelect.value,
        asrLanguage: asrLanguageInput.value,
        // This page has no docsFormat control, so pass the value loaded from
        // storage; normalize() sanitizes it and an unknown/absent value falls
        // back to the "doc" default exactly as before.
        docsFormat: preservedDocsFormat,
      });

      if (!settings.aiApiKey) {
        setStatus(saveStatus, "addAiKey");
        return;
      }

      try {
        await storage.set({ [settingsApi.STORAGE_KEY]: settings });
        aiBaseUrlInput.value = settings.aiBaseUrl;
        aiModelInput.value = settings.aiModel;
        asrBaseUrlInput.value = settings.asrBaseUrl;
        asrModelInput.value = settings.asrModel;
        asrProtocolSelect.value = settings.asrProtocol;
        asrLanguageInput.value = settings.asrLanguage;
        setStatus(saveStatus, "saved");
      } catch (_error) {
        setStatus(saveStatus, "saveFailed");
      }
    }

    async function copyCustomizationPrompt() {
      setStatus(copyStatus, "copying");
      try {
        await copyPromptValue(
          root.navigator.clipboard,
          customizationPrompt.value,
        );
        setStatus(copyStatus, "promptCopied");
      } catch (_error) {
        setStatus(copyStatus, "copyFailed");
      }
    }

    async function clearCachedDigests() {
      const all = await storage.get(null);
      const keys = Object.keys(all).filter((key) => key.startsWith("digest_"));
      if (keys.length) await storage.remove(keys);
      setStatus(dataStatus, "clearedDigests", { count: keys.length });
    }

    async function clearNotes() {
      await storage.remove("ytd_notes");
      setStatus(dataStatus, "notesDeleted");
    }

    async function resetAllData() {
      const confirmed = root.confirm(
        translate(currentLanguage, "resetConfirm"),
      );
      if (!confirmed) return;

      await storage.clear();
      await persistPreferredLanguage(storage, currentLanguage);
      await loadSettings();
      setStatus(dataStatus, "allDataDeleted");
    }

    form.addEventListener("submit", saveSettings);
    copyCustomizationPromptBtn.addEventListener(
      "click",
      copyCustomizationPrompt,
    );
    doc
      .getElementById("clearCacheBtn")
      .addEventListener("click", clearCachedDigests);
    doc.getElementById("clearNotesBtn").addEventListener("click", clearNotes);
    doc.getElementById("resetBtn").addEventListener("click", resetAllData);
    for (const button of languageButtons) {
      button.addEventListener("click", async () => {
        const language = button.dataset.language;
        applyLanguage(language);
        await persistPreferredLanguage(storage, language);
      });
    }

    if (doc.readyState === "loading") {
      doc.addEventListener("DOMContentLoaded", loadOptions, { once: true });
    } else {
      void loadOptions();
    }
  }

  return {
    COPY,
    LANGUAGE_STORAGE_KEY,
    copyPromptValue,
    createPromptDrafts,
    createStorageAdapter,
    normalizeLanguage,
    persistPreferredLanguage,
    readPreferredLanguage,
    translate,
    updateLanguageButtonState,
    updateLocalizedPrompt,
    switchPromptDraft,
    initialize,
  };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = YTD_OPTIONS;
}

if (typeof document !== "undefined") {
  YTD_OPTIONS.initialize();
}
