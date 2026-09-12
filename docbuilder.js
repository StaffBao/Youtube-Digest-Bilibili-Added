/**
 * Pure document-building helpers for the export pipeline.
 *
 * This module is intentionally side-effect free: it never touches the DOM,
 * never calls chrome.* and never reads global state. Every input arrives as a
 * function argument, so the same code can be required directly by Node tests.
 *
 * The data model (ExportDoc / Block) is a contract shared with the .docx
 * renderer task; both sides must emit and consume exactly the shapes below.
 * Nothing here may throw: an export failure interrupts the whole user flow, so
 * every entry point degrades to empty output instead of propagating errors.
 *
 * ExportDoc = {
 *   title, subtitle,
 *   meta: [ { label, value } ],
 *   sections: [ { heading, blocks: Block[] } ]
 * }
 * Block = p | pair | ts | tsPair | item | quote | empty
 */
var YTD_DOC = (() => {
  // Escapes for HTML text nodes / attributes. Self-contained on purpose: the
  // module must stay requireable without sidepanel.js's own escapeHtml.
  function escapeHtml(text) {
    return String(text == null ? "" : text)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function isNonEmptyString(value) {
    return typeof value === "string" && value.trim().length > 0;
  }

  function pad2(n) {
    return String(n).padStart(2, "0");
  }

  // Shared seconds -> clock formatter. Under an hour it stays compact (M:SS);
  // once hours are reached the minute/second fields are zero padded so long
  // videos read as H:MM:SS.
  function secondsToClock(totalSeconds) {
    const s = Math.floor(totalSeconds);
    const hours = Math.floor(s / 3600);
    const minutes = Math.floor((s % 3600) / 60);
    const secs = s % 60;
    if (hours > 0) return `${hours}:${pad2(minutes)}:${pad2(secs)}`;
    return `${minutes}:${pad2(secs)}`;
  }

  // Human-facing duration. Missing / non-positive durations are reported as
  // "未知" rather than a misleading 0:00.
  function formatDurationForDoc(seconds) {
    const n = Number(seconds);
    if (!Number.isFinite(n) || n <= 0) return "未知";
    return secondsToClock(n);
  }

  // Timestamp label. Unlike duration, an unknown timestamp collapses to "" so
  // callers can omit the bracket prefix entirely instead of printing [未知].
  function formatTimestampForDoc(seconds) {
    const n = Number(seconds);
    if (!Number.isFinite(n) || n < 0) return "";
    return secondsToClock(n);
  }

  // MUST stay byte-for-byte equivalent to background.js isMostlyChinese().
  // The panel and the background script both decide "is this transcript
  // Chinese?" from this exact formula; any drift makes the two disagree and a
  // video gets a translation pass on one side but not the other. Kana/Hangul/
  // Latin all count as foreign, so Japanese and Korean read as non-Chinese.
  function isMostlyChineseText(text) {
    const sample = String(text == null ? "" : text).slice(0, 5000);
    const cjk = (sample.match(/[\u4e00-\u9fff]/g) || []).length;
    const kana = (sample.match(/[\u3040-\u30ff]/g) || []).length;
    const hangul = (sample.match(/[\uac00-\ud7af]/g) || []).length;
    const latin = (sample.match(/[a-zA-Z]/g) || []).length;
    return cjk >= kana + hangul + latin;
  }

  // Builds the video-info header as a flat { label, value } list. Empty values
  // are dropped entirely (never rendered as a blank "标题：" row). Duration is
  // only emitted for a real positive number so we never surface a stray "未知".
  function docMetaSection(data) {
    const d = data && typeof data === "object" ? data : {};
    const out = [];
    const push = (label, value) => {
      const v = value == null ? "" : String(value).trim();
      if (v) out.push({ label, value: v });
    };

    push("标题", d.videoTitle);
    push("平台", d.platform);
    push("UP主/频道", d.channelName);
    push("链接", d.videoUrl);
    const dur = Number(d.durationSeconds);
    if (Number.isFinite(dur) && dur > 0) {
      push("时长", formatDurationForDoc(dur));
    }
    push("导出时间", d.exportedAt);
    push("字幕来源", d.transcriptSource);
    push("原文语言", d.sourceLanguageName);
    return out;
  }

  // --- Overview -----------------------------------------------------------

  // Index-aligned lookup: analysis and translatedAnalysis are parallel arrays,
  // mirroring renderAnalysisResults' zh?.chapters?.[idx] / keyQuotes convention.
  function alignedAt(source, key, idx) {
    if (!source || typeof source !== "object") return null;
    const arr = Array.isArray(source[key]) ? source[key] : null;
    if (!arr) return null;
    const item = arr[idx];
    return item && typeof item === "object" ? item : null;
  }

  function docOverviewSection(input) {
    const cfg = input && typeof input === "object" ? input : {};
    const mode = cfg.mode;
    const heading = "AI 概览 / Overview";

    const analysis = cfg.analysis && typeof cfg.analysis === "object" ? cfg.analysis : null;
    const zh = cfg.translatedAnalysis && typeof cfg.translatedAnalysis === "object"
      ? cfg.translatedAnalysis
      : null;

    const chapters = analysis && Array.isArray(analysis.chapters) ? analysis.chapters : [];
    const quotes = analysis && Array.isArray(analysis.keyQuotes) ? analysis.keyQuotes : [];

    // Nothing to show: emit a single grey placeholder rather than an empty
    // section that would render as a bare heading.
    if (chapters.length === 0 && quotes.length === 0) {
      return { heading, blocks: [{ type: "empty", text: "（暂无 AI 概览）" }] };
    }

    const blocks = [];

    // Chapters first, then quotes — the ordering is what expresses the
    // "章节" / "关键引述" grouping; no extra block type is introduced for it.
    chapters.forEach((raw, idx) => {
      const c = raw && typeof raw === "object" ? raw : {};
      const time = c.timestamp || "";
      if (mode === "zh") {
        // zh mode falls back to the source chapter when no translation exists.
        const z = alignedAt(zh, "chapters", idx) || c;
        blocks.push({ type: "item", time, text: z.title || "", sub: z.summary || "" });
      } else if (mode === "bilingual") {
        blocks.push({ type: "item", time, text: c.title || "", sub: c.summary || "" });
        const z = alignedAt(zh, "chapters", idx);
        // Out-of-range or missing translation: emit only the source line. The
        // Chinese item carries no timestamp so we never print a duplicate time.
        // v17: a chapter already written in Chinese would print the same text
        // twice in bilingual mode, so skip its Chinese twin.
        if (z && !isMostlyChineseText(`${c.title || ""} ${c.summary || ""}`)) {
          blocks.push({ type: "item", time: "", text: z.title || "", sub: z.summary || "" });
        }
      } else {
        blocks.push({ type: "item", time, text: c.title || "", sub: c.summary || "" });
      }
    });

    quotes.forEach((raw, idx) => {
      const q = raw && typeof raw === "object" ? raw : {};
      const time = q.timestamp || "";
      if (mode === "zh") {
        const z = alignedAt(zh, "keyQuotes", idx) || q;
        blocks.push({ type: "quote", time, text: z.quote || "" });
      } else if (mode === "bilingual") {
        blocks.push({ type: "quote", time, text: q.quote || "" });
        const z = alignedAt(zh, "keyQuotes", idx);
        if (z && !isMostlyChineseText(q.quote || "")) {
          blocks.push({ type: "quote", time: "", text: z.quote || "" });
        }
      } else {
        blocks.push({ type: "quote", time, text: q.quote || "" });
      }
    });

    return { heading, blocks };
  }

  // --- Transcript ---------------------------------------------------------

  function docTranscriptSection(payload) {
    const p = payload && typeof payload === "object" ? payload : {};
    const mode = p.mode;
    const sourceLanguageName = p.sourceLanguageName;

    let heading;
    if (mode === "zh") heading = "中文逐字稿";
    else if (mode === "bilingual") heading = `${sourceLanguageName || "原文"}·中文对照逐字稿`;
    else heading = "逐字稿";

    const timestamps = p.timestamps === true;
    const tsSegments = Array.isArray(p.tsSegments) ? p.tsSegments : [];
    const pairs = Array.isArray(p.pairs) ? p.pairs : [];
    const blocks = [];

    // R4-m5: the non-timestamp body renderer, shared by the `!timestamps` branch
    // and by the "timestamps requested but the timestamp channel delivered
    // nothing" fallback below. Keeping it a function-local closure adds no module
    // level symbol, so the YTD_DOC export surface stays exactly as it was.
    const renderPlainBody = () => {
      if (mode === "bilingual") {
        // pair.target stays "" when the translation is missing; the HTML
        // renderer owns the grey placeholder, so we must not fill it here.
        pairs.forEach((raw) => {
          const pr = raw && typeof raw === "object" ? raw : {};
          blocks.push({ type: "pair", source: pr.source || "", target: pr.target || "" });
        });
      } else {
        const rawText =
          mode === "zh" && isNonEmptyString(p.formattedTextZh)
            ? p.formattedTextZh
            : p.formattedText;
        if (isNonEmptyString(rawText)) {
          String(rawText)
            .split(/\n\n+/)
            .forEach((para) => {
              const t = para.trim();
              if (t) blocks.push({ type: "p", text: t });
            });
        }
      }
    };

    if (timestamps && tsSegments.length > 0) {
      // Preferred timestamp channel: pre-segmented lines from the punctuation
      // path. bilingual carries source/target, everything else a single text.
      tsSegments.forEach((raw) => {
        const s = raw && typeof raw === "object" ? raw : {};
        const time = s.time || "";
        if (mode === "bilingual") {
          blocks.push({ type: "tsPair", time, source: s.source || "", target: s.target || "" });
        } else {
          blocks.push({ type: "ts", time, text: s.text || "" });
        }
      });
    } else if (timestamps && isNonEmptyString(p.timestampedText)) {
      // Fallback: parse the "[M:SS] text" plain-text form line by line. A line
      // without a recognizable stamp degrades to a plain paragraph so no text
      // is silently dropped.
      const stamp = /^\[(\d+:\d{2}(?::\d{2})?)\]\s*(.*)$/;
      String(p.timestampedText)
        .split(/\r?\n/)
        .forEach((rawLine) => {
          const line = rawLine.trim();
          if (!line) return;
          const m = line.match(stamp);
          if (m) blocks.push({ type: "ts", time: m[1], text: m[2] });
          else blocks.push({ type: "p", text: line });
        });
    } else if (!timestamps) {
      renderPlainBody();
    }

    // R4-m5: timestamps were requested, yet neither timestamp channel produced a
    // single block (no tsSegments, and no timestampedText - or one whose lines
    // are all blank). Render the plain body instead of throwing away
    // formattedText / pairs; when those are empty too the placeholder below
    // still reports "（无字幕内容）" exactly as before.
    if (timestamps && blocks.length === 0) {
      renderPlainBody();
    }

    if (blocks.length === 0) {
      return { heading, blocks: [{ type: "empty", text: "（无字幕内容）" }] };
    }
    return { heading, blocks };
  }

  // --- Notes --------------------------------------------------------------

  function noteText(value) {
    if (value == null) return "";
    if (typeof value === "string") return value;
    if (typeof value === "object") return value.text || "";
    return "";
  }

  function docNotesSection(input) {
    const cfg = input && typeof input === "object" ? input : {};
    const mode = cfg.mode;
    const heading = "时间戳笔记 / Notes";

    const rawNotes = Array.isArray(cfg.notes) ? cfg.notes : [];
    const zhNotes = Array.isArray(cfg.translatedNotes) ? cfg.translatedNotes : [];

    // Bind each note to its index-aligned translation BEFORE the defensive
    // sort. Sorting notes alone would desync them from translatedNotes, so we
    // sort the pairs together to keep alignment intact.
    const paired = rawNotes.map((note, idx) => ({
      note: note && typeof note === "object" ? note : {},
      zh: zhNotes[idx] != null ? zhNotes[idx] : null,
    }));
    paired.sort(
      (a, b) => (a.note.timestampSeconds || 0) - (b.note.timestampSeconds || 0),
    );

    if (paired.length === 0) {
      return { heading, blocks: [{ type: "empty", text: "（本视频暂无时间戳笔记）" }] };
    }

    const blocks = paired.map(({ note, zh }) => {
      const time = note.timestamp || "";
      const zhText = noteText(zh);
      if (mode === "bilingual") {
        return { type: "tsPair", time, source: note.text || "", target: zhText };
      }
      if (mode === "zh") {
        return { type: "ts", time, text: zhText || note.text || "" };
      }
      return { type: "ts", time, text: note.text || "" };
    });

    return { heading, blocks };
  }

  // --- Assembly -----------------------------------------------------------

  function buildExportDoc(input) {
    const cfg = input && typeof input === "object" ? input : {};
    const mode = cfg.mode;
    const opts = cfg.opts && typeof cfg.opts === "object" ? cfg.opts : {};
    const data = cfg.data && typeof cfg.data === "object" ? cfg.data : {};

    const videoInfo =
      data.videoInfo && typeof data.videoInfo === "object" ? data.videoInfo : {};
    const sourceLanguageName =
      data.sourceLanguageName || videoInfo.sourceLanguageName || "";

    const title = isNonEmptyString(videoInfo.videoTitle)
      ? String(videoInfo.videoTitle).trim()
      : "未命名视频";

    // Document-level subtitle. It states the transcript flavor once for the
    // whole doc; the transcript section heading stays shorter on purpose.
    let subtitle;
    if (mode === "zh") subtitle = "中文逐字稿";
    else if (mode === "bilingual") subtitle = `${sourceLanguageName || "原文"}·中文对照逐字稿`;
    else subtitle = "原文逐字稿";

    const meta =
      opts.meta === true
        ? docMetaSection({
            videoTitle: videoInfo.videoTitle,
            platform: videoInfo.platform,
            channelName: videoInfo.channelName,
            videoUrl: videoInfo.videoUrl,
            durationSeconds: videoInfo.durationSeconds,
            exportedAt: data.exportedAt != null ? data.exportedAt : videoInfo.exportedAt,
            transcriptSource:
              data.transcriptSource != null ? data.transcriptSource : videoInfo.transcriptSource,
            sourceLanguageName,
          })
        : [];

    // Fixed section order: transcript -> overview -> notes. A disabled section
    // is omitted entirely rather than emitted with a placeholder.
    const sections = [];
    sections.push(
      docTranscriptSection({
        mode,
        timestamps: opts.timestamps === true,
        formattedText: data.formattedText,
        formattedTextZh: data.formattedTextZh,
        pairs: data.pairs,
        timestampedText: data.timestampedText,
        timestampedTextZh: data.timestampedTextZh,
        tsSegments: data.tsSegments,
        sourceLanguageName,
      }),
    );

    if (opts.overview === true) {
      sections.push(
        docOverviewSection({
          analysis: data.analysis,
          translatedAnalysis: data.translatedAnalysis,
          mode,
        }),
      );
    }

    if (opts.notes === true) {
      sections.push(
        docNotesSection({
          notes: data.notes,
          translatedNotes: data.translatedNotes,
          mode,
        }),
      );
    }

    return { title, subtitle, meta, sections };
  }

  // --- Word-compatible HTML rendering -------------------------------------

  // Bracketed timestamp prefix. Empty time yields no prefix at all so
  // timestamp-less lines don't start with a stray "[] ".
  function timePrefix(time) {
    const t = time == null ? "" : String(time).trim();
    return t ? `<strong>[${escapeHtml(t)}]</strong> ` : "";
  }

  function hasContent(value) {
    return value != null && String(value).length > 0;
  }

  const MISSING_TRANSLATION = '<span style="color:#999;">（本段翻译缺失）</span>';

  function renderBlock(block) {
    const b = block && typeof block === "object" ? block : {};
    switch (b.type) {
      case "p":
        return `<p style="margin-bottom:12pt;line-height:1.5;">${escapeHtml(b.text || "")}</p>`;

      case "pair": {
        // Mirrors buildWordHtmlBilingual: source line tight above, translation
        // line spaced below in grey-blue; missing target prints the placeholder.
        const source = escapeHtml(b.source || "");
        const target = hasContent(b.target) ? escapeHtml(b.target) : MISSING_TRANSLATION;
        return (
          `<p style="margin-bottom:4pt;line-height:1.5;">${source}</p>\n` +
          `<p class="doc-sub-line" style="margin-bottom:14pt;line-height:1.5;color:#444;">${target}</p>`
        );
      }

      case "ts":
        return `<p style="margin-bottom:10pt;line-height:1.5;">${timePrefix(b.time)}${escapeHtml(b.text || "")}</p>`;

      case "tsPair": {
        const source = `${timePrefix(b.time)}${escapeHtml(b.source || "")}`;
        const target = hasContent(b.target) ? escapeHtml(b.target) : MISSING_TRANSLATION;
        return (
          `<p style="margin-bottom:4pt;line-height:1.5;">${source}</p>\n` +
          `<p class="doc-sub-line" style="margin-bottom:14pt;line-height:1.5;color:#444;">${target}</p>`
        );
      }

      case "item": {
        // Bold main line (optionally stamped) with an indented sub line beneath.
        const main = `${timePrefix(b.time)}<strong>${escapeHtml(b.text || "")}</strong>`;
        let out = `<p style="margin-bottom:${hasContent(b.sub) ? "2pt" : "10pt"};line-height:1.5;">${main}</p>`;
        if (hasContent(b.sub)) {
          out +=
            `\n<p class="doc-sub-line" style="margin-bottom:12pt;line-height:1.5;color:#444;">${escapeHtml(b.sub)}</p>`;
        }
        return out;
      }

      case "quote": {
        const quoted = `“${escapeHtml(b.text || "")}”`;
        return `<p style="margin:0 0 10pt 18pt;line-height:1.5;border-left:2pt solid #ccc;padding-left:8pt;color:#333;">${timePrefix(b.time)}${quoted}</p>`;
      }

      case "empty":
        return `<p class="doc-placeholder" style="margin-bottom:12pt;color:#999;">${escapeHtml(b.text || "")}</p>`;

      default:
        return "";
    }
  }

  function renderSection(section) {
    const s = section && typeof section === "object" ? section : {};
    const heading = isNonEmptyString(s.heading) ? `<h2>${escapeHtml(s.heading)}</h2>` : "";
    const blocks = Array.isArray(s.blocks) ? s.blocks : [];
    const body = blocks.map(renderBlock).filter((html) => html.length > 0).join("\n");
    return heading ? `${heading}\n${body}` : body;
  }

  // Produces Word-compatible HTML. The head/style block deliberately reuses
  // buildWordHtml's structure (office namespaces, Microsoft YaHei 12pt body,
  // 16pt h1) so the exported doc matches the existing transcript export. No
  // BOM is added here — the caller (downloadAsDoc) owns the \ufeff prefix.
  function renderExportDocToWordHtml(doc) {
    const d = doc && typeof doc === "object" ? doc : {};
    const title = d.title || "";
    const subtitle = d.subtitle || "";
    const meta = Array.isArray(d.meta) ? d.meta : [];
    const sections = Array.isArray(d.sections) ? d.sections : [];

    const metaHtml = meta.length
      ? `<div class="doc-meta">\n` +
        meta
          .map((row) => {
            const m = row && typeof row === "object" ? row : {};
            return `<p style="margin:0 0 2pt 0;"><strong>${escapeHtml(m.label || "")}：</strong>${escapeHtml(m.value || "")}</p>`;
          })
          .join("\n") +
        `\n</div>`
      : "";

    const subtitleHtml = isNonEmptyString(subtitle)
      ? `<p class="doc-subtitle" style="margin-bottom:10pt;color:#555;">${escapeHtml(subtitle)}</p>\n`
      : "";

    const sectionsHtml = sections
      .map(renderSection)
      .filter((html) => html.length > 0)
      .join("\n");

    return `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<style>
body { font-family: 'Microsoft YaHei', 'SimSun', sans-serif; font-size: 12pt; }
h1 { font-size: 16pt; margin-bottom: 12pt; }
h2 { font-size: 14pt; margin-top: 18pt; margin-bottom: 8pt; }
p { text-indent: 0; }
.doc-meta { margin-bottom: 14pt; color: #333; }
.doc-subtitle { color: #555; }
.doc-placeholder { color: #999; }
.doc-sub-line { color: #444; }
</style>
</head>
<body>
<h1>${escapeHtml(title)}</h1>
${subtitleHtml}${metaHtml}
${sectionsHtml}
</body>
</html>`;
  }

  return {
    escapeHtml,
    formatDurationForDoc,
    formatTimestampForDoc,
    isMostlyChineseText,
    docMetaSection,
    docOverviewSection,
    docTranscriptSection,
    docNotesSection,
    buildExportDoc,
    renderExportDocToWordHtml,
  };
})();

// Make the module reachable as globalThis.YTD_DOC regardless of how the file
// is loaded (a classic script already hoists the top-level `var`, but the
// explicit assignment also covers strict/module-ish contexts).
if (typeof globalThis !== "undefined") {
  globalThis.YTD_DOC = YTD_DOC;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = YTD_DOC;
}
