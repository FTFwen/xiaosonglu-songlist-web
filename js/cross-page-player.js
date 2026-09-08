// 按钮墙 / 24 点的全站歌曲续播条：消费一次性的同标签页播放交接。
(() => {
  'use strict';

  const HANDOFF_KEY = 'xsl:cross-page-player:handoff:v1';
  const FAVORITES_KEY = 'favorites:shared';
  const MAX_HANDOFF_AGE = 5 * 60 * 1000;
  const AUDIO_ASSET_VERSION = '3';
  const PLAY_MODES = [
    { key: 'list', glyph: '↻', label: '歌单循环', desc: '按顺序播放，播完循环整个播放列表' },
    { key: 'random', glyph: '⇄', label: '随机播放', desc: '播完随机切换下一首' },
    { key: 'single', glyph: '↻', label: '单曲循环', desc: '当前曲目循环播放' },
  ];
  const PLAY_MODE_MAP = Object.fromEntries(PLAY_MODES.map(mode => [mode.key, mode]));
  const PLAYBACK_ICONS = {
    play: {
      viewBox: '0 0 1024 1024',
      path: 'M715.8 493.5L335 165.1c-14.2-12.2-35-1.2-35 18.5v656.8c0 19.7 20.8 30.7 35 18.5l380.8-328.4c10.9-9.4 10.9-27.6 0-37z',
    },
    pause: {
      viewBox: '64 64 896 896',
      path: 'M304 176h80v672h-80zm408 0h-64c-4.4 0-8 3.6-8 8v656c0 4.4 3.6 8 8 8h64c4.4 0 8-3.6 8-8V184c0-4.4-3.6-8-8-8z',
    },
  };

  function playbackIcon(paused) {
    const icon = paused ? PLAYBACK_ICONS.play : PLAYBACK_ICONS.pause;
    return `<svg class="xsp-icon" viewBox="${icon.viewBox}" aria-hidden="true"><path d="${icon.path}"></path></svg>`;
  }

  function normalizeDestination(urlValue) {
    try {
      const url = new URL(urlValue, window.location.href);
      if (url.origin !== window.location.origin) return '';
      const path = url.pathname.replace(/\/index\.html$/i, '/').replace(/\/{2,}/g, '/');
      if (path === '/') return '/';
      if (path === '/buttons' || path.startsWith('/buttons/')) return '/buttons/';
      if (path === '/24xsl' || path.startsWith('/24xsl/')) return '/24xsl/';
      return '';
    } catch (error) {
      return '';
    }
  }

  const hostDestination = normalizeDestination(window.location.href);
  if (hostDestination !== '/buttons/' && hostDestination !== '/24xsl/') return;
  document.body.classList.add(hostDestination === '/buttons/' ? 'cross-page-host-buttons' : 'cross-page-host-24');

  function consumeHandoff() {
    let parsed = null;
    try {
      parsed = JSON.parse(sessionStorage.getItem(HANDOFF_KEY) || 'null');
      sessionStorage.removeItem(HANDOFF_KEY);
    } catch (error) {
      return null;
    }
    if (!parsed || parsed.version !== 1 || parsed.destination !== hostDestination) return null;
    if (!Number.isFinite(parsed.createdAt) || Date.now() - parsed.createdAt > MAX_HANDOFF_AGE) return null;
    if (!parsed.song || !parsed.song.src) return null;
    return parsed;
  }

  function safeItem(item) {
    if (!item || !item.src) return null;
    try {
      const url = new URL(item.src, window.location.origin);
      if (url.origin !== window.location.origin) return null;
      if (url.pathname.startsWith('/assets/audio/')) url.searchParams.set('v', AUDIO_ASSET_VERSION);
      return {
        song_id: item.song_id,
        row_key: String(item.row_key || item.song_name || ''),
        song_name: String(item.song_name || item.display_song_name || '未命名'),
        display_song_name: String(item.display_song_name || item.song_name || '未命名'),
        artist: String(item.artist || ''),
        src: url.href,
      };
    } catch (error) {
      return null;
    }
  }

  function favoriteKey(item) {
    const name = String(item && (item.display_song_name || item.song_name || item.row_key) || '').trim();
    return name ? `name:${name}` : '';
  }

  function readFavorites() {
    try {
      const parsed = JSON.parse(localStorage.getItem(FAVORITES_KEY) || '{}');
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch (error) {
      return {};
    }
  }

  function favoriteSnapshot(item, key) {
    return {
      key,
      song_id: item.song_id ?? null,
      row_key: item.row_key || item.song_name || '',
      song_name: item.song_name || item.display_song_name || '',
      display_song_name: item.display_song_name || item.song_name || '',
      artist: item.artist || '',
      artist_search: '',
      feat_artist: '',
      sing_count: 0,
      last_sing_at: '',
      status_labels: '',
      language: '',
      display_version: '',
      tone: '',
      remark: '',
      type: '',
      identification: '',
      importedManual: false,
    };
  }

  function writeFavorites(favorites) {
    try {
      localStorage.setItem(FAVORITES_KEY, JSON.stringify(favorites));
      window.dispatchEvent(new CustomEvent('favorites:shared:changed', { detail: favorites }));
      return true;
    } catch (error) {
      console.warn('[跨页续播] 中意清单保存失败。', error);
      return false;
    }
  }

  const saved = consumeHandoff();
  if (!saved) return;

  let queue = (Array.isArray(saved.queue) ? saved.queue : []).map(safeItem).filter(Boolean);
  const savedSong = safeItem(saved.song);
  if (!queue.length && savedSong) queue = [savedSong];
  if (!queue.length) return;

  let index = Math.min(Math.max(Number(saved.index) || 0, 0), queue.length - 1);
  if (savedSong) {
    const matched = queue.findIndex(item => String(item.song_id) === String(savedSong.song_id) || item.src === savedSong.src);
    if (matched >= 0) index = matched;
  }

  let playMode = PLAY_MODE_MAP[saved.playMode] ? saved.playMode : 'list';
  const audio = new Audio();
  audio.preload = 'auto';
  audio.volume = Number.isFinite(saved.volume) ? Math.min(1, Math.max(0, saved.volume)) : 0.8;

  let desiredPlaying = saved.wantedPlaying === true;
  let resumeBlocked = false;
  let loadFailed = false;
  let fallbackTime = Math.max(0, Number(saved.currentTime) || 0);
  let playRequestId = 0;
  let loadRequestId = 0;
  let noticeText = '';
  let noticeTimer = null;

  const player = document.createElement('div');
  player.className = 'cross-page-song-player';
  player.setAttribute('role', 'region');
  player.setAttribute('aria-label', '全站歌曲播放器');
  player.innerHTML = `
    <button type="button" class="xsp-prev" title="上一首" aria-label="上一首">‹</button>
    <button type="button" class="xsp-toggle" title="播放" aria-label="播放">${playbackIcon(true)}</button>
    <button type="button" class="xsp-next" title="下一首" aria-label="下一首">›</button>
    <div class="xsp-info" aria-live="polite">
      <span class="xsp-kicker">跨页续播</span>
      <span class="xsp-name">未选择歌曲</span>
      <span class="xsp-artist"></span>
    </div>
    <div class="xsp-progress">
      <span class="xsp-current">00:00</span>
      <input class="xsp-seek" type="range" min="0" max="1" value="0" step="0.1" aria-label="播放进度">
      <span class="xsp-duration">00:00</span>
    </div>
    <button type="button" class="xsp-mode" title="切换播放模式" aria-label="切换播放模式"><span aria-hidden="true">↻</span></button>
    <button type="button" class="xsp-favorite" title="收藏到中意清单" aria-label="收藏到中意清单" aria-pressed="false"><span aria-hidden="true">♡</span></button>
    <label class="xsp-volume" title="音量">
      <svg class="xsp-icon" aria-hidden="true"><use href="#icon-sound"></use></svg>
      <input class="xsp-volume-input" type="range" min="0" max="100" value="${Math.round(audio.volume * 100)}" step="1" aria-label="音量">
    </label>`;
  document.body.appendChild(player);
  document.body.classList.add('has-cross-page-song-player');

  const dom = {
    prev: player.querySelector('.xsp-prev'),
    toggle: player.querySelector('.xsp-toggle'),
    next: player.querySelector('.xsp-next'),
    kicker: player.querySelector('.xsp-kicker'),
    name: player.querySelector('.xsp-name'),
    artist: player.querySelector('.xsp-artist'),
    current: player.querySelector('.xsp-current'),
    duration: player.querySelector('.xsp-duration'),
    seek: player.querySelector('.xsp-seek'),
    mode: player.querySelector('.xsp-mode'),
    favorite: player.querySelector('.xsp-favorite'),
    volume: player.querySelector('.xsp-volume-input'),
  };
  dom.volume.setAttribute('aria-valuetext', `${Math.round(audio.volume * 100)}%`);

  function formatTime(value) {
    const seconds = Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
    const minutes = Math.floor(seconds / 60);
    return `${String(minutes).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
  }

  function currentItem() {
    return queue[index] || null;
  }

  function currentTime() {
    return audio.readyState >= 1 && Number.isFinite(audio.currentTime) ? audio.currentTime : fallbackTime;
  }

  const rendered = Object.create(null);

  function setText(key, element, value) {
    if (rendered[key] === value) return;
    rendered[key] = value;
    element.textContent = value;
  }

  function setHtml(key, element, value) {
    if (rendered[key] === value) return;
    rendered[key] = value;
    element.innerHTML = value;
  }

  function showNotice(message) {
    noticeText = message;
    if (noticeTimer) clearTimeout(noticeTimer);
    renderState();
    noticeTimer = setTimeout(() => {
      noticeTimer = null;
      noticeText = '';
      renderState();
    }, 1600);
  }

  function renderMode() {
    const mode = PLAY_MODE_MAP[playMode];
    if (!mode) return;
    setText('modeGlyph', dom.mode, mode.glyph);
    const title = `播放模式：${mode.label}（${mode.desc}），点击切换`;
    if (rendered.modeTitle !== title) {
      rendered.modeTitle = title;
      dom.mode.title = title;
      dom.mode.setAttribute('aria-label', title);
      dom.mode.dataset.mode = mode.key;
    }
  }

  function renderFavorite() {
    const item = currentItem();
    const key = favoriteKey(item);
    const active = !!key && !!readFavorites()[key];
    setText('favoriteGlyph', dom.favorite, active ? '♥' : '♡');
    dom.favorite.classList.toggle('is-active', active);
    dom.favorite.disabled = !key;
    dom.favorite.setAttribute('aria-pressed', String(active));
    const title = key ? (active ? '取消中意' : '收藏到中意清单') : '当前歌曲无法收藏';
    if (rendered.favoriteTitle !== title) {
      rendered.favoriteTitle = title;
      dom.favorite.title = title;
      dom.favorite.setAttribute('aria-label', title);
    }
  }

  function renderState() {
    const item = currentItem();
    if (!item) return;
    const paused = audio.paused;
    const controlLabel = paused ? '播放' : '暂停';
    const blocked = resumeBlocked || loadFailed;
    setText('name', dom.name, item.display_song_name || item.song_name || '未命名');
    setText('artist', dom.artist, item.artist || '');
    setHtml('toggleIcon', dom.toggle, playbackIcon(paused));
    if (rendered.toggleLabel !== controlLabel) {
      rendered.toggleLabel = controlLabel;
      dom.toggle.title = controlLabel;
      dom.toggle.setAttribute('aria-label', controlLabel);
    }
    setText('kicker', dom.kicker, noticeText || (loadFailed ? '音频加载失败' : (resumeBlocked ? '点播放继续' : (paused ? '已暂停' : '跨页续播'))));
    if (rendered.blocked !== blocked) {
      rendered.blocked = blocked;
      player.classList.toggle('is-resume-blocked', blocked);
    }
    renderMode();
    renderFavorite();
  }

  function renderProgress() {
    const time = currentTime();
    const duration = Number.isFinite(audio.duration) ? audio.duration : (Number(saved.duration) || 0);
    const currentLabel = formatTime(time);
    const durationLabel = formatTime(duration);
    const max = String(Math.max(1, duration));
    const value = String(Math.min(time, Math.max(1, duration)));
    setText('currentLabel', dom.current, currentLabel);
    setText('durationLabel', dom.duration, durationLabel);
    if (rendered.seekMax !== max) {
      rendered.seekMax = max;
      dom.seek.max = max;
    }
    if (rendered.seekValue !== value) {
      rendered.seekValue = value;
      dom.seek.value = value;
    }
  }

  function render() {
    renderState();
    renderProgress();
  }

  function buildHandoff(destination) {
    const item = currentItem();
    if (!item) return null;
    return {
      version: 1,
      source: hostDestination,
      destination,
      createdAt: Date.now(),
      nonce: (window.crypto && typeof window.crypto.randomUUID === 'function')
        ? window.crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      song: item,
      queue,
      index,
      currentTime: currentTime(),
      duration: Number.isFinite(audio.duration) ? audio.duration : (Number(saved.duration) || 0),
      volume: audio.volume,
      wantedPlaying: desiredPlaying && !audio.ended,
      playMode,
    };
  }

  function writeHandoff(destination) {
    const payload = buildHandoff(destination);
    if (!payload) return;
    try { sessionStorage.setItem(HANDOFF_KEY, JSON.stringify(payload)); } catch (error) { /* ignore */ }
  }

  async function attemptPlay() {
    const requestId = ++playRequestId;
    const requestedSrc = audio.src;
    desiredPlaying = true;
    loadFailed = false;
    try {
      await audio.play();
      if (requestId !== playRequestId || audio.src !== requestedSrc) return;
      resumeBlocked = false;
    } catch (error) {
      if (requestId !== playRequestId || audio.src !== requestedSrc || error && error.name === 'AbortError') return;
      desiredPlaying = false;
      resumeBlocked = true;
      console.info('[跨页续播] 自动播放未能启动，等待用户点击播放。', error && error.name);
    }
    render();
  }

  function loadAt(nextIndex, shouldPlay, startAt = 0) {
    index = (nextIndex + queue.length) % queue.length;
    const item = currentItem();
    if (!item) return;

    playRequestId += 1;
    const loadId = ++loadRequestId;
    audio.pause();
    resumeBlocked = false;
    loadFailed = false;
    desiredPlaying = shouldPlay;
    fallbackTime = Math.max(0, Number(startAt) || 0);
    audio.src = item.src;
    const requestedSrc = audio.src;
    audio.addEventListener('loadedmetadata', () => {
      if (loadId !== loadRequestId || audio.src !== requestedSrc || currentItem() !== item) return;
      const duration = Number.isFinite(audio.duration) ? audio.duration : 0;
      audio.currentTime = duration > 0 ? Math.min(fallbackTime, Math.max(0, duration - 0.15)) : fallbackTime;
      fallbackTime = audio.currentTime;
      render();
    }, { once: true });
    audio.load();
    if (shouldPlay) attemptPlay();
    render();
  }

  function playAdjacent(direction) {
    if (!queue.length) return;
    let nextIndex;
    if (playMode === 'random' && queue.length > 1) {
      do { nextIndex = Math.floor(Math.random() * queue.length); } while (nextIndex === index);
    } else {
      nextIndex = (index + direction + queue.length) % queue.length;
    }
    loadAt(nextIndex, true, 0);
  }

  dom.prev.addEventListener('click', () => playAdjacent(-1));
  dom.next.addEventListener('click', () => playAdjacent(1));
  dom.toggle.addEventListener('click', () => {
    if (audio.paused) attemptPlay();
    else {
      playRequestId += 1;
      desiredPlaying = false;
      resumeBlocked = false;
      audio.pause();
    }
  });
  dom.mode.addEventListener('click', () => {
    const modeIndex = PLAY_MODES.findIndex(mode => mode.key === playMode);
    playMode = PLAY_MODES[(modeIndex + 1) % PLAY_MODES.length].key;
    renderMode();
    showNotice(`播放模式：${PLAY_MODE_MAP[playMode].label}`);
  });
  dom.favorite.addEventListener('click', () => {
    const item = currentItem();
    const key = favoriteKey(item);
    if (!item || !key) return;
    const favorites = readFavorites();
    const removing = !!favorites[key];
    if (removing) delete favorites[key];
    else favorites[key] = favoriteSnapshot(item, key);
    if (!writeFavorites(favorites)) {
      showNotice('中意清单保存失败');
      return;
    }
    renderFavorite();
    showNotice(removing ? '已取消中意' : '已加入中意');
  });
  dom.volume.addEventListener('input', () => {
    const nextVolume = Math.min(1, Math.max(0, Number(dom.volume.value) / 100));
    audio.volume = Number.isFinite(nextVolume) ? nextVolume : audio.volume;
    dom.volume.setAttribute('aria-valuetext', `${Math.round(audio.volume * 100)}%`);
  });
  dom.seek.addEventListener('input', () => {
    const nextTime = Number(dom.seek.value);
    if (Number.isFinite(nextTime)) {
      audio.currentTime = nextTime;
      fallbackTime = nextTime;
    }
    renderProgress();
  });

  audio.addEventListener('play', () => {
    desiredPlaying = true;
    resumeBlocked = false;
    renderState();
  });
  audio.addEventListener('pause', renderState);
  audio.addEventListener('timeupdate', () => {
    fallbackTime = audio.currentTime;
    renderProgress();
  });
  audio.addEventListener('durationchange', renderProgress);
  audio.addEventListener('ended', () => {
    desiredPlaying = false;
    if (playMode === 'single') loadAt(index, true, 0);
    else playAdjacent(1);
  });
  audio.addEventListener('error', () => {
    playRequestId += 1;
    desiredPlaying = false;
    resumeBlocked = false;
    loadFailed = true;
    render();
  });

  window.addEventListener('storage', event => {
    if (event.key === FAVORITES_KEY) renderFavorite();
  });
  window.addEventListener('favorites:shared:changed', renderFavorite);

  document.addEventListener('click', event => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const link = event.target.closest && event.target.closest('a[href]');
    if (!link || link.target === '_blank' || link.hasAttribute('download')) return;
    const destination = normalizeDestination(link.href);
    if (!destination || destination === hostDestination && link.getAttribute('href') === '#') return;
    writeHandoff(destination);
  }, { capture: true });

  const elapsed = desiredPlaying ? Math.max(0, (Date.now() - saved.createdAt) / 1000) : 0;
  loadAt(index, desiredPlaying, fallbackTime + elapsed);
})();
