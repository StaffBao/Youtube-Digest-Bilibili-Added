const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const contentSource = fs.readFileSync(path.join(__dirname, '../content.js'), 'utf8');
const backgroundSource = fs.readFileSync(path.join(__dirname, '../background.js'), 'utf8');
const probeStart = backgroundSource.indexOf('function isBilibiliUiMounted()');
const probeEnd = backgroundSource.indexOf('\n}', probeStart) + 2;
const probeSource = backgroundSource.slice(probeStart, probeEnd);

// A small DOM harness keeps this regression suite dependency-free. Test the
// real content script, including startup, messages, observers and reinjection.
function harness({ ready = false, enabled = true, reject = false, platform = 'bilibili' } = {}) {
  const writes = [];
  const timers = new Map();
  const messages = [];
  const listeners = [];
  let timerId = 0;
  let checks = 0;
  let observers = 0;
  class Element {
    constructor(tag = 'DIV', id = '') {
      this.tagName = tag;
      this.id = id;
      this.style = {};
      this.children = [];
      this.isConnected = true;
    }
    setAttribute() {}
    addEventListener() {}
    getBoundingClientRect() { return { width: 600, height: 40 }; }
    closest(selector) { return selector === 'ytd-watch-metadata' ? root : null; }
    querySelectorAll() { return []; }
    appendChild(child) {
      if (child.parentElement) child.remove();
      this.children.push(child);
      child.parentElement = this;
      child.isConnected = true;
      writes.push({ parent: this, child });
    }
    insertBefore(child) { this.appendChild(child); }
    remove() {
      if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(x => x !== this);
      this.parentElement = null;
      this.isConnected = false;
    }
  }
  const root = new Element('DIV', 'app');
  const toolbar = new Element('DIV', 'arc_toolbar_report');
  const group = new Element();
  const player = new Element();
  const all = [root, toolbar, group, player];
  const byId = id => all.find(x => x.id === id && x.isConnected) || null;
  const document = {
    readyState: 'complete', body: new Element(), head: new Element(),
    getElementById: byId,
    addEventListener() {},
    createElement(tag) { const element = new Element(tag.toUpperCase()); all.push(element); return element; },
    querySelector(selector) {
      if (selector.includes('.bpx-player-container') || selector.includes('#movie_player')) return player;
      return null;
    },
    querySelectorAll(selector) {
      if (selector === '#ytd-digest-button') return all.filter(x => x.id === 'ytd-digest-button' && x.isConnected);
      if (selector === '#arc_toolbar_report .video-toolbar-left-main') return [group];
      if (selector.includes('#arc_toolbar_report')) return [toolbar, group];
      if (selector.includes('#top-level-buttons-computed')) return [group];
      return [];
    },
  };
  const context = vm.createContext({
    document, console: { log() {}, warn() {}, error() {} },
    window: {
      location: { hostname: platform === 'bilibili' ? 'www.bilibili.com' : 'www.youtube.com', pathname: platform === 'bilibili' ? '/video/BV1Dfd2B9EYM' : '/watch', href: 'https://example.test/video' },
      addEventListener() {}, getComputedStyle: () => ({ display: 'flex', visibility: 'visible' }),
    },
    history: { pushState() {} },
    chrome: { runtime: {
      sendMessage: async message => {
        messages.push(message.action);
        if (message.action === 'checkConfig') return { bilibiliEnabled: enabled };
        if (message.action === 'checkBilibiliUiReady') {
          checks++;
          if (reject) throw new Error('Background unavailable');
          return { ready };
        }
      },
      onMessage: { addListener: listener => listeners.push(listener) },
    } },
    MutationObserver: class { constructor(callback) { this.callback = callback; observers++; } observe() {} },
    setTimeout: (fn, delay) => { timers.set(++timerId, { fn, delay }); return timerId; },
    clearTimeout: id => timers.delete(id),
    setInterval: (fn, delay) => { timers.set(++timerId, { fn, delay }); return timerId; },
    clearInterval: id => timers.delete(id),
  });
  const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
  return {
    context, root, group, player, writes, timers, messages, listeners, flush,
    setReady(value) { ready = value; },
    get checks() { return checks; }, get observers() { return observers; },
    run() { vm.runInContext(contentSource, context); },
    async tick(delay = 500) {
      const next = [...timers].find(([, timer]) => timer.delay === delay);
      assert.ok(next, `Expected a ${delay}ms timer`);
      timers.delete(next[0]); next[1].fn(); await flush();
    },
  };
}

test('complete document is not enough: no page writes before Vue mounts, then both buttons appear', async () => {
  const h = harness(); h.run(); await h.flush();
  assert.equal(h.checks, 1);
  assert.equal(h.writes.length, 0);
  await h.tick();
  assert.equal(h.writes.length, 0);
  h.setReady(true); await h.tick();
  assert.deepEqual(h.writes.map(x => x.child.id), ['ytd-digest-button', 'ytd-note-button']);
  assert.equal(h.writes[0].parent, h.group);
  assert.equal(h.writes[1].parent, h.player);
});

test('already mounted page gets buttons without an arbitrary startup delay', async () => {
  const h = harness({ ready: true }); h.run(); await h.flush();
  assert.equal(h.writes.length, 2);
  assert.equal(h.checks, 1);
});

test('repeated injection does not create competing listeners or observers', async () => {
  const h = harness({ ready: true }); h.run(); await h.flush(); h.run(); await h.flush();
  assert.equal(h.listeners.length, 1);
  assert.equal(h.observers, 1);
  assert.equal(h.writes.length, 2);
});

test('background failures fail closed while content message handling remains registered', async () => {
  const h = harness({ reject: true }); h.run(); await h.flush();
  await h.tick();
  assert.equal(h.writes.length, 0);
  assert.equal(h.listeners.length, 1);
});

test('unknown or broken page stops readiness polling without inserting buttons', async () => {
  const h = harness(); h.run(); await h.flush();
  for (let i = 0; i < 60; i++) await h.tick();
  assert.equal(h.checks, 60);
  assert.equal(h.writes.length, 0);
  assert.equal(h.timers.size, 0);
});

test('disabled Bilibili mode does not start readiness checks or inject UI', async () => {
  const h = harness({ enabled: false }); h.run(); await h.flush();
  assert.equal(h.checks, 0);
  assert.equal(h.writes.length, 0);
});

test('YouTube does not wait for the Bilibili readiness probe', async () => {
  const h = harness({ platform: 'youtube' }); h.run(); await h.flush();
  assert.equal(h.checks, 0);
  assert.equal(h.writes.length, 2);
});

test('MAIN probe requires the live, successfully mounted root instance', () => {
  const root = {};
  const context = vm.createContext({ document: { getElementById: () => root } });
  vm.runInContext(probeSource, context);
  const probe = () => vm.runInContext('isBilibiliUiMounted()', context);
  assert.equal(probe(), false);
  root.__vue__ = { $el: root, _isMounted: false };
  assert.equal(probe(), false);
  root.__vue__._isMounted = true;
  assert.equal(probe(), true);
  root.__vue__._isDestroyed = true;
  assert.equal(probe(), false);
  root.__vue__ = { $el: {}, _isMounted: true };
  assert.equal(probe(), false);
});

test('readiness relay targets the sending document and rejects unrelated callers', async () => {
  const start = backgroundSource.indexOf('  if (message.action === "checkBilibiliUiReady")');
  const end = backgroundSource.indexOf('  // We need to return true', start);
  const calls = [];
  const context = vm.createContext({
    isBilibiliUiMounted() {},
    chrome: { scripting: { executeScript: async options => {
      calls.push(options); return [{ result: true }];
    } } },
  });
  const handler = vm.runInContext(`(function(message, sender, sendResponse) {${backgroundSource.slice(start, end)}})`, context);
  let response;
  handler({ action: 'checkBilibiliUiReady', tabId: 999 }, {
    tab: { id: 12 }, frameId: 0, documentId: 'current-document',
    url: 'https://www.bilibili.com/video/BV1Dfd2B9EYM/',
  }, value => { response = value; });
  await Promise.resolve(); await Promise.resolve();
  assert.equal(response.ready, true);
  assert.equal(calls[0].target.tabId, 12);
  assert.equal(calls[0].target.documentIds[0], 'current-document');
  assert.equal(calls[0].world, 'MAIN');
  handler({ action: 'checkBilibiliUiReady' }, {
    tab: { id: 13 }, frameId: 0, url: 'https://example.test/',
  }, value => { response = value; });
  assert.equal(response.ready, false);
  assert.equal(calls.length, 1);
});
