// 按钮墙 / 24 点的全站歌曲续播条：消费一次性的同标签页播放交接。
(() => {
  'use strict';

  const HANDOFF_KEY = 'xsl:cross-page-player:handoff:v1';
  const MAX_HANDOFF_AGE = 5 * 60 * 1000;

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

  const playMode = ['list', 'random', 'single'].includes(saved.playMode) ? saved.playMode : 'list';
  const audio = new Audio();
  audio.preload = 'auto';
  audio.volume = Number.isFinite(saved.volume) ? Math.min(1, Math.max(0, saved.volume)) : 0.8;

  let desiredPlaying = saved.wantedPlaying === true;
  let resumeBlocked = false;
  let loadFailed = false;
  let fallbackTime = Math.max(0, Number(saved.currentTime) || 0);

  const player = document.createElement('div');
  player.className = 'cross-page-song-player';
  player.setAttribute('role', 'region');
  player.setAttribute('aria-label', '全站歌曲播放器');
  player.innerHTML = `
    <button type="button" class="xsp-prev" title="上一首" aria-label="上一首">‹</button>
    <button type="button" class="xsp-toggle" title="播放" aria-label="播放">▶</button>
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
    </div>`;
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
  };

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

  function render() {
    const item = currentItem();
    if (!item) return;
    const time = currentTime();
    const duration = Number.isFinite(audio.duration) ? audio.duration : (Number(saved.duration) || 0);
    dom.name.textContent = item.display_song_name || item.song_name || '未命名';
    dom.artist.textContent = item.artist || '';
    dom.toggle.textContent = audio.paused ? '▶' : 'Ⅱ';
    dom.toggle.title = audio.paused ? '播放' : '暂停';
    dom.toggle.setAttribute('aria-label', audio.paused ? '播放' : '暂停');
    dom.kicker.textContent = loadFailed ? '音频加载失败' : (resumeBlocked ? '点播放继续' : (audio.paused ? '已暂停' : '跨页续播'));
    player.classList.toggle('is-resume-blocked', resumeBlocked || loadFailed);
    dom.current.textContent = formatTime(time);
    dom.duration.textContent = formatTime(duration);
    dom.seek.max = String(Math.max(1, duration));
    dom.seek.value = String(Math.min(time, Math.max(1, duration)));
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
    desiredPlaying = true;
    loadFailed = false;
    try {
      await audio.play();
      resumeBlocked = false;
    } catch (error) {
      resumeBlocked = true;
      console.info('[跨页续播] 自动播放未能启动，等待用户点击播放。', error && error.name);
    }
    render();
  }

  function loadAt(nextIndex, shouldPlay, startAt = 0) {
    index = (nextIndex + queue.length) % queue.length;
    const item = currentItem();
    if (!item) return;

    audio.pause();
    resumeBlocked = false;
    loadFailed = false;
    desiredPlaying = shouldPlay;
    fallbackTime = Math.max(0, Number(startAt) || 0);
    audio.src = item.src;
    audio.addEventListener('loadedmetadata', () => {
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
      desiredPlaying = false;
      resumeBlocked = false;
      audio.pause();
    }
  });
  dom.seek.addEventListener('input', () => {
    const nextTime = Number(dom.seek.value);
    if (Number.isFinite(nextTime)) {
      audio.currentTime = nextTime;
      fallbackTime = nextTime;
    }
    render();
  });

  audio.addEventListener('play', () => {
    desiredPlaying = true;
    resumeBlocked = false;
    render();
  });
  audio.addEventListener('pause', render);
  audio.addEventListener('timeupdate', () => {
    fallbackTime = audio.currentTime;
    render();
  });
  audio.addEventListener('durationchange', render);
  audio.addEventListener('ended', () => {
    desiredPlaying = false;
    if (playMode === 'single') loadAt(index, true, 0);
    else playAdjacent(1);
  });
  audio.addEventListener('error', () => {
    desiredPlaying = false;
    resumeBlocked = false;
    loadFailed = true;
    render();
  });

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
