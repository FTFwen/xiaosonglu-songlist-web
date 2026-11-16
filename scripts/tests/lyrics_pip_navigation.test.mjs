import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

// Black-box test for the real initCrossPageNavigation() in js/app.js.
// The function is extracted from source (brace-matched, not pattern-regexed), executed in a vm
// context, and then driven through a mocked document click registration. Every collaborator it
// touches (window.location / documentPictureInPicture / window.open / normalizeCrossPageDestination
// / writeCrossPageHandoff / showToast) is mocked here; the navigation logic itself is untouched.

const appSource = await readFile(new URL('../../js/app.js', import.meta.url), 'utf8');

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `js/app.js must still declare function ${name}`);
  const open = source.indexOf('{', source.indexOf(')', start));
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced braces while extracting ${name}`);
}

const navigationSource = extractFunction(appSource, 'initCrossPageNavigation');

// Mirrors js/app.js normalizeCrossPageDestination() semantics, driven by the mocked window.location.
function makeNormalize(location) {
  return urlValue => {
    try {
      const url = new URL(urlValue, location.href);
      if (url.origin !== location.origin) return '';
      const path = url.pathname.replace(/\/index\.html$/i, '/').replace(/\/{2,}/g, '/');
      if (path === '/') return '/';
      if (path === '/buttons' || path.startsWith('/buttons/')) return '/buttons/';
      if (path === '/24xsl' || path.startsWith('/24xsl/')) return '/24xsl/';
      return '';
    } catch {
      return '';
    }
  };
}

function makeLink({ href, target = '', download = false, rawHref = null }) {
  const attributes = new Map();
  if (download) attributes.set('download', '');
  return {
    href,
    target,
    attributes,
    hasAttribute: name => attributes.has(name),
    getAttribute: name => (name === 'href' ? (rawHref === null ? href : rawHref) : (attributes.get(name) ?? null)),
  };
}

function makeEvent(link, overrides = {}) {
  const event = {
    type: 'click',
    button: 0,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    defaultPrevented: false,
    target: { closest: selector => (selector === 'a[href]' && link ? link : null) },
    preventDefault() { event.defaultPrevented = true; },
    ...overrides,
  };
  return event;
}

function setup({ href = 'https://example.test/', pip = false, pipClosed = false } = {}) {
  const location = new URL(href);
  const state = {
    listeners: [],
    handoffs: [],
    toasts: [],
    opened: [],
    normalizeCalls: [],
    preventDefaultCount: 0,
  };
  const pipWindow = pip ? { closed: pipClosed } : null;
  const window = {
    location,
    documentPictureInPicture: pip ? { window: pipWindow } : undefined,
    open(...args) { state.opened.push(args); return {}; },
  };
  const document = {
    addEventListener(type, callback, options) {
      state.listeners.push({ type, callback, options });
    },
  };
  const sandbox = {
    window,
    document,
    URL,
    normalizeCrossPageDestination: urlValue => {
      const result = makeNormalize(location)(urlValue);
      state.normalizeCalls.push([urlValue, result]);
      return result;
    },
    writeCrossPageHandoff: destination => { state.handoffs.push(destination); return true; },
    showToast: message => { state.toasts.push(message); },
  };
  const init = vm.runInNewContext(`(() => {\n${navigationSource}\nreturn initCrossPageNavigation;\n})()`, sandbox);
  return {
    state,
    location,
    init,
    click(link, overrides) {
      init();
      const listener = state.listeners.find(entry => entry.type === 'click');
      assert.ok(listener, 'initCrossPageNavigation must register a click listener');
      assert.equal(listener.options?.capture, true, 'cross-page navigation must listen in the capture phase');
      const event = makeEvent(link, overrides);
      listener.callback(event);
      return event;
    },
  };
}

test('initCrossPageNavigation registers exactly one capture-phase click listener', () => {
  const { state, init } = setup();
  init();
  assert.equal(state.listeners.length, 1);
  assert.equal(state.listeners[0].type, 'click');
  // The options object is allocated inside the vm realm, so compare fields rather than prototypes.
  assert.equal(state.listeners[0].options?.capture, true);
});

test('without PiP a /buttons/ link still writes the cross-page handoff', () => {
  const { state, click } = setup({ href: 'https://example.test/player/' });
  const event = click(makeLink({ href: 'https://example.test/buttons/' }));
  assert.equal(event.defaultPrevented, false);
  assert.equal(state.opened.length, 0);
  assert.deepEqual(state.handoffs, ['/buttons/']);
});

test('without PiP a /24xsl/ link still writes the cross-page handoff', () => {
  const { state, click } = setup({ href: 'https://example.test/player/' });
  const event = click(makeLink({ href: 'https://example.test/24xsl/index.html' }));
  assert.equal(event.defaultPrevented, false);
  assert.equal(state.opened.length, 0);
  assert.deepEqual(state.handoffs, ['/24xsl/']);
});

test('without PiP an unrelated in-site link writes no handoff and is not intercepted', () => {
  const { state, click } = setup({ href: 'https://example.test/player/' });
  const event = click(makeLink({ href: 'https://example.test/song/42' }));
  assert.equal(event.defaultPrevented, false);
  assert.equal(state.opened.length, 0);
  assert.deepEqual(state.handoffs, []);
});

test('with PiP open, an in-site link is opened in a new tab instead of handing off', () => {
  const link = makeLink({ href: 'https://example.test/song/42' });
  const { state, click } = setup({ href: 'https://example.test/player/', pip: true });
  const event = click(link);
  assert.equal(event.defaultPrevented, true, 'in-site navigation must be cancelled so the PiP window survives');
  assert.deepEqual(state.opened, [[link.href, '_blank', 'noopener']]);
  assert.equal(state.toasts.length, 1);
  assert.match(state.toasts[0], /新标签/);
  assert.deepEqual(state.handoffs, [], 'a PiP-preserving new tab must not also write a handoff');
});

test('with PiP open, a same-page hash link is not intercepted', () => {
  const { state, click } = setup({ href: 'https://example.test/buttons/', pip: true });
  const event = click(makeLink({ href: 'https://example.test/buttons/#lyrics' }));
  assert.equal(event.defaultPrevented, false);
  assert.equal(state.opened.length, 0);
  assert.equal(state.toasts.length, 0);
});

test('with PiP open, a bare #anchor on the same page is not intercepted', () => {
  const { state, click } = setup({ href: 'https://example.test/buttons/', pip: true });
  const event = click(makeLink({ href: '#lyrics', rawHref: '#lyrics' }));
  assert.equal(event.defaultPrevented, false);
  assert.equal(state.opened.length, 0);
  assert.equal(state.toasts.length, 0);
});

test('with PiP open, an external-origin link is left to the browser', () => {
  const { state, click } = setup({ href: 'https://example.test/player/', pip: true });
  const event = click(makeLink({ href: 'https://elsewhere.test/article' }));
  assert.equal(event.defaultPrevented, false);
  assert.equal(state.opened.length, 0);
  assert.deepEqual(state.handoffs, []);
});

test('with PiP closed, in-site links fall back to the handoff path', () => {
  const { state, click } = setup({ href: 'https://example.test/player/', pip: true, pipClosed: true });
  const event = click(makeLink({ href: 'https://example.test/buttons/' }));
  assert.equal(event.defaultPrevented, false);
  assert.equal(state.opened.length, 0);
  assert.deepEqual(state.handoffs, ['/buttons/']);
});

for (const [label, overrides] of [
  ['ctrl', { ctrlKey: true }],
  ['meta', { metaKey: true }],
  ['shift', { shiftKey: true }],
  ['alt', { altKey: true }],
  ['middle button', { button: 1 }],
]) {
  test(`with PiP open, a ${label} click is not touched`, () => {
    const { state, click } = setup({ href: 'https://example.test/player/', pip: true });
    const event = click(makeLink({ href: 'https://example.test/song/42' }), overrides);
    assert.equal(event.defaultPrevented, false);
    assert.equal(state.opened.length, 0);
    assert.deepEqual(state.handoffs, []);
  });
}

test('with PiP open, target=_blank and download links are not touched', () => {
  const { state, click } = setup({ href: 'https://example.test/player/', pip: true });
  const blank = click(makeLink({ href: 'https://example.test/song/42', target: '_blank' }));
  assert.equal(blank.defaultPrevented, false);
  const download = click(makeLink({ href: 'https://example.test/assets/audio/x.m4a', download: true }));
  assert.equal(download.defaultPrevented, false);
  assert.equal(state.opened.length, 0);
  assert.deepEqual(state.handoffs, []);
});

test('inside a non-PiP document, download and _blank links still write no handoff', () => {
  const { state, click } = setup({ href: 'https://example.test/player/' });
  const blank = click(makeLink({ href: 'https://example.test/buttons/', target: '_blank' }));
  assert.equal(blank.defaultPrevented, false);
  const download = click(makeLink({ href: 'https://example.test/24xsl/', download: true }));
  assert.equal(download.defaultPrevented, false);
  assert.deepEqual(state.handoffs, []);
});

test('clicks that do not land inside an a[href] are ignored', () => {
  const { state, click } = setup({ href: 'https://example.test/buttons/', pip: true });
  const event = click(null);
  assert.equal(event.defaultPrevented, false);
  assert.equal(state.opened.length, 0);
  assert.deepEqual(state.handoffs, []);
});
