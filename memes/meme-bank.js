'use strict';
(() => {
  const endpoint = '/api/memes';
  let entries = [];
  const $ = id => document.getElementById(id);
  const mainView = { doc: document, selected: new Set() };
  let pipView, openingPip = false;
  const viewElement = (view, id) => view.doc.getElementById(id);
  const copying = new Set();
  let featured, submitting = false;
  const validCopies = value => Number.isSafeInteger(value) && value >= 0;
  const label = id => `#${String(id).padStart(3, '0')}`;
  const normalize = value => value.normalize('NFKC').toLowerCase();
  const tagName = value => value.normalize('NFKC').trim().replace(/^#+\s*/, '').replace(/\s+/g, ' ');
  const validTag = tag => tag.length > 0 && tag.length <= 20 && !/[、,，\n]/.test(tag);
  const retiredTag = '直播名场面';
  const tagIcons = new Map(Object.entries({
    反串: '🎭', 口头禅: '💬', 吐槽: '🙄', 夸夸: '👏', 开心: '😄', 心疼: '🥺',
    惊讶: '😲', 懂你: '🤝', 戏精: '🎬', 打Call: '📣', 摸鱼: '🐟', 无奈: '😮‍💨',
    爆笑: '🤣', 玩梗: '🤹', 疑惑: '🤔', 着急: '😰', 贴贴: '🫂',
  }).map(([tag, icon]) => [normalize(tag), icon]));
  const showTag = tag => tagName(tag) !== retiredTag;
  const tagIcon = tag => tagIcons.get(normalize(tagName(tag))) ?? '🏷️';
  const visibleEntry = entry => ({ ...entry, tags: entry.tags.filter(showTag) });

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

  async function copyText(text, document) {
    try { await document.defaultView.navigator.clipboard.writeText(text); return true; } catch {}
    const previous = document.activeElement;
    const field = document.createElement('textarea');
    field.value = text;
    field.readOnly = true;
    field.style.cssText = 'position:fixed;left:0;top:0;opacity:0;pointer-events:none';
    document.body.append(field);
    try { field.select(); return document.execCommand('copy'); } catch { return false; }
    finally { field.remove(); previous?.focus(); }
  }

  async function copyEntry(entry, button, selector, view) {
    if (copying.has(entry.id)) return;
    copying.add(entry.id);
    const results = viewElement(view, 'results');
    const region = results.contains(button) ? results : $('random-card');
    const cardSelector = `[data-entry="${entry.id}"]`;
    function report(message) {
      viewElement(view, 'feedback').textContent = message;
      const status = region.querySelector(`${cardSelector} .copy-status`);
      if (status) status.textContent = message;
    }
    try {
      report('');
      if (!await copyText(entry.text, view.doc)) {
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
      for (const target of [mainView, pipView].filter(Boolean)) {
        for (const node of target.doc.querySelectorAll(`[data-copies="${entry.id}"]`)) {
          node.textContent = `${entry.copies} 次复制`;
        }
        if (viewElement(target, 'order').value !== 'copies') continue;
        const restoreFocus = target === view && region === results && view.doc.activeElement === button;
        renderResults(target);
        if (restoreFocus) results.querySelector(`${cardSelector} ${selector}`)?.focus();
      }

      report('已复制正文');
    } finally { copying.delete(entry.id); }
  }

  function card(entry, view = mainView) {
    const node = view.doc.importNode($('card-template').content.firstElementChild, true);
    if (view !== mainView) node.querySelector('.copy-label svg')?.remove();
    node.dataset.entry = entry.id;
    node.querySelector('[data-field="id"]').textContent = label(entry.id);
    const time = node.querySelector('time');
    time.dateTime = time.textContent = entry.date;
    node.querySelector('[data-field="tags"]').textContent = entry.tags.map(tag => `${tagIcon(tag)} #${tag}`).join('  ');
    node.querySelector('.quote').textContent = entry.text;
    const counter = node.querySelector('[data-field="count"]');
    counter.dataset.copies = entry.id;
    counter.textContent = `${entry.copies} 次复制`;
    for (const selector of ['.copy', '.copy-label']) {
      const button = node.querySelector(selector);
      button.addEventListener('click', () => copyEntry(entry, button, selector, view));
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

  function renderResults(view = mainView) {
    const get = id => viewElement(view, id);
    const terms = normalize(get('query').value).trim().split(/\s+/).filter(Boolean);
    const byLatest = (a, b) => b.date.localeCompare(a.date) || b.id - a.id;
    const results = entries.filter(entry => {
      const searchable = normalize([entry.text, ...entry.tags.flatMap(tag => [tag, `#${tag}`]), String(entry.id), label(entry.id)].join(' '));
      return terms.every(term => searchable.includes(term)) && [...view.selected].every(tag => entry.tags.includes(tag));
    });
    results.sort(get('order').value === 'copies' ? (a, b) => b.copies - a.copies || byLatest(a, b) : byLatest);
    get('results').replaceChildren(...results.map(entry => card(entry, view)));
    get('result-count').textContent = `${results.length} / ${entries.length} 条`;
    get('empty').hidden = results.length > 0;
  }

  function renderTags(view = mainView, focusTag) {
    const { doc, selected } = view;
    const tags = new Map();
    for (const entry of entries) {
      for (const tag of new Set(entry.tags)) tags.set(tag, (tags.get(tag) || 0) + 1);
    }
    const sortedTags = [...tags].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh-CN'));
    function chip(tag, count, removable = false) {
      const button = doc.createElement('button');
      const badge = doc.createElement('span');
      const active = selected.has(tag);
      button.type = 'button';
      button.className = 'tag';
      button.textContent = `${tagIcon(tag)} ${tag}`;
      badge.textContent = removable ? '×' : `${count} ${active ? '✓' : '+'}`;
      badge.setAttribute('aria-hidden', 'true');
      if (removable) button.setAttribute('aria-label', `移除标签 ${tag}`);
      else button.setAttribute('aria-pressed', String(active));
      button.append(badge);
      button.addEventListener('click', () => {
        if (!selected.delete(tag)) selected.add(tag);
        renderTags(view, tag);
        renderResults(view);
      });
      return button;
    }
    const selectedTags = viewElement(view, 'selected-tags');
    if (selected.size) {
      const reset = doc.createElement('button');
      reset.type = 'button';
      reset.className = 'tag tag-clear';
      reset.textContent = '清空';
      reset.addEventListener('click', () => {
        const first = selected.values().next().value;
        selected.clear();
        renderTags(view, first);
        renderResults(view);
      });
      selectedTags.replaceChildren(...[...selected].map(tag => chip(tag, 0, true)), reset);
    } else {
      const empty = doc.createElement('span');
      empty.className = 'tag-placeholder';
      empty.textContent = '暂未选择标签';
      selectedTags.replaceChildren(empty);
    }
    const buttons = new Map(sortedTags.map(([tag, count]) => [tag, chip(tag, count)]));
    viewElement(view, 'tags').replaceChildren(...buttons.values());
    buttons.get(focusTag)?.focus({ preventScroll: true });
    if (view === mainView) {
      $('submission-tag-options').replaceChildren(...sortedTags.map(([tag]) => {
        const option = doc.createElement('option');
        option.value = tag;
        option.label = `${tagIcon(tag)} ${tag}`;
        return option;
      }));
    }
  }

  function bindFilters(view) {
    viewElement(view, 'query').addEventListener('input', () => renderResults(view));
    viewElement(view, 'order').addEventListener('change', () => renderResults(view));
  }

  async function openPip() {
    const button = $('open-pip');
    const status = $('pip-message');
    const api = window.documentPictureInPicture;
    if (!api?.requestWindow) {
      status.textContent = '此浏览器不支持画中画，请用桌面版 Chrome 或 Edge。';
      return;
    }
    if (pipView || openingPip) return;
    openingPip = true;
    button.disabled = true;
    status.textContent = '';
    let child;
    try {
      child = await api.requestWindow({ width: 440, height: 570 });
      const doc = child.document;
      const view = { doc, selected: new Set(mainView.selected) };
      function cleanup() {
        if (pipView !== view) return;
        pipView = undefined;
        button.disabled = false;
        button.setAttribute('aria-pressed', 'false');
      }
      pipView = view;
      child.addEventListener('pagehide', cleanup, { once: true });
      doc.title = '小松绿烂梗库';
      doc.documentElement.lang = 'zh-CN';
      doc.documentElement.classList.add('memes-pip');
      const style = doc.createElement('link');
      style.rel = 'stylesheet';
      style.href = document.querySelector('link[href*="meme-bank.css"]').href;
      doc.head.append(style);
      const panel = doc.importNode($('pip-template').content, true);
      panel.querySelector('.pip-filters').append(doc.importNode(document.querySelector('.filters'), true));
      doc.body.append(panel);
      viewElement(view, 'query').value = $('query').value;
      viewElement(view, 'order').value = $('order').value;
      bindFilters(view);
      renderTags(view);
      renderResults(view);
      button.setAttribute('aria-pressed', 'true');
      viewElement(view, 'query').focus();
    } catch {
      child?.close();
      pipView = undefined;
      button.setAttribute('aria-pressed', 'false');
      status.textContent = '画中画未能打开，请再试一次。';
    } finally {
      openingPip = false;
      button.disabled = Boolean(pipView);
    }
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
       if (!showTag(tag)) return submissionError('「直播名场面」已停用，请选用其他标签。');
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
      entries.push(visibleEntry(entry));
      mainView.selected.clear();
      $('query').value = '';
      $('order').value = 'latest';
      renderTags();
      renderResults();
      if (pipView) {
        renderTags(pipView);
        renderResults(pipView);
      }
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
      entries = data.entries.map(visibleEntry);
      renderTags();
      showRandom();
      renderResults();
      $('load-state').hidden = true;
      $('query').disabled = $('order').disabled = $('open-submission').disabled = $('open-pip').disabled = false;
    } catch {
      $('load-message').textContent = '梗库加载失败，请重试。';
      retry.hidden = false;
    } finally {
      retry.disabled = false;
      $('results').removeAttribute('aria-busy');
    }
  }

  bindFilters(mainView);
  $('open-pip').addEventListener('click', openPip);
  $('shuffle-button').addEventListener('click', () => showRandom(true));
  $('retry-load').addEventListener('click', loadEntries);
  if (!window.matchMedia('(max-width: 768px)').matches) loadEntries();
})();
