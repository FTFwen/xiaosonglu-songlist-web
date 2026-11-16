import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash, webcrypto } from 'node:crypto';
import vm from 'node:vm';

// Execute the complete public module, not extracted functions or source-pattern assertions.
const moduleSource = await readFile(new URL('../../js/lyrics-pip.js', import.meta.url), 'utf8');
const baseURI = 'https://example.test/player/';
const audioBytes = Buffer.from('lyrics PiP black-box audio fixture');
const audioHash = createHash('sha256').update(audioBytes).digest('hex');
const audioURL = `assets/audio/fixture.m4a?v=${audioHash.slice(0, 16)}`;
const audioEvents = ['timeupdate', 'play', 'pause', 'seeking', 'seeked', 'ended', 'loadedmetadata', 'ratechange', 'emptied', 'volumechange'];

class Events {
  constructor() { this.listeners = new Map(); }
  addEventListener(type, callback, options) {
    const entries = this.listeners.get(type) || [];
    if (!entries.some(entry => entry.callback === callback)) entries.push({ callback, once: !!options?.once });
    this.listeners.set(type, entries);
  }
  removeEventListener(type, callback) {
    const entries = (this.listeners.get(type) || []).filter(entry => entry.callback !== callback);
    if (entries.length) this.listeners.set(type, entries); else this.listeners.delete(type);
  }
  dispatchEvent(event) {
    event.target ??= this;
    event.preventDefault ??= () => { event.defaultPrevented = true; };
    for (const entry of [...(this.listeners.get(event.type) || [])]) {
      if (entry.once) this.removeEventListener(event.type, entry.callback);
      entry.callback.call(this, event);
    }
    return !event.defaultPrevented;
  }
  emit(type, fields = {}) { return this.dispatchEvent({ type, ...fields }); }
  listenerCount(type) { return (this.listeners.get(type) || []).length; }
  get totalListeners() { return [...this.listeners.values()].reduce((sum, entries) => sum + entries.length, 0); }
}

class Element extends Events {
  constructor(tagName, namespaceURI = null) {
    super();
    this.tagName = tagName.toUpperCase();
    this.namespaceURI = namespaceURI;
    this.children = [];
    this.parentNode = null;
    this.attributes = new Map();
    this.className = '';
    this.hidden = false;
    this.disabled = false;
    this.scrollTop = 0;
    this.clientHeight = 200;
    this.offsetHeight = 30;
    this.clientTop = 0;
    // Distance of this element's border box from the document top in the mock layout.
    this.rectTopBase = 0;
    this.scrollCalls = [];
    this._text = '';
    const classes = () => new Set(this.className.split(/\s+/).filter(Boolean));
    this.classList = {
      contains: name => classes().has(name),
      add: (...names) => { const values = classes(); names.forEach(name => values.add(name)); this.className = [...values].join(' '); },
      remove: (...names) => { const values = classes(); names.forEach(name => values.delete(name)); this.className = [...values].join(' '); },
      toggle: (name, force) => {
        const enabled = force === undefined ? !classes().has(name) : !!force;
        this.classList[enabled ? 'add' : 'remove'](name);
        return enabled;
      },
    };
  }
  set textContent(value) { this.replaceChildren(); this._text = String(value); }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  // Fail immediately if rendering ever switches to an HTML parsing sink.
  set innerHTML(_) { throw new Error('unsafe innerHTML write'); }
  set outerHTML(_) { throw new Error('unsafe outerHTML write'); }
  insertAdjacentHTML() { throw new Error('unsafe insertAdjacentHTML write'); }
  appendChild(node) {
    if (node.parentNode) node.parentNode.children.splice(node.parentNode.children.indexOf(node), 1);
    this.children.push(node); node.parentNode = this; return node;
  }
  replaceChildren(...nodes) {
    for (const node of this.children) node.parentNode = null;
    this.children = []; this._text = '';
    for (const node of nodes) this.appendChild(node);
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  get offsetTop() { return this.parentNode ? this.parentNode.children.indexOf(this) * 45 : 0; }
  // Minimal layout model mirroring the real DOM: .lp-viewport is `position: relative`, so a
  // lyric line's offsetTop is already relative to the scrolled viewport, while the viewport
  // itself sits below a non-zero header (rectTopBase) and may have a clientTop border.
  getBoundingClientRect() {
    if (this.classList.contains('lp-line')) {
      const viewport = this.parentNode && this.parentNode.parentNode;
      const top = viewport.rectTopBase + viewport.clientTop + this.offsetTop - viewport.scrollTop;
      return { top, bottom: top + 45, height: 45, left: 0, right: 0, width: 0 };
    }
    const height = this.classList.contains('lp-viewport') ? this.clientHeight : 30;
    return { top: this.rectTopBase, bottom: this.rectTopBase + height, height, left: 0, right: 0, width: 0 };
  }
  scrollTo(options) { this.scrollCalls.push({ ...options }); this.scrollTop = options.top; }
  click() { if (!this.disabled) this.emit('click'); }
  closest(selector) {
    const tags = selector.split(',');
    for (let node = this; node; node = node.parentNode) {
      if (tags.includes(node.tagName.toLowerCase()) ||
          (tags.includes('[contenteditable="true"]') && node.getAttribute('contenteditable') === 'true') ||
          (tags.includes('a[href]') && node.tagName === 'A' && node.getAttribute('href') !== null)) return node;
    }
    return null;
  }
}

class Document extends Events {
  constructor() {
    super(); this.baseURI = baseURI;
    this.documentElement = new Element('html'); this.head = new Element('head'); this.body = new Element('body');
    this.documentElement.appendChild(this.head); this.documentElement.appendChild(this.body);
  }
  createElement(tag) { return new Element(tag); }
  createElementNS(namespace, tag) { return new Element(tag, namespace); }
}

class PipWindow extends Events {
  constructor() {
    super(); this.document = new Document(); this.closed = false; this.closeCalls = 0;
    this.frames = new Map(); this.nextFrame = 1; this.reducedMotion = false;
  }
  requestAnimationFrame(callback) { const id = this.nextFrame++; this.frames.set(id, callback); return id; }
  cancelAnimationFrame(id) { this.frames.delete(id); }
  matchMedia() { return { matches: this.reducedMotion }; }
  close() { this.closeCalls++; if (!this.closed) { this.closed = true; this.emit('pagehide'); } }
  runFrame() {
    const callbacks = [...this.frames.values()]; this.frames.clear();
    callbacks.forEach(callback => callback(0));
  }
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function settle() {
  // Drain chained fetch/json/crypto and requestWindow continuations without real timers.
  for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve));
}
function descendants(node) { return node.children.flatMap(child => [child, ...descendants(child)]); }
function byClass(pip, name) { return descendants(pip.document.body).filter(node => node.classList.contains(name)); }
function control(pip, label) {
  const node = descendants(pip.document.body).find(node => node.tagName === 'BUTTON' && node.getAttribute('aria-label') === label);
  assert.ok(node, `missing control: ${label}`); return node;
}
function text(pip, name) { const nodes = byClass(pip, name); assert.equal(nodes.length, 1, name); return nodes[0].textContent; }
function lyricTexts(pip) { return byClass(pip, 'lp-line').map(node => node.textContent); }
function activeTexts(pip) { return byClass(pip, 'is-active').map(node => node.textContent); }
function fixture() {
  return {
    track: { songId: 7, rowKey: 'fixture-row', name: 'Fixture song', artist: 'Fixture artist', audioUrl: audioURL },
    record: {
      songId: 7, key: 'song-7', rowKey: 'fixture-row', audio: { url: audioURL, sha256: audioHash },
      match: { status: 'matched', sourceId: 42, sourcePath: 'sources/42.json', selected: { id: 42 } },
      alignment: { status: 'pending_asr', humanVerified: false, offsetSeconds: 0 },
    },
    source: { id: 42, track: { id: 42 }, platform: 'netease', lines: [{ t: 1, text: 'first line' }, { t: 10, text: 'middle line' }, { t: 20, text: 'last line' }] },
  };
}

function longFixture() {
  const data = fixture();
  data.source = { id: 42, track: { id: 42 }, platform: 'netease',
    lines: Array.from({ length: 12 }, (_, index) => ({ t: index * 10, text: `line ${index}` })) };
  data.record.alignment = { status: 'asr_consistent_draft', humanVerified: true, offsetSeconds: 0 };
  return data;
}

function harness(t, config = {}) {
  const data = config.data || fixture();
  const host = new Events(), button = new Element('button'), audio = new Events();
  Object.assign(audio, { currentTime: 0, paused: true, ended: false, seeking: false, volume: 0.8, muted: false });
  const intervals = new Map(), requests = [], fetches = [], notifications = [], windows = [], digestCalls = [];
  let intervalId = 0, inGesture = false, selected = data.track, liked = false;
  const calls = { previous: 0, next: 0, toggle: 0, favorite: 0 };
  const routes = new Map([
    ['/player/data/lyrics/tracks/song-7.json', data.record],
    ['/player/data/lyrics/sources/42.json', data.source],
  ]);
  Object.assign(host, {
    document: new Document(), isSecureContext: config.secure !== false,
    console: { warn: message => notifications.push(message) },
    crypto: { subtle: { digest: async (algorithm, bytes) => { digestCalls.push({ algorithm, bytes }); return webcrypto.subtle.digest(algorithm, bytes); } } },
    setInterval: (callback, delay) => { const id = ++intervalId; intervals.set(id, { callback, delay }); return id; },
    clearInterval: id => intervals.delete(id),
    fetch: async (input, options) => {
      const url = new URL(input, baseURI); fetches.push({ url, options });
      if (config.fetch) {
        const response = config.fetch(url, options);
        if (response !== undefined) return response;
      }
      if (url.pathname === '/api/lyrics/offset') return { ok: true, json: async () => ({ ok: true, record: null }) };
      if (url.pathname === '/player/assets/audio/fixture.m4a') return {
        ok: true, arrayBuffer: async () => Uint8Array.from(config.audioBytes || audioBytes).buffer,
      };
      assert.ok(routes.has(url.pathname), `unexpected fetch: ${url.href}`);
      const payload = routes.get(url.pathname);
      return { ok: true, json: async () => structuredClone(payload) };
    },
  });
  if (config.crypto === false) delete host.crypto;
  if (config.supported !== false) host.documentPictureInPicture = {
    requestWindow: options => {
      requests.push({ options, inGesture });
      if (config.requestWindow) return config.requestWindow(options);
      const pip = new PipWindow(); windows.push(pip); return Promise.resolve(pip);
    },
  };
  const context = vm.createContext({ window: host, URL, AbortController, Uint8Array });
  vm.runInContext(moduleSource, context, { filename: 'js/lyrics-pip.js' });
  const options = {
    button, audio, getTrack: () => selected, getFavorite: () => liked,
    showMessage: message => notifications.push(message),
    previous: () => { calls.previous++; }, next: () => { calls.next++; },
    toggle: () => { calls.toggle++; audio.paused = !audio.paused; },
    favorite: () => { calls.favorite++; liked = !liked; },
    ...config.options,
  };
  const api = host.XSLLyricsPip.init(options);
  const h = {
    host, button, audio, api, options, data, routes, intervals, requests, fetches, notifications, windows, calls, digestCalls,
    setTrack: value => { selected = value; }, setLiked: value => { liked = value; },
    click: () => { inGesture = true; try { button.click(); } finally { inGesture = false; } },
    open: async () => { h.click(); await settle(); assert.equal(notifications.length, 0, notifications.join('; ')); return windows.at(-1); },
    tick: () => { for (const { callback } of [...intervals.values()]) callback(); },
  };
  t.after(() => { api.close(); host.emit('pagehide'); });
  return h;
}

function assertFailed(h, pip, reason) {
  assert.match(text(pip, 'lp-status'), /歌词加载失败/);
  assert.match(text(pip, 'lp-empty'), reason);
  assert.deepEqual(lyricTexts(pip), []);
  assert.equal(control(pip, '重新加载歌词').hidden, false);
}

test('public init validates required inputs and returns refresh/close', t => {
  const h = harness(t);
  for (const options of [undefined, {}, { button: h.button, audio: h.audio }, { audio: h.audio, getTrack() {} }]) {
    assert.throws(() => h.host.XSLLyricsPip.init(options), { name: 'TypeError', message: 'XSLLyricsPip.init requires button, audio and getTrack' });
  }
  assert.equal(typeof h.api.refresh, 'function'); assert.equal(typeof h.api.close, 'function');
  assert.equal(h.button.getAttribute('aria-pressed'), 'false');
});

test('requestWindow is synchronous in the user gesture and pending clicks are deduplicated', async t => {
  const opening = deferred();
  const h = harness(t, { requestWindow: () => opening.promise });
  h.click();
  assert.equal(h.requests.length, 1, 'requestWindow must already have run before click returns');
  assert.equal(h.requests[0].inGesture, true);
  assert.equal(h.requests[0].options.width, 440); assert.equal(h.requests[0].options.height, 580);
  h.click(); h.click(); assert.equal(h.requests.length, 1);
  const pip = new PipWindow(); opening.resolve(pip); await settle();
  assert.equal(h.button.getAttribute('aria-pressed'), 'true');
  assert.deepEqual(lyricTexts(pip), ['first line', 'middle line', 'last line']);
  h.click(); assert.equal(pip.closed, true); assert.equal(h.requests.length, 1);
});

for (const [name, config, message] of [
  ['insecure context', { secure: false }, /HTTPS|localhost/],
  ['unsupported browser', { supported: false }, /不支持 Document Picture-in-Picture/],
]) test(`${name} reports an actionable message without opening or fetching`, t => {
  const h = harness(t, config); h.click();
  assert.equal(h.requests.length, 0); assert.equal(h.fetches.length, 0);
  assert.match(h.notifications[0], message); assert.equal(h.button.getAttribute('aria-pressed'), 'false');
});

for (const asynchronous of [false, true]) test(`requestWindow ${asynchronous ? 'rejection' : 'throw'} resets the opening guard for retry`, async t => {
  let fail = true;
  const h = harness(t, { requestWindow: () => {
    if (fail) { const error = new Error('permission denied'); if (asynchronous) return Promise.reject(error); throw error; }
    return Promise.resolve(new PipWindow());
  } });
  h.click(); await settle(); assert.match(h.notifications[0], /permission denied/);
  assert.equal(h.button.getAttribute('aria-pressed'), 'false'); assert.equal(h.fetches.length, 0);
  fail = false; h.click(); await settle(); assert.equal(h.requests.length, 2);
  assert.equal(h.button.getAttribute('aria-pressed'), 'true');
});

test('matched lyrics load only from validated URLs, filter metadata and sort valid lines', async t => {
  const data = fixture();
  data.source.lines = [
    { t: 20, text: 'last line' }, { t: -1, text: 'negative' }, { t: 3, text: '作词：Example' },
    { t: 10, text: '  middle line  ' }, null, { t: 4, text: '' }, { t: 1, text: 'first line' },
    { t: 2, text: 'Lyrics: Someone' }, { t: '5', text: 'invalid timestamp' }, { t: 4, text: 123 },
  ];
  const h = harness(t, { data }), pip = await h.open();
  assert.deepEqual(lyricTexts(pip), ['first line', 'middle line', 'last line']);
  assert.equal(text(pip, 'lp-title'), data.track.name); assert.equal(text(pip, 'lp-artist'), data.track.artist);
  assert.equal(pip.document.title, 'Fixture song · 歌词');
  assert.deepEqual(h.fetches.map(call => call.url.href), [
    `${baseURI}data/lyrics/tracks/song-7.json`, `${baseURI}data/lyrics/sources/42.json`,
    'https://example.test/api/lyrics/offset?key=song-7',
  ]);
  for (const { url, options } of h.fetches) {
    assert.equal(options.cache, url.pathname.startsWith('/api/') ? 'no-store' : 'no-cache'); assert.equal(options.credentials, 'same-origin');
    assert.equal(options.redirect, 'error'); assert.equal(options.signal.aborted, false);
  }
  assert.equal(h.digestCalls.length, 0, 'matching versioned URLs need no audio download');
  assert.equal(pip.document.head.children[0].href, `${baseURI}css/lyrics-pip.css?v=3`);
});

const identityFailures = [
  ['song ID', data => { data.record.songId = 8; }, /歌词歌曲身份不匹配/],
  ['record key', data => { data.record.key = 'song-8'; }, /歌词歌曲身份不匹配/],
  ['row key', data => { data.record.rowKey = 'other-row'; }, /歌词歌曲身份不匹配/],
  ['missing selected row key', data => { data.track.rowKey = ''; }, /当前歌曲信息不完整/],
  ['unsafe song ID', data => { data.track.songId = Number.MAX_SAFE_INTEGER + 1; }, /当前歌曲信息不完整/],
  ['missing audio hash', data => { data.record.audio.sha256 = ''; }, /音频版本信息不完整/],
  ['audio path', data => { data.record.audio.url = `assets/audio/other.m4a?v=${audioHash.slice(0, 16)}`; }, /音频路径不匹配/],
  ['audio origin', data => { data.track.audioUrl = `https://other.test/player/${audioURL}`; }, /音频路径不匹配/],
  ['audio credentials', data => { data.track.audioUrl = `https://user:pass@example.test/player/${audioURL}`; }, /音频路径不匹配/],
  ['selected URL version', data => { data.track.audioUrl = 'assets/audio/fixture.m4a?v=000000000000'; }, /音频版本不匹配/],
  ['record URL version', data => { data.record.audio.url = 'assets/audio/fixture.m4a?v=000000000000'; }, /音频版本不匹配/],
  ['ambiguous version', data => { data.track.audioUrl += `&v=${audioHash.slice(0, 16)}`; }, /音频版本参数有歧义/],
  ['invalid version syntax', data => { data.track.audioUrl = 'assets/audio/fixture.m4a?v=latest'; }, /音频版本不匹配/],
  ['source path traversal', data => { data.record.match.sourcePath = '../../outside.json'; }, /歌词来源信息不一致/],
  ['source selected ID', data => { data.record.match.selected.id = 43; }, /歌词来源信息不一致/],
  ['source nonnumeric ID', data => { data.record.match.sourceId = '42'; }, /歌词来源信息不一致/],
];
for (const [name, mutate, reason] of identityFailures) test(`rejects ${name} before fetching any source lyrics`, async t => {
  const data = fixture(); mutate(data);
  const h = harness(t, { data }), pip = await h.open(); assertFailed(h, pip, reason);
  assert.equal(h.fetches.some(call => call.url.pathname.includes('/sources/')), false);
});

for (const [name, mutate] of [
  ['source ID', source => { source.id = 43; }],
  ['source track ID', source => { source.track.id = 43; }],
  ['source platform', source => { source.platform = 'untrusted'; }],
  ['source lines schema', source => { source.lines = {}; }],
]) test(`rejects mismatched ${name} without rendering lyrics`, async t => {
  const data = fixture(); mutate(data.source);
  const h = harness(t, { data }), pip = await h.open(); assertFailed(h, pip, /歌词源身份不匹配/);
});

for (const unversioned of ['record', 'selected', 'both']) test(`SHA-256 verifies actual audio when ${unversioned} URL has no version`, async t => {
  const data = fixture();
  if (unversioned !== 'selected') data.record.audio.url = 'assets/audio/fixture.m4a';
  if (unversioned !== 'record') data.track.audioUrl = 'assets/audio/fixture.m4a';
  const h = harness(t, { data }), pip = await h.open();
  assert.deepEqual(lyricTexts(pip), ['first line', 'middle line', 'last line']);
  assert.equal(h.digestCalls.length, 1); assert.equal(h.digestCalls[0].algorithm, 'SHA-256');
  const fetchedAudio = h.fetches.find(call => call.url.pathname.endsWith('.m4a'));
  assert.equal(fetchedAudio.url.href, new URL(data.track.audioUrl, baseURI).href);
  assert.equal(fetchedAudio.options.redirect, 'error'); assert.equal(fetchedAudio.options.credentials, 'same-origin');
});

for (const [name, config, reason] of [
  ['changed audio bytes', { audioBytes: Buffer.from('different audio') }, /实际音频版本不匹配/],
  ['unavailable Web Crypto', { crypto: false }, /无法安全核验音频版本/],
]) test(`unversioned audio rejects ${name}`, async t => {
  const data = fixture(); data.track.audioUrl = 'assets/audio/fixture.m4a';
  const h = harness(t, { ...config, data }), pip = await h.open(); assertFailed(h, pip, reason);
  assert.equal(h.fetches.some(call => call.url.pathname.includes('/sources/')), false);
});

for (const status of ['candidate', 'version_review_required', 'not_found']) test(`${status} never exposes unconfirmed source lyrics`, async t => {
  const data = fixture(); data.record.match.status = status;
  const h = harness(t, { data }), pip = await h.open();
  assert.deepEqual(lyricTexts(pip), []);
  assert.equal(h.fetches.length, 1, 'must not fetch the source for an unconfirmed match');
  assert.equal(text(pip, 'lp-status'), status === 'not_found' ? '暂无已确认歌词' : '歌词来源 / 版本待确认');
  assert.equal(control(pip, '重新加载歌词').hidden, true);
  assert.equal(byClass(pip, 'lp-timing')[0].hidden, true);
});

test('unverified lyrics automatically highlight and scroll without a trial button', async t => {
  const h = harness(t), pip = await h.open(), viewport = byClass(pip, 'lp-viewport')[0];
  h.audio.currentTime = 15; h.audio.emit('timeupdate'); pip.runFrame(); h.tick();
  assert.equal(byClass(pip, 'lp-status')[0].hidden, true);
  assert.equal(byClass(pip, 'lp-hint').length, 0);
  assert.deepEqual(activeTexts(pip), ['middle line']);
  assert.ok(viewport.scrollCalls.length > 0);
  assert.equal(byClass(pip, 'lp-button').some(button => /试滚/.test(button.textContent)), false);
  assert.equal(control(pip, '+0.5 秒').hidden, false);
  h.audio.currentTime = 25; h.audio.emit('timeupdate');
  assert.deepEqual(activeTexts(pip), ['last line']);
  control(pip, '+0.5 秒').click();
  assert.equal(text(pip, 'lp-offset'), '偏移 0.5 秒');
});

for (const humanVerified of [false, true]) test(`${humanVerified ? 'human-verified' : 'machine-draft'} alignment highlights across offset and forward/backward seeks`, async t => {
  const data = fixture(); data.record.alignment = { status: 'asr_consistent_draft', humanVerified, offsetSeconds: 2 };
  const h = harness(t, { data }), pip = await h.open(), viewport = byClass(pip, 'lp-viewport')[0];
  assert.equal(byClass(pip, 'lp-status')[0].hidden, true);
  assert.equal(control(pip, '+0.5 秒').hidden, false); assert.equal(text(pip, 'lp-offset'), '偏移 2.0 秒');
  for (const [time, expected] of [[2.9, []], [3, ['first line']], [12, ['middle line']], [22, ['last line']], [5, ['first line']], [0, []]]) {
    h.audio.currentTime = time; h.audio.seeking = true; h.audio.emit('seeking');
    assert.deepEqual(activeTexts(pip), expected, `seek to ${time}`);
    assert.ok(activeTexts(pip).length <= 1);
  }
  assert.equal(viewport.scrollCalls.at(-1).behavior, 'instant');
  h.audio.currentTime = 12; h.audio.seeking = false; h.audio.emit('seeked');
  assert.deepEqual(activeTexts(pip), ['middle line']); assert.equal(viewport.scrollCalls.at(-1).behavior, 'smooth');
  control(pip, '+0.5 秒').click();
  assert.equal(text(pip, 'lp-offset'), '偏移 2.5 秒'); assert.deepEqual(activeTexts(pip), ['first line']);
  assert.equal(byClass(pip, 'lp-status')[0].hidden, true);
  control(pip, '−0.5 秒').click(); assert.deepEqual(activeTexts(pip), ['middle line']);
  assert.equal(text(pip, 'lp-offset'), '偏移 2.0 秒');
  pip.reducedMotion = true; h.audio.currentTime = 22; h.audio.emit('timeupdate');
  assert.equal(viewport.scrollCalls.at(-1).behavior, 'instant');
});

// Reported by the user: the highlighted line was correct, but the viewport drifted and showed
// the lines just before it. `.lp-viewport` is `position: relative`, so a line's offsetTop is
// already relative to the scrolled viewport; subtracting viewport.offsetTop (its distance from
// the header above it) scrolled up by exactly that header height.
test('auto-scroll centres the active line with a non-zero header and a prior scroll position', async t => {
  const h = harness(t, { data: longFixture() }), pip = await h.open(), viewport = byClass(pip, 'lp-viewport')[0];
  viewport.rectTopBase = 120; // header/timing rows above the lyric viewport
  viewport.scrollTop = 400;   // the reader had already scrolled inside the viewport
  const lineTop = index => index * 45;
  const centred = index => lineTop(index) - (viewport.clientHeight - 45) / 2;

  h.audio.currentTime = 70; h.audio.seeking = true; h.audio.emit('seeking');
  assert.deepEqual(activeTexts(pip), ['line 7']);
  assert.equal(viewport.scrollCalls.at(-1).top, centred(7), 'line 7 must be centred, not 120px short');
  assert.equal(viewport.scrollCalls.at(-1).behavior, 'instant');
  assert.notEqual(viewport.scrollCalls.at(-1).top, lineTop(7) - viewport.rectTopBase - (viewport.clientHeight - 45) / 2,
    'the old formula subtracted the header twice');
  assert.equal(lineTop(7) + 45 / 2 - viewport.scrollTop, viewport.clientHeight / 2, 'active line centre == viewport centre');

  h.audio.currentTime = 110; h.audio.emit('seeking');
  assert.deepEqual(activeTexts(pip), ['line 11']);
  assert.equal(viewport.scrollCalls.at(-1).top, centred(11));
  assert.equal(lineTop(11) + 45 / 2 - viewport.scrollTop, viewport.clientHeight / 2);
});

test('auto-scroll clamps at the top for early lines and counts the viewport border once', async t => {
  const h = harness(t, { data: longFixture() }), pip = await h.open(), viewport = byClass(pip, 'lp-viewport')[0];
  viewport.rectTopBase = 260; viewport.clientTop = 6; viewport.scrollTop = 37;
  const centred = index => index * 45 - (viewport.clientHeight - 45) / 2;

  h.audio.currentTime = 10; h.audio.emit('timeupdate');
  assert.deepEqual(activeTexts(pip), ['line 1']);
  assert.equal(viewport.scrollCalls.at(-1).top, 0, 'early lines must not scroll above the list top');

  h.audio.seeking = true; h.audio.currentTime = 40; h.audio.emit('seeking');
  assert.deepEqual(activeTexts(pip), ['line 4']);
  assert.equal(viewport.scrollCalls.at(-1).top, centred(4));
  const node = byClass(pip, 'lp-line')[4].getBoundingClientRect();
  assert.equal(node.top + node.height / 2 - viewport.rectTopBase - viewport.clientTop + viewport.scrollTop, 4 * 45 + 22.5);
  assert.equal(4 * 45 + 22.5 - viewport.scrollTop, viewport.clientHeight / 2, 'clientTop must cancel out exactly once');
});

test('a late old-song source response cannot overwrite the current song even if fetch ignores abort', async t => {
  const oldSource = deferred();
  const h = harness(t, { fetch: url => url.pathname.endsWith('/sources/42.json') ? oldSource.promise : undefined });
  const pip = await h.open();
  const oldRequest = h.fetches.find(call => call.url.pathname.endsWith('/sources/42.json'));
  assert.ok(oldRequest); assert.equal(text(pip, 'lp-status'), '正在核验歌词与音频版本…');
  const next = fixture(); next.track = { ...next.track, songId: -9, rowKey: 'derivative-row', name: 'New derivative' };
  Object.assign(next.record, { songId: -9, key: 'derivative-9', rowKey: 'derivative-row' });
  next.record.match = { status: 'matched', sourceId: 99, sourcePath: 'sources/99.json', selected: { id: 99 } };
  next.source = { id: 99, track: { id: 99 }, platform: 'netease', lines: [{ t: 0, text: 'new song only' }] };
  h.routes.set('/player/data/lyrics/tracks/derivative-9.json', next.record);
  h.routes.set('/player/data/lyrics/sources/99.json', next.source);
  h.setTrack(next.track); h.api.refresh(); await settle();
  assert.equal(oldRequest.options.signal.aborted, true); assert.equal(text(pip, 'lp-title'), 'New derivative');
  assert.deepEqual(lyricTexts(pip), ['new song only']);
  oldSource.resolve({ ok: true, json: async () => h.data.source }); await settle();
  assert.deepEqual(lyricTexts(pip), ['new song only']); assert.equal(text(pip, 'lp-title'), 'New derivative');
  assert.equal(h.fetches.filter(call => call.url.pathname.endsWith('/tracks/derivative-9.json')).length, 1);
});

test('rowKey and audio URL changes reload even with the same song ID', async t => {
  const h = harness(t), pip = await h.open();
  h.data.record.rowKey = 'new-row'; h.setTrack({ ...h.data.track, rowKey: 'new-row' }); h.api.refresh(); await settle();
  assert.deepEqual(lyricTexts(pip), ['first line', 'middle line', 'last line']);
  assert.equal(h.fetches.filter(call => call.url.pathname.includes('/tracks/')).length, 2);
  h.setTrack({ ...h.data.track, rowKey: 'new-row', audioUrl: 'assets/audio/fixture.m4a' });
  h.api.refresh(); await settle(); assert.equal(h.digestCalls.length, 1);
  assert.equal(h.fetches.filter(call => call.url.pathname.includes('/tracks/')).length, 3);
});

function assertClean(h, pip, oldNodes) {
  assert.equal(h.button.getAttribute('aria-pressed'), 'false'); assert.equal(h.button.classList.contains('active'), false);
  assert.equal(h.intervals.size, 0); assert.equal(pip.frames.size, 0);
  assert.equal(h.audio.totalListeners, 0); assert.equal(pip.totalListeners, 0); assert.equal(pip.document.totalListeners, 0);
  for (const node of oldNodes) assert.equal(node.totalListeners, 0, `leaked listener on ${node.tagName}`);
  assert.ok(h.fetches.every(call => call.options.signal.aborted), 'all window fetch signals are aborted');
}

for (const method of ['close', 'pagehide']) test(`${method} removes PiP listeners/timers and reopening installs exactly one set`, async t => {
  const h = harness(t), pip = await h.open(), oldNodes = descendants(pip.document.body);
  for (const event of audioEvents) assert.equal(h.audio.listenerCount(event), 1, event);
  assert.equal(h.intervals.size, 1); assert.equal([...h.intervals.values()][0].delay, 250); assert.equal(pip.frames.size, 1);
  if (method === 'close') h.api.close(); else pip.close();
  assertClean(h, pip, oldNodes); assert.equal(pip.closeCalls, 1);
  const fetchCount = h.fetches.length;
  h.audio.emit('timeupdate'); pip.document.emit('keydown', { code: 'Space', target: pip.document.body });
  h.tick(); pip.runFrame(); h.api.refresh(); await settle();
  assert.equal(h.fetches.length, fetchCount); assert.equal(h.calls.toggle, 0);
  const reopened = await h.open(); assert.notEqual(reopened, pip); assert.equal(h.requests.length, 2);
  for (const event of audioEvents) assert.equal(h.audio.listenerCount(event), 1, event);
  assert.equal(h.intervals.size, 1); assert.equal(reopened.frames.size, 1);
  const oldToggle = oldNodes.find(node => node.classList.contains('lp-toggle')); oldToggle.click();
  assert.equal(h.calls.toggle, 0, 'old controls remain inert after reopening');
});

test('host pagehide disposes button and pending opening cannot resurrect a window', async t => {
  const opening = deferred(), h = harness(t, { requestWindow: () => opening.promise });
  h.click(); assert.equal(h.requests.length, 1); h.host.emit('pagehide');
  assert.equal(h.button.listenerCount('click'), 0); assert.equal(h.host.listenerCount('pagehide'), 0);
  const pip = new PipWindow(); opening.resolve(pip); await settle();
  assert.equal(pip.closed, true); assert.equal(pip.closeCalls, 1); assert.equal(h.fetches.length, 0);
  h.click(); assert.equal(h.requests.length, 1); assert.equal(h.button.getAttribute('aria-pressed'), 'false');
});

test('host pagehide closes an open window and reinitializing the same button replaces the old instance', async t => {
  const h = harness(t), pip = await h.open(), oldNodes = descendants(pip.document.body);
  const replacement = h.host.XSLLyricsPip.init(h.options);
  assert.equal(pip.closed, true); assertClean(h, pip, oldNodes);
  assert.equal(h.button.listenerCount('click'), 1); assert.equal(h.host.listenerCount('pagehide'), 1);
  const reopened = await h.open(); h.host.emit('pagehide');
  assert.equal(reopened.closed, true); assertClean(h, reopened, descendants(reopened.document.body));
  assert.equal(h.button.listenerCount('click'), 0); assert.equal(h.host.totalListeners, 0);
  replacement.close();
});

test('controls call the public callbacks and synchronize favorite/play icons from actual state', async t => {
  const h = harness(t), pip = await h.open();
  const play = control(pip, '播放'), favorite = control(pip, '收藏');
  const playPath = play.children[0].children[0].getAttribute('d');
  assert.equal(play.children[0].tagName, 'SVG'); assert.equal(play.children[0].namespaceURI, 'http://www.w3.org/2000/svg');
  assert.equal(favorite.getAttribute('aria-pressed'), 'false');
  control(pip, '上一首').click(); control(pip, '下一首').click(); play.click(); favorite.click(); await settle();
  assert.deepEqual(h.calls, { previous: 1, next: 1, toggle: 1, favorite: 1 });
  assert.equal(control(pip, '暂停'), play); const pausePath = play.children[0].children[0].getAttribute('d');
  assert.notEqual(pausePath, playPath); assert.equal(favorite.getAttribute('aria-label'), '取消收藏');
  assert.equal(favorite.getAttribute('aria-pressed'), 'true'); assert.equal(favorite.classList.contains('is-favorite'), true);
  play.click(); favorite.click(); await settle();
  assert.equal(control(pip, '播放'), play); assert.equal(play.children[0].children[0].getAttribute('d'), playPath);
  assert.equal(favorite.classList.contains('is-favorite'), false); assert.equal(favorite.getAttribute('aria-pressed'), 'false');
  h.audio.paused = false; h.audio.emit('play'); assert.equal(control(pip, '暂停'), play);
  h.audio.ended = true; h.audio.emit('ended'); assert.equal(control(pip, '播放'), play);
  h.setLiked(true); h.tick(); assert.equal(favorite.getAttribute('aria-pressed'), 'true');
  h.setTrack(null); h.api.refresh();
  assert.equal(text(pip, 'lp-status'), '未选歌'); assert.deepEqual(lyricTexts(pip), []);
  for (const label of ['上一首', '下一首', '播放', '取消收藏']) assert.equal(control(pip, label).disabled, true);
});

test('Space toggles once outside interactive fields and missing callbacks remain disabled', async t => {
  const h = harness(t, { options: { previous: undefined, favorite: undefined } }), pip = await h.open();
  assert.equal(control(pip, '上一首').disabled, true); assert.equal(control(pip, '收藏').disabled, true);
  const event = { type: 'keydown', code: 'Space', target: pip.document.body };
  pip.document.dispatchEvent(event); assert.equal(event.defaultPrevented, true); assert.equal(h.calls.toggle, 1);
  for (const fields of [{ repeat: true }, { altKey: true }, { ctrlKey: true }, { metaKey: true }, { code: 'Enter' }]) {
    pip.document.emit('keydown', { code: 'Space', target: pip.document.body, ...fields });
  }
  for (const tag of ['button', 'input', 'textarea', 'select']) {
    pip.document.emit('keydown', { code: 'Space', target: new Element(tag) });
  }
  const editable = new Element('div'); editable.setAttribute('contenteditable', 'true');
  pip.document.emit('keydown', { code: 'Space', target: editable });
  assert.equal(h.calls.toggle, 1);
});

test('callback rejection is reported without losing playback controls', async t => {
  const h = harness(t, { options: { next: () => Promise.reject(new Error('callback failed')), previous: () => { throw new Error('callback failed'); } } });
  const pip = await h.open(); control(pip, '下一首').click(); control(pip, '上一首').click(); await settle();
  assert.deepEqual(h.notifications, ['操作未完成，请重试', '操作未完成，请重试']);
  assert.equal(h.button.getAttribute('aria-pressed'), 'true'); assert.equal(control(pip, '播放').disabled, false);
});

test('retry recovers from a network failure using the current track', async t => {
  let failing = true;
  const h = harness(t, { fetch: url => failing && url.pathname.includes('/tracks/') ? Promise.resolve({ ok: false, status: 503 }) : undefined });
  const pip = await h.open(); assertFailed(h, pip, /HTTP 503/);
  failing = false; control(pip, '重新加载歌词').click(); await settle();
  assert.deepEqual(lyricTexts(pip), ['first line', 'middle line', 'last line']);
  assert.equal(control(pip, '重新加载歌词').hidden, true);
});

test('titles, artists, lyrics and server errors render literally through textContent only', async t => {
  const payload = '<img src=x onerror="globalThis.pwned=true"><script>alert(1)</script>&lt;b&gt;';
  const data = fixture(); data.track.name = payload; data.track.artist = payload; data.source.lines = [{ t: 0, text: payload }];
  const h = harness(t, { data }), pip = await h.open();
  assert.equal(text(pip, 'lp-title'), payload); assert.equal(text(pip, 'lp-artist'), payload);
  assert.deepEqual(lyricTexts(pip), [payload]);
  for (const name of ['lp-title', 'lp-artist', 'lp-line']) assert.equal(byClass(pip, name)[0].children.length, 0);
  assert.equal(descendants(pip.document.body).some(node => ['IMG', 'SCRIPT', 'B'].includes(node.tagName)), false);
  assert.equal(h.notifications.length, 0, 'poison HTML setters must not have been called');
  h.routes.set('/player/data/lyrics/tracks/song-7.json', { ...data.record, audio: { url: audioURL, sha256: 'bad' } });
  // Also exercise arbitrary error text, which follows a separate rendering path.
  h.host.fetch = async () => { throw new Error(payload); };
  control(pip, '重新加载歌词').click(); await settle();
  assert.equal(text(pip, 'lp-empty'), payload); assert.equal(byClass(pip, 'lp-empty')[0].children.length, 0);
});

function sharedRecord(offsetSeconds = 4) {
  return { key: 'song-7', rowKey: 'fixture-row', audioSha256: audioHash, sourceId: 42,
    offsetSeconds, updatedAt: '2026-11-16T06:00:00.000Z' };
}
function sharedResponse(record) { return { ok: true, json: async () => ({ ok: true, record }) }; }

test('volume slider controls same audio and follows external volume/mute changes', async t => {
  const h = harness(t), pip = await h.open(), slider = byClass(pip, 'lp-volume')[0];
  assert.equal(slider.value, '80');
  slider.value = '25'; h.audio.muted = true; slider.emit('input');
  assert.equal(h.audio.volume, 0.25); assert.equal(h.audio.muted, false);
  assert.equal(text(pip, 'lp-volume-value'), '25%');
  h.audio.volume = 0.6; h.audio.muted = true; h.audio.emit('volumechange');
  assert.equal(slider.value, '60'); assert.equal(text(pip, 'lp-volume-value'), '静音');
  slider.value = '0'; slider.emit('input'); assert.equal(h.audio.volume, 0);
});

test('volume uses main-player callback', async t => {
  let value;
  const h = harness(t, { options: { setVolume: n => { value = n; h.audio.volume = n; } } });
  const pip = await h.open(), slider = byClass(pip, 'lp-volume')[0];
  slider.value = '32'; slider.emit('input'); assert.equal(value, 0.32); assert.equal(h.audio.volume, 0.32);
});

test('shared offset replaces machine offset and controls automatic highlight', async t => {
  const data = fixture(); data.record.alignment.offsetSeconds = 3;
  const h = harness(t, { data, fetch: url => url.pathname === '/api/lyrics/offset' ? sharedResponse(sharedRecord(8)) : undefined });
  const pip = await h.open(); assert.equal(text(pip, 'lp-offset'), '偏移 8.0 秒');
  h.audio.currentTime = 12; h.audio.emit('timeupdate'); assert.deepEqual(activeTexts(pip), ['first line']);
  control(pip, '+0.5 秒').click(); assert.equal(text(pip, 'lp-offset'), '偏移 8.5 秒');
});

test('failed shared GET leaves lyrics and adjustments usable and can retry', async t => {
  let failing = true;
  const h = harness(t, { fetch: url => url.pathname === '/api/lyrics/offset' ? failing ? { ok: false, status: 503 } : sharedResponse(null) : undefined });
  const pip = await h.open(); assert.equal(lyricTexts(pip).length, 3);
  assert.match(text(pip, 'lp-shared-status'), /读取失败/); control(pip, '+0.5 秒').click();
  failing = false; control(pip, '重读共享偏移').click(); await settle();
  assert.equal(text(pip, 'lp-offset'), '偏移 0.5 秒'); assert.equal(control(pip, '重读共享偏移').hidden, true);
});

for (const [name, change] of [
  ['key', r => { r.key = 'song-8'; }], ['row', r => { r.rowKey = 'other'; }],
  ['hash', r => { r.audioSha256 = '0'.repeat(64); }], ['source', r => { r.sourceId = 43; }],
  ['offset type', r => { r.offsetSeconds = '4'; }], ['offset range', r => { r.offsetSeconds = 601; }],
  ['date', r => { r.updatedAt = 'bad'; }],
]) test(`invalid shared ${name} cannot alter original lyrics`, async t => {
  const record = sharedRecord(); change(record);
  const h = harness(t, { fetch: url => url.pathname === '/api/lyrics/offset' ? sharedResponse(record) : undefined });
  const pip = await h.open(); assert.equal(lyricTexts(pip).length, 3);
  assert.equal(text(pip, 'lp-offset'), '偏移 0.0 秒'); assert.match(text(pip, 'lp-shared-status'), /读取失败/);
});

test('upload sends total offset and preserves further edits made during upload', async t => {
  const pending = deferred(); let submitted;
  const h = harness(t, { fetch: (url, options) => {
    if (url.pathname !== '/api/lyrics/offset') return;
    if (options.method === 'GET') return sharedResponse(sharedRecord(4));
    submitted = JSON.parse(options.body); return pending.promise;
  } });
  const pip = await h.open(); control(pip, '+0.5 秒').click(); control(pip, '上传偏移').click();
  assert.deepEqual(submitted, { key: 'song-7', rowKey: 'fixture-row', audioSha256: audioHash, sourceId: 42, offsetSeconds: 4.5 });
  assert.equal(control(pip, '上传偏移').disabled, true); control(pip, '+0.5 秒').click();
  pending.resolve(sharedResponse(sharedRecord(4.5))); await settle();
  assert.match(text(pip, 'lp-shared-status'), /上传成功/); assert.equal(text(pip, 'lp-offset'), '偏移 5.0 秒');
  assert.equal(control(pip, '上传偏移').disabled, false);
});

test('failed upload preserves local edits without reporting success', async t => {
  const h = harness(t, { fetch: (url, options) => url.pathname === '/api/lyrics/offset' && options.method === 'PUT' ? { ok: false, status: 503 } : undefined });
  const pip = await h.open(); control(pip, '−0.5 秒').click(); control(pip, '上传偏移').click(); await settle();
  assert.equal(text(pip, 'lp-offset'), '偏移 -0.5 秒'); assert.match(text(pip, 'lp-shared-status'), /上传失败/);
  assert.equal(control(pip, '上传偏移').disabled, false);
});

test('late shared GET cannot overwrite successful upload', async t => {
  const pending = deferred();
  const h = harness(t, { fetch: (url, options) => {
    if (url.pathname !== '/api/lyrics/offset') return;
    return options.method === 'GET' ? pending.promise : sharedResponse(sharedRecord(0.5));
  } });
  const pip = await h.open(); control(pip, '+0.5 秒').click(); control(pip, '上传偏移').click(); await settle();
  pending.resolve(sharedResponse(sharedRecord(30))); await settle();
  assert.equal(text(pip, 'lp-offset'), '偏移 0.5 秒'); assert.match(text(pip, 'lp-shared-status'), /上传成功/);
});

test('late shared GET preserves a local edit', async t => {
  const pending = deferred();
  const h = harness(t, { fetch: url => url.pathname === '/api/lyrics/offset' ? pending.promise : undefined });
  const pip = await h.open(); control(pip, '+0.5 秒').click();
  pending.resolve(sharedResponse(sharedRecord(30))); await settle();
  assert.equal(text(pip, 'lp-offset'), '偏移 0.5 秒'); assert.match(text(pip, 'lp-shared-status'), /保留当前本地/);
});

test('switching songs invalidates a pending shared request and close cleans volume listener', async t => {
  const pending = deferred(); let signal;
  const h = harness(t, { fetch: (url, options) => {
    if (url.pathname === '/api/lyrics/offset') { signal = options.signal; return pending.promise; }
  } });
  const pip = await h.open(); h.setTrack(null); h.api.refresh(); assert.equal(signal.aborted, true);
  pending.resolve(sharedResponse(sharedRecord(30))); await settle();
  assert.equal(text(pip, 'lp-status'), '未选歌'); assert.deepEqual(lyricTexts(pip), []);
  h.api.close(); assert.equal(h.audio.listenerCount('volumechange'), 0);
});
