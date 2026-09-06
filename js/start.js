/**
 * js/start.js - 小松绿 · 个人工作台 / 浏览器初始页核心脚本
 * 涵盖：壁纸轮换与IndexedDB上传、纯享看图模式(Zen)、聚合搜索、常用网址、
 *      花园空间、黑胶轻量随身听、待办便签、组件显隐设置与配置备份导入导出。
 */

(function () {
  'use strict';

  // ===== 1. 常量与预置数据 =====
  const STORAGE_KEYS = {
    BOOKMARKS_VER: 'start_bm_v2',
    WALLPAPER: 'start_wallpaper_v1',
    SETTINGS: 'start_settings_v1',
    BOOKMARKS: 'start_bookmarks_v1',
    TODOS: 'start_todos_v1',
    MEMO: 'start_memo_v1',
    SEARCH_ENGINE: 'start_search_engine_v1',
    PLAYER: 'start_player_v1',
    WEATHER: 'start_weather_v1',
    WEATHER_CITY: 'start_weather_city_v1'
  };

  // 3 张精选官方预设壁纸库（其余素材暂时归档保留）
  const OFFICIAL_WALLPAPERS = [
    { id: 1, file: 'assets/wallpapers/wallpaper-01.jpg', title: '小松绿 · 园艺晨光', ratio: 0.75 },
    { id: 2, file: 'assets/wallpapers/wallpaper-02.jpg', title: '小松绿 · 晴空微风', ratio: 0.95 },
    { id: 3, file: 'assets/wallpapers/wallpaper-16.jpg', title: '小松绿 · 树荫与飞鸟', ratio: 0.45 }
  ];

  // 默认常用网址书签
  const DEFAULT_BOOKMARKS = [
    { id: 'bm-bili', name: '哔哩哔哩', url: 'https://www.bilibili.com', iconBg: 'linear-gradient(135deg, #00aeec, #0090c5)', svgIcon: 'icon-brand-bilibili' },
    { id: 'bm-github', name: 'GitHub', url: 'https://github.com', iconBg: 'linear-gradient(135deg, #24292e, #111417)', svgIcon: 'icon-brand-github' },
    { id: 'bm-youtube', name: 'YouTube', url: 'https://www.youtube.com', iconBg: 'linear-gradient(135deg, #ff0000, #c40000)', svgIcon: 'icon-brand-youtube' },
    { id: 'bm-bing', name: '必应搜索', url: 'https://cn.bing.com', iconBg: 'linear-gradient(135deg, #008373, #005a4e)', svgIcon: 'icon-brand-bing' },
    { id: 'bm-music', name: '网易云音乐', url: 'https://music.163.com', iconBg: 'linear-gradient(135deg, #e60026, #b8001e)', svgIcon: 'icon-brand-music' },
    { id: 'bm-weibo', name: '微博', url: 'https://weibo.com', iconBg: 'linear-gradient(135deg, #e6162d, #fa7d3c)', svgIcon: 'icon-brand-weibo' },
    { id: 'bm-zhihu', name: '知乎', url: 'https://www.zhihu.com', iconBg: 'linear-gradient(135deg, #0084ff, #0055b3)', svgIcon: 'icon-brand-zhihu' },
    { id: 'bm-specimen', name: '小松绿标本馆', url: 'https://viridis.website', iconBg: 'linear-gradient(135deg, #8a9a4e, #687737)', char: '🌻' }
  ];

  // 默认设置
  const DEFAULT_SETTINGS = {
    maskDarkness: 8,       // 0~60% (轻盈明快，还原插画真实色彩)
    wpFit: "cover",        // "cover" (沉浸全屏铺满) | "contain" (完整画幅居中) | "fill" (拉伸)
    wpPos: "center 18%",   // 壁纸构图焦点对齐：面部黄金区域
    cardBlur: 14,          // 14px 柔美毛玻璃柔焦
    cardOpacity: 45,       // 45% 清晰护眼高可读性
    widgets: {
      search: true,
      bookmarks: true,
      calWeather: true,
      player: true,
      todo: true
    }
  };

  // 搜索引擎配置
  const SEARCH_ENGINES = {
    baidu: { name: '百度', url: 'https://www.baidu.com/s?wd=', placeholder: '百度一下，你就知道…' },
    bing: { name: '必应', url: 'https://cn.bing.com/search?q=', placeholder: '微软 Bing 搜索…' },
    google: { name: 'Google', url: 'https://www.google.com/search?q=', placeholder: 'Google Search…' },
    bilibili: { name: 'B站', url: 'https://search.bilibili.com/all?keyword=', placeholder: '在哔哩哔哩搜索视频、UP主…' },
    github: { name: 'GitHub', url: 'https://github.com/search?q=', placeholder: 'Search repositories & code…' },
    songs: { name: '🎵 站内搜歌', url: 'songs/?q=', placeholder: '在小松绿歌单中检索歌曲、歌手…', internal: true }
  };

  // ===== 2. 状态变量 =====
  let currentSettings = loadSettings();
  let currentBookmarks = loadBookmarks();
  let currentTodos = loadTodos();
  let currentEngine = localStorage.getItem(STORAGE_KEYS.SEARCH_ENGINE) || 'bing';
  if (!SEARCH_ENGINES[currentEngine]) currentEngine = 'bing';

  // 音乐播放器状态
  const playerState = {
    audio: new Audio(),
    songs: [],
    audioMap: {},
    currentIndex: -1,
    isPlaying: false
  };

  // ===== 3. IndexedDB 用于本地大图壁纸存储 =====
  const DB_NAME = 'XslStartDB';
  const DB_VERSION = 1;
  const STORE_WALLPAPER = 'custom_wallpaper';

  function openDatabase() {
    return new Promise((resolve, reject) => {
      if (!window.indexedDB) return reject(new Error('IndexedDB not supported'));
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(STORE_WALLPAPER)) {
          db.createObjectStore(STORE_WALLPAPER);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function saveCustomWallpaperToDB(dataUrl) {
    try {
      const db = await openDatabase();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_WALLPAPER, 'readwrite');
        tx.objectStore(STORE_WALLPAPER).put(dataUrl, 'current');
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } catch (e) {
      console.warn('[StartPage] IndexedDB 存储失败，尝试回退 localStorage:', e);
      try { localStorage.setItem('start_custom_wp_data', dataUrl); } catch (err) {}
    }
  }

  async function getCustomWallpaperFromDB() {
    try {
      const db = await openDatabase();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_WALLPAPER, 'readonly');
        const req = tx.objectStore(STORE_WALLPAPER).get('current');
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    } catch (e) {
      return localStorage.getItem('start_custom_wp_data');
    }
  }

  async function deleteCustomWallpaperFromDB() {
    try {
      const db = await openDatabase();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_WALLPAPER, 'readwrite');
        tx.objectStore(STORE_WALLPAPER).delete('current');
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } catch (e) {}
    try { localStorage.removeItem('start_custom_wp_data'); } catch (e) {}
  }

  // ===== 4. 壁纸管理系统 =====
  let currentWallpaperIndex = 0;

  async function initWallpaper() {
    const saved = localStorage.getItem(STORAGE_KEYS.WALLPAPER);
    if (saved === 'custom') {
      const customUrl = await getCustomWallpaperFromDB();
      if (customUrl) {
        applyWallpaper(customUrl, true);
        return;
      }
    }

    // 支持 URL 参数直达指定壁纸（例如 ?wp=2）或保存的官方壁纸索引
    const urlParams = new URLSearchParams(window.location.search);
    const wpParam = urlParams.get('wp');
    if (wpParam) {
      const idx = parseInt(wpParam, 10) - 1;
      if (idx >= 0 && idx < OFFICIAL_WALLPAPERS.length) {
        currentWallpaperIndex = idx;
        applyWallpaper(OFFICIAL_WALLPAPERS[currentWallpaperIndex].file);
        return;
      }
    }

    // 默认：随机挑选一张
    currentWallpaperIndex = Math.floor(Math.random() * OFFICIAL_WALLPAPERS.length);
    applyWallpaper(OFFICIAL_WALLPAPERS[currentWallpaperIndex].file);
  }

  function applyWallpaper(url, isCustom = false) {
    const wpImg = document.getElementById('wallpaperBg');
    const wpAmbient = document.getElementById('wallpaperAmbient');
    if (!wpImg) return;

    const wpInfo = OFFICIAL_WALLPAPERS[currentWallpaperIndex];
    const fitMode = currentSettings.wpFit || 'cover';

    let effectiveMode = 'mode-cover';
    if (fitMode === 'contain') {
      effectiveMode = 'mode-contain';
    } else if (fitMode === 'fill') {
      effectiveMode = 'mode-fill';
    } else {
      effectiveMode = 'mode-cover';
    }

    wpImg.classList.remove('mode-cover', 'mode-contain', 'mode-fill');
    wpImg.classList.add(effectiveMode);
    wpImg.classList.add('transitioning');

    const newImg = new Image();
    newImg.onload = () => {
      wpImg.style.backgroundImage = `url("${url}")`;
      if (wpAmbient) {
        wpAmbient.style.backgroundImage = `url("${url}")`;
        // 仅在 contain 模式下显示环境氛围层
        wpAmbient.style.opacity = (effectiveMode === 'mode-contain') ? '1' : '0';
      }
      wpImg.classList.remove('transitioning');
    };
    newImg.src = url;

    // 同步设置指示器
    const titleEl = document.getElementById('wallpaperTitle');
    if (titleEl) {
      titleEl.textContent = isCustom ? '自定义壁纸' : (wpInfo ? wpInfo.title : '官方精选');
    }
  }

  function nextWallpaper() {
    currentWallpaperIndex = (currentWallpaperIndex + 1) % OFFICIAL_WALLPAPERS.length;
    localStorage.removeItem(STORAGE_KEYS.WALLPAPER);
    applyWallpaper(OFFICIAL_WALLPAPERS[currentWallpaperIndex].file);
    showToast(`已切换壁纸：${OFFICIAL_WALLPAPERS[currentWallpaperIndex].title}`);
  }

  
  window.addEventListener('resize', () => {
    const wpInfo = OFFICIAL_WALLPAPERS[currentWallpaperIndex];
    if (wpInfo) {
      const isCustom = localStorage.getItem(STORAGE_KEYS.WALLPAPER) === 'custom';
      applyWallpaper(wpInfo.file, isCustom);
    }
  }, { passive: true });
  
  // ===== 5. 纯享看图模式 (Zen Mode) =====
  let isZenMode = false;
  let zenToastTimer = null;

  function toggleZenMode(forceState) {
    isZenMode = typeof forceState === 'boolean' ? forceState : !isZenMode;
    document.body.classList.toggle('zen-mode', isZenMode);

    const hint = document.getElementById('zenHint');
    if (isZenMode) {
      if (hint) {
        hint.classList.add('show');
        clearTimeout(zenToastTimer);
        zenToastTimer = setTimeout(() => hint.classList.remove('show'), 2800);
      }
    } else {
      if (hint) hint.classList.remove('show');
    }
  }

  // ===== 6. 时间、日期、农历与时段问候 =====
  function getGreeting(hour) {
    if (hour >= 5 && hour < 9) return '清晨好，深呼吸，迎接崭新的一天 🍃';
    if (hour >= 9 && hour < 12) return '上午好，专注当下，保持明媚好心情 🌻';
    if (hour >= 12 && hour < 14) return '中午好，记得好好吃饭，稍作小憩 🍱';
    if (hour >= 14 && hour < 18) return '下午好，喝杯水，享受微风与阳光 ☕';
    if (hour >= 18 && hour < 23) return '晚上好，辛苦了一整天，听首歌放松一下吧 🎶';
    return '夜深了，早点休息哦，祝你有个甜甜的美梦 🌙';
  }

  function getSolarTermOrDate(d) {
    const month = d.getMonth() + 1;
    const day = d.getDate();
    if (month === 1 && day === 1) return '元旦 🎊';
    if (month === 5 && day === 1) return '劳动节 🛠️';
    if (month === 6 && day === 1) return '儿童节 🎈';
    if (month === 9 && day === 10) return '教师节 📖';
    if (month === 10 && day === 1) return '国庆节 🇨🇳';
    return '草木有情 · 森系常青 🌿';
  }

  function updateClock() {
    const now = new Date();
    const h = String(now.getHours()).padStart(2, '0');
    const m = String(now.getMinutes()).padStart(2, '0');
    const s = String(now.getSeconds()).padStart(2, '0');

    const clockHours = document.getElementById('clockHours');
    const clockMinutes = document.getElementById('clockMinutes');
    const clockSeconds = document.getElementById('clockSeconds');
    if (clockHours) clockHours.textContent = h;
    if (clockMinutes) clockMinutes.textContent = m;
    if (clockSeconds) clockSeconds.textContent = s;

    // 问候与日期更新（首次无条件执行，后续每分钟整点同步）
    const clockDate = document.getElementById('clockDate');
    if (clockDate && (now.getSeconds() === 0 || clockDate.dataset.inited !== 'true')) {
      clockDate.dataset.inited = 'true';
      const weekdays = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
      const dateStr = `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日 ${weekdays[now.getDay()]}`;
      const clockGreeting = document.getElementById('clockGreeting');
      const clockSolar = document.getElementById('clockSolar');

      clockDate.textContent = dateStr;
      if (clockGreeting) clockGreeting.textContent = getGreeting(now.getHours());
      if (clockSolar) clockSolar.textContent = getSolarTermOrDate(now);
    }
  }

  // ===== 7. 聚合搜索系统 =====
  function initSearch() {
    const input = document.getElementById('searchInput');
    const form = document.getElementById('searchForm');
    const clearBtn = document.getElementById('searchClearBtn');
    const tabs = document.querySelectorAll('.search-engine-tab');

    syncEngineTabs(currentEngine);

    tabs.forEach(tab => {
      tab.addEventListener('click', () => {
        const engineKey = tab.dataset.engine;
        if (!SEARCH_ENGINES[engineKey]) return;
        currentEngine = engineKey;
        localStorage.setItem(STORAGE_KEYS.SEARCH_ENGINE, currentEngine);
        syncEngineTabs(currentEngine);
        input.focus();
      });
    });

    if (input && clearBtn) {
      input.addEventListener('input', () => {
        clearBtn.style.display = input.value ? 'flex' : 'none';
      });
      clearBtn.addEventListener('click', () => {
        input.value = '';
        clearBtn.style.display = 'none';
        input.focus();
      });
    }

    if (form) {
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        const query = (input.value || '').trim();
        if (!query) {
          input.focus();
          return;
        }

        const engine = SEARCH_ENGINES[currentEngine] || SEARCH_ENGINES.bing;
        if (engine.internal) {
          window.location.href = `songs/?q=${encodeURIComponent(query)}`;
        } else {
          window.open(`${engine.url}${encodeURIComponent(query)}`, '_blank', 'noopener,noreferrer');
        }
      });
    }
  }

  function syncEngineTabs(activeKey) {
    const tabs = document.querySelectorAll('.search-engine-tab');
    const input = document.getElementById('searchInput');
    tabs.forEach(t => t.classList.toggle('active', t.dataset.engine === activeKey));
    if (input && SEARCH_ENGINES[activeKey]) {
      input.placeholder = SEARCH_ENGINES[activeKey].placeholder;
    }
  }

  // ===== 8. 常用网址书签系统 =====
  function loadBookmarks() {
    // 升级重置为高质感 SVG 图标
    if (localStorage.getItem('start_bm_migrated_v2') !== 'true') {
      localStorage.setItem('start_bm_migrated_v2', 'true');
      localStorage.removeItem(STORAGE_KEYS.BOOKMARKS);
      return [...DEFAULT_BOOKMARKS];
    }
    try {
      const raw = localStorage.getItem(STORAGE_KEYS.BOOKMARKS);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length) return parsed;
      }
    } catch (e) {}
    return [...DEFAULT_BOOKMARKS];
  }

  function saveBookmarks(list) {
    currentBookmarks = list;
    localStorage.setItem(STORAGE_KEYS.BOOKMARKS, JSON.stringify(list));
    renderBookmarks();
  }

  function renderBookmarks() {
    const grid = document.getElementById('bookmarksGrid');
    if (!grid) return;

    const items = currentBookmarks.map((bm, index) => {
      const bg = bm.iconBg ? (bm.iconBg.startsWith('linear-gradient') ? `background: ${bm.iconBg};` : `background-color: ${bm.iconBg};`) : 'background-color: var(--primary);';
      const iconHtml = bm.svgIcon 
        ? `<svg class="bookmark-brand-svg" aria-hidden="true"><use href="#${bm.svgIcon}"></use></svg>`
        : `<span>${escapeHtml(bm.char || (bm.name ? bm.name.slice(0, 1).toUpperCase() : '★'))}</span>`;

      return `
        <div class="bookmark-item" data-id="${bm.id || index}">
          <a class="bookmark-link" href="${escapeHtml(bm.url)}" target="_blank" rel="noopener" title="${escapeHtml(bm.name)}&#10;${escapeHtml(bm.url)}">
            <div class="bookmark-icon" style="${bg}">
              ${iconHtml}
            </div>
            <span class="bookmark-title">${escapeHtml(bm.name)}</span>
          </a>
          <button class="bookmark-del-btn" data-index="${index}" title="删除此快捷方式" aria-label="删除">✕</button>
        </div>
      `;
    }).join('');

    grid.innerHTML = items + `
      <div class="bookmark-item bookmark-add" id="addBookmarkBtn" role="button" tabindex="0" title="添加新的常用网址">
        <div class="bookmark-icon add-icon">
          <span>+</span>
        </div>
        <span class="bookmark-title">添加捷径</span>
      </div>
    `;

    grid.querySelectorAll('.bookmark-del-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        const idx = Number(btn.dataset.index);
        if (!isNaN(idx)) {
          const removed = currentBookmarks[idx];
          currentBookmarks.splice(idx, 1);
          saveBookmarks(currentBookmarks);
          showToast(`已移除书签：${removed.name || '未命名'}`);
        }
      });
    });

    const addBtn = document.getElementById('addBookmarkBtn');
    if (addBtn) {
      addBtn.addEventListener('click', openAddBookmarkDialog);
    }
  }

  function openAddBookmarkDialog() {
    const dialog = document.getElementById('bookmarkDialog');
    const nameInput = document.getElementById('bmDialogName');
    const urlInput = document.getElementById('bmDialogUrl');
    if (!dialog) return;

    nameInput.value = '';
    urlInput.value = '';
    dialog.showModal();
    nameInput.focus();
  }

  // ===== 9. 黑胶轻量随身听 =====
  async function initMiniPlayer() {
    const playBtn = document.getElementById('playerPlayBtn');
    const prevBtn = document.getElementById('playerPrevBtn');
    const nextBtn = document.getElementById('playerNextBtn');
    const shuffleBtn = document.getElementById('playerShuffleBtn');
    const disc = document.getElementById('vinylDisc');
    const progressBar = document.getElementById('playerProgress');
    const timeEl = document.getElementById('playerTime');

    try {
      if (window.XSL_DATA && window.XSL_DATA.song_catalog && window.XSL_DATA.song_catalog.songs) {
        playerState.songs = window.XSL_DATA.song_catalog.songs;
      } else {
        const res = await fetch('data/xiaosonglu/song_catalog.json');
        if (res.ok) {
          const json = await res.json();
          playerState.songs = json.songs || [];
        }
      }

      const audioRes = await fetch('data/xiaosonglu/audio_index.json');
      if (audioRes.ok) {
        const audioJson = await audioRes.json();
        playerState.audioMap = audioJson.audios || {};
      }
    } catch (e) {
      console.warn('[StartPage] 歌曲数据加载异常:', e);
    }

    if (playerState.songs.length) {
      playerState.currentIndex = Math.floor(Math.random() * playerState.songs.length);
      renderPlayerSong(playerState.songs[playerState.currentIndex]);
    }

    if (playBtn) playBtn.addEventListener('click', togglePlaySong);
    if (nextBtn) nextBtn.addEventListener('click', () => changeSong(1));
    if (prevBtn) prevBtn.addEventListener('click', () => changeSong(-1));
    if (shuffleBtn) shuffleBtn.addEventListener('click', () => pickRandomSong(true));

    playerState.audio.addEventListener('play', () => {
      playerState.isPlaying = true;
      if (playBtn) playBtn.innerHTML = '<svg class="icon"><use href="#icon-pause"></use></svg>';
      if (disc) disc.classList.add('playing');
    });

    playerState.audio.addEventListener('pause', () => {
      playerState.isPlaying = false;
      if (playBtn) playBtn.innerHTML = '<svg class="icon"><use href="#icon-play"></use></svg>';
      if (disc) disc.classList.remove('playing');
    });

    playerState.audio.addEventListener('timeupdate', () => {
      const cur = playerState.audio.currentTime || 0;
      const dur = playerState.audio.duration || 0;
      if (dur > 0 && progressBar) {
        progressBar.value = (cur / dur) * 100;
      }
      if (timeEl) {
        timeEl.textContent = `${formatTime(cur)} / ${formatTime(dur)}`;
      }
    });

    playerState.audio.addEventListener('ended', () => {
      changeSong(1, true);
    });

    playerState.audio.addEventListener('error', (e) => {
      console.warn('[MiniPlayer] 音频播放失败:', e);
      if (disc) disc.classList.remove('playing');
      if (playBtn) playBtn.innerHTML = '<svg class="icon"><use href="#icon-play"></use></svg>';
      const current = playerState.songs[playerState.currentIndex];
      showToast(`《${current ? current.display_song_name || current.song_name : '此歌'}》音频未在本地就绪，可前往完整歌单收听 🎵`);
    });

    if (progressBar) {
      progressBar.addEventListener('input', () => {
        const dur = playerState.audio.duration || 0;
        if (dur > 0) {
          playerState.audio.currentTime = (progressBar.value / 100) * dur;
        }
      });
    }
  }

  function renderPlayerSong(song) {
    if (!song) return;
    const titleEl = document.getElementById('playerSongTitle');
    const artistEl = document.getElementById('playerSongArtist');
    const tagEl = document.getElementById('playerSongTag');
    const cutBtn = document.getElementById('playerCutLinkBtn');

    if (titleEl) titleEl.textContent = song.display_song_name || song.song_name || '未知曲目';
    if (artistEl) artistEl.textContent = song.artist || '小松绿';
    if (tagEl) tagEl.textContent = song.language || song.type || '精选';

    if (cutBtn) {
      if (song.cut_link) {
        cutBtn.href = song.cut_link;
        cutBtn.style.display = 'inline-flex';
      } else {
        cutBtn.style.display = 'none';
      }
    }
  }

  function togglePlaySong() {
    if (!playerState.songs.length) return;
    if (playerState.currentIndex < 0) playerState.currentIndex = 0;
    const song = playerState.songs[playerState.currentIndex];

    if (playerState.isPlaying) {
      playerState.audio.pause();
    } else {
      const audioRel = playerState.audioMap[song.row_key || song.song_name];
      if (audioRel) {
        playerState.audio.src = audioRel;
        playerState.audio.play().catch(err => {
          console.warn('[MiniPlayer] 播放拦截:', err);
          showToast(`音频切片未就绪，可前往完整歌单或点击B站切片收听 🎵`);
        });
      } else {
        showToast(`《${song.song_name}》暂未收录本地音频，建议前往完整歌单查看 🎵`);
      }
    }
  }

  function changeSong(step, autoPlay = false) {
    if (!playerState.songs.length) return;
    playerState.currentIndex = (playerState.currentIndex + step + playerState.songs.length) % playerState.songs.length;
    const song = playerState.songs[playerState.currentIndex];
    renderPlayerSong(song);

    const audioRel = playerState.audioMap[song.row_key || song.song_name];
    if (audioRel) {
      playerState.audio.src = audioRel;
      if (playerState.isPlaying || autoPlay) {
        playerState.audio.play().catch(() => {});
      }
    } else {
      playerState.audio.pause();
      playerState.audio.removeAttribute('src');
    }
  }

  function pickRandomSong(autoPlay = true) {
    if (!playerState.songs.length) return;
    const nextIdx = Math.floor(Math.random() * playerState.songs.length);
    playerState.currentIndex = nextIdx;
    const song = playerState.songs[nextIdx];
    renderPlayerSong(song);

    const audioRel = playerState.audioMap[song.row_key || song.song_name];
    if (audioRel) {
      playerState.audio.src = audioRel;
      if (autoPlay) playerState.audio.play().catch(() => {});
    }
    showToast(`今日随心听：${song.display_song_name || song.song_name}`);
  }

  // ===== 10. 待办与灵感便签 =====
  function loadTodos() {
    try {
      const raw = localStorage.getItem(STORAGE_KEYS.TODOS);
      if (raw) return JSON.parse(raw);
    } catch (e) {}
    return [
      { id: 1, text: '看一场小松绿的直播 🌻', done: false },
      { id: 2, text: '去按钮墙连击 10 次 🎵', done: false }
    ];
  }

  function saveTodos(todos) {
    currentTodos = todos;
    localStorage.setItem(STORAGE_KEYS.TODOS, JSON.stringify(todos));
    renderTodos();
  }

  function renderTodos() {
    const listEl = document.getElementById('todoList');
    if (!listEl) return;

    if (!currentTodos.length) {
      listEl.innerHTML = '<div class="todo-empty">暂无待办事项，轻松一下吧 🍵</div>';
      return;
    }

    listEl.innerHTML = currentTodos.map((item, idx) => `
      <li class="todo-item ${item.done ? 'done' : ''}" data-index="${idx}">
        <label class="todo-check-label">
          <input type="checkbox" ${item.done ? 'checked' : ''} class="todo-checkbox">
          <span class="todo-text">${escapeHtml(item.text)}</span>
        </label>
        <button class="todo-del-btn" title="删除">✕</button>
      </li>
    `).join('');

    listEl.querySelectorAll('.todo-checkbox').forEach(input => {
      input.addEventListener('change', (e) => {
        const itemEl = e.target.closest('.todo-item');
        const idx = Number(itemEl.dataset.index);
        if (!isNaN(idx)) {
          currentTodos[idx].done = e.target.checked;
          saveTodos(currentTodos);
        }
      });
    });

    listEl.querySelectorAll('.todo-del-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const itemEl = e.target.closest('.todo-item');
        const idx = Number(itemEl.dataset.index);
        if (!isNaN(idx)) {
          currentTodos.splice(idx, 1);
          saveTodos(currentTodos);
        }
      });
    });
  }

  function initTodoAndMemo() {
    renderTodos();

    const addInput = document.getElementById('todoInput');
    const addBtn = document.getElementById('todoAddBtn');
    const clearDoneBtn = document.getElementById('todoClearDoneBtn');

    if (addBtn && addInput) {
      const handleAdd = () => {
        const val = addInput.value.trim();
        if (!val) return;
        currentTodos.unshift({ id: Date.now(), text: val, done: false });
        saveTodos(currentTodos);
        addInput.value = '';
      };
      addBtn.addEventListener('click', handleAdd);
      addInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') handleAdd();
      });
    }

    if (clearDoneBtn) {
      clearDoneBtn.addEventListener('click', () => {
        currentTodos = currentTodos.filter(t => !t.done);
        saveTodos(currentTodos);
        showToast('已清理完成的待办事项');
      });
    }

    const memoTextarea = document.getElementById('memoTextarea');
    if (memoTextarea) {
      memoTextarea.value = localStorage.getItem(STORAGE_KEYS.MEMO) || '';
      let timer = null;
      memoTextarea.addEventListener('input', () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          localStorage.setItem(STORAGE_KEYS.MEMO, memoTextarea.value);
        }, 300);
      });
    }

    const tabs = document.querySelectorAll('.memo-todo-tab');
    tabs.forEach(tab => {
      tab.addEventListener('click', () => {
        tabs.forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        const target = tab.dataset.tab;
        const todoPanel = document.getElementById('panelTodo');
        const memoPanel = document.getElementById('panelMemo');
        if (todoPanel && memoPanel) {
          todoPanel.style.display = target === 'todo' ? 'flex' : 'none';
          memoPanel.style.display = target === 'memo' ? 'flex' : 'none';
        }
      });
    });
  }

  // ===== 11. 设置抽屉与个性化定制 =====
  function loadSettings() {
    try {
      const raw = localStorage.getItem(STORAGE_KEYS.SETTINGS);
      if (raw) {
        const parsed = JSON.parse(raw);
        // 升级旧版配置：自动升级为沉浸式全屏 cover、舒适毛玻璃柔焦与高清晰度护眼底色
        if (parsed.wpFit === 'auto' || !parsed.wpFit) parsed.wpFit = 'cover';
        if (parsed.cardOpacity === undefined || parsed.cardOpacity < 20) parsed.cardOpacity = 45;
        if (parsed.cardBlur === undefined || parsed.cardBlur < 10) parsed.cardBlur = 14;
        if (!parsed.wpPos) parsed.wpPos = 'center 18%';
        if (parsed.maskDarkness > 15) parsed.maskDarkness = 8;
        if (parsed.widgets) {
          if (parsed.widgets.calWeather === undefined) {
            parsed.widgets.calWeather = parsed.widgets.garden !== false;
          }
        }
        return Object.assign({}, DEFAULT_SETTINGS, parsed);
      }
    } catch (e) {}
    return Object.assign({}, DEFAULT_SETTINGS);
  }

  function saveSettings(s) {
    currentSettings = s;
    localStorage.setItem(STORAGE_KEYS.SETTINGS, JSON.stringify(s));
    applySettings();
  }

  function applySettings() {
    const mask = document.getElementById('wallpaperMask');
    if (mask) {
      mask.style.backgroundColor = `rgba(0, 0, 0, ${(currentSettings.maskDarkness ?? 8) / 100})`;
    }
    const isNight = document.documentElement.getAttribute('data-ambience-time') === 'night';
    const blur = currentSettings.cardBlur ?? 14;
    const opacity = (currentSettings.cardOpacity ?? 45) / 100;

    document.documentElement.style.setProperty('--card-blur', `${blur}px`);
    document.documentElement.style.setProperty('--card-opacity', `${opacity}`);
    if (isNight) {
      document.documentElement.style.setProperty('--card-bg', `rgba(16, 24, 36, ${Math.max(0.78, opacity)})`);
    } else {
      document.documentElement.style.setProperty('--card-bg', `rgba(255, 255, 255, ${opacity})`);
    }
    document.documentElement.style.setProperty('--wp-pos', currentSettings.wpPos || 'center 18%');

    const widgetMap = {
      search: document.getElementById('widgetSearch'),
      bookmarks: document.getElementById('widgetBookmarks'),
      calWeather: document.getElementById('widgetCalWeather'),
      player: document.getElementById('widgetPlayer'),
      todo: document.getElementById('widgetTodo')
    };

    Object.keys(widgetMap).forEach(key => {
      const el = widgetMap[key];
      if (el) {
        const isVisible = currentSettings.widgets[key] !== false;
        el.style.display = isVisible ? '' : 'none';
      }
    });
  }

  function initSettingsDrawer() {
    applySettings();

    const drawer = document.getElementById('settingsDrawer');
    const openBtn = document.getElementById('openSettingsBtn');
    const closeBtn = document.getElementById('closeSettingsBtn');

    if (openBtn && drawer) {
      openBtn.addEventListener('click', () => {
        syncSettingsForm();
        drawer.showModal();
      });
    }

    if (closeBtn && drawer) {
      closeBtn.addEventListener('click', () => drawer.close());
    }

    // 画幅模式切换
    const wpFitSelect = document.getElementById('wpFitSelect');
    if (wpFitSelect) {
      wpFitSelect.value = currentSettings.wpFit || 'cover';
      wpFitSelect.addEventListener('change', (e) => {
        currentSettings.wpFit = e.target.value;
        saveSettings(currentSettings);
        const isCustom = localStorage.getItem(STORAGE_KEYS.WALLPAPER) === 'custom';
        const curUrl = isCustom ? (document.getElementById('wallpaperBg')?.style.backgroundImage?.replace(/url\(["']?([^"']*)["']?\)/, '$1')) : OFFICIAL_WALLPAPERS[currentWallpaperIndex]?.file;
        if (curUrl) applyWallpaper(curUrl, isCustom);
      });
    }

    // 壁纸构图焦点对准
    const wpPosSelect = document.getElementById('wpPosSelect');
    if (wpPosSelect) {
      wpPosSelect.value = currentSettings.wpPos || 'center 18%';
      wpPosSelect.addEventListener('change', (e) => {
        currentSettings.wpPos = e.target.value;
        saveSettings(currentSettings);
      });
    }

    // 卡片透明度调节 (2% ~ 35%)
    const opacityRange = document.getElementById('cardOpacityRange');
    const opacityVal = document.getElementById('cardOpacityVal');
    if (opacityRange) {
      opacityRange.value = currentSettings.cardOpacity ?? 6;
      if (opacityVal) opacityVal.textContent = `${currentSettings.cardOpacity ?? 6}%`;
      opacityRange.addEventListener('input', (e) => {
        currentSettings.cardOpacity = Number(e.target.value);
        if (opacityVal) opacityVal.textContent = `${currentSettings.cardOpacity}%`;
        saveSettings(currentSettings);
      });
    }

    // 毛玻璃模糊度调节
    const blurRange = document.getElementById('cardBlurRange');
    const blurVal = document.getElementById('cardBlurVal');
    if (blurRange) {
      blurRange.value = currentSettings.cardBlur ?? 8;
      if (blurVal) blurVal.textContent = `${currentSettings.cardBlur ?? 8}px`;
      blurRange.addEventListener('input', (e) => {
        currentSettings.cardBlur = Number(e.target.value);
        if (blurVal) blurVal.textContent = `${currentSettings.cardBlur}px`;
        saveSettings(currentSettings);
      });
    }

    // 背景遮罩浓度
    const darknessRange = document.getElementById('maskDarknessRange');
    const darknessVal = document.getElementById('maskDarknessVal');
    if (darknessRange) {
      darknessRange.value = currentSettings.maskDarkness ?? 8;
      if (darknessVal) darknessVal.textContent = `${currentSettings.maskDarkness ?? 8}%`;
      darknessRange.addEventListener('input', (e) => {
        currentSettings.maskDarkness = Number(e.target.value);
        if (darknessVal) darknessVal.textContent = `${currentSettings.maskDarkness}%`;
        saveSettings(currentSettings);
      });
    }

    const checkboxMap = {
      search: document.getElementById('toggleSearch'),
      bookmarks: document.getElementById('toggleBookmarks'),
      calWeather: document.getElementById('toggleCalWeather'),
      player: document.getElementById('togglePlayer'),
      todo: document.getElementById('toggleTodo')
    };

    Object.keys(checkboxMap).forEach(key => {
      const cb = checkboxMap[key];
      if (cb) {
        cb.checked = currentSettings.widgets[key] !== false;
        cb.addEventListener('change', (e) => {
          currentSettings.widgets[key] = e.target.checked;
          saveSettings(currentSettings);
        });
      }
    });

    const uploadInput = document.getElementById('customWpInput');
    const uploadBtn = document.getElementById('uploadWpBtn');
    const resetWpBtn = document.getElementById('resetWpBtn');

    if (uploadBtn && uploadInput) {
      uploadBtn.addEventListener('click', () => uploadInput.click());
      uploadInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (!file) return;
        if (!file.type.startsWith('image/')) {
          showToast('请选择有效的图片文件');
          return;
        }

        const reader = new FileReader();
        reader.onload = async (event) => {
          const dataUrl = event.target.result;
          await saveCustomWallpaperToDB(dataUrl);
          localStorage.setItem(STORAGE_KEYS.WALLPAPER, 'custom');
          applyWallpaper(dataUrl, true);
          showToast('自定义壁纸已生效并保存至本地');
        };
        reader.readAsDataURL(file);
      });
    }

    if (resetWpBtn) {
      resetWpBtn.addEventListener('click', async () => {
        await deleteCustomWallpaperFromDB();
        localStorage.removeItem(STORAGE_KEYS.WALLPAPER);
        currentWallpaperIndex = 0;
        applyWallpaper(OFFICIAL_WALLPAPERS[0].file);
        showToast('已恢复官方精选壁纸');
      });
    }

    const exportBtn = document.getElementById('exportBackupBtn');
    const importBtn = document.getElementById('importBackupBtn');
    const importInput = document.getElementById('importBackupInput');

    if (exportBtn) {
      exportBtn.addEventListener('click', () => {
        const backupData = {
          version: 1,
          date: new Date().toISOString(),
          settings: currentSettings,
          bookmarks: currentBookmarks,
          todos: currentTodos,
          memo: localStorage.getItem(STORAGE_KEYS.MEMO) || ''
        };
        const blob = new Blob([JSON.stringify(backupData, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `小松绿工作台备份_${new Date().toISOString().slice(0, 10)}.json`;
        a.click();
        URL.revokeObjectURL(url);
        showToast('配置备份文件已开始下载');
      });
    }

    if (importBtn && importInput) {
      importBtn.addEventListener('click', () => importInput.click());
      importInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (event) => {
          try {
            const data = JSON.parse(event.target.result);
            if (data.settings) saveSettings(data.settings);
            if (Array.isArray(data.bookmarks)) saveBookmarks(data.bookmarks);
            if (Array.isArray(data.todos)) saveTodos(data.todos);
            if (typeof data.memo === 'string') {
              localStorage.setItem(STORAGE_KEYS.MEMO, data.memo);
              const memoEl = document.getElementById('memoTextarea');
              if (memoEl) memoEl.value = data.memo;
            }
            showToast('备份已成功恢复！');
            drawer.close();
          } catch (err) {
            showToast(`导入失败：文件格式不正确（${err.message}）`);
          }
        };
        reader.readAsText(file);
      });
    }
  }

  function syncSettingsForm() {
    const darknessRange = document.getElementById('maskDarknessRange');
    const darknessVal = document.getElementById('maskDarknessVal');
    const blurRange = document.getElementById('cardBlurRange');
    const blurVal = document.getElementById('cardBlurVal');

    const opacityRange = document.getElementById('cardOpacityRange');
    const opacityVal = document.getElementById('cardOpacityVal');

    if (darknessRange) darknessRange.value = currentSettings.maskDarkness;
    if (darknessVal) darknessVal.textContent = `${currentSettings.maskDarkness}%`;
    if (blurRange) blurRange.value = currentSettings.cardBlur;
    if (blurVal) blurVal.textContent = `${currentSettings.cardBlur}px`;
    if (opacityRange) opacityRange.value = currentSettings.cardOpacity ?? 45;
    if (opacityVal) opacityVal.textContent = `${currentSettings.cardOpacity ?? 45}%`;
  }

  // ===== 12. 工具函数与全局绑定 =====
  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function formatTime(sec) {
    if (!Number.isFinite(sec) || sec <= 0) return '00:00';
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  let toastTimer = null;
  function showToast(msg) {
    let toast = document.getElementById('globalToast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'globalToast';
      toast.className = 'global-toast';
      document.body.appendChild(toast);
    }
    toast.textContent = msg;
    toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('show'), 2600);
  }

  function initZenTriggers() {
    // 已删除双击进入纯享模式功能（防止误触），仅在处于纯享模式时允许点击任意处退出
    window.addEventListener('click', (e) => {
      if (isZenMode) {
        toggleZenMode(false);
      }
    });

    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (isZenMode) toggleZenMode(false);
      }
    });

    const quickZenBtn = document.getElementById('quickZenBtn');
    if (quickZenBtn) {
      quickZenBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleZenMode();
      });
    }

    const quickNextWpBtn = document.getElementById('quickNextWpBtn');
    if (quickNextWpBtn) quickNextWpBtn.addEventListener('click', nextWallpaper);
  }

  function initBookmarkDialog() {
    const dialog = document.getElementById('bookmarkDialog');
    const form = document.getElementById('bookmarkForm');
    const cancelBtn = document.getElementById('bmDialogCancel');
    if (!dialog || !form) return;

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const name = (document.getElementById('bmDialogName').value || '').trim();
      let url = (document.getElementById('bmDialogUrl').value || '').trim();
      if (!name || !url) return;

      if (!/^https?:\/\//i.test(url)) {
        url = 'https://' + url;
      }

      const colors = ['#8a9a4e', '#5b6ee1', '#e8b890', '#2e9b60', '#d9536f', '#e67e22', '#16a085'];
      const randomColor = colors[Math.floor(Math.random() * colors.length)];

      currentBookmarks.push({
        id: 'bm-' + Date.now(),
        name,
        url,
        iconBg: randomColor,
        char: name.slice(0, 1).toUpperCase()
      });

      saveBookmarks(currentBookmarks);
      dialog.close();
      showToast(`已添加常用网址：${name}`);
    });

    if (cancelBtn) {
      cancelBtn.addEventListener('click', () => dialog.close());
    }
  }

  
  // ===== 14. 天气组件系统 =====
  const CITY_TRANSLATIONS = {
    'beijing': '北京', 'shanghai': '上海', 'guangzhou': '广州', 'shenzhen': '深圳',
    'chengdu': '成都', 'hangzhou': '杭州', 'wuhan': '武汉', 'nanjing': '南京',
    'chongqing': '重庆', 'tianjin': '天津', 'xian': '西安', "xi'an": '西安',
    'suzhou': '苏州', 'changsha': '长沙', 'zhengzhou': '郑州', 'shenyang': '沈阳',
    'qingdao': '青岛', 'jinan': '济南', 'dalian': '大连', 'fuzhou': '福州',
    'xiamen': '厦门', 'harbin': '哈尔滨', 'kunming': '昆明', 'hefei': '合肥',
    'pootung': '上海浦东', 'haidian': '北京海淀', 'chaoyang': '北京朝阳'
  };

  const WIND_DIR_MAP = {
    'N': '北风', 'NNE': '东北风', 'NE': '东北风', 'ENE': '东北风',
    'E': '东风', 'ESE': '东南风', 'SE': '东南风', 'SSE': '东南风',
    'S': '南风', 'SSW': '西南风', 'SW': '西南风', 'WSW': '西南风',
    'W': '西风', 'WNW': '西北风', 'NW': '西北风', 'NNW': '西北风'
  };

  function formatTime12to24(t12) {
    if (!t12) return '--:--';
    const m = t12.match(/(\d+):(\d+)\s*(AM|PM)/i);
    if (!m) return t12;
    let h = parseInt(m[1], 10);
    const min = m[2];
    const ampm = m[3].toUpperCase();
    if (ampm === 'PM' && h < 12) h += 12;
    if (ampm === 'AM' && h === 12) h = 0;
    return `${String(h).padStart(2, '0')}:${min}`;
  }

  function getUvText(uv) {
    const n = parseInt(uv, 10) || 0;
    if (n <= 2) return `弱 (${n})`;
    if (n <= 5) return `中 (${n})`;
    if (n <= 7) return `较强 (${n})`;
    return `极强 (${n})`;
  }

  function formatWind(dir, speedKmph) {
    const d = WIND_DIR_MAP[dir] || dir || '微风';
    const sp = parseInt(speedKmph, 10) || 0;
    return `${d} ${sp}km/h`;
  }

  function mapWeatherCondition(desc) {
    const d = (desc || '').toLowerCase();
    if (d.includes('thunder') || d.includes('storm')) {
      return { icon: '⚡', text: '雷阵雨', tip: '雷雨天气，请留在室内注意安全 ⚡' };
    }
    if (d.includes('snow') || d.includes('sleet') || d.includes('blizzard') || d.includes('ice')) {
      return { icon: '❄️', text: '降雪', tip: '雪花漫天，外出保暖防滑哦 ❄️' };
    }
    if (d.includes('heavy rain') || d.includes('torrential') || (d.includes('shower') && d.includes('heavy'))) {
      return { icon: '⛈️', text: '强降雨', tip: '雨势较大，出行注意安全 🌧️' };
    }
    if (d.includes('rain') || d.includes('drizzle') || d.includes('shower')) {
      return { icon: '🌧️', text: '降雨', tip: '雨落草木新，出门备把小伞哦 🍃' };
    }
    if (d.includes('fog') || d.includes('mist') || d.includes('haze')) {
      return { icon: '🌫️', text: '薄雾', tip: '晨雾朦胧，视线不佳出行慢行 🌫️' };
    }
    if (d.includes('overcast')) {
      return { icon: '☁️', text: '阴天', tip: '云层遮阳，气候清凉适合静心 ☁️' };
    }
    if (d.includes('cloudy')) {
      return { icon: '⛅', text: '多云', tip: '云淡风轻，心情也要明媚灿烂 ⛅' };
    }
    if (d.includes('partly') || (d.includes('sun') && d.includes('cloud'))) {
      return { icon: '⛅', text: '多云间晴', tip: '微风正好，享受惬意时光 🍃' };
    }
    if (d.includes('clear') || d.includes('sunny')) {
      return { icon: '☀️', text: '晴朗', tip: '阳光明媚，向阳生长，充满元气 🌻' };
    }
    return { icon: '🌤️', text: desc || '晴好', tip: '草木有情，微风不燥，今天也是美好的一天 🌿' };
  }

  function getWeatherTip(condition, tempC) {
    if (condition && condition.tip) return condition.tip;
    if (tempC >= 32) return '气温偏高，记得防暑降温多喝水哦 🥤';
    if (tempC <= 8) return '天气微凉，小松绿提醒你添衣御寒 🧣';
    return '草木有情，微风不燥，今天也是美好的一天 🍃';
  }

  function renderWeatherUI(weatherData) {
    if (!weatherData) return;
    const iconEl = document.getElementById('weatherIcon');
    const tempEl = document.getElementById('weatherTemp');
    const rangeEl = document.getElementById('weatherRange');
    const descEl = document.getElementById('weatherDesc');
    const cityEl = document.getElementById('weatherCity');
    const feelsEl = document.getElementById('weatherFeels');
    const humidityEl = document.getElementById('weatherHumidity');
    const windEl = document.getElementById('weatherWind');
    const uvEl = document.getElementById('weatherUv');
    const sunriseEl = document.getElementById('weatherSunrise');
    const sunsetEl = document.getElementById('weatherSunset');
    const tipEl = document.getElementById('weatherTipText');

    if (iconEl) iconEl.textContent = weatherData.icon || '☀️';
    if (tempEl) tempEl.textContent = `${weatherData.tempC}°C`;
    if (rangeEl) {
      if (Number.isFinite(weatherData.minTemp) && Number.isFinite(weatherData.maxTemp)) {
        rangeEl.textContent = `${weatherData.minTemp}° ~ ${weatherData.maxTemp}°`;
      } else {
        rangeEl.textContent = `${weatherData.tempC}°`;
      }
    }
    if (descEl) descEl.textContent = weatherData.descText || '晴朗';
    if (cityEl) cityEl.textContent = weatherData.cityName || '当前位置';
    if (feelsEl) feelsEl.textContent = `${weatherData.feelsC}°`;
    if (humidityEl) humidityEl.textContent = `${weatherData.humidity}%`;
    if (windEl) windEl.textContent = weatherData.windText || '微风';
    if (uvEl) uvEl.textContent = weatherData.uvText || '弱';
    if (sunriseEl) sunriseEl.textContent = weatherData.sunrise || '--:--';
    if (sunsetEl) sunsetEl.textContent = weatherData.sunset || '--:--';
    if (tipEl) tipEl.textContent = weatherData.tip || '草木有情，微风不燥，今天也是美好的一天 🍃';
  }

  async function fetchWeather(customCity = '', forceFresh = false) {
    const refreshBtn = document.getElementById('refreshWeatherBtn');
    if (refreshBtn) refreshBtn.classList.add('loading');

    // 检查缓存（30分钟）
    if (!forceFresh && !customCity) {
      try {
        const raw = localStorage.getItem(STORAGE_KEYS.WEATHER);
        if (raw) {
          const parsed = JSON.parse(raw);
          if (Date.now() - parsed.timestamp < 30 * 60 * 1000 && parsed.data) {
            renderWeatherUI(parsed.data);
            if (refreshBtn) refreshBtn.classList.remove('loading');
            return;
          }
        }
      } catch (e) {}
    }

    const targetCity = customCity || localStorage.getItem(STORAGE_KEYS.WEATHER_CITY) || '';
    const queryUrl = targetCity
      ? `https://wttr.in/${encodeURIComponent(targetCity)}?format=j1`
      : 'https://wttr.in/?format=j1';

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 6500);
      const res = await fetch(queryUrl, { signal: controller.signal });
      clearTimeout(timer);

      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const current = data.current_condition?.[0] || {};
      const area = data.nearest_area?.[0] || {};
      const todayForecast = data.weather?.[0] || {};
      const astronomy = todayForecast.astronomy?.[0] || {};

      let rawCity = targetCity || area.areaName?.[0]?.value || '本地';
      const cleanCityKey = rawCity.trim().toLowerCase();
      const displayCity = targetCity || CITY_TRANSLATIONS[cleanCityKey] || rawCity;

      const rawDesc = current.weatherDesc?.[0]?.value || 'Clear';
      const cond = mapWeatherCondition(rawDesc);
      const tempC = parseInt(current.temp_C, 10) || 20;
      const feelsC = parseInt(current.FeelsLikeC, 10) || tempC;
      const humidity = parseInt(current.humidity, 10) || 50;
      const tip = getWeatherTip(cond, tempC);

      const minTemp = parseInt(todayForecast.mintempC, 10);
      const maxTemp = parseInt(todayForecast.maxtempC, 10);
      const sunrise = formatTime12to24(astronomy.sunrise);
      const sunset = formatTime12to24(astronomy.sunset);
      const windText = formatWind(current.winddir16Point, current.windspeedKmph);
      const uvText = getUvText(current.uvIndex);

      const weatherObj = {
        cityName: displayCity,
        tempC,
        feelsC,
        humidity,
        minTemp: Number.isFinite(minTemp) ? minTemp : tempC,
        maxTemp: Number.isFinite(maxTemp) ? maxTemp : tempC,
        windText,
        uvText,
        sunrise,
        sunset,
        icon: cond.icon,
        descText: cond.text,
        tip
      };

      renderWeatherUI(weatherObj);
      localStorage.setItem(STORAGE_KEYS.WEATHER, JSON.stringify({
        timestamp: Date.now(),
        data: weatherObj
      }));
    } catch (err) {
      console.warn('[StartPage] 天气加载失败或超时:', err);
      try {
        const fallbackRaw = localStorage.getItem(STORAGE_KEYS.WEATHER);
        if (fallbackRaw) {
          const parsed = JSON.parse(fallbackRaw);
          if (parsed.data) {
            renderWeatherUI(parsed.data);
            showToast('已加载离线天气数据');
            if (refreshBtn) refreshBtn.classList.remove('loading');
            return;
          }
        }
      } catch (e) {}

      const cityEl = document.getElementById('weatherCity');
      const descEl = document.getElementById('weatherDesc');
      if (cityEl && cityEl.textContent === '正在定位…') cityEl.textContent = '点击设定城市';
      if (descEl && descEl.textContent.includes('加载中')) descEl.textContent = '暂无网络数据';
    } finally {
      if (refreshBtn) refreshBtn.classList.remove('loading');
    }
  }

  function initWeather() {
    fetchWeather();

    const cityWrap = document.getElementById('weatherCityWrap');
    const dialog = document.getElementById('weatherCityDialog');
    const input = document.getElementById('weatherCityInput');
    const confirmBtn = document.getElementById('weatherCityConfirmBtn');
    const cancelBtn = document.getElementById('weatherCityCancelBtn');
    const refreshBtn = document.getElementById('refreshWeatherBtn');

    if (cityWrap && dialog && input) {
      cityWrap.addEventListener('click', () => {
        const isShown = dialog.style.display !== 'none';
        dialog.style.display = isShown ? 'none' : 'flex';
        if (!isShown) {
          input.value = localStorage.getItem(STORAGE_KEYS.WEATHER_CITY) || '';
          input.focus();
        }
      });

      const applyCity = () => {
        const val = (input.value || '').trim();
        if (val) {
          localStorage.setItem(STORAGE_KEYS.WEATHER_CITY, val);
          showToast(`正在切换城市：${val}`);
        } else {
          localStorage.removeItem(STORAGE_KEYS.WEATHER_CITY);
          showToast('已恢复自动定位天气');
        }
        dialog.style.display = 'none';
        fetchWeather(val, true);
      };

      if (confirmBtn) confirmBtn.addEventListener('click', applyCity);
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') applyCity();
        if (e.key === 'Escape') dialog.style.display = 'none';
      });
      if (cancelBtn) cancelBtn.addEventListener('click', () => {
        dialog.style.display = 'none';
      });
    }

    if (refreshBtn) {
      refreshBtn.addEventListener('click', () => {
        const savedCity = localStorage.getItem(STORAGE_KEYS.WEATHER_CITY) || '';
        fetchWeather(savedCity, true);
        showToast('正在更新最新天气数据…');
      });
    }
  }

  // ===== 15. 日历组件系统 =====
  let calDisplayYear = new Date().getFullYear();
  let calDisplayMonth = new Date().getMonth(); // 0-11
  let calSelectedDate = new Date();

  const SOLAR_TERM_NAMES = [
    '小寒', '大寒', '立春', '雨水', '惊蛰', '春分', '清明', '谷雨',
    '立夏', '小满', '芒种', '夏至', '小暑', '大暑', '立秋', '处暑',
    '白露', '秋分', '寒露', '霜降', '立冬', '小雪', '大雪', '冬至'
  ];
  const SOLAR_TERM_INFO = [
    0, 21208, 42467, 63836, 85337, 107014, 128867, 150921,
    173149, 195551, 218072, 240693, 263343, 285989, 308563, 331033,
    353350, 375494, 397447, 419210, 440795, 462224, 483532, 504758
  ];

  function getSolarTermsForMonth(year, month) {
    const terms = {};
    const n1 = month * 2;
    const n2 = month * 2 + 1;
    [n1, n2].forEach(n => {
      const off = 31556925974.7 * (year - 1900) + SOLAR_TERM_INFO[n] * 60000;
      const d = new Date(Date.UTC(1900, 0, 6, 2, 5) + off);
      if (d.getUTCFullYear() === year && d.getUTCMonth() === month) {
        terms[d.getUTCDate()] = SOLAR_TERM_NAMES[n];
      }
    });
    return terms;
  }

  const SOLAR_FESTIVALS = {
    '1-1': '元旦',
    '2-14': '情人节',
    '3-8': '妇女节',
    '3-12': '植树节',
    '4-1': '愚人节',
    '5-1': '劳动节',
    '5-4': '青年节',
    '6-1': '儿童节',
    '7-1': '建党节',
    '8-1': '建军节',
    '9-10': '教师节',
    '10-1': '国庆节',
    '10-24': '程序员节',
    '12-25': '圣诞节'
  };

  const LUNAR_FESTIVALS = {
    '1-1': '春节',
    '1-15': '元宵节',
    '2-2': '龙头节',
    '5-5': '端午节',
    '7-7': '七夕节',
    '7-15': '中元节',
    '8-15': '中秋节',
    '9-9': '重阳节',
    '12-8': '腊八节',
    '12-23': '小年'
  };

  const LUNAR_DAY_NAMES = [
    '', '初一', '初二', '初三', '初四', '初五', '初六', '初七', '初八', '初九', '初十',
    '十一', '十二', '十三', '十四', '十五', '十六', '十七', '十八', '十九', '二十',
    '廿一', '廿二', '廿三', '廿四', '廿五', '廿六', '廿七', '廿八', '廿九', '三十'
  ];

  const LUNAR_MONTH_NAMES = ['', '正月', '二月', '三月', '四月', '五月', '六月', '七月', '八月', '九月', '十月', '冬月', '腊月'];

  const chineseDateFormatter = new Intl.DateTimeFormat('zh-u-ca-chinese', {
    month: 'numeric',
    day: 'numeric'
  });

  const chineseFullFormatter = new Intl.DateTimeFormat('zh-u-ca-chinese', {
    dateStyle: 'full'
  });

  function getLunarDayInfo(date) {
    try {
      const parts = chineseDateFormatter.formatToParts(date);
      let lunarMonth = 0;
      let lunarDay = 0;
      for (const p of parts) {
        if (p.type === 'month') lunarMonth = parseInt(p.value, 10);
        if (p.type === 'day') lunarDay = parseInt(p.value, 10);
      }
      const dayName = LUNAR_DAY_NAMES[lunarDay] || `${lunarDay}`;
      const monthName = LUNAR_MONTH_NAMES[lunarMonth] || `${lunarMonth}月`;

      const festivalKey = `${lunarMonth}-${lunarDay}`;
      const festival = LUNAR_FESTIVALS[festivalKey] || '';

      // 除夕特殊判断：腊月最后一天
      let isChuxi = false;
      if (lunarMonth === 12) {
        const nextDay = new Date(date.getTime() + 86400000);
        const nextParts = chineseDateFormatter.formatToParts(nextDay);
        for (const p of nextParts) {
          if (p.type === 'month' && parseInt(p.value, 10) === 1) isChuxi = true;
        }
      }

      let fullStr = '';
      try {
        fullStr = chineseFullFormatter.format(date);
      } catch (err) {}

      return {
        lunarMonth,
        lunarDay,
        monthName,
        dayName,
        displayLabel: (lunarDay === 1 ? monthName : dayName),
        festival: isChuxi ? '除夕' : festival,
        fullStr
      };
    } catch (e) {
      return { lunarMonth: 0, lunarDay: 0, monthName: '', dayName: '', displayLabel: '', festival: '', fullStr: '' };
    }
  }

  function updateSelectedDayInfo(date) {
    const infoSolar = document.getElementById('calInfoSolar');
    const infoLunar = document.getElementById('calInfoLunar');
    const infoTag = document.getElementById('calInfoTag');
    const infoTermTag = document.getElementById('calInfoTermTag');

    if (!infoSolar || !infoLunar) return;

    const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
    const y = date.getFullYear();
    const m = date.getMonth();
    const d = date.getDate();
    const w = weekdays[date.getDay()];

    infoSolar.textContent = `${m + 1}月${d}日 ${w}`;

    const lunar = getLunarDayInfo(date);
    const solarKey = `${m + 1}-${d}`;
    const solarFestival = SOLAR_FESTIVALS[solarKey] || '';
    const terms = getSolarTermsForMonth(y, m);
    const solarTerm = terms[d] || '';

    let cleanFull = lunar.fullStr.replace(/\d{4}/, '').replace(/星期./, '').trim();
    infoLunar.textContent = `农历 ${lunar.monthName}${lunar.dayName} · ${cleanFull}`;

    const festivalText = solarFestival || lunar.festival;
    if (infoTag) {
      if (festivalText) {
        infoTag.textContent = festivalText;
        infoTag.style.display = 'inline-block';
      } else {
        infoTag.style.display = 'none';
      }
    }

    if (infoTermTag) {
      if (solarTerm) {
        infoTermTag.textContent = solarTerm;
        infoTermTag.style.display = 'inline-block';
      } else {
        infoTermTag.style.display = 'none';
      }
    }
  }

  function renderCalendarGrid() {
    const labelEl = document.getElementById('calCurrentLabel');
    const gridEl = document.getElementById('calDaysGrid');
    if (!gridEl) return;

    if (labelEl) {
      labelEl.textContent = `${calDisplayYear}年 ${calDisplayMonth + 1}月`;
    }

    gridEl.innerHTML = '';

    const today = new Date();
    const todayYear = today.getFullYear();
    const todayMonth = today.getMonth();
    const todayDate = today.getDate();

    const firstDay = new Date(calDisplayYear, calDisplayMonth, 1);
    // 周一排在第 0 列：0(周一) ~ 6(周日)
    const firstDayIndex = (firstDay.getDay() + 6) % 7;
    const daysInMonth = new Date(calDisplayYear, calDisplayMonth + 1, 0).getDate();
    const daysInPrevMonth = new Date(calDisplayYear, calDisplayMonth, 0).getDate();

    const currentTerms = getSolarTermsForMonth(calDisplayYear, calDisplayMonth);

    // 1. 上月余日填充
    for (let i = firstDayIndex - 1; i >= 0; i--) {
      const prevDate = daysInPrevMonth - i;
      const cellDate = new Date(calDisplayYear, calDisplayMonth - 1, prevDate);
      const lunar = getLunarDayInfo(cellDate);

      const cell = document.createElement('div');
      cell.className = 'cal-cell is-other-month';
      cell.innerHTML = `
        <span class="cal-cell-day">${prevDate}</span>
        <span class="cal-cell-sub">${lunar.displayLabel}</span>
      `;
      cell.addEventListener('click', () => {
        calDisplayMonth--;
        if (calDisplayMonth < 0) {
          calDisplayMonth = 11;
          calDisplayYear--;
        }
        calSelectedDate = cellDate;
        renderCalendarGrid();
        updateSelectedDayInfo(cellDate);
      });
      gridEl.appendChild(cell);
    }

    // 2. 本月真实日期
    for (let d = 1; d <= daysInMonth; d++) {
      const cellDate = new Date(calDisplayYear, calDisplayMonth, d);
      const isToday = (calDisplayYear === todayYear && calDisplayMonth === todayMonth && d === todayDate);
      const isSelected = (cellDate.getFullYear() === calSelectedDate.getFullYear() &&
                          cellDate.getMonth() === calSelectedDate.getMonth() &&
                          cellDate.getDate() === calSelectedDate.getDate());

      const lunar = getLunarDayInfo(cellDate);
      const solarKey = `${calDisplayMonth + 1}-${d}`;
      const solarFest = SOLAR_FESTIVALS[solarKey] || '';
      const festivalName = solarFest || lunar.festival;
      const termName = currentTerms[d] || '';

      let subText = lunar.displayLabel;
      let badgeClass = '';

      if (festivalName) {
        subText = festivalName;
        badgeClass = 'has-festival';
      } else if (termName) {
        subText = termName;
        badgeClass = 'has-term';
      }

      const cell = document.createElement('div');
      cell.className = `cal-cell ${isToday ? 'is-today' : ''} ${isSelected ? 'is-selected' : ''} ${badgeClass}`;
      cell.innerHTML = `
        <span class="cal-cell-day">${d}</span>
        <span class="cal-cell-sub">${subText}</span>
      `;

      cell.addEventListener('click', () => {
        calSelectedDate = cellDate;
        gridEl.querySelectorAll('.cal-cell').forEach(c => c.classList.remove('is-selected'));
        cell.classList.add('is-selected');
        updateSelectedDayInfo(cellDate);
      });

      gridEl.appendChild(cell);
    }

    // 3. 下月余日填充（固定补满42格或35格）
    const totalRendered = firstDayIndex + daysInMonth;
    const totalSlots = totalRendered > 35 ? 42 : 35;
    const nextDaysNeeded = totalSlots - totalRendered;

    for (let j = 1; j <= nextDaysNeeded; j++) {
      const cellDate = new Date(calDisplayYear, calDisplayMonth + 1, j);
      const lunar = getLunarDayInfo(cellDate);

      const cell = document.createElement('div');
      cell.className = 'cal-cell is-other-month';
      cell.innerHTML = `
        <span class="cal-cell-day">${j}</span>
        <span class="cal-cell-sub">${lunar.displayLabel}</span>
      `;
      cell.addEventListener('click', () => {
        calDisplayMonth++;
        if (calDisplayMonth > 11) {
          calDisplayMonth = 0;
          calDisplayYear++;
        }
        calSelectedDate = cellDate;
        renderCalendarGrid();
        updateSelectedDayInfo(cellDate);
      });
      gridEl.appendChild(cell);
    }

    updateSelectedDayInfo(calSelectedDate);
  }

  function initCalendar() {
    renderCalendarGrid();

    const prevBtn = document.getElementById('calPrevBtn');
    const nextBtn = document.getElementById('calNextBtn');
    const todayBtn = document.getElementById('calTodayBtn');

    if (prevBtn) {
      prevBtn.addEventListener('click', () => {
        calDisplayMonth--;
        if (calDisplayMonth < 0) {
          calDisplayMonth = 11;
          calDisplayYear--;
        }
        renderCalendarGrid();
      });
    }

    if (nextBtn) {
      nextBtn.addEventListener('click', () => {
        calDisplayMonth++;
        if (calDisplayMonth > 11) {
          calDisplayMonth = 0;
          calDisplayYear++;
        }
        renderCalendarGrid();
      });
    }

    if (todayBtn) {
      todayBtn.addEventListener('click', () => {
        const now = new Date();
        calDisplayYear = now.getFullYear();
        calDisplayMonth = now.getMonth();
        calSelectedDate = new Date();
        renderCalendarGrid();
        showToast('已返回当前月份与今日');
      });
    }
  }

  // ===== 16. 卡片与小组件鼠标微浮动交互 (克制优雅的 3D Tilt 跟随) =====
  function initInteractive3DTilt() {
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    if (window.matchMedia && !window.matchMedia('(hover: hover) and (pointer: fine)').matches) return;

    let activeCard = null;
    let cardRect = null;
    let rafId = null;
    let mousePos = { x: 0, y: 0 };

    function cancelPendingFrame() {
      if (rafId) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
    }

    function updateCardTransform() {
      rafId = null;
      if (!activeCard || !activeCard.isConnected) {
        activeCard = null;
        cardRect = null;
        return;
      }
      if (!cardRect || cardRect.width <= 0 || cardRect.height <= 0) return;

      const rawPx = (mousePos.x - cardRect.left) / cardRect.width - 0.5; // -0.5 ~ 0.5
      const rawPy = (mousePos.y - cardRect.top) / cardRect.height - 0.5; // -0.5 ~ 0.5
      const px = Math.max(-0.6, Math.min(0.6, rawPx));
      const py = Math.max(-0.6, Math.min(0.6, rawPy));

      // 克制优雅的幅度：大卡片幅度极轻微，小卡片略灵动
      const isLarge = activeCard.classList.contains('glass-card');
      const maxTilt = isLarge ? 1.5 : 3.0; // 倾斜角度最大 1.5 ~ 3 度
      const maxTransX = isLarge ? 2.5 : 3.8; // 位移 ±2.5 ~ 3.8px
      const maxTransY = isLarge ? 2.0 : 3.2;

      const rx = (-py * maxTilt).toFixed(2);
      const ry = (px * maxTilt).toFixed(2);
      const tx = (px * maxTransX).toFixed(1);
      const ty = (-2.0 + py * maxTransY).toFixed(1); // 悬停底数优雅上浮 2px

      activeCard.style.transform = `perspective(1000px) translate3d(${tx}px, ${ty}px, 6px) rotateX(${rx}deg) rotateY(${ry}deg)`;
    }

    function resetCard(card) {
      if (!card) return;
      card.style.transition = 'transform 0.4s cubic-bezier(0.22, 1, 0.36, 1), box-shadow 0.35s ease';
      card.style.transform = 'perspective(1000px) translate3d(0, 0, 0) rotateX(0deg) rotateY(0deg)';
    }

    function clearActive() {
      if (activeCard) {
        resetCard(activeCard);
        activeCard = null;
        cardRect = null;
      }
      cancelPendingFrame();
    }

    function updateActiveRect() {
      if (activeCard && activeCard.isConnected) {
        cardRect = activeCard.getBoundingClientRect();
      }
    }

    window.addEventListener('scroll', updateActiveRect, { passive: true, capture: true });
    window.addEventListener('resize', updateActiveRect, { passive: true });

    document.addEventListener('mousemove', function (e) {
      // 匹配所有卡片、书签和日历单元格
      const card = e.target.closest('.glass-card, .bookmark-item, .cal-cell');

      if (!card) {
        clearActive();
        return;
      }

      if (activeCard !== card) {
        if (activeCard) resetCard(activeCard);
        cancelPendingFrame();
        activeCard = card;
        cardRect = card.getBoundingClientRect();
        card.style.transition = 'transform 0.1s ease-out, box-shadow 0.25s ease';
      }

      mousePos.x = e.clientX;
      mousePos.y = e.clientY;

      if (!rafId) {
        rafId = requestAnimationFrame(updateCardTransform);
      }
    }, { passive: true });

    document.addEventListener('mouseleave', clearActive, { passive: true });
    window.addEventListener('blur', clearActive, { passive: true });
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) clearActive();
    }, { passive: true });
  }

  // ===== 17. DOM 初始化入口 =====
  document.addEventListener('DOMContentLoaded', () => {
    initWallpaper();
    updateClock();
    setInterval(updateClock, 1000);
    initSearch();
    renderBookmarks();
    initBookmarkDialog();
    initMiniPlayer();
    initTodoAndMemo();
    initWeather();
    initCalendar();
    initSettingsDrawer();
    initZenTriggers();
    initInteractive3DTilt();
  });

  window.applyStartSettings = applySettings;

})();
