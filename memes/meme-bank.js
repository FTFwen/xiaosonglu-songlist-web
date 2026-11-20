'use strict';
(() => {
  const endpoint = '/api/memes';
  let entries = [];
  const $ = id => document.getElementById(id);
  const selected = new Set();
  const copying = new Set();
  let featured, submitting = false;
  const validCopies = value => Number.isSafeInteger(value) && value >= 0;
  const label = id => `#${String(id).padStart(3, '0')}`;
  const normalize = value => value.normalize('NFKC').toLowerCase();
  const tagName = value => value.normalize('NFKC').trim().replace(/^#+\s*/, '').replace(/\s+/g, ' ');
  const validTag = tag => tag.length > 0 && tag.length <= 20 && !/[、,，\n]/.test(tag);

  function validEntry(entry) {
    return entry && Number.isSafeInteger(entry.id) && entry.id > 0 && validCopies(entry.copies) &&
      typeof entry.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(entry.date) &&
      typeof entry.text === 'string' && entry.text.trim() && Array.isArray(entry.tags) &&
      entry.tags.every(tag => typeof tag === 'string' && tag.length > 0);
  }

  async function request(payload) {
    const options = { cache: 'no-store', signal: AbortSignal.timeout(12000) };
    if (payload) {
      options.method = 'POST';
      options.headers = { 'Content-Type': 'application/json' };
      options.body = JSON.stringify(payload);
    }
    const response = await fetch(endpoint, options);
    const data = await response.json();
    if (!response.ok || data?.ok !== true) {
      throw new Error(data?.ok === false && typeof data.error === 'string' ? data.error : 'invalid_response');
    }
    return data;
  }

  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); return true; } catch {}
    const previous = document.activeElement;
    const field = document.createElement('textarea');
    field.value = text;
    field.readOnly = true;
    field.style.cssText = 'position:fixed;left:0;top:0;opacity:0;pointer-events:none';
    document.body.append(field);
    try { field.select(); return document.execCommand('copy'); } catch { return false; }
    finally { field.remove(); previous?.focus(); }
  }

  async function copyEntry(entry, button, selector) {
    if (copying.has(entry.id)) return;
    copying.add(entry.id);
    const region = $('results').contains(button) ? $('results') : $('random-card');
    const cardSelector = `[data-entry="${entry.id}"]`;
    function report(message) {
      $('feedback').textContent = message;
      const status = region.querySelector(`${cardSelector} .copy-status`);
      if (status) status.textContent = message;
    }
    try {
      report('');
      if (!await copyText(entry.text)) {
        report('复制失败，请重试。');
        return;
      }
      report('已复制正文，正在更新计数…');
      try {
        const { copies } = await request({ action: 'copy', id: entry.id });
        if (!validCopies(copies)) throw new Error('invalid_response');
        entry.copies = copies;
      } catch {
        report('已复制正文，但无法确认复制计数是否更新。');
        return;
      }
      for (const node of document.querySelectorAll(`[data-copies="${entry.id}"]`)) {
        node.textContent = `${entry.copies} 次复制`;
      }
      if ($('order').value === 'copies') {
        const restoreFocus = region === $('results') && document.activeElement === button;
        renderResults();
        if (restoreFocus) region.querySelector(`${cardSelector} ${selector}`)?.focus();
      }
      report('已复制正文');
    } finally { copying.delete(entry.id); }
  }

  function card(entry) {
    const node = $('card-template').content.firstElementChild.cloneNode(true);
    node.dataset.entry = entry.id;
    node.querySelector('[data-field="id"]').textContent = label(entry.id);
    const time = node.querySelector('time');
    time.dateTime = time.textContent = entry.date;
    node.querySelector('[data-field="tags"]').textContent = entry.tags.map(tag => `#${tag}`).join('  ');
    node.querySelector('.quote').textContent = entry.text;
    const counter = node.querySelector('[data-field="count"]');
    counter.dataset.copies = entry.id;
    counter.textContent = `${entry.copies} 次复制`;
    for (const selector of ['.copy', '.copy-label']) {
      const button = node.querySelector(selector);
      button.addEventListener('click', () => copyEntry(entry, button, selector));
    }
    return node;
  }

  function showRandom(notify = false) {
    $('shuffle-button').disabled = !entries.length;
    if (!entries.length) return;
    const pool = entries.length > 1 ? entries.filter(entry => entry.id !== featured?.id) : entries;
    featured = pool[Math.floor(Math.random() * pool.length)];
    $('random-card').replaceChildren(card(featured));
    if (notify) $('feedback').textContent = entries.length === 1 ? '目前只有这一条。' : '已换一条';
  }

  function renderResults() {
    const terms = normalize($('query').value).trim().split(/\s+/).filter(Boolean);
    const byLatest = (a, b) => b.date.localeCompare(a.date) || b.id - a.id;
    const results = entries.filter(entry => {
      const searchable = normalize([entry.text, ...entry.tags.flatMap(tag => [tag, `#${tag}`]), String(entry.id), label(entry.id)].join(' '));
      return terms.every(term => searchable.includes(term)) && [...selected].every(tag => entry.tags.includes(tag));
    });
    results.sort($('order').value === 'copies' ? (a, b) => b.copies - a.copies || byLatest(a, b) : byLatest);
    $('results').replaceChildren(...results.map(card));
    $('result-count').textContent = `${results.length} / ${entries.length} 条`;
    $('empty').hidden = results.length > 0;
  }

  function renderTags() {
    const tags = new Map();
    for (const entry of entries) {
      for (const tag of new Set(entry.tags)) tags.set(tag, (tags.get(tag) || 0) + 1);
    }
    const controls = new Map();
    const sortedTags = [...tags].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh-CN'));
    for (const [tag, number] of [[null, entries.length], ...sortedTags]) {
      const button = document.createElement('button');
      const badge = document.createElement('span');
      button.type = 'button';
      button.className = 'tag';
      button.textContent = tag ?? '全部标签';
      badge.textContent = number;
      button.append(badge);
      controls.set(tag, button);
      button.addEventListener('click', () => {
        if (tag === null) selected.clear();
        else if (!selected.delete(tag)) selected.add(tag);
        updatePressed();
        renderResults();
      });
    }
    function updatePressed() {
      for (const [name, control] of controls) {
        control.setAttribute('aria-pressed', String(name === null ? !selected.size : selected.has(name)));
      }
    }
    updatePressed();
    $('tags').replaceChildren(...controls.values());
    $('submission-tag-options').replaceChildren(...sortedTags.map(([tag]) => {
      const option = document.createElement('option');
      option.value = tag;
      return option;
    }));
  }

  const dialog = $('submission-dialog');
  const form = $('submission-form');
  function submissionError(message = '') {
    const error = $('submission-error');
    error.textContent = message;
    error.hidden = !message;
  }
  $('open-submission').addEventListener('click', () => {
    submissionError();
    dialog.showModal();
  });
  $('cancel-submission').addEventListener('click', () => dialog.close());
  form.addEventListener('input', () => submissionError());
  dialog.addEventListener('cancel', event => { if (submitting) event.preventDefault(); });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (submitting) return;
    const textField = $('submission-text');
    const tagField = $('submission-tags');
    const text = textField.value.trim();
    const rawTags = tagField.value;
    if (!text || text.length > 500) return submissionError('请输入 1–500 字的正文。');
    if (rawTags.length > 120) return submissionError('标签输入最多 120 字。');

    const byName = new Map(entries.flatMap(entry => entry.tags.map(tag => [normalize(tagName(tag)), tag])));
    const chosen = new Map();
    for (const value of rawTags.split(/[、,，\n]+/)) {
      const tag = tagName(value);
      if (!tag) continue;
      const key = normalize(tag);
      if (!chosen.has(key)) chosen.set(key, byName.get(key) ?? tag);
    }
    const tags = [...chosen.values()];
    if (!tags.length || tags.length > 6 || !tags.every(validTag)) {
      return submissionError('请填写 1–6 个标签，每个标签最多 20 字。');
    }

    submissionError();
    submitting = true;
    textField.readOnly = tagField.readOnly = true;
    $('cancel-submission').disabled = $('submit-entry').disabled = true;
    $('submit-entry').textContent = '正在投稿…';
    try {
      const { entry } = await request({ action: 'submit', text, tags });
      if (!validEntry(entry)) throw new Error('invalid_response');
      if (entries.some(item => item.id === entry.id)) throw new Error('invalid_response');
      entries.push(entry);
      selected.clear();
      $('query').value = '';
      $('order').value = 'latest';
      renderTags();
      renderResults();
      if (!featured) showRandom();
      form.reset();
      dialog.close();
      $('feedback').textContent = '投稿已加入，见最新条目。';
    } catch (error) {
      submissionError(submitErrorMessage(error.message));
    } finally {
      submitting = false;
      textField.readOnly = tagField.readOnly = false;
      $('cancel-submission').disabled = $('submit-entry').disabled = false;
      $('submit-entry').textContent = '加入梗库';
    }
  });

  function submitErrorMessage(code) {
    switch (code) {
      case 'duplicate_text': return '这句已经收录了。';
      case 'invalid_text': return '请输入 1–500 字的正文。';
      case 'invalid_tags': return '请填写 1–6 个标签，每个标签最多 20 字。';
      case 'rate_limited': return '投稿太频繁了，请稍后再试。';
      default: return '暂时无法确认投稿是否成功，已保留填写内容。可以先刷新页面查看。';
    }
  }

  async function loadEntries() {
    $('load-message').textContent = '正在加载梗库…';
    const retry = $('retry-load');
    retry.disabled = true;
    $('results').setAttribute('aria-busy', 'true');
    try {
      const data = await request();
      if (!Array.isArray(data.entries) || !data.entries.every(validEntry) ||
          new Set(data.entries.map(entry => entry.id)).size !== data.entries.length) {
        throw new Error('invalid_response');
      }
      entries = data.entries;
      renderTags();
      showRandom();
      renderResults();
      $('load-state').hidden = true;
      $('query').disabled = $('order').disabled = $('open-submission').disabled = false;
    } catch {
      $('load-message').textContent = '梗库加载失败，请重试。';
      retry.hidden = false;
    } finally {
      retry.disabled = false;
      $('results').removeAttribute('aria-busy');
    }
  }

  $('query').addEventListener('input', renderResults);
  $('order').addEventListener('change', renderResults);
  $('shuffle-button').addEventListener('click', () => showRandom(true));
  $('retry-load').addEventListener('click', loadEntries);
  if (!window.matchMedia('(max-width: 768px)').matches) loadEntries();
})();
