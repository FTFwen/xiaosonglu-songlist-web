/* Standalone Document Picture-in-Picture lyrics. No player globals required. */
(function (host) {
  'use strict';
  const instances = new WeakMap();
  const NS = 'http://www.w3.org/2000/svg';
  const paths = {
    previous: 'M6 5v14M19 5 8 12l11 7Z',
    next: 'M18 5v14M5 5l11 7-11 7Z',
    play: 'm8 5 11 7-11 7Z',
    pause: 'M8 5v14M16 5v14',
    favorite: 'M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8Z'
  };
  const credit = /^(?:作词|作曲|编曲|词曲|词|曲|演唱|歌手|制作人?|混音师?|母带|录音师?|监制|和声|吉他|小提琴|钢琴|弦乐|贝斯|鼓|翻译|翻唱|策划|出品人?|版权|词作者|曲作者|作詞|編曲|唄|歌|lyrics?|composer|arranger|vocal|producer|guitar|piano|mixed?\s+by|music(?:\s+by)?)\s*[:：]/i;

  function init(options) {
    const { button, audio } = options || {};
    if (!button || !audio || typeof options.getTrack !== 'function') {
      throw new TypeError('XSLLyricsPip.init requires button, audio and getTrack');
    }
    if (instances.has(button)) instances.get(button)();
    const base = host.document.baseURI;
    const cssURL = new URL('css/lyrics-pip.css', base).href;
    let pip = null, opening = false, generation = 0, controller = null;
    let timer = null, raf = null, ui = null, identity = null, track = null;
    let lines = [], nodes = [], active = -1, alignment = null;
    let trial = false, adjustment = 0, loadState = '', disposed = false;
    const removers = [];
    const notify = text => {
      if (typeof options.showMessage === 'function') options.showMessage(text);
      else host.console.warn('[Lyrics PiP] ' + text);
    };
    const listen = (target, name, fn, opts) => {
      target.addEventListener(name, fn, opts);
      removers.push(() => target.removeEventListener(name, fn, opts));
    };
    const pressed = value => {
      button.setAttribute('aria-pressed', String(value));
      button.classList.toggle('active', value);
    };
    pressed(false);

    function snapshot() {
      const value = options.getTrack();
      return value && { songId: value.songId, rowKey: value.rowKey, name: value.name,
        artist: value.artist, audioUrl: value.audioUrl };
    }
    function keyOf(value) {
      return JSON.stringify(value ? [value.songId, value.rowKey, value.audioUrl] : null);
    }
    function current(token) {
      if (!pip || pip.closed || generation !== token) return false;
      try { return keyOf(snapshot()) === identity; } catch (_) { return false; }
    }
    function el(tag, cls, text, parent) {
      const node = pip.document.createElement(tag);
      if (cls) node.className = cls;
      if (text !== undefined) node.textContent = text;
      if (parent) parent.appendChild(node);
      return node;
    }
    function icon(target, name) {
      target.replaceChildren();
      const svg = pip.document.createElementNS(NS, 'svg');
      svg.setAttribute('viewBox', '0 0 24 24');
      svg.setAttribute('aria-hidden', 'true');
      const path = pip.document.createElementNS(NS, 'path');
      path.setAttribute('d', paths[name]);
      svg.appendChild(path);
      target.appendChild(svg);
    }
    function action(parent, label, callback, iconName) {
      const node = el('button', 'lp-button', undefined, parent);
      node.type = 'button';
      node.setAttribute('aria-label', label);
      node.title = label;
      if (iconName) icon(node, iconName); else node.textContent = label;
      listen(node, 'click', callback);
      return node;
    }
    function invoke(name) {
      try {
        const result = typeof options[name] === 'function' ? options[name]() : undefined;
        Promise.resolve(result).then(() => refresh(), () => notify('操作未完成，请重试'));
      } catch (_) { notify('操作未完成，请重试'); }
      refresh();
    }
    function build() {
      const doc = pip.document;
      doc.documentElement.lang = 'zh-CN';
      doc.title = '小松绿 · 歌词';
      const sheet = doc.createElement('link');
      sheet.rel = 'stylesheet'; sheet.href = cssURL; doc.head.appendChild(sheet);
      doc.body.replaceChildren();
      const main = el('main', 'lyrics-pip', undefined, doc.body);
      const head = el('header', 'lp-header', undefined, main);
      el('div', 'lp-eyebrow', '小松绿 · 随身歌词', head);
      const title = el('h1', 'lp-title', '', head);
      const artist = el('p', 'lp-artist', '', head);
      const state = el('p', 'lp-status', '', head);
      state.setAttribute('role', 'status');
      el('p', 'lp-hint', '拖动窗口标题栏移动 · 请保留歌单页面', head);
      const timing = el('div', 'lp-timing', undefined, main);
      const tryButton = action(timing, '试滚歌词', () => {
        if (nodes[active]) nodes[active].classList.remove('is-active');
        trial = !trial; active = -1; updateStatus(); sync();
      });
      const minus = action(timing, '−0.5 秒', () => adjust(-0.5));
      const offset = el('span', 'lp-offset', '', timing);
      const plus = action(timing, '+0.5 秒', () => adjust(0.5));
      const viewport = el('section', 'lp-viewport', undefined, main);
      viewport.setAttribute('aria-label', '歌词'); viewport.tabIndex = 0;
      const list = el('div', 'lp-lines', undefined, viewport);
      const retry = action(main, '重新加载歌词', () => load(track));
      retry.classList.add('lp-retry'); retry.hidden = true;
      const foot = el('footer', 'lp-footer', undefined, main);
      const previous = action(foot, '上一首', () => invoke('previous'), 'previous');
      const toggle = action(foot, '播放', () => invoke('toggle'), 'play');
      toggle.classList.add('lp-toggle');
      const next = action(foot, '下一首', () => invoke('next'), 'next');
      const favorite = action(foot, '收藏', () => invoke('favorite'), 'favorite');
      ui = { title, artist, state, timing, tryButton, minus, plus, offset,
        viewport, list, retry, previous, toggle, next, favorite, playing: null, liked: null };
      listen(doc, 'keydown', event => {
        if (event.code !== 'Space' || event.altKey || event.ctrlKey || event.metaKey || event.repeat) return;
        if (event.target.closest && event.target.closest('button,input,textarea,select,[contenteditable="true"],a[href]')) return;
        event.preventDefault(); invoke('toggle');
      });
    }
    function adjust(delta) {
      adjustment = Math.round((adjustment + delta) * 10) / 10;
      if (nodes[active]) nodes[active].classList.remove('is-active');
      active = -1; updateStatus(); sync();
    }
    function automatic() {
      return alignment && (alignment.humanVerified === true || alignment.status === 'asr_consistent_draft');
    }
    function offsetSeconds() {
      return (alignment && Number.isFinite(alignment.offsetSeconds) ? alignment.offsetSeconds : 0) + adjustment;
    }
    function updateStatus() {
      if (!ui) return;
      let text = loadState;
      if (loadState === 'ready') {
        text = trial ? '试滚 · 时间未校准' : alignment.humanVerified === true ? '人工核验 · 同步歌词' :
          alignment.status === 'asr_consistent_draft' ? '机器草稿 · 未人工核验' : '歌词待校准 · 静态阅读';
        if (adjustment !== 0) text += ' · 本地试调 ' + (adjustment > 0 ? '+' : '') + adjustment.toFixed(1) + ' 秒';
      }
      ui.state.textContent = text;
      ui.timing.hidden = loadState !== 'ready';
      ui.tryButton.hidden = !!automatic();
      ui.tryButton.textContent = trial ? '停止试滚' : '试滚歌词';
      ui.tryButton.setAttribute('aria-pressed', String(trial));
      ui.minus.hidden = ui.plus.hidden = ui.offset.hidden = !(automatic() || trial);
      ui.offset.textContent = '偏移 ' + offsetSeconds().toFixed(1) + ' 秒';
    }
    function message(text) { ui.list.replaceChildren(el('p', 'lp-empty', text)); }
    async function json(url, signal) {
      const response = await host.fetch(url, { signal, cache: 'no-cache', credentials: 'same-origin', redirect: 'error' });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      return response.json();
    }
    async function verifyAudio(record, selected, signal) {
      if (!record.audio || !/^[a-f0-9]{64}$/i.test(record.audio.sha256 || '')) throw new Error('音频版本信息不完整');
      const expected = new URL(record.audio.url, base), actual = new URL(selected.audioUrl, base);
      if (actual.origin !== expected.origin || actual.pathname !== expected.pathname || actual.username || actual.password) throw new Error('音频路径不匹配');
      const digest = record.audio.sha256.toLowerCase();
      for (const url of [expected, actual]) {
        const versions = url.searchParams.getAll('v');
        if (versions.length > 1) throw new Error('音频版本参数有歧义');
        if (versions.length && (!/^[a-f0-9]{12,64}$/i.test(versions[0]) || !digest.startsWith(versions[0].toLowerCase()))) throw new Error('音频版本不匹配');
      }
      if (!expected.searchParams.has('v') || !actual.searchParams.has('v')) {
        if (!host.crypto || !host.crypto.subtle) throw new Error('无法安全核验音频版本');
        const response = await host.fetch(actual.href, { signal, credentials: 'same-origin', redirect: 'error' });
        if (!response.ok) throw new Error('无法读取音频进行版本核验');
        const bytes = await response.arrayBuffer();
        const hash = await host.crypto.subtle.digest('SHA-256', bytes);
        const hex = Array.from(new Uint8Array(hash), n => n.toString(16).padStart(2, '0')).join('');
        if (hex !== digest) throw new Error('实际音频版本不匹配');
      }
    }
    async function load(selected) {
      const token = ++generation;
      if (controller) controller.abort();
      controller = new AbortController();
      const signal = controller.signal;
      lines = []; nodes = []; active = -1; trial = false; adjustment = 0; alignment = null;
      loadState = selected ? '正在核验歌词与音频版本…' : '未选歌';
      ui.retry.hidden = true;
      message(selected ? '正在载入歌词…' : '先在主页面选一首歌吧'); updateStatus();
      if (!selected) return;
      try {
        const id = selected.songId;
        if (!Number.isSafeInteger(id) || !id || typeof selected.rowKey !== 'string' || !selected.rowKey || typeof selected.audioUrl !== 'string' || !selected.audioUrl) throw new Error('当前歌曲信息不完整');
        const key = (id < 0 ? 'derivative-' : 'song-') + Math.abs(id);
        const record = await json(new URL('data/lyrics/tracks/' + key + '.json', base), signal);
        if (!current(token)) return;
        if (record.songId !== id || record.key !== key || record.rowKey !== selected.rowKey) throw new Error('歌词歌曲身份不匹配');
        await verifyAudio(record, selected, signal);
        if (!current(token)) return;
        const match = record.match || {};
        if (match.status !== 'matched') {
          loadState = /candidate|version/.test(match.status || '') ? '歌词来源 / 版本待确认' : '暂无已确认歌词';
          message(loadState); updateStatus(); return;
        }
        const sourceId = match.sourceId;
        if (!Number.isSafeInteger(sourceId) || sourceId <= 0 || match.sourcePath !== 'sources/' + sourceId + '.json' || match.selected?.id !== sourceId) throw new Error('歌词来源信息不一致');
        // Construct from the validated numeric id; never fetch an arbitrary sourcePath.
        const source = await json(new URL('data/lyrics/sources/' + sourceId + '.json', base), signal);
        if (!current(token)) return;
        if (source.id !== sourceId || source.track?.id !== sourceId || source.platform !== 'netease' || !Array.isArray(source.lines)) throw new Error('歌词源身份不匹配');
        lines = source.lines.filter(line => line && Number.isFinite(line.t) && line.t >= 0 && typeof line.text === 'string')
          .map(line => ({ t: line.t, text: line.text.trim() }))
          .filter(line => line.text && !credit.test(line.text)).sort((a, b) => a.t - b.t);
        alignment = record.alignment || {};
        if (!lines.length) { loadState = '暂无可展示歌词'; message('这首歌还没有可展示的歌词'); }
        else {
          loadState = 'ready'; ui.list.replaceChildren(); ui.viewport.scrollTop = 0;
          nodes = lines.map(line => el('p', 'lp-line', line.text, ui.list));
        }
        updateStatus(); sync();
      } catch (error) {
        if (!current(token) || error.name === 'AbortError') return;
        loadState = '歌词加载失败 · 可重试';
        message(error.message || '暂时无法读取歌词'); ui.retry.hidden = false; updateStatus();
      }
    }
    function sync() {
      if (!ui || !pip || pip.closed) return;
      const playing = !audio.paused && !audio.ended;
      if (playing !== ui.playing) {
        ui.playing = playing; icon(ui.toggle, playing ? 'pause' : 'play');
        ui.toggle.setAttribute('aria-label', playing ? '暂停' : '播放');
        ui.toggle.title = playing ? '暂停' : '播放';
      }
      const liked = typeof options.getFavorite === 'function' ? !!options.getFavorite() : false;
      if (liked !== ui.liked) {
        ui.liked = liked; ui.favorite.classList.toggle('is-favorite', liked);
        ui.favorite.setAttribute('aria-pressed', String(liked));
        ui.favorite.setAttribute('aria-label', liked ? '取消收藏' : '收藏');
      }
      for (const name of ['previous', 'toggle', 'next', 'favorite']) ui[name].disabled = !track || typeof options[name] !== 'function';
      if (loadState !== 'ready' || !(automatic() || trial)) return;
      const time = audio.currentTime - offsetSeconds();
      let lo = 0, hi = lines.length;
      while (lo < hi) { const mid = (lo + hi) >>> 1; if (lines[mid].t <= time) lo = mid + 1; else hi = mid; }
      const index = lo - 1;
      if (index === active) return;
      if (nodes[active]) nodes[active].classList.remove('is-active');
      active = index;
      if (nodes[active]) {
        const node = nodes[active]; node.classList.add('is-active');
        const reduce = pip.matchMedia('(prefers-reduced-motion: reduce)').matches;
        // Both rects live in the same visual space, so this stays correct with a header above the
        // viewport, a viewport border, a scaled window and an existing scroll position. A line's
        // offsetTop is already relative to this positioned viewport, so never subtract it again.
        const nodeRect = node.getBoundingClientRect(), viewportRect = ui.viewport.getBoundingClientRect();
        const offsetInContent = ui.viewport.scrollTop + nodeRect.top - viewportRect.top - (ui.viewport.clientTop || 0);
        const top = Math.max(0, offsetInContent - (ui.viewport.clientHeight - nodeRect.height) / 2);
        ui.viewport.scrollTo({ top, behavior: reduce || audio.seeking ? 'instant' : 'smooth' });
      }
    }
    function refresh() {
      if (!pip || pip.closed || !ui) return;
      let selected;
      try { selected = snapshot(); } catch (_) { return; }
      const nextIdentity = keyOf(selected);
      track = selected;
      ui.title.textContent = selected?.name || '还没有选歌';
      ui.artist.textContent = selected?.artist || '';
      pip.document.title = selected?.name ? selected.name + ' · 歌词' : '小松绿 · 歌词';
      if (nextIdentity !== identity) { identity = nextIdentity; load(selected); }
      sync();
    }
    function frame() {
      if (!pip || pip.closed) return;
      refresh(); raf = pip.requestAnimationFrame(frame);
    }
    function cleanup() {
      ++generation;
      if (controller) controller.abort(); controller = null;
      if (timer !== null) host.clearInterval(timer); timer = null;
      if (raf !== null && pip) pip.cancelAnimationFrame(raf); raf = null;
      while (removers.length) removers.pop()();
      pip = null; ui = null; identity = null; track = null;
      lines = []; nodes = []; pressed(false);
    }
    function close() {
      const windowToClose = pip;
      cleanup();
      if (windowToClose && !windowToClose.closed) windowToClose.close();
    }
    function click() {
      if (disposed) return;
      if (pip && !pip.closed) { close(); return; }
      if (opening) return;
      if (!host.isSecureContext) { notify('画中画歌词需要 HTTPS 或 localhost 安全上下文'); return; }
      if (!host.documentPictureInPicture || typeof host.documentPictureInPicture.requestWindow !== 'function') {
        notify('当前浏览器不支持 Document Picture-in-Picture，无法打开置顶歌词窗口'); return;
      }
      opening = true;
      const ticket = ++generation;
      let request;
      try {
        // This call must remain synchronous within the button's user gesture.
        request = host.documentPictureInPicture.requestWindow({ width: 440, height: 580 });
      } catch (error) { opening = false; notify('无法打开画中画歌词：' + error.message); return; }
      Promise.resolve(request).then(window => {
        opening = false;
        if (disposed || generation !== ticket) { window.close(); return; }
        pip = window;
        try {
          build(); pressed(true);
          listen(pip, 'pagehide', cleanup, { once: true });
          for (const name of ['timeupdate', 'play', 'pause', 'seeking', 'seeked', 'ended', 'loadedmetadata', 'ratechange', 'emptied']) listen(audio, name, refresh);
          refresh(); timer = host.setInterval(refresh, 250); raf = pip.requestAnimationFrame(frame);
        } catch (error) { close(); notify('画中画歌词初始化失败：' + error.message); }
      }, error => { opening = false; if (!disposed) notify('无法打开画中画歌词：' + (error.message || '请求被浏览器拒绝')); });
    }
    function dispose() {
      disposed = true; close(); button.removeEventListener('click', click);
      host.removeEventListener('pagehide', dispose);
      if (instances.get(button) === dispose) instances.delete(button);
    }
    button.addEventListener('click', click);
    host.addEventListener('pagehide', dispose, { once: true });
    instances.set(button, dispose);
    return { refresh, close };
  }
  host.XSLLyricsPip = { init };
})(window);
