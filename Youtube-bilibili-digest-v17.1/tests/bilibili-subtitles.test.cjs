const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../background.js'), 'utf8');
const bvid = 'BV1Zj411X7af';
const track = (url = '//aisubtitle.hdslb.com/example.json', lan = 'ai-zh') => ({ lan, subtitle_url: url });
const playerResponse = tracks => ({ code: 0, data: { subtitle: { subtitles: tracks } } });
const textResponse = { body: [{ from: 1.5, to: 4.2, content: '测试平台字幕' }] };
function functionSource(name) {
  const start = source.search(new RegExp(`(?:async )?function ${name}\\(`));
  assert.ok(start >= 0, name);
  return source.slice(start, source.indexOf('\n}', start) + 2);
}
const definitions = [
  'readBilibiliSubtitleState', 'bilibiliSubtitleFailure', 'handleFetchBilibiliTranscript',
  'scoreBilibiliSubtitle', 'normalizeSubtitleUrl', 'reorderTracksByLangPreference', 'buildTranscriptResult', 'fetchJson',
].map(functionSource).join('\n');

function harness({ videoData = { bvid, cid: 123 }, part = 1, fetcher, downloader } = {}) {
  const requests = [];
  const downloads = [];
  const downloadOptions = [];
  const window = { location: { href: `https://www.bilibili.com/video/${bvid}/?p=${part}` }, __INITIAL_STATE__: { videoData } };
  let probes = 0;
  const context = vm.createContext({
    window, URL, AbortController, console, debugLog() {},
    setTimeout(fn, delay) { if (delay === 750) queueMicrotask(fn); return 1; },
    clearTimeout() {},
    fetch: async (url, options) => {
      if (new URL(url).hostname !== 'api.bilibili.com') {
        downloads.push(url);
        downloadOptions.push(options);
        // Model the reported CDN response (Access-Control-Allow-Origin: *).
        // Exercise the real fetchJson helper so include cannot slip through
        // behind a mocked download helper as it did in the earlier tests.
        if (options.credentials === 'include') throw new TypeError('CORS: wildcard origin with credentials');
        const payload = await (downloader ? downloader(url) : textResponse);
        return { ok: true, json: async () => payload };
      }
      requests.push({ url, options });
      const payload = await (fetcher ? fetcher(url, requests.length, window) : playerResponse([track()]));
      return { ok: true, json: async () => payload };
    },
    runMainWorldScript: async (_tab, func, ...args) => { probes++; return func(...args); },
  });
  vm.runInContext(definitions, context);
  return {
    requests, downloads, downloadOptions, window, context,
    get probes() { return probes; },
    read: force => context.readBilibiliSubtitleState(bvid, force),
    run: lang => context.handleFetchBilibiliTranscript(bvid, 42, lang),
  };
}

test('late open with no initial track list preserves cid and queries in page login context', async () => {
  const h = harness(); const result = await h.run();
  assert.equal(result.success, true);
  assert.equal(result.language, 'ai-zh');
  assert.equal(result.transcriptText, '测试平台字幕');
  assert.equal(h.requests.length, 1);
  assert.equal(new URL(h.requests[0].url).searchParams.get('cid'), '123');
  assert.equal(h.requests[0].options.credentials, 'include');
  assert.equal(h.requests[0].options.cache, 'no-store');
});

test('opening early still uses initial tracks without a new API request', async () => {
  const h = harness({ videoData: { bvid, cid: 123, subtitle: { subtitles: [track()] } } });
  assert.equal((await h.run()).success, true);
  assert.equal(h.requests.length, 0);
});

test('signed AI subtitle CDN download omits cookies and preserves its signature', async () => {
  const url = 'https://aisubtitle.hdslb.com/bfs/ai_subtitle/prod/test?auth_key=test-signature';
  const h = harness({ fetcher: () => playerResponse([track(url)]) });
  const result = await h.run();
  assert.equal(result.success, true);
  assert.equal(h.downloadOptions[0].credentials, 'omit');
  assert.equal(h.downloads[0], url);
  assert.equal(h.requests[0].options.credentials, 'include');
  assert.equal(h.probes, 1);
});

test('shared JSON helper retains cookies by default for Bilibili metadata APIs', async () => {
  const h = harness();
  await h.context.fetchJson('https://api.bilibili.com/x/player/pagelist?bvid=' + bvid);
  assert.equal(h.requests[0].options.credentials, 'include');
});

test('multipart page uses selected part and never the first cid or its tracks', async () => {
  const h = harness({ part: 2, videoData: {
    bvid, cid: 111, subtitle: { subtitles: [track('//aisubtitle.hdslb.com/wrong.json')] },
    pages: [{ page: 1, cid: 111 }, { page: 2, cid: 222 }],
  } });
  assert.equal((await h.run()).success, true);
  assert.equal(new URL(h.requests[0].url).searchParams.get('cid'), '222');
  assert.ok(!h.downloads.some(url => url.includes('wrong')));
});

test('stale SPA initial data resolves the current BV and part through pagelist', async () => {
  const h = harness({ part: 2, videoData: { bvid: 'BV1Dfd2B9EYM', cid: 999 },
    fetcher: url => url.includes('pagelist')
      ? { code: 0, data: [{ page: 1, cid: 111 }, { page: 2, cid: 222 }] }
      : playerResponse([track()]),
  });
  assert.equal((await h.run()).success, true);
  assert.equal(new URL(h.requests[1].url).searchParams.get('cid'), '222');
});

test('AI track appearing after an empty response is retried without ASR', async () => {
  const h = harness({ fetcher: (_url, count) => playerResponse(count === 1 ? [] : [track()]) });
  assert.equal((await h.run()).success, true);
  assert.equal(h.probes, 2);
});

test('three successful empty lists produce NO_SUBTITLES', async () => {
  const h = harness({ fetcher: () => playerResponse([]) });
  assert.equal((await h.run()).error, 'NO_SUBTITLES');
  assert.equal(h.probes, 3);
});

test('API rejection is not mislabeled as missing subtitles', async () => {
  const h = harness({ fetcher: () => ({ code: -403, message: 'forbidden' }) });
  assert.equal((await h.run()).error, 'BILI_SUBTITLE_API_ERROR');
  assert.equal(h.probes, 1);
});

test('need_login_subtitle on a code-zero response is recognized', async () => {
  const h = harness({ fetcher: () => ({ code: 0, data: { need_login_subtitle: true, subtitle: { subtitles: [] } } }) });
  assert.equal((await h.run()).error, 'BILI_LOGIN_REQUIRED');
});

test('network error is retryable in the UI, not a claim of no subtitles', async () => {
  const h = harness({ fetcher: () => { throw new Error('Network blocked'); } });
  assert.equal((await h.run()).error, 'BILI_SUBTITLE_REQUEST_FAILED');
});

test('expired initial subtitle URL is refreshed from the live API', async () => {
  const h = harness({
    videoData: { bvid, cid: 123, subtitle: { subtitles: [track('//aisubtitle.hdslb.com/expired.json')] } },
    downloader: url => { if (url.includes('expired')) throw new Error('403'); return textResponse; },
  });
  assert.equal((await h.run()).success, true);
  assert.equal(h.probes, 2);
  assert.equal(h.requests.length, 1);
});

test('subtitle download failures remain distinct from no tracks', async () => {
  const h = harness({ downloader: () => { throw new Error('403'); } });
  assert.equal((await h.run()).error, 'BILI_SUBTITLE_DOWNLOAD_FAILED');
  assert.equal(h.probes, 3);
});

test('navigation during a request discards the old subtitle list', async () => {
  const h = harness({ fetcher: (_url, _count, window) => {
    window.location.href = 'https://www.bilibili.com/video/BV1Dfd2B9EYM/';
    return playerResponse([track()]);
  } });
  assert.equal((await h.run()).error, 'BILI_VIDEO_CHANGED');
  assert.equal(h.downloads.length, 0);
});

test('explicit non-Chinese track preference is preserved', async () => {
  const h = harness({ fetcher: () => playerResponse([track(), track('//aisubtitle.hdslb.com/en.json', 'en')]) });
  const result = await h.run('non-zh');
  assert.equal(result.language, 'en');
  assert.ok(h.downloads[0].endsWith('/en.json'));
});

test('Bilibili query failures retain Try Again even when ASR is enabled', () => {
  const panel = fs.readFileSync(path.join(__dirname, '../sidepanel.js'), 'utf8');
  const start = panel.indexOf('    if (currentPlatform === "bilibili" && !isNoSubtitles)');
  const end = panel.indexOf('\n    if (canUseAsr)', start);
  assert.ok(start >= 0 && end > start);
  const shown = [];
  const context = vm.createContext({
    currentPlatform: 'bilibili', isNoSubtitles: false, isLoginRequired: false,
    transcriptResult: { error: 'BILI_SUBTITLE_API_ERROR', message: 'Retry the subtitle query' },
    showError: (...args) => shown.push(args),
  });
  const route = vm.runInContext(`(function() {${panel.slice(start, end)} return 'ASR';})`, context);
  assert.equal(route(), undefined);
  assert.equal(shown.length, 1);
  context.isNoSubtitles = true;
  assert.equal(route(), 'ASR');
});
