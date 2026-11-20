import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
const read = name => readFile(new URL(`../../memes/${name}`, import.meta.url), 'utf8');
const script = new vm.Script(await read('meme-bank.js'), {filename:'memes/meme-bank.js'});
const html = await read('index.html');
const seed = [
  {id:1, date:'2026-01-01', text:'seed needle', tags:['疑惑']},
  {id:2, date:'2026-01-02', text:'another seed', tags:['开心']},
]; // Published seed rows lack the API's copies field.
const live = {...seed[0], text:'live revision', copies:7};
const api = '/api/memes', snapshot = '/memes/seed.json', stats = '/memes/danmaku-stats.json';

class Element {
  children = []; dataset = {}; listeners = new Map(); value = ''; textContent = '';
  hidden = false; disabled = false;
  constructor(selector = '') { this.selector = selector; }
  append(...nodes) {
    for (const node of nodes.flatMap(node => node.fragment ? node.children : [node])) {
      node.parentElement = this;
      this.children.push(node);
    }
  }
  closest(selector) {
    assert.equal(selector, '[data-entry]');
    for (let node = this; node; node = node.parentElement) {
      if ('entry' in node.dataset) return node;
    }
    return null;
  }
  appendChild(node) { this.append(node); return node; }
  replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
  contains(node) { return this === node || this.children.some(child => child.contains(node)); }
  setAttribute(attr, value) { this[attr] = value; }
  removeAttribute(attr) { delete this[attr]; }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }
  fire(type) {
    assert.ok(!this.hidden && !this.disabled, `cannot ${type} hidden or disabled control`);
    for (const fn of this.listeners.get(type) || []) fn({ target: this, type });
  }
  querySelectorAll(selector) {
    const [first, rest] = selector.split(/\s+/, 2);
    const attr = /^\[data-([\w-]+)(?:="([^"]*)")?\]$/.exec(first);
    return this.children.flatMap(child => {
      const value = attr && child.dataset[attr[1]];
      const matches = child.selector === first || (value != null && (!attr[2] || String(value) === attr[2]));
      const here = matches ? (rest ? child.querySelectorAll(rest) : [child]) : [];
      return [...here, ...child.querySelectorAll(selector)];
    });
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
}
function makeCard() {
  const card = new Element('.card');
  for (const selector of ['time', '.quote', '.copy', '.copy-label', '.copy-status']) card.append(new Element(selector));
  for (const field of ['id', 'tags', 'count', 'danmaku']) {
    const span = new Element(); span.dataset.field = field; card.append(span);
  }
  return card;
}
function openPage() {
  const nodes = new Map();
  for (const [tag, id] of html.matchAll(/<[^<>]*?\sid="([^"]+)"[^<>]*>/g)) {
    if (nodes.has(id)) continue; // Skip duplicate IDs inside the PiP template.
    const node = new Element();
    node.hidden = /\shidden\b/.test(tag); node.disabled = /\sdisabled\b/.test(tag);
    nodes.set(id, node);
  }
  const get = id => nodes.get(id);
  get('card-template').content = { firstElementChild: makeCard() };
  get('order').value = 'latest';
  const document = {
    getElementById: get, createElement: () => new Element(), importNode: makeCard,
    createDocumentFragment: () => Object.assign(new Element(), { fragment: true }),
    querySelectorAll: selector => [...nodes.values()].flatMap(node => node.querySelectorAll(selector)),
  };
  const pending = [], clipboard = [], frames = new Map();
  let frameId = 0;
  const window = {
    document, AbortSignal, matchMedia: () => ({ matches: false }),
    navigator: { clipboard: { writeText: async text => { clipboard.push(text); } } },
    requestAnimationFrame: fn => { frames.set(++frameId, fn); return frameId; },
    cancelAnimationFrame: id => frames.delete(id),
    fetch(url, options = {}) {
      const parsed = new URL(url, 'https://test.invalid/memes/');
      const path = parsed.pathname + parsed.search;
      return new Promise(resolve => pending.push({ path, options, resolve }));
    },
  };
  document.defaultView = window;
  window.window = window;
  script.runInNewContext(window);
  async function settle() {
    for (let i = 0; i < 100; i++) {
      await new Promise(resolve => setImmediate(resolve));
      if (!frames.size) return;
      const callbacks = [...frames.values()]; frames.clear();
      for (const fn of callbacks) fn(i * 16);
    }
    assert.fail('rendering exceeded 100 frames');
  }
  async function reply(path, data, status = 200) {
    await settle();
    const i = pending.findIndex(req => req.path === path && (req.options.method ?? 'GET') === 'GET');
    assert.notEqual(i, -1, `expected pending GET ${path}`);
    const [req] = pending.splice(i, 1);
    req.resolve({ ok: status < 400, status, json: async () => structuredClone(data) });
    await settle();
  }
  return {
    get, clipboard, reply, settle,
    quotes: () => get('results').querySelectorAll('.quote').map(node => node.textContent),
    async search(value) { get('query').value = value; get('query').fire('input'); await settle(); },
  };
}

test('API renders while stats is pending, then late stats update the card', async () => {
  const page = openPage();
  await page.reply(api, { ok: true, entries: [live] });
  assert.deepEqual(page.quotes(), [live.text]);
  await page.reply(stats, { counts: { [live.id]: 23 } });
  const badge = page.get('results').querySelector('[data-field="danmaku"]');
  assert.equal(badge.hidden, false);
  assert.match(badge.textContent, /23/);
});
test('seed rows are searchable and copyable while list API is pending', async () => {
  const page = openPage();
  await page.reply(snapshot, seed);
  await page.search('needle');
  assert.deepEqual(page.quotes(), [seed[0].text]);
  page.get('results').querySelector('.copy').fire('click');
  await page.settle();
  assert.deepEqual(page.clipboard, [seed[0].text]);
});
test('API failure preserves seed and exposes a working retry', async () => {
  const page = openPage();
  await page.reply(snapshot, seed);
  await page.reply(api, { ok: false }, 503);
  assert.deepEqual(page.quotes().sort(), seed.map(row => row.text).sort());
  assert.equal(page.get('load-state').hidden, false, 'retry must be visible');
  page.get('retry-load').fire('click');
  await page.reply(api, { ok: true, entries: [live] });
  assert.deepEqual(page.quotes(), [live.text]);
  assert.ok(page.get('load-state').hidden || page.get('retry-load').hidden);
});
test('late seed cannot overwrite or mix with authoritative API entries', async () => {
  const page = openPage();
  await page.reply(api, { ok: true, entries: [live] });
  assert.deepEqual(page.quotes(), [live.text]);
  await page.reply(snapshot, seed);
  assert.deepEqual(page.quotes(), [live.text]);
  await page.search('seed');
  assert.deepEqual(page.quotes(), []);
});

test('seed displays shared counts before the full list and late reads cannot lower confirmed counts', async () => {
  const page = openPage();
  await page.reply(api + '?view=counts', {ok:true, copies:{1:12}});
  await page.reply(snapshot, seed);
  await page.search('needle');
  const count = () => page.get('results').querySelector('[data-field="count"]').textContent;
  assert.match(count(), /12/);
  await page.reply(api, {ok:true, entries:[{...seed[0], copies:11}]});
  assert.match(count(), /12/);
});
