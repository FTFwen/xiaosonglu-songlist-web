// 按钮墙 / 24 点的全站歌曲续播条：消费一次性的同标签页播放交接。
(() => {
  'use strict';

  const HANDOFF_KEY = 'xsl:cross-page-player:handoff:v1';
  const FAVORITES_KEY = 'favorites:shared';
  const MAX_HANDOFF_AGE = 5 * 60 * 1000;
  const AUDIO_ASSET_VERSION = '3';
  const PLAY_MODES = [
    { key: 'list', glyph: '↻', icon: 'redo', label: '歌单循环', desc: '按顺序播放，播完循环整个播放列表' },
    { key: 'random', glyph: '⇄', icon: 'random-shuffle', label: '随机播放', desc: '播完随机切换下一首' },
    { key: 'single', glyph: '↻', icon: 'sync', label: '单曲循环', desc: '当前曲目循环播放' },
  ];
  const PLAY_MODE_MAP = Object.fromEntries(PLAY_MODES.map(mode => [mode.key, mode]));
  const PLAYER_ICONS = {
    'caret-right': {
      viewBox: '0 0 1024 1024',
      path: 'M715.8 493.5L335 165.1c-14.2-12.2-35-1.2-35 18.5v656.8c0 19.7 20.8 30.7 35 18.5l380.8-328.4c10.9-9.4 10.9-27.6 0-37z',
    },
    pause: {
      viewBox: '64 64 896 896',
      path: 'M304 176h80v672h-80zm408 0h-64c-4.4 0-8 3.6-8 8v656c0 4.4 3.6 8 8 8h64c4.4 0 8-3.6 8-8V184c0-4.4-3.6-8-8-8z',
    },
    'step-backward': {
      viewBox: '0 0 1024 1024',
      path: 'M347.6 528.95l383.2 301.02c14.25 11.2 35.2 1.1 35.2-16.95V210.97c0-18.05-20.95-28.14-35.2-16.94L347.6 495.05a21.53 21.53 0 000 33.9M330 864h-64a8 8 0 01-8-8V168a8 8 0 018-8h64a8 8 0 018 8v688a8 8 0 01-8 8',
    },
    'step-forward': {
      viewBox: '0 0 1024 1024',
      path: 'M676.4 528.95L293.2 829.97c-14.25 11.2-35.2 1.1-35.2-16.95V210.97c0-18.05 20.95-28.14 35.2-16.94l383.2 301.02a21.53 21.53 0 010 33.9M694 864h64a8 8 0 008-8V168a8 8 0 00-8-8h-64a8 8 0 00-8 8v688a8 8 0 008 8',
    },
    redo: {
      viewBox: '64 64 896 896',
      path: 'M758.2 839.1C851.8 765.9 912 651.9 912 523.9 912 303 733.5 124.3 512.6 124 291.4 123.7 112 302.8 112 523.9c0 125.2 57.5 236.9 147.6 310.2 3.5 2.8 8.6 2.2 11.4-1.3l39.4-50.5c2.7-3.4 2.1-8.3-1.2-11.1-8.1-6.6-15.9-13.7-23.4-21.2a318.64 318.64 0 01-68.6-101.7C200.4 609 192 567.1 192 523.9s8.4-85.1 25.1-124.5c16.1-38.1 39.2-72.3 68.6-101.7 29.4-29.4 63.6-52.5 101.7-68.6C426.9 212.4 468.8 204 512 204s85.1 8.4 124.5 25.1c38.1 16.1 72.3 39.2 101.7 68.6 29.4 29.4 52.5 63.6 68.6 101.7 16.7 39.4 25.1 81.3 25.1 124.5s-8.4 85.1-25.1 124.5a318.64 318.64 0 01-68.6 101.7c-9.3 9.3-19.1 18-29.3 26L668.2 724a8 8 0 00-14.1 3l-39.6 162.2c-1.2 5 2.6 9.9 7.7 9.9l167 .8c6.7 0 10.5-7.7 6.3-12.9l-37.3-47.9z',
    },
    'random-shuffle': {
      viewBox: '0 0 1024 1024',
      path: 'M740.144 325.536l-31.456-31.456a16 16 0 0 1-4.688-11.312v-28.304a14.464 14.464 0 0 1 24.688-10.24l97.824 97.824a11.136 11.136 0 0 1 0 15.744l-97.824 97.808a14.464 14.464 0 0 1-24.688-10.24v-28.288a16 16 0 0 1 4.688-11.312l32.224-32.224h-42.464c-91.2 0-162.864 78.304-162.56 184 2.4 133.68-89.68 232-210.4 232H224a16 16 0 0 1-16-16v-16a16 16 0 0 1 16-16h101.504c93.328 0 164.32-75.808 162.384-183.504v-0.432c-0.368-131.328 91.84-232.064 210.56-232.064h41.696z m-41.696 416H768a16 16 0 0 1 16 16v16a16 16 0 0 1-16 16h-69.552c-47.376 0-90.56-16.064-125.28-43.696a13.296 13.296 0 0 1 2.096-22.192l19.68-10.304a16 16 0 0 1 16.592 1.072c3.232 2.256 5.92 4.032 8.048 5.312a151.84 151.84 0 0 0 78.88 21.808z m-288.16-343.744a132.4 132.4 0 0 0-7.936-4.832c-22.672-12.56-48.752-19.424-76.848-19.424H224a16 16 0 0 1-16-16v-16a16 16 0 0 1 16-16h101.504c41.44 0 79.52 11.584 111.568 32.24 0.96 0.608 2 1.312 3.136 2.08a16 16 0 0 1 1.856 24.864l-12.112 11.36a16 16 0 0 1-19.68 1.712z',
    },
    sync: {
      viewBox: '64 64 896 896',
      path: 'M168 504.2c1-43.7 10-86.1 26.9-126 17.3-41 42.1-77.7 73.7-109.4S337 212.3 378 195c42.4-17.9 87.4-27 133.9-27s91.5 9.1 133.8 27A341.5 341.5 0 01755 268.8c9.9 9.9 19.2 20.4 27.8 31.4l-60.2 47a8 8 0 003 14.1l175.7 43c5 1.2 9.9-2.6 9.9-7.7l.8-180.9c0-6.7-7.7-10.5-12.9-6.3l-56.4 44.1C765.8 155.1 646.2 92 511.8 92 282.7 92 96.3 275.6 92 503.8a8 8 0 008 8.2h60c4.4 0 7.9-3.5 8-7.8zm756 7.8h-60c-4.4 0-7.9 3.5-8 7.8-1 43.7-10 86.1-26.9 126-17.3 41-42.1 77.8-73.7 109.4A342.45 342.45 0 01512.1 856a342.24 342.24 0 01-243.2-100.8c-9.9-9.9-19.2-20.4-27.8-31.4l60.2-47a8 8 0 00-3-14.1l-175.7-43c-5-1.2-9.9 2.6-9.9 7.7l-.7 181c0 6.7 7.7 10.5 12.9 6.3l56.4-44.1C258.2 868.9 377.8 932 512.2 932c229.2 0 415.5-183.7 419.8-411.8a8 8 0 00-8-8.2z',
    },
    heart: {
      viewBox: '64 64 896 896',
      path: 'M923 283.6a260.04 260.04 0 00-56.9-82.8 264.4 264.4 0 00-84-55.5A265.34 265.34 0 00679.7 125c-49.3 0-97.4 13.5-139.2 39-10 6.1-19.5 12.8-28.5 20.1-9-7.3-18.5-14-28.5-20.1-41.8-25.5-89.9-39-139.2-39-35.5 0-69.9 6.8-102.4 20.3-31.4 13-59.7 31.7-84 55.5a258.44 258.44 0 00-56.9 82.8c-13.9 32.3-21 66.6-21 101.9 0 33.3 6.8 68 20.3 103.3 11.3 29.5 27.5 60.1 48.2 91 32.8 48.9 77.9 99.9 133.9 151.6 92.8 85.7 184.7 144.9 188.6 147.3l23.7 15.2c10.5 6.7 24 6.7 34.5 0l23.7-15.2c3.9-2.5 95.7-61.6 188.6-147.3 56-51.7 101.1-102.7 133.9-151.6 20.7-30.9 37-61.5 48.2-91 13.5-35.3 20.3-70 20.3-103.3.1-35.3-7-69.6-20.9-101.9zM512 814.8S156 586.7 156 385.5C156 283.6 240.3 201 344.3 201c73.1 0 136.5 40.8 167.7 100.4C543.2 241.8 606.6 201 679.7 201c104 0 188.3 82.6 188.3 184.5 0 201.2-356 429.3-356 429.3z',
    },
    'heart-fill': {
      viewBox: '64 64 896 896',
      path: 'M923 283.6a260.04 260.04 0 00-56.9-82.8 264.4 264.4 0 00-84-55.5A265.34 265.34 0 00679.7 125c-49.3 0-97.4 13.5-139.2 39-10 6.1-19.5 12.8-28.5 20.1-9-7.3-18.5-14-28.5-20.1-41.8-25.5-89.9-39-139.2-39-35.5 0-69.9 6.8-102.4 20.3-31.4 13-59.7 31.7-84 55.5a258.44 258.44 0 00-56.9 82.8c-13.9 32.3-21 66.6-21 101.9 0 33.3 6.8 68 20.3 103.3 11.3 29.5 27.5 60.1 48.2 91 32.8 48.9 77.9 99.9 133.9 151.6 92.8 85.7 184.7 144.9 188.6 147.3l23.7 15.2c10.5 6.7 24 6.7 34.5 0l23.7-15.2c3.9-2.5 95.7-61.6 188.6-147.3 56-51.7 101.1-102.7 133.9-151.6 20.7-30.9 37-61.5 48.2-91 13.5-35.3 20.3-70 20.3-103.3.1-35.3-7-69.6-20.9-101.9z',
    },
    sound: {
      viewBox: '64 64 896 896',
      path: 'M625.9 115c-5.9 0-11.9 1.6-17.4 5.3L254 352H90c-8.8 0-16 7.2-16 16v288c0 8.8 7.2 16 16 16h164l354.5 231.7c5.5 3.6 11.6 5.3 17.4 5.3 16.7 0 32.1-13.3 32.1-32.1V147.1c0-18.8-15.4-32.1-32.1-32.1zM586 803L293.4 611.7l-18-11.7H146V424h129.4l17.9-11.7L586 221v582zm348-327H806c-8.8 0-16 7.2-16 16v40c0 8.8 7.2 16 16 16h128c8.8 0 16-7.2 16-16v-40c0-8.8-7.2-16-16-16zm-41.9 261.8l-110.3-63.7a15.9 15.9 0 00-21.7 5.9l-19.9 34.5c-4.4 7.6-1.8 17.4 5.8 21.8L856.3 800a15.9 15.9 0 0021.7-5.9l19.9-34.5c4.4-7.6 1.7-17.4-5.8-21.8zM760 344a15.9 15.9 0 0021.7 5.9L892 286.2c7.6-4.4 10.2-14.2 5.8-21.8L878 230a15.9 15.9 0 00-21.7-5.9L746 287.8a15.99 15.99 0 00-5.8 21.8L760 344z',
    },
  };

  function playerIcon(id, extraClass = '') {
    const icon = PLAYER_ICONS[id] || PLAYER_ICONS['caret-right'];
    return `<svg class="xsp-icon${extraClass ? ` ${extraClass}` : ''}" viewBox="${icon.viewBox}" aria-hidden="true"><path d="${icon.path}"></path></svg>`;
  }

  function playbackIcon(paused) {
    return playerIcon(paused ? 'caret-right' : 'pause');
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
    <button type="button" class="xsp-prev" title="上一首" aria-label="上一首"><span class="xsp-desktop-glyph" aria-hidden="true">‹</span>${playerIcon('step-backward', 'xsp-mobile-only')}</button>
    <button type="button" class="xsp-toggle" title="播放" aria-label="播放">${playbackIcon(true)}</button>
    <button type="button" class="xsp-next" title="下一首" aria-label="下一首"><span class="xsp-desktop-glyph" aria-hidden="true">›</span>${playerIcon('step-forward', 'xsp-mobile-only')}</button>
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
    <button type="button" class="xsp-mode" title="切换播放模式" aria-label="切换播放模式"><span class="xsp-desktop-glyph" aria-hidden="true">↻</span>${playerIcon('redo', 'xsp-mobile-only icon-sm')}</button>
    <button type="button" class="xsp-favorite" title="收藏到中意清单" aria-label="收藏到中意清单" aria-pressed="false"><span class="xsp-desktop-glyph" aria-hidden="true">♡</span>${playerIcon('heart', 'xsp-mobile-only')}</button>
    <label class="xsp-volume" title="音量">
      ${playerIcon('sound')}
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
    const modeShrink = playMode === 'list' || playMode === 'single';
    const modeContent = `<span class="xsp-desktop-glyph" aria-hidden="true">${mode.glyph}</span>${playerIcon(mode.icon, `xsp-mobile-only${modeShrink ? ' icon-sm' : ''}`)}`;
    setHtml('modeIcon', dom.mode, modeContent);
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
    const favoriteContent = `<span class="xsp-desktop-glyph" aria-hidden="true">${active ? '♥' : '♡'}</span>${playerIcon(active ? 'heart-fill' : 'heart', 'xsp-mobile-only')}`;
    setHtml('favoriteIcon', dom.favorite, favoriteContent);
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
