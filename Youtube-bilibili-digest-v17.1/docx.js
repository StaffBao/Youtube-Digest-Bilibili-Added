/**
 * Zero-dependency .docx writer (OOXML + ZIP) for the Chrome MV3 extension.
 *
 * This module builds a *genuinely valid* .docx file entirely in the browser
 * with no npm packages, no bundler and no ES modules. A .docx is nothing more
 * than a ZIP archive whose entries are a fixed set of XML "parts" (the Office
 * Open XML / OPC packaging convention), so the whole job splits into three
 * layers:
 *
 *   1. crc32()      – table-driven CRC-32 used by every ZIP header.
 *   2. zipEntries() – deflate-raw compression + hand-assembled ZIP container.
 *   3. buildDocx()  – renders the ExportDoc model into the five OOXML parts
 *                     and hands them to zipEntries().
 *
 * The code follows the same shared-module convention as settings.js: an IIFE
 * assigned to a top-level `var` (which becomes a globalThis property in a
 * classic script) plus a CommonJS `module.exports` guard so upstream Node
 * tests can require() it directly.
 *
 * Consumes exactly the same ExportDoc model as the parallel HTML renderer, so
 * both exporters stay byte-for-byte consistent in structure.
 */
var YTD_DOCX = (() => {
  "use strict";

  // ---------------------------------------------------------------------------
  // Constants
  // ---------------------------------------------------------------------------

  // Fixed placeholder text used when a bilingual pair is missing its target
  // line. Keeping it as a constant guarantees the DOCX and HTML renderers can
  // agree on the same wording.
  const PLACEHOLDER_TEXT = "（本段翻译缺失）";

  // ZIP local file header / central directory / EOCD signatures.
  const SIG_LOCAL = 0x04034b50;
  const SIG_CENTRAL = 0x02014b50;
  const SIG_EOCD = 0x06054b50;

  // We target "version needed to extract" = 20 (2.0), which is the minimum for
  // deflate-compressed entries. Everything we produce is plain deflate, so 20
  // is sufficient and maximally compatible.
  const VERSION_NEEDED = 20;
  const VERSION_MADE_BY = 20;

  // General purpose bit flag: bit 11 (0x0800) tells the reader the file name is
  // encoded as UTF-8 rather than CP437. Without it, non-ASCII part names could
  // be mis-decoded. Our part names are ASCII, but setting the flag is harmless
  // and correct.
  const FLAG_UTF8 = 0x0800;

  // Compression method 8 = DEFLATE. Method 0 would be "stored" (no compression).
  const METHOD_DEFLATE = 8;

  // OOXML namespaces / content types / relationship types.
  const NS_CONTENT_TYPES = "http://schemas.openxmlformats.org/package/2006/content-types";
  const NS_RELATIONSHIPS = "http://schemas.openxmlformats.org/package/2006/relationships";
  const NS_WML = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
  const NS_OFFICE_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

  const CT_RELS = "application/vnd.openxmlformats-package.relationships+xml";
  const CT_XML = "application/xml";
  const CT_DOCUMENT_MAIN =
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml";
  const CT_STYLES =
    "application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml";

  const REL_OFFICE_DOCUMENT = NS_OFFICE_REL + "/officeDocument";
  const REL_STYLES = NS_OFFICE_REL + "/styles";

  const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

  // ---------------------------------------------------------------------------
  // 1. CRC-32 (table driven)
  // ---------------------------------------------------------------------------

  // Pre-compute the 256-entry CRC-32 lookup table once, using the standard
  // reflected polynomial 0xEDB88320. Both the ZIP local header and the central
  // directory store this value; if it is wrong Word declares the file corrupt
  // outright, so it is generated with the textbook bit-by-bit algorithm.
  const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) {
        // If the low bit is set, shift right and XOR with the polynomial;
        // otherwise just shift right. `>>> 0` keeps it an unsigned 32-bit int.
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      table[i] = c >>> 0;
    }
    return table;
  })();

  /**
   * Compute the CRC-32 of a byte array.
   * @param {Uint8Array} bytes
   * @returns {number} unsigned 32-bit integer
   */
  function crc32(bytes) {
    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
    let crc = 0xffffffff;
    for (let i = 0; i < data.length; i++) {
      crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
    }
    // Final inversion, coerced to an unsigned 32-bit value.
    return (crc ^ 0xffffffff) >>> 0;
  }

  // ---------------------------------------------------------------------------
  // 2. ZIP container assembly
  // ---------------------------------------------------------------------------

  /**
   * Compress bytes with a *raw* DEFLATE stream.
   *
   * Why "deflate-raw" and not "deflate"/"gzip": the ZIP format stores a bare
   * DEFLATE stream (RFC 1951). "deflate" wraps it in a zlib header/trailer
   * (RFC 1950) and "gzip" adds a gzip header (RFC 1952); either wrapper makes
   * the payload invalid for ZIP and Word reports the archive as corrupt.
   *
   * @param {Uint8Array} bytes
   * @returns {Promise<Uint8Array>}
   */
  async function deflateRaw(bytes) {
    const stream = new Blob([bytes]).stream().pipeThrough(
      new CompressionStream("deflate-raw")
    );
    const buf = await new Response(stream).arrayBuffer();
    return new Uint8Array(buf);
  }

  // DOS time/date packing. ZIP stores modification stamps in the legacy MS-DOS
  // format: time = hours<<11 | minutes<<5 | seconds/2, date = (year-1980)<<9 |
  // month<<5 | day. Both are 16-bit and written little-endian.
  function dosTimeFromDate(d) {
    return (
      ((d.getHours() << 11) |
        (d.getMinutes() << 5) |
        Math.floor(d.getSeconds() / 2)) &
      0xffff
    );
  }

  function dosDateFromDate(d) {
    return (
      (((d.getFullYear() - 1980) << 9) |
        ((d.getMonth() + 1) << 5) |
        d.getDate()) &
      0xffff
    );
  }

  /**
   * Assemble a ZIP archive from a list of entries.
   *
   * Layout (all multi-byte integers little-endian):
   *   [local header + data] * N
   *   [central directory header] * N
   *   [end of central directory record (EOCD)]
   *
   * @param {{name: string, bytes: Uint8Array}[]} entries
   * @returns {Promise<Uint8Array>}
   */
  async function zipEntries(entries) {
    const list = Array.isArray(entries) ? entries : [];
    const encoder = new TextEncoder();
    const now = new Date();
    const dosTime = dosTimeFromDate(now);
    const dosDate = dosDateFromDate(now);

    const localChunks = []; // local headers + compressed payloads, in order
    const centralChunks = []; // central directory headers, in order
    let offset = 0; // running byte offset = start of the next local header

    for (let i = 0; i < list.length; i++) {
      const entry = list[i] || {};
      const nameBytes = encoder.encode(String(entry.name == null ? "" : entry.name));
      const raw =
        entry.bytes instanceof Uint8Array
          ? entry.bytes
          : encoder.encode(String(entry.bytes == null ? "" : entry.bytes));

      const comp = await deflateRaw(raw);
      const crc = crc32(raw);
      const localOffset = offset; // remember where this entry's local header begins

      // --- Local file header (30 bytes fixed + file name + extra) -----------
      //  0  signature                (4)  0x04034b50
      //  4  version needed           (2)  20
      //  6  general purpose flag     (2)  0x0800 (UTF-8 name)
      //  8  compression method       (2)  8 (deflate)
      // 10  last mod time            (2)  DOS time
      // 12  last mod date            (2)  DOS date
      // 14  crc-32                   (4)  CRC of *uncompressed* bytes
      // 18  compressed size          (4)
      // 22  uncompressed size        (4)
      // 26  file name length         (2)
      // 28  extra field length       (2)  0
      // 30  file name                (n)
      const local = new Uint8Array(30 + nameBytes.length);
      const lv = new DataView(local.buffer);
      lv.setUint32(0, SIG_LOCAL, true);
      lv.setUint16(4, VERSION_NEEDED, true);
      lv.setUint16(6, FLAG_UTF8, true);
      lv.setUint16(8, METHOD_DEFLATE, true);
      lv.setUint16(10, dosTime, true);
      lv.setUint16(12, dosDate, true);
      lv.setUint32(14, crc, true);
      lv.setUint32(18, comp.length, true);
      lv.setUint32(22, raw.length, true);
      lv.setUint16(26, nameBytes.length, true);
      lv.setUint16(28, 0, true);
      local.set(nameBytes, 30);

      localChunks.push(local, comp);
      // Advance the offset by exactly the bytes we just emitted so the next
      // local header (and this entry's central-directory back-reference) are
      // precise.
      offset += local.length + comp.length;

      // --- Central directory file header (46 bytes fixed + name) -----------
      //  0  signature                (4)  0x02014b50
      //  4  version made by          (2)  20
      //  6  version needed           (2)  20
      //  8  general purpose flag     (2)  0x0800
      // 10  compression method       (2)  8
      // 12  last mod time            (2)
      // 14  last mod date            (2)
      // 16  crc-32                   (4)
      // 20  compressed size          (4)
      // 24  uncompressed size        (4)
      // 28  file name length         (2)
      // 30  extra field length       (2)  0
      // 32  file comment length      (2)  0
      // 34  disk number start        (2)  0
      // 36  internal file attrs      (2)  0
      // 38  external file attrs      (4)  0
      // 42  relative offset of local header (4)
      // 46  file name                (n)
      const central = new Uint8Array(46 + nameBytes.length);
      const cv = new DataView(central.buffer);
      cv.setUint32(0, SIG_CENTRAL, true);
      cv.setUint16(4, VERSION_MADE_BY, true);
      cv.setUint16(6, VERSION_NEEDED, true);
      cv.setUint16(8, FLAG_UTF8, true);
      cv.setUint16(10, METHOD_DEFLATE, true);
      cv.setUint16(12, dosTime, true);
      cv.setUint16(14, dosDate, true);
      cv.setUint32(16, crc, true);
      cv.setUint32(20, comp.length, true);
      cv.setUint32(24, raw.length, true);
      cv.setUint16(28, nameBytes.length, true);
      cv.setUint16(30, 0, true); // extra length
      cv.setUint16(32, 0, true); // comment length
      cv.setUint16(34, 0, true); // disk number start
      cv.setUint16(36, 0, true); // internal attrs
      cv.setUint32(38, 0, true); // external attrs
      cv.setUint32(42, localOffset, true); // relative offset of local header
      central.set(nameBytes, 46);
      centralChunks.push(central);
    }

    // Total size of the central directory block, and where it starts (= the
    // offset right after the last local entry).
    let cdSize = 0;
    for (let i = 0; i < centralChunks.length; i++) cdSize += centralChunks[i].length;
    const cdOffset = offset;

    // --- End of central directory record (EOCD, 22 bytes) ------------------
    //  0  signature                       (4)  0x06054b50
    //  4  number of this disk             (2)  0
    //  6  disk where central dir starts   (2)  0
    //  8  central dir records on this disk(2)
    // 10  total central dir records       (2)
    // 12  size of central directory       (4)
    // 16  offset of central directory     (4)
    // 20  comment length                  (2)  0
    const eocd = new Uint8Array(22);
    const ev = new DataView(eocd.buffer);
    ev.setUint32(0, SIG_EOCD, true);
    ev.setUint16(4, 0, true);
    ev.setUint16(6, 0, true);
    ev.setUint16(8, centralChunks.length, true);
    ev.setUint16(10, centralChunks.length, true);
    ev.setUint32(12, cdSize, true);
    ev.setUint32(16, cdOffset, true);
    ev.setUint16(20, 0, true);

    // Concatenate: local section, then central directory, then EOCD.
    const all = localChunks.concat(centralChunks, [eocd]);
    let total = 0;
    for (let i = 0; i < all.length; i++) total += all[i].length;
    const out = new Uint8Array(total);
    let pos = 0;
    for (let i = 0; i < all.length; i++) {
      out.set(all[i], pos);
      pos += all[i].length;
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // 3. XML helpers
  // ---------------------------------------------------------------------------

  /**
   * Escape the five XML-significant characters. Missing an `&` (or any of these)
   * is the single most common cause of a "cannot open because there are
   * problems with the contents" error in Word, so every text node goes through
   * this before being embedded.
   */
  function escapeXml(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&apos;");
  }

  /**
   * Build a run (<w:r>). Child order inside <w:rPr> matters for schema
   * validity: rStyle must precede b, which precedes color/sz, etc.
   * Every <w:t> carries xml:space="preserve" so Word does not strip leading /
   * trailing spaces (e.g. the "[3:25] " timestamp prefix).
   */
  function runXml(text, opts) {
    const o = opts || {};
    const rPr = [];
    if (o.style) rPr.push('<w:rStyle w:val="' + o.style + '"/>');
    if (o.bold) rPr.push("<w:b/>");
    const rPrXml = rPr.length ? "<w:rPr>" + rPr.join("") + "</w:rPr>" : "";
    return (
      "<w:r>" +
      rPrXml +
      '<w:t xml:space="preserve">' +
      escapeXml(text) +
      "</w:t></w:r>"
    );
  }

  /**
   * Build a paragraph (<w:p>). Child order inside <w:pPr>: pStyle, then
   * spacing, then ind (matches CT_PPr sequence).
   */
  function paraXml(runsXml, opts) {
    const o = opts || {};
    const pPr = [];
    if (o.style) pPr.push('<w:pStyle w:val="' + o.style + '"/>');
    if (typeof o.before === "number" || typeof o.after === "number") {
      let sp = "<w:spacing";
      if (typeof o.before === "number") sp += ' w:before="' + o.before + '"';
      if (typeof o.after === "number") sp += ' w:after="' + o.after + '"';
      sp += "/>";
      pPr.push(sp);
    }
    if (typeof o.indLeft === "number") pPr.push('<w:ind w:left="' + o.indLeft + '"/>');
    const pPrXml = pPr.length ? "<w:pPr>" + pPr.join("") + "</w:pPr>" : "";
    return "<w:p>" + pPrXml + runsXml + "</w:p>";
  }

  function timeRun(time) {
    // Bold "[time] " prefix run used by ts / tsPair / item / quote blocks.
    return runXml("[" + time + "] ", { bold: true });
  }

  // ---------------------------------------------------------------------------
  // OOXML parts
  // ---------------------------------------------------------------------------

  function contentTypesXml() {
    return (
      XML_DECL +
      '<Types xmlns="' +
      NS_CONTENT_TYPES +
      '">' +
      '<Default Extension="rels" ContentType="' +
      CT_RELS +
      '"/>' +
      '<Default Extension="xml" ContentType="' +
      CT_XML +
      '"/>' +
      '<Override PartName="/word/document.xml" ContentType="' +
      CT_DOCUMENT_MAIN +
      '"/>' +
      '<Override PartName="/word/styles.xml" ContentType="' +
      CT_STYLES +
      '"/>' +
      "</Types>"
    );
  }

  function rootRelsXml() {
    return (
      XML_DECL +
      '<Relationships xmlns="' +
      NS_RELATIONSHIPS +
      '">' +
      '<Relationship Id="rId1" Type="' +
      REL_OFFICE_DOCUMENT +
      '" Target="word/document.xml"/>' +
      "</Relationships>"
    );
  }

  function documentRelsXml() {
    return (
      XML_DECL +
      '<Relationships xmlns="' +
      NS_RELATIONSHIPS +
      '">' +
      '<Relationship Id="rId1" Type="' +
      REL_STYLES +
      '" Target="styles.xml"/>' +
      "</Relationships>"
    );
  }

  /**
   * word/styles.xml.
   *
   * CRITICAL: <w:rFonts w:eastAsia="Microsoft YaHei"> inside docDefaults. Word
   * resolves CJK glyphs through the eastAsia font slot; if it is left unset the
   * Chinese text silently falls back to a substitute font (often a mismatched
   * serif), which is the easiest trap in this whole module. Setting ascii /
   * hAnsi / cs too keeps Latin, high-ANSI and complex-script runs consistent.
   *
   * All w:styleId values here must match, letter for letter, the names
   * referenced from document.xml.
   */
  function stylesXml() {
    return (
      XML_DECL +
      '<w:styles xmlns:w="' +
      NS_WML +
      '">' +
      // Document defaults: 12pt Microsoft YaHei for every script slot.
      "<w:docDefaults>" +
      "<w:rPrDefault><w:rPr>" +
      '<w:rFonts w:ascii="Microsoft YaHei" w:eastAsia="Microsoft YaHei" ' +
      'w:hAnsi="Microsoft YaHei" w:cs="Microsoft YaHei"/>' +
      '<w:sz w:val="24"/><w:szCs w:val="24"/>' +
      "</w:rPr></w:rPrDefault>" +
      "<w:pPrDefault><w:pPr>" +
      '<w:spacing w:after="160" w:line="259" w:lineRule="auto"/>' +
      "</w:pPr></w:pPrDefault>" +
      "</w:docDefaults>" +
      // Base paragraph style.
      '<w:style w:type="paragraph" w:default="1" w:styleId="Normal">' +
      '<w:name w:val="Normal"/><w:qFormat/>' +
      "</w:style>" +
      // Heading1: 16pt bold, outline level 0 (shows in the navigation pane).
      '<w:style w:type="paragraph" w:styleId="Heading1">' +
      '<w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:qFormat/>' +
      '<w:pPr><w:keepNext/><w:spacing w:before="240" w:after="240"/>' +
      '<w:outlineLvl w:val="0"/></w:pPr>' +
      '<w:rPr><w:b/><w:sz w:val="32"/><w:szCs w:val="32"/></w:rPr>' +
      "</w:style>" +
      // Heading2: 14pt bold, outline level 1.
      '<w:style w:type="paragraph" w:styleId="Heading2">' +
      '<w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:qFormat/>' +
      '<w:pPr><w:keepNext/><w:spacing w:before="240" w:after="120"/>' +
      '<w:outlineLvl w:val="1"/></w:pPr>' +
      '<w:rPr><w:b/><w:sz w:val="28"/><w:szCs w:val="28"/></w:rPr>' +
      "</w:style>" +
      // DocMeta: compact video-info header lines.
      '<w:style w:type="paragraph" w:styleId="DocMeta">' +
      '<w:name w:val="Doc Meta"/><w:basedOn w:val="Normal"/>' +
      '<w:pPr><w:spacing w:after="40"/></w:pPr>' +
      "</w:style>" +
      // DocSubLine: secondary line of a pair, grey 444444, roomy after-spacing.
      '<w:style w:type="paragraph" w:styleId="DocSubLine">' +
      '<w:name w:val="Doc Sub Line"/><w:basedOn w:val="Normal"/>' +
      '<w:pPr><w:spacing w:after="280"/></w:pPr>' +
      '<w:rPr><w:color w:val="444444"/></w:rPr>' +
      "</w:style>" +
      // DocPlaceholder: light-grey missing-translation line.
      '<w:style w:type="paragraph" w:styleId="DocPlaceholder">' +
      '<w:name w:val="Doc Placeholder"/><w:basedOn w:val="Normal"/>' +
      '<w:rPr><w:color w:val="999999"/></w:rPr>' +
      "</w:style>" +
      // DocQuote: indented, dark-grey quotation.
      '<w:style w:type="paragraph" w:styleId="DocQuote">' +
      '<w:name w:val="Doc Quote"/><w:basedOn w:val="Normal"/>' +
      '<w:pPr><w:ind w:left="480"/><w:spacing w:after="200"/></w:pPr>' +
      '<w:rPr><w:color w:val="333333"/></w:rPr>' +
      "</w:style>" +
      // MetaLabel: character style, bold, for the "label：" run.
      '<w:style w:type="character" w:styleId="MetaLabel">' +
      '<w:name w:val="Meta Label"/><w:rPr><w:b/></w:rPr>' +
      "</w:style>" +
      "</w:styles>"
    );
  }

  // A4 page geometry in twentieths of a point (twips): 11906 x 16838 with 1in
  // (1440 twip) margins all round.
  function sectPrXml() {
    return (
      "<w:sectPr>" +
      '<w:pgSz w:w="11906" w:h="16838"/>' +
      '<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" ' +
      'w:header="720" w:footer="720" w:gutter="0"/>' +
      "</w:sectPr>"
    );
  }

  // ---------------------------------------------------------------------------
  // Block rendering
  // ---------------------------------------------------------------------------

  function str(v) {
    return typeof v === "string" ? v : "";
  }

  function hasText(v) {
    return typeof v === "string" && v.trim() !== "";
  }

  /**
   * Render a source/target pair into exactly two paragraphs. Line count is
   * preserved unconditionally (never merged, never skipped) so bilingual
   * alignment cannot drift. A missing target becomes a grey placeholder line.
   */
  function renderPair(time, source, target, withTime) {
    const showTime = withTime && hasText(time);
    const prefix = showTime ? timeRun(time) : "";

    // Source line (tight 80-twip gap before its translation).
    const sourcePara = paraXml(prefix + runXml(source), { after: 80 });

    // Target line: normal translation or grey placeholder.
    // Note: timestamp prefix intentionally omitted here to match the HTML
    // renderer (docbuilder.js) which only stamps the source line.
    let targetPara;
    if (hasText(target)) {
      targetPara = paraXml(runXml(target), {
        style: "DocSubLine",
        after: 280,
      });
    } else {
      targetPara = paraXml(runXml(PLACEHOLDER_TEXT), {
        style: "DocPlaceholder",
        after: 280,
      });
    }
    return sourcePara + targetPara;
  }

  /**
   * Render one Block. Returns "" when the block should be skipped entirely
   * (empty single-text blocks) so Word does not show stray blank lines.
   */
  function renderBlock(block) {
    if (!block || typeof block !== "object") return "";
    switch (block.type) {
      case "p": {
        const text = str(block.text);
        if (!hasText(text)) return "";
        return paraXml(runXml(text), { after: 240 });
      }
      case "pair":
        return renderPair(str(block.time), str(block.source), str(block.target), false);
      case "ts": {
        const time = str(block.time);
        const text = str(block.text);
        if (!hasText(text) && !hasText(time)) return "";
        const runs = (hasText(time) ? timeRun(time) : "") + runXml(text);
        return paraXml(runs, { after: 240 });
      }
      case "tsPair":
        return renderPair(str(block.time), str(block.source), str(block.target), true);
      case "item": {
        const time = str(block.time);
        const text = str(block.text);
        const sub = str(block.sub);
        if (!hasText(text) && !hasText(sub) && !hasText(time)) return "";
        const runs = (hasText(time) ? timeRun(time) : "") + runXml(text, { bold: true });
        const out = [paraXml(runs, { after: hasText(sub) ? 80 : 240 })];
        if (hasText(sub)) {
          out.push(paraXml(runXml(sub), { style: "DocSubLine", after: 280 }));
        }
        return out.join("");
      }
      case "quote": {
        const time = str(block.time);
        const text = str(block.text);
        if (!hasText(text) && !hasText(time)) return "";
        // Wrap in Chinese curly quotes; keep the timestamp prefix bold.
        const runs =
          (hasText(time) ? timeRun(time) : "") + runXml("“" + text + "”");
        return paraXml(runs, { style: "DocQuote", after: 200 });
      }
      case "empty": {
        // Always emit the placeholder line to preserve vertical rhythm.
        const text = str(block.text);
        return paraXml(runXml(hasText(text) ? text : PLACEHOLDER_TEXT), {
          style: "DocPlaceholder",
          after: 240,
        });
      }
      default:
        return "";
    }
  }

  // ---------------------------------------------------------------------------
  // document.xml
  // ---------------------------------------------------------------------------

  function normalizeDoc(doc) {
    const d = doc && typeof doc === "object" ? doc : {};
    return {
      title: str(d.title),
      subtitle: str(d.subtitle),
      meta: Array.isArray(d.meta) ? d.meta : [],
      sections: Array.isArray(d.sections) ? d.sections : [],
    };
  }

  function documentXml(doc) {
    const body = [];

    if (hasText(doc.title)) {
      body.push(paraXml(runXml(doc.title), { style: "Heading1" }));
    }
    if (hasText(doc.subtitle)) {
      body.push(paraXml(runXml(doc.subtitle), { after: 240 }));
    }

    for (let i = 0; i < doc.meta.length; i++) {
      const m = doc.meta[i];
      if (!m || typeof m !== "object") continue;
      const label = str(m.label);
      const value = str(m.value);
      if (!hasText(label) && !hasText(value)) continue;
      // label run uses the bold MetaLabel character style, with a full-width
      // colon; value run is plain text.
      const runs = runXml(label + "：", { style: "MetaLabel" }) + runXml(value);
      body.push(paraXml(runs, { style: "DocMeta" }));
    }

    for (let i = 0; i < doc.sections.length; i++) {
      const section = doc.sections[i];
      if (!section || typeof section !== "object") continue;
      const heading = str(section.heading);
      if (hasText(heading)) {
        body.push(paraXml(runXml(heading), { style: "Heading2" }));
      }
      const blocks = Array.isArray(section.blocks) ? section.blocks : [];
      for (let j = 0; j < blocks.length; j++) {
        const rendered = renderBlock(blocks[j]);
        if (rendered) body.push(rendered);
      }
    }

    body.push(sectPrXml());

    return (
      XML_DECL +
      '<w:document xmlns:w="' +
      NS_WML +
      '" xmlns:r="' +
      NS_OFFICE_REL +
      '">' +
      "<w:body>" +
      body.join("") +
      "</w:body></w:document>"
    );
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Feature detection: true when the browser exposes CompressionStream
   * (Chrome 103+; manifest minimum_chrome_version is 116). Callers use this to
   * fall back to the HTML-based .doc export when unavailable.
   * @returns {boolean}
   */
  function isDocxSupported() {
    return typeof CompressionStream !== "undefined";
  }

  /**
   * Build a .docx file from an ExportDoc model.
   *
   * The five OPC parts are added with "[Content_Types].xml" FIRST: the OPC
   * convention (and several strict parsers) require the content-types stream to
   * be the first entry in the package so it can be located without scanning.
   *
   * @param {object} doc ExportDoc
   * @returns {Promise<Uint8Array>} the .docx file bytes
   * @throws {Error} message contains "DOCX_UNSUPPORTED" if CompressionStream is
   *   unavailable, so the caller can detect it and fall back precisely.
   */
  async function buildDocx(doc) {
    if (!isDocxSupported()) {
      throw new Error(
        "DOCX_UNSUPPORTED: CompressionStream is not available in this environment."
      );
    }
    const d = normalizeDoc(doc);
    const encoder = new TextEncoder();
    const parts = [
      { name: "[Content_Types].xml", bytes: encoder.encode(contentTypesXml()) },
      { name: "_rels/.rels", bytes: encoder.encode(rootRelsXml()) },
      { name: "word/_rels/document.xml.rels", bytes: encoder.encode(documentRelsXml()) },
      { name: "word/styles.xml", bytes: encoder.encode(stylesXml()) },
      { name: "word/document.xml", bytes: encoder.encode(documentXml(d)) },
    ];
    return zipEntries(parts);
  }

  return {
    buildDocx,
    isDocxSupported,
    crc32,
    // Exposed for tests / advanced callers; harmless to keep public.
    zipEntries,
  };
})();

// Make the module reachable as globalThis.YTD_DOCX regardless of how the file
// is loaded (a classic script already hoists the top-level `var`, but the
// explicit assignment also covers strict/module-ish contexts).
if (typeof globalThis !== "undefined") {
  globalThis.YTD_DOCX = YTD_DOCX;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = YTD_DOCX;
}
