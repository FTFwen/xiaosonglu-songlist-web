// app.js - 小松绿歌单网页版（由浏览器插件 popup.js 改造，已删除直播间操作功能）
// 改动点：
//  1. chrome.storage.local -> localStorage（Promise 封装，接口一致）
//  2. chrome.runtime.getURL -> 相对路径
//  3. 删除：点歌 / 调音 / 打call / 房间切换 / 随机点歌 / 点歌前缀设置（直播间相关功能）
//  4. 保留：歌曲总览、搜索、高级筛选、演唱详情、歌切链接、中意清单、历史每日歌曲（对齐 song.nagisa.live 浏览功能）
//  5. 本地 JSON 读取：优先 fetch 相对路径；file:// 打开失败时回退 window.XSL_DATA 内嵌数据
//  6. 固定房间：小松绿（数据在本地）

const SONG_CACHE_TTL = 5 * 60 * 1000;
const HISTORY_CACHE_TTL = 30 * 60 * 1000;
// 中意存档（单一本地存档，浏览器 localStorage）
const FAVORITES_KEY = 'favorites:shared';
// 当前用的中意清单名（上传/导入存档时记录，刷新按它拉取）
const FAV_CURRENT_KEY = 'favorites:currentName';
// 二创歌曲（手动导入，本地存储；勾选"只看二创"才显示）
const DERIVATIVE_KEY = 'songs:derivative';

// 加载二创歌曲（本地），勾选"只看二创"时合并进列表
function loadDerivativeSongs() {
  try {
    const raw = localStorage.getItem(DERIVATIVE_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    state.derivativeSongs = Array.isArray(arr) ? arr.filter(s => s && (s.song_name || s.display_song_name)) : [];
  } catch (e) {
    state.derivativeSongs = [];
  }
}
// 保存二创歌曲到本地
function saveDerivativeSongs() {
  try { localStorage.setItem(DERIVATIVE_KEY, JSON.stringify(state.derivativeSongs)); }
  catch (e) { /* ignore */ }
}

// 把导入的歌曲数据加入二创歌曲（标记 custom:true），去重（按歌名），并重新渲染
function importDerivativeSongsFromData(items) {
  const arr = Array.isArray(items) ? items : [];
  const existing = new Set(state.derivativeSongs.map(s => (s.display_song_name || s.song_name || '').trim()));
  arr.forEach(item => {
    const name = String((item.display_song_name || item.song_name || item.row_key || '').trim());
    if (!name) return;
    const key = name.toLowerCase();
    if (existing.has(key)) return; // 去重
    state.derivativeSongs.push({
      song_id: null,
      row_key: name,
      song_name: name,
      display_song_name: item.display_song_name || name,
      artist: item.artist || '',
      artist_search: '',
      feat_artist: '',
      sing_count: 0,
      last_sing_at: '',
      status_labels: '',
      language: item.language || '',
      display_version: '',
      tone: '',
      remark: '',
      type: item.type || '',
      identification: '',
      custom: true, // 二创歌曲标记
      derivative: true
    });
    existing.add(key);
  });
  saveDerivativeSongs();
  applySongFilters();
}

// 中意存档服务器接口
const FAV_API_BASE = '/api/fav/';
const favCurrentName = async () => (await storageGet(FAV_CURRENT_KEY))[FAV_CURRENT_KEY] || '';
const setFavCurrentName = name => storageSet({ [FAV_CURRENT_KEY]: name });
function updateFavCurrentNameUi() {
  const name = (state.favCurrentNameValue || '').trim();
  dom.favCurrentName.textContent = name ? `当前清单：${name}` : '当前清单：未保存';
}

const state = {
  currentRoomKey: 'xiaosonglu',
  favCurrentNameValue: '', // 当前中意清单名（本地记录 + 刷新拉取依据）
  currentRoom: getRoomConfig('xiaosonglu'),
  settings: {
    lastRoomKey: 'xiaosonglu',
    roomSettings: {}
  },
  searchMode: 'mixed',
  filtersVisible: false,
  favoritesOnly: false,
  derivativeSongs: [], // 二创歌曲（手动导入，勾选"只看二创"才显示）
  allSongs: [],
  filteredSongs: [],
  favoritesMap: {},
  favoriteList: [],
  favoritesImportVisible: false,
  selectedSong: null,
  isSongLoading: false,
  songDataUpdatedAt: null,
  songDataFromCache: false,
  detailsCache: {},
  historyMeta: null,
  historyEntries: [],
  historyPage: 1,
  historyTotalPages: 1,
  historySelectedDate: null,
  isHistoryLoading: false,
  songFilters: {
    query: '',
    countMin: null,
    countMax: null,
    daysMin: null,
    daysMax: null,
    languages: [],
    tags: [],
    derivativeOnly: false,
    sortField: 'last_sing_at',
    sortDir: 'desc'
  },
  audioIndex: null,
  audioIndexLoaded: false,
  cutInfo: null,
  playlist: [],
  songlists: [],
  songlistView: { type: 'list' }
};

const dom = {};

function $(id) {
  return document.getElementById(id);
}

function escHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function getSongCutUrl(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (/^https?:\/\//i.test(text)) return text;
  const match = text.match(/(BV[0-9A-Za-z]+)/i);
  return match ? `https://www.bilibili.com/video/${match[1]}/` : text;
}

function showToast(message, duration = 2200) {
  const toast = dom.toast;
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => toast.classList.remove('show'), duration);
}

function setHeaderStatus(text, cls = '') {
  dom.headerStatus.textContent = text;
  dom.headerStatus.className = `status-pill${cls ? ` ${cls}` : ''}`;
}

function formatTone(tone) {
  if (tone === null || tone === undefined || tone === '') return '';
  const num = Number(tone);
  if (Number.isFinite(num)) {
    if (num > 0) return `+${num}`;
    return `${num}`;
  }
  return String(tone);
}

function getDaysAgo(dateText) {
  if (!dateText) return null;
  const d = new Date(dateText);
  if (Number.isNaN(d.getTime())) return null;
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const then = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  return Math.floor((start - then) / 86400000);
}

function formatLastSing(dateText) {
  if (!dateText) return '—';
  const days = getDaysAgo(dateText);
  if (days === null) return dateText;
  if (days === 0) return '今天';
  if (days === 1) return '昨天';
  if (days < 7) return `${days} 天前`;
  if (days < 30) return `${Math.floor(days / 7)} 周前`;
  return dateText;
}

const INTERNAL_STATUS_LABELS = new Set([
  '歌切直补',
  '待原始回放定位',
  '待后续回放时间定位',
  '歌切合集补录',
  '自动识别待人工复核'
]);

const INTERNAL_TYPE_LABELS = new Set([
  '歌切补录'
]);

function splitStatusLabels(text) {
  return String(text || '')
    .split(/[、,，]/)
    .map(item => item.trim())
    .filter(Boolean);
}

function splitTypeLabels(text) {
  return String(text || '')
    .split(/[、,，/／|｜]/)
    .map(item => item.trim())
    .filter(Boolean);
}

function isInternalStatusLabel(label) {
  const text = String(label || '').trim();
  if (!text) return false;
  if (INTERNAL_STATUS_LABELS.has(text)) return true;
  // 含识歌流水线关键词的一律不展示（自动识别/待复核/回放定位/歌切补录等），
  // 这些是内部处理标记，不是给用户看的信息
  return /自动识别|待人工复核|待复核|回放定位|歌切直补|歌切补录|合集补录/.test(text);
}

function getVisibleStatusLabels(value) {
  const labels = Array.isArray(value) ? value : splitStatusLabels(value);
  return labels.filter(label => !isInternalStatusLabel(label));
}

function getVisibleTypeLabels(value) {
  return splitTypeLabels(value)
    .filter(label => !INTERNAL_TYPE_LABELS.has(label))
    .slice(0, 5);
}

function getVisibleStatusText(value) {
  return getVisibleStatusLabels(value).join('、');
}

function getLanguageBadgeClass(lang) {
  if (lang === '中文') return 'lang-zh';
  if (lang === '日语') return 'lang-ja';
  if (lang === '英语') return 'lang-en';
  if (lang === '粤语') return 'lang-cantonese';
  return 'lang-other';
}

function copyToClipboard(text) {
  return navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
}

function fallbackCopy(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.left = '-9999px';
  ta.style.top = '0';
  document.body.appendChild(ta);
  let ok = false;
  try {
    ta.select();
    ok = document.execCommand('copy');
  } catch (err) {
    ok = false;
  }
  document.body.removeChild(ta);
  return ok;
}

// ---- 存储：localStorage（Promise 封装） ----

function storageGet(keys) {
  return Promise.resolve().then(() => {
    const list = Array.isArray(keys) ? keys : [keys];
    const out = {};
    list.forEach(key => {
      try {
        const raw = localStorage.getItem(key);
        out[key] = raw === null ? null : JSON.parse(raw);
      } catch (err) {
        out[key] = null;
      }
    });
    return out;
  });
}

function storageSet(obj) {
  return Promise.resolve().then(() => {
    Object.keys(obj).forEach(key => {
      try {
        localStorage.setItem(key, JSON.stringify(obj[key]));
        // 中意数据变化 → 同页广播给 content script（插件 viridis-sync.js）
        // storage 事件只在其他标签页触发，同页操作要靠自定义事件通知
        if (key === FAVORITES_KEY) {
          try {
            window.dispatchEvent(new CustomEvent('favorites:shared:changed', { detail: obj[key] }));
          } catch (e) { /* 忽略 */ }
        }
      } catch (err) {
        console.warn('[歌单网页] 保存失败（localStorage 可能已满或不可用）:', key, err);
      }
    });
  });
}

function storageRemove(keys) {
  return Promise.resolve().then(() => {
    const list = Array.isArray(keys) ? keys : [keys];
    list.forEach(key => localStorage.removeItem(key));
  });
}

async function loadGlobalSettings() {
  const result = await storageGet(['settings:global']);
  const saved = result['settings:global'];
  if (saved && typeof saved === 'object') {
    state.settings = {
      lastRoomKey: saved.lastRoomKey || 'xiaosonglu',
      roomSettings: saved.roomSettings || {}
    };
  }
}

async function saveGlobalSettings() {
  await storageSet({ 'settings:global': state.settings });
}

function renderRoomContextSummary() {
  const current = state.currentRoom;
  dom.roomSubtitle.textContent = current.subtitle;
}

function getSongSearchText(song, mode) {
  const name = `${song.display_song_name || ''} ${song.song_name || ''} ${song.search_name || ''} ${song.row_key || ''}`.toLowerCase();
  const artist = `${song.artist || ''} ${song.artist_search || ''} ${song.feat_artist || ''}`.toLowerCase();
  const version = `${song.display_version || ''} ${song.type || ''} ${song.remark || ''}`.toLowerCase();
  if (mode === 'song') return `${name} ${version}`;
  if (mode === 'artist') return `${artist} ${version}`;
  return `${name} ${artist} ${version}`;
}

function dedupeSongs(rows) {
  const map = new Map();
  rows.forEach((row, index) => {
    const song = normalizeRoomSong(row, index);
    const key = song.song_name || song.row_key || String(song.song_id || index);
    if (!map.has(key)) {
      map.set(key, song);
      return;
    }
    const existing = map.get(key);
    const mergedStatuses = new Set([...splitStatusLabels(existing.status_labels), ...splitStatusLabels(song.status_labels)]);
    existing.status_labels = Array.from(mergedStatuses).join('、');
    if (!existing.last_sing_at || (song.last_sing_at && song.last_sing_at > existing.last_sing_at)) {
      existing.last_sing_at = song.last_sing_at;
    }
    if ((song.sing_count || 0) > (existing.sing_count || 0)) {
      existing.sing_count = song.sing_count;
    }
    if (!existing.identification && song.identification) existing.identification = song.identification;
  });
  return Array.from(map.values());
}

function getLocalResourceUrl(resourcePath) {
  return resourcePath; // 网页版直接相对路径
}

// 内嵌数据映射：本地 JSON 路径 -> window.XSL_DATA 里的键（file:// 下 fetch 不可用时回退）
const EMBEDDED_DATA_MAP = {
  'data/xiaosonglu/song_catalog.json': 'song_catalog',
  'data/xiaosonglu/history_index.json': 'history_index',
  'data/xiaosonglu/song_details.json': 'song_details',
  'data/xiaosonglu/audio_index.json': 'audio_index',
  'data/xiaosonglu/song_cut_info.json': 'song_cut_info'
};

async function fetchLocalJson(resourcePath) {
  try {
    const resp = await fetch(getLocalResourceUrl(resourcePath), { cache: 'no-cache' });
    if (resp.ok) {
      try {
        return await resp.json();
      } catch (err) {
        throw new Error(`JSON 解析失败（${err.message}）`);
      }
    }
    throw new Error(`HTTP ${resp.status}`);
  } catch (err) {
    // file:// 等场景 fetch 本地 JSON 会被 CORS 拦截 -> 回退内嵌数据
    const embeddedKey = EMBEDDED_DATA_MAP[resourcePath];
    if (embeddedKey && window.XSL_DATA && window.XSL_DATA[embeddedKey]) {
      return window.XSL_DATA[embeddedKey];
    }
    throw new Error(`本地数据文件读取失败：${err.message || err}`);
  }
}

function paginateLocalHistory(entries, page, pageSize) {
  const total = Array.isArray(entries) ? entries.length : 0;
  const safeSize = Math.max(1, Number(pageSize) || 30);
  const totalPages = total ? Math.ceil(total / safeSize) : 1;
  const safePage = Math.min(Math.max(1, Number(page) || 1), totalPages);
  const start = (safePage - 1) * safeSize;
  return {
    page: safePage,
    totalPages,
    entries: entries.slice(start, start + safeSize)
  };
}

function mapLocalHistoryEntry(entry) {
  return {
    song_name: entry.song_name || '',
    sing_time: entry.sing_time || entry.start_time || '',
    statuses: Array.isArray(entry.statuses) ? entry.statuses : splitStatusLabels(entry.statuses),
    artist: entry.artist || '',
    replay_title: entry.replay_title || '',
    replay_url: entry.replay_url || '',
    cut_link: getSongCutUrl(entry.cut_link)
  };
}

async function getCachedSongs(roomKey) {
  const keys = getStorageKeys(roomKey);
  const result = await storageGet([keys.songCache, keys.songCacheTime]);
  const cache = result[keys.songCache];
  const time = result[keys.songCacheTime];
  if (!Array.isArray(cache) || !time) return null;
  if (Date.now() - time > SONG_CACHE_TTL) return null;
  return { songs: cache, time };
}

async function saveSongCache(roomKey, songs) {
  const keys = getStorageKeys(roomKey);
  await storageSet({
    [keys.songCache]: songs,
    [keys.songCacheTime]: Date.now()
  });
}

async function loadSongData(forceRefresh = false) {
  const roomKey = state.currentRoomKey;
  const room = state.currentRoom;
  state.isSongLoading = true;
  setHeaderStatus('歌单加载中…');

  // 只保留主播唱过的歌（sing_count > 0）；未唱过的不出现在歌单/中意里
  const keepSungSongs = songs => {
    const raw = Array.isArray(songs) ? songs : [];
    return raw.filter(song => (Number(song.sing_count) || 0) > 0);
  };

  try {
    if (!forceRefresh) {
      const cached = await getCachedSongs(roomKey);
      if (cached) {
        if (state.currentRoomKey !== roomKey) return; // 已切换房间，丢弃过期结果
        state.allSongs = keepSungSongs(cached.songs);
        applySongFilters();
        setHeaderStatus('歌单已更新', 'ok');
        updateSongMetaText(new Date(cached.time), true);
        return;
      }
    }

    let songs;
    if (room.sourceType === 'local-json' && room.songDataUrl) {
      const payload = await fetchLocalJson(room.songDataUrl);
      songs = dedupeSongs(Array.isArray(payload.songs) ? payload.songs : []);
    }

    if (state.currentRoomKey !== roomKey) return; // 已切换房间，丢弃过期结果
    state.allSongs = keepSungSongs(songs || []);
    await saveSongCache(roomKey, songs || []); // 缓存原始数据，缓存命中时才能重新计算隐藏数
    applySongFilters();
    setHeaderStatus('歌单已更新', 'ok');
    updateSongMetaText(new Date(), false);
    showToast(`歌单已刷新，共 ${state.allSongs.length} 首`);
  } catch (error) {
    if (state.currentRoomKey !== roomKey) return;
    console.error('[歌单网页] 加载歌曲失败:', error);
    setHeaderStatus('歌单加载失败', 'err');
    renderSongs(error.message);
  } finally {
    state.isSongLoading = false;
  }
}

function updateSongMetaText(dateObj, fromCache) {
  state.songDataUpdatedAt = dateObj || null;
  state.songDataFromCache = !!fromCache;
  const count = state.filteredSongs.length;
  const total = state.allSongs.length;
  dom.songMetaText.textContent = `共 ${total} 首歌曲 · 当前显示 ${count} 首`;
}

// 拼音检索：为歌曲生成拼音索引（全拼 + 首字母），供搜索匹配
const pinyinCache = new Map();
function getSongPinyin(song) {
  const key = song.row_key || song.song_id;
  if (pinyinCache.has(key)) return pinyinCache.get(key);
  let result = { full: '', initials: '' };
  try {
    if (window.pinyinPro) {
      const name = `${song.display_song_name || song.song_name || ''} ${song.artist || ''}`;
      const arr = window.pinyinPro.pinyin(String(name), { toneType: 'none', type: 'array', nonZh: 'consecutive', v: true });
      const full = arr.join('').toLowerCase().replace(/\s+/g, '');
      const initials = arr.map(p => (p || '').charAt(0)).join('').toLowerCase();
      result = { full, initials };
    }
  } catch (e) { /* 拼音生成失败不影响普通搜索 */ }
  pinyinCache.set(key, result);
  return result;
}

function applySongFilters() {
  const query = (dom.searchInput.value || '').trim().toLowerCase();
  state.songFilters.query = query;

  let rows = state.allSongs.slice();
  if (query) {
    const q = query.replace(/\s+/g, '');
    rows = rows.filter(song => {
      if (getSongSearchText(song, state.searchMode).includes(query)) return true;
      // 拼音检索：全拼或首字母包含（如 "shaonvlei" / "snl"）
      if (!q) return false;
      const pi = getSongPinyin(song);
      return (pi.full && pi.full.includes(q)) || (pi.initials && pi.initials.includes(q));
    });
  }

  rows = rows.filter(song => {
    if (state.songFilters.countMin !== null && (song.sing_count || 0) < state.songFilters.countMin) return false;
    if (state.songFilters.countMax !== null && (song.sing_count || 0) > state.songFilters.countMax) return false;

    const days = getDaysAgo(song.last_sing_at);
    if (state.songFilters.daysMin !== null) {
      if (days === null || days < state.songFilters.daysMin) return false;
    }
    if (state.songFilters.daysMax !== null) {
      if (days === null || days > state.songFilters.daysMax) return false;
    }

    if (state.songFilters.languages.length > 0 && !state.songFilters.languages.includes(song.language || '')) return false;
    if (state.songFilters.tags.length > 0) {
      const songTags = new Set(String(song.type || '').split(/[、,，/／|｜\s]+/).map(t => t.trim()).filter(Boolean));
      const hit = state.songFilters.tags.some(tag => songTags.has(tag));
      if (!hit) return false;
    }
    if (state.favoritesOnly && !state.favoritesMap[getFavoriteKey(song)]) return false;
    return true;
  });

  // 二创歌曲：勾选"只看二创"时才合并进列表显示（否则默认隐藏，不参与普通次数/天数过滤）
  if (state.songFilters.derivativeOnly && state.derivativeSongs.length) {
    rows = rows.concat(state.derivativeSongs);
  }

  rows.sort((a, b) => compareSongs(a, b, state.songFilters.sortField, state.songFilters.sortDir));
  state.filteredSongs = rows;
  hydrateFavoriteList();

  renderSongs();
  renderFavorites();
  if (state.songDataUpdatedAt) {
    updateSongMetaText(state.songDataUpdatedAt, state.songDataFromCache);
  } else {
    updateSongMetaText(null, false);
  }
  syncFilterSummary();
}

function compareSongs(a, b, field, dir) {
  let va;
  let vb;
  if (field === 'sing_count') {
    va = Number(a.sing_count || 0);
    vb = Number(b.sing_count || 0);
  } else if (field === 'last_sing_at') {
    va = a.last_sing_at || '';
    vb = b.last_sing_at || '';
  } else if (field === 'artist') {
    va = (a.artist || '').toLowerCase();
    vb = (b.artist || '').toLowerCase();
  } else {
    va = (a.display_song_name || a.song_name || '').toLowerCase();
    vb = (b.display_song_name || b.song_name || '').toLowerCase();
  }
  if (va < vb) return dir === 'asc' ? -1 : 1;
  if (va > vb) return dir === 'asc' ? 1 : -1;
  return 0;
}

function getSongCardHtml(song) {
  const favoriteKey = getFavoriteKey(song);
  const favoriteActive = !!state.favoritesMap[favoriteKey];
  const statuses = getVisibleStatusLabels(song.status_labels);
  const identification = (song.identification || '').trim();
  const days = getDaysAgo(song.last_sing_at);
  const badges = [];
  const visibleTypes = getVisibleTypeLabels(song.type);
  const locked = isLockedSong(song);
  const banned = isBannedSong(song);

  if (song.language) badges.push(`<span class="badge ${getLanguageBadgeClass(song.language)}">${escHtml(song.language)}</span>`);
  if (song.display_version) badges.push(`<span class="badge">Ver. ${escHtml(song.display_version)}</span>`);
  visibleTypes.forEach(type => badges.push(`<span class="badge">${escHtml(type)}</span>`));
  if (identification) badges.push(`<span class="badge id ${banned ? 'banned' : locked ? 'locked' : ''}">${escHtml(identification)}</span>`);
  if (song.tone !== '' && song.tone !== null && song.tone !== undefined) badges.push(`<span class="badge tone">Tone ${escHtml(formatTone(song.tone))}</span>`);

  const statusHtml = statuses.map(item => `<span class="badge status">${escHtml(item)}</span>`).join('');
  const artistLine = [song.artist || '', song.feat_artist ? `feat. ${song.feat_artist}` : ''].filter(Boolean).join(' · ');
  const bottomLine = [
    song.last_sing_at ? `最近：${escHtml(formatLastSing(song.last_sing_at))}` : '最近：—',
    days === null ? '距今：—' : `距今：${days} 天`
  ].join(' · ');
  const cutUrl = getSongCutUrl(song.cut_link);
  const cutTitle = cutTitleOf(song);
  const cutLabel = cutTitle || '打开视频';
  const audioUrl = audioUrlOf(song);
  const isNowPlaying = !!(player.current && player.current.song_id === song.song_id && player.playing);
  const playBtnHtml = audioUrl
    ? `<button class="song-play-btn${isNowPlaying ? ' playing' : ''}" data-play-song="${song.song_id}" title="${isNowPlaying ? '暂停' : '播放音频'}">${iconSvg(isNowPlaying ? 'pause' : 'caret-right')}</button>`
    : '';
  const inSomeSonglist = isSongInAnySonglist(song);
  const songlistAddHtml = `<button class="songlist-add-btn${inSomeSonglist ? ' in-some' : ''}" data-songlist-pick="${song.song_id}" title="${inSomeSonglist ? '已在歌单中，点击管理' : '加入歌单'}">${iconSvg('folder-add')}</button>`;

  return `
    <div class="song-item${state.selectedSong && state.selectedSong.song_id === song.song_id ? ' selected' : ''}" data-song-id="${song.song_id}">
      <div class="song-top">
        <div class="song-main">
          <div class="song-name">${escHtml(song.display_song_name || song.song_name || '')}</div>
          <div class="song-sub">${escHtml(artistLine || '歌手未填写')}</div>
        </div>
        ${playBtnHtml}
        ${songlistAddHtml}
        <button class="favorite-star${favoriteActive ? ' active' : ''}" data-favorite-key="${escHtml(favoriteKey)}" ${canFavoriteSong(song) ? '' : 'disabled'} title="${favoriteActive ? '取消中意' : '加入中意'}">${iconSvg(favoriteActive ? 'heart-fill' : 'heart')}</button>
      </div>
      <div class="badge-wrap">
        <button class="badge count" data-detail-song="${escHtml(song.song_name || song.row_key || '')}" data-detail-label="${escHtml(song.display_song_name || song.song_name || '')}" data-detail-count="${escHtml(song.sing_count || 0)}">次数 ${escHtml(song.sing_count || 0)}</button>
        ${badges.join('')}
      </div>
      ${statuses.length ? `<div class="status-wrap">${statusHtml}</div>` : ''}
      <div class="song-bottom">
        <div class="song-bottom-left">
          <span>${escHtml(bottomLine)}</span>
        </div>
      </div>
      ${cutUrl ? `<div class="song-sub song-cut-row">歌切：<a href="${escHtml(cutUrl)}" target="_blank" rel="noreferrer" data-song-cut-link="${escHtml(cutUrl)}" title="${escHtml(cutTitle || cutUrl)}">${escHtml(cutLabel)}</a></div>` : ''}
    </div>
  `;
}

/* ===== 音频播放器（对齐 komichi-vup.com/sings 的在线播放能力） ===== */
const PLAYLIST_KEY = 'playlist:xiaosonglu';
const SONGLISTS_KEY = 'songlists:xiaosonglu';

// 内联图标（Ant Design 线性图标，sprite 定义在 index.html）
function iconSvg(id, extraClass = '') {
  return `<svg class="icon${extraClass ? ` ${extraClass}` : ''}" aria-hidden="true"><use href="#icon-${id}"></use></svg>`;
}

// 播放模式：random=随机播放 / single=单曲循环 / list=歌单循环（默认）
const PLAY_MODES = [
  { key: 'list',    icon: 'redo',    label: '歌单循环', desc: '按顺序播放，播完循环整个播放列表' },
  { key: 'random',  icon: 'random-shuffle', label: '随机播放', desc: '播完随机切换下一首' },
  { key: 'single',  icon: 'sync',    label: '单曲循环', desc: '当前曲目循环播放' }
];
const PLAY_MODE_MAP = Object.fromEntries(PLAY_MODES.map(m => [m.key, m]));

const player = {
  audio: new Audio(),
  preloadAudio: new Audio(), // 预加载下一首用（不发声），提升切歌响应
  queue: [],        // 当前播放队列（song 对象数组）
  index: -1,
  playMode: 'list', // 'random' | 'single' | 'list'
  shuffleOrder: null, // 随机播放顺序（索引数组，洗牌后不重复），null 表示未初始化
  shufflePos: 0,      // 当前在 shuffleOrder 里的位置
  volume: 0.8,
  get current() { return this.queue[this.index] || null; }
};
player.audio.preload = 'auto';
player.audio.volume = player.volume;
player.preloadAudio.preload = 'auto';

// 进度条拖动状态：拖动中只预览，松开后才真正跳转
let seekDragging = false;

// ===== 睡眠定时（月亮图标）=====
const timerState = {
  running: false,     // 是否在倒计时
  totalSec: 0,        // 当前设定的总秒数
  remainSec: 0,       // 剩余秒数
  lastTickAt: 0,      // 上次 tick 的时间戳（ms）
  pickerH: 0,         // 弹层里的时
  pickerM: 0,         // 弹层里的分
  snapshotSec: -1,    // 打开弹层时的值快照（秒），用于判断用户是否调整过
  timerId: null
};

// 倒计时进行中：图标高亮样式（running），不显示数字、不做复杂动效
function renderTimerButton() {
  dom.playerTimerBtn.classList.toggle('running', timerState.running);
  dom.playerTimerBtn.title = timerState.running
    ? '睡眠定时倒计时中（点击调整，0:0 即关闭）'
    : '睡眠定时：设置倒计时，结束后自动暂停';
  // 手机端悬浮按钮同步状态
  if (dom.mobileTimerFab) {
    dom.mobileTimerFab.classList.toggle('timer-running', timerState.running);
    dom.mobileTimerFab.title = timerState.running
      ? '睡眠定时倒计时中（点击调整，0:0 即关闭）'
      : '睡眠定时：设置倒计时，结束后自动暂停';
  }
}

function formatTimerTime(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

function openTimerPopover() {
  // 打开时预填：未运行时用 0:0；运行中显示当前剩余时间
  if (timerState.running) {
    timerState.pickerH = Math.floor(timerState.remainSec / 3600);
    timerState.pickerM = Math.floor((timerState.remainSec % 3600) / 60);
  }
  dom.timerValH.textContent = String(timerState.pickerH);
  dom.timerValM.textContent = String(timerState.pickerM);
  // 记录打开时的值作为快照：倒计时中若未调整，确定/取消都不应重置倒计时
  timerState.snapshotSec = pickerToSec();
  dom.playerTimerPopover.classList.add('show');
  dom.playerTimerBtn.classList.add('active');
  dom.playerTimerPopTitle.textContent = timerState.running ? '调整定时（0:0 即关闭）' : '睡眠定时（0:0 即关闭）';
}

function closeTimerPopover() {
  dom.playerTimerPopover.classList.remove('show');
  dom.playerTimerBtn.classList.remove('active');
}

// 应用弹层里的 时/分 → 秒；0 时 0 分视为关闭计时
function pickerToSec() {
  return timerState.pickerH * 3600 + timerState.pickerM * 60;
}

// 确定弹层：倒计时中且值未变（sec === snapshotSec）→ 只收起不重置；否则按值处理
function confirmTimerPopover() {
  const sec = pickerToSec();
  if (timerState.running && sec === timerState.snapshotSec) {
    // 未做任何调整：保持当前倒计时继续流动
    closeTimerPopover();
    return;
  }
  startTimer(sec);
}

// 开始倒计时（sec 秒后暂停播放）；sec<=0 表示关闭计时功能
function startTimer(sec) {
  if (sec <= 0) {
    stopTimer(true);
    closeTimerPopover();
    showToast('已关闭睡眠定时');
    return;
  }
  stopTimer(true); // 重置旧计时
  timerState.running = true;
  timerState.totalSec = sec;
  timerState.remainSec = sec;
  timerState.lastTickAt = Date.now();
  clearInterval(timerState.timerId);
  timerState.timerId = setInterval(() => {
    const now = Date.now();
    const delta = Math.floor((now - timerState.lastTickAt) / 1000);
    if (delta > 0) {
      timerState.lastTickAt = now;
      timerState.remainSec = Math.max(0, timerState.remainSec - delta);
      renderTimerButton();
      if (timerState.remainSec <= 0) {
        onTimerFinished();
      }
    }
  }, 500);
  renderTimerButton();
  closeTimerPopover();
  showToast(`睡眠定时 ${formatTimerTime(sec)} 后自动暂停播放`);
}

// 停止计时（clear 是否清空运行状态）
function stopTimer(clear = false) {
  if (timerState.timerId) {
    clearInterval(timerState.timerId);
    timerState.timerId = null;
  }
  if (clear) {
    timerState.running = false;
    timerState.totalSec = 0;
    timerState.remainSec = 0;
  }
  renderTimerButton();
}

// 倒计时结束：暂停播放（保留播放进度，可继续）
function onTimerFinished() {
  stopTimer(true);
  if (player.playing) {
    player.audio.pause();
    player.playing = false;
    updatePlayerUI();
  }
  showToast('⏳ 定时结束，已暂停播放');
}

// play() 被切歌/暂停等正常中断（AbortError），不应提示用户
function isPlayAborted(err) {
  return !!err && (err.name === 'AbortError' || /interrupted by a call to pause/i.test(err.message || ''));
}

function audioUrlOf(song) {
  if (!song || !state.audioIndex || !state.audioIndex.audios) return '';
  const key = song.row_key || song.song_name || '';
  return state.audioIndex.audios[key] || '';
}

// 歌切切片标题：优先歌切台账标题（单曲视频标题 / 合集分P标题），兜底回放标题
function cutTitleOf(song) {
  if (!song || !state.cutInfo || !state.cutInfo.cuts) return '';
  const key = song.row_key || song.song_name || '';
  const info = state.cutInfo.cuts[key];
  return info && info.title ? info.title : '';
}

function formatAudioTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) return '00:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function getPlayableSongs() {
  return state.filteredSongs.filter(s => audioUrlOf(s));
}

function syncPlayingButton() {
  document.querySelectorAll('.song-item .song-play-btn.playing').forEach(b => {
    b.classList.remove('playing');
    b.innerHTML = iconSvg('caret-right');
    b.title = '播放音频';
  });
  const cur = player.current;
  if (cur && player.playing) {
    const el = dom.songListWrap && dom.songListWrap.querySelector(`.song-item[data-song-id="${cur.song_id}"] .song-play-btn`);
    if (el) {
      el.classList.add('playing');
      el.innerHTML = iconSvg('pause');
      el.title = '暂停';
    }
  }
}

function updatePlayerUI() {
  const hasAudio = !!(state.audioIndex && state.audioIndex.audios && Object.keys(state.audioIndex.audios).length);
  if (hasAudio) {
    dom.playerBar.style.display = 'flex';
    document.body.classList.add('has-player');
    dom.playAllBtn.style.display = '';
    dom.playShuffleBtn.style.display = '';
    dom.playerShuffleBtn.style.display = '';
  } else {
    dom.playerBar.style.display = 'none';
    document.body.classList.remove('has-player');
    dom.playAllBtn.style.display = 'none';
    dom.playShuffleBtn.style.display = 'none';
    dom.playerShuffleBtn.style.display = 'none';
  }
  const cur = player.current;
  dom.playerSongName.textContent = cur ? (cur.display_song_name || cur.song_name || '未命名') : '未选择歌曲';
  dom.playerSongArtist.textContent = cur ? (cur.artist || '') : '';
  dom.playerToggleBtn.innerHTML = iconSvg(player.playing ? 'pause' : 'caret-right');
  dom.playerToggleBtn.title = player.playing ? '暂停' : '播放';
  const mode = PLAY_MODE_MAP[player.playMode] || PLAY_MODE_MAP.list;
  // 歌单循环/单曲循环图标比随机播放小 2px
  const modeShrink = (player.playMode === 'list' || player.playMode === 'single');
  dom.playerShuffleBtn.innerHTML = iconSvg(mode.icon, modeShrink ? 'icon-sm' : '');
  dom.playerShuffleBtn.title = `播放模式：${mode.label}（${mode.desc}），点击切换`;
  updatePlayerFavState();
  syncPlayingButton();
  renderPlaylist();
}

// 更新播放栏收藏按钮：根据当前播放的歌是否已加入中意，切换爱心实/空心
function updatePlayerFavState() {
  const cur = player.current;
  const active = !!cur && !!state.favoritesMap[getFavoriteKey(cur)];
  dom.playerFavBtn.innerHTML = iconSvg(active ? 'heart-fill' : 'heart');
  dom.playerFavBtn.classList.toggle('active', active);
  dom.playerFavBtn.title = cur ? (active ? '取消中意' : '收藏到中意清单') : '';
  dom.playerFavBtn.disabled = !cur;
}

function playSongAt(index) {
  const song = player.queue[index];
  if (!song) return;
  // 随机模式：直接指定 index 播放时，同步 shufflePos 到该曲在洗牌顺序里的位置
  if (player.playMode === 'random') {
    if (!player.shuffleOrder || player.shuffleOrder.length !== player.queue.length) {
      buildShuffleOrder();
    }
    const pos = player.shuffleOrder.indexOf(index);
    if (pos >= 0) player.shufflePos = pos;
  }
  const url = audioUrlOf(song);
  if (!url) {
    showToast('这首歌暂时没有收录音频');
    return;
  }
  player.index = index;
  player.audio.src = url;
  player.audio.play().catch(err => {
    // 被快速切歌/暂停等正常中断，不提示用户
    if (isPlayAborted(err)) return;
    console.warn('[播放器] 播放失败:', err);
    showToast(`音频播放失败：${err.message || err}`);
    player.playing = false;
    updatePlayerUI();
  });
  updatePlayerUI();
  preloadNextSong();
}

// 播放当前曲目后，按播放模式预加载下一首，切歌/自动下一首时秒开
function preloadNextSong() {
  try {
    const len = player.queue.length;
    if (!len || !player.preloadAudio) return;
    let nextIndex;
    if (player.playMode === 'list') {
      nextIndex = player.index + 1;
      if (nextIndex >= len) nextIndex = 0;
    } else if (player.playMode === 'random') {
      if (player.shuffleOrder && player.shuffleOrder.length > 1) {
        let pos = player.shufflePos + 1;
        if (pos >= player.shuffleOrder.length) pos = 0; // 到末尾回到洗牌后第一首（重新一轮）
        nextIndex = player.shuffleOrder[pos];
      } else {
        nextIndex = player.index;
      }
    } else {
      return; // 单曲循环不需要预载下一首
    }
    const next = player.queue[nextIndex];
    const url = next && audioUrlOf(next);
    if (url && player.preloadAudio.src !== url) {
      player.preloadAudio.src = url;
    }
  } catch (e) { /* 预载失败不影响播放 */ }
}

function startPlaybackFrom(song) {
  const queue = getPlayableSongs();
  if (!queue.length) { showToast('当前列表没有可播放的音频'); return; }
  player.queue = queue;
  const idx = queue.findIndex(s => s.song_id === song.song_id);
  playSongAt(idx >= 0 ? idx : 0);
}

function playAllSongs() {
  const songs = getPlayableSongs();
  if (!songs.length) { showToast('当前列表没有可播放的音频'); return; }
  state.playlist = songs.map(snapshotOf);
  savePlaylist();
  player.queue = state.playlist;
  player.playMode = 'list';
  playSongAt(0);
  renderPlaylist();
  updatePlayerUI();
}

function playShuffleAll() {
  const songs = getPlayableSongs();
  if (!songs.length) { showToast('当前列表没有可播放的音频'); return; }
  state.playlist = songs.map(snapshotOf);
  savePlaylist();
  player.queue = state.playlist;
  player.playMode = 'random';
  buildShuffleOrder(); // 洗牌一次，定下随机播放顺序（不重复）
  playSongAt(player.shuffleOrder[0]);
  renderPlaylist();
  updatePlayerUI();
}

// 生成随机播放顺序（洗牌 0..queue.length-1，不重复）；若队列为空则置 null
function buildShuffleOrder() {
  const len = player.queue.length;
  if (!len) { player.shuffleOrder = null; player.shufflePos = 0; return; }
  const order = Array.from({ length: len }, (_, i) => i);
  // Fisher-Yates 洗牌
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  player.shuffleOrder = order;
  player.shufflePos = 0;
}

/* ===== 播放列表（点击歌曲加入并播放，localStorage 持久化） ===== */
function snapshotOf(song) {
  return {
    song_id: song.song_id,
    row_key: song.row_key || song.song_name || '',
    song_name: song.song_name || '',
    display_song_name: song.display_song_name || song.song_name || '',
    artist: song.artist || ''
  };
}

function loadPlaylist() {
  try {
    const raw = localStorage.getItem(PLAYLIST_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    state.playlist = Array.isArray(arr) ? arr.filter(p => p && p.song_id != null) : [];
  } catch (e) {
    state.playlist = [];
  }
  player.queue = state.playlist;
}

function savePlaylist() {
  try { localStorage.setItem(PLAYLIST_KEY, JSON.stringify(state.playlist)); } catch (e) { /* ignore */ }
}

// 点击歌曲：加入播放列表并播放；正在播的这首再次点击 = 暂停/恢复
function addToPlaylist(song, autoplay = true) {
  if (!song) return;
  const snap = snapshotOf(song);
  // 正在播放的这首再次点击 = 暂停/恢复（按歌曲身份判断，不依赖队列引用/索引，避免误判成重新播放）
  const cur = player.current;
  if (cur && player.index >= 0 && String(cur.song_id) === String(song.song_id)) {
    if (player.audio.paused) {
      player.audio.play().catch(() => {});
    } else {
      player.audio.pause();
    }
    renderPlaylist();
    updatePlayerUI();
    return;
  }
  const existing = state.playlist.findIndex(p => p.song_id === snap.song_id);
  if (existing >= 0) state.playlist.splice(existing, 1);
  state.playlist.push(snap);
  savePlaylist();
  player.queue = state.playlist;
  if (autoplay) {
    playSongAt(state.playlist.length - 1);
  }
  renderPlaylist();
  updatePlayerUI();
}

function removeFromPlaylist(index) {
  if (index < 0 || index >= state.playlist.length) return;
  const wasCurrent = player.queue === state.playlist && player.index === index;
  state.playlist.splice(index, 1);
  savePlaylist();
  if (wasCurrent) {
    if (state.playlist.length === 0) {
      player.index = -1;
      player.playing = false;
      player.audio.pause();
      player.audio.removeAttribute('src');
    } else {
      const nextIdx = Math.min(index, state.playlist.length - 1);
      playSongAt(nextIdx);
    }
  } else if (player.queue === state.playlist && player.index > index) {
    player.index--;
  }
  renderPlaylist();
  updatePlayerUI();
}

function clearPlaylist() {
  state.playlist = [];
  savePlaylist();
  player.queue = state.playlist;
  player.index = -1;
  player.playing = false;
  player.audio.pause();
  player.audio.removeAttribute('src');
  renderPlaylist();
  updatePlayerUI();
}

function renderPlaylist() {
  const wrap = dom.playlistListWrap;
  // 自动开合：有歌曲时展开播放列表，没有歌曲时收起
  dom.playlistPanel.classList.toggle('show', state.playlist.length > 0);
  dom.playlistCountText.textContent = `${state.playlist.length} 首`;
  if (!state.playlist.length) {
    wrap.innerHTML = '<div class="playlist-empty">播放列表还是空的～<br>点击任意歌曲卡片即可加入并播放</div>';
    return;
  }
  wrap.innerHTML = state.playlist.map((item, index) => {
    const isCurrent = player.queue === state.playlist && player.index === index;
    const name = item.display_song_name || item.song_name || '';
    return `
      <div class="playlist-item${isCurrent ? ' playing' : ''}" data-playlist-index="${index}">
        <span class="playlist-item-idx">${isCurrent ? iconSvg('caret-right') : index + 1}</span>
        <div class="playlist-item-main">
          <div class="playlist-item-name">${escHtml(name)}</div>
          <div class="playlist-item-artist">${escHtml(item.artist || '')}</div>
        </div>
        <button class="mini-btn" data-playlist-copy="${index}" title="复制歌名">${iconSvg('copy')}</button>
        <button class="mini-btn danger" data-playlist-remove="${index}" title="从播放列表移除">${iconSvg('close')}</button>
      </div>`;
  }).join('');
}

/* 面板拖动：拖住上边缘可移动位置（指针事件，鼠标/触屏通用；位置不持久化，刷新后回到默认） */
function initPanelDrag(panel) {
  const head = panel && (panel.querySelector('.playlist-head') || panel.querySelector('.songlist-head'));
  if (!panel || !head) return;
  let drag = null;
  head.addEventListener('pointerdown', e => {
    // 头部按钮（清空等）正常点击，不启动拖动
    if (e.button !== 0 || e.target.closest('button, input, a')) return;
    // 若面板用了 transform 居中（歌单面板 translateY(-50%)），
    // 拖动前先把当前实际位置转成像素定位，避免拖动错位
    const rect = panel.getBoundingClientRect();
    panel.style.transform = 'none';
    panel.style.left = `${rect.left}px`;
    panel.style.top = `${rect.top}px`;
    drag = {
      startX: e.clientX,
      startY: e.clientY,
      origLeft: rect.left,
      origTop: rect.top,
      moved: false
    };
    document.body.classList.add('dragging-panel');
    e.preventDefault();
  });
  document.addEventListener('pointermove', e => {
    if (!drag) return;
    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;
    if (!drag.moved && Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true;
    if (!drag.moved) return;
    const maxLeft = Math.max(0, window.innerWidth - panel.offsetWidth);
    const maxTop = Math.max(0, window.innerHeight - panel.offsetHeight);
    panel.style.bottom = 'auto';
    panel.style.left = `${Math.min(Math.max(0, drag.origLeft + dx), maxLeft)}px`;
    panel.style.top = `${Math.min(Math.max(0, drag.origTop + dy), maxTop)}px`;
  });
  document.addEventListener('pointerup', () => {
    drag = null;
    document.body.classList.remove('dragging-panel');
  });
}

/* 手机端：歌单 / 播放列表默认收起为悬浮气泡，点击气泡开合面板 */
function initMobileFabs() {
  const closeAll = () => {
    dom.songlistPanel.classList.remove('mobile-open');
    dom.playlistPanel.classList.remove('mobile-open');
    dom.songlistFab.classList.remove('active');
    dom.playlistFab.classList.remove('active');
  };
  const togglePanel = (panel, fab) => {
    const opening = !panel.classList.contains('mobile-open');
    closeAll();
    if (opening) {
      panel.classList.add('mobile-open');
      fab.classList.add('active');
    }
  };
  dom.songlistFab.addEventListener('click', () => togglePanel(dom.songlistPanel, dom.songlistFab));
  dom.playlistFab.addEventListener('click', () => togglePanel(dom.playlistPanel, dom.playlistFab));
  // 手机端睡眠定时：点击收起面板，再切换定时弹层
  dom.mobileTimerFab.addEventListener('click', () => {
    closeAll();
    if (dom.playerTimerPopover.classList.contains('show')) {
      confirmTimerPopover();
    } else {
      openTimerPopover();
    }
  });
}

/* ===== 歌单系统（左上角，localStorage 持久化；内置“中意歌曲”与收藏联动） ===== */
function getFavoritesSonglist() {
  return { id: 'favorites', name: '中意歌曲', builtin: true, songKeys: Object.keys(state.favoritesMap) };
}

function getAllSonglists() {
  return [getFavoritesSonglist(), ...state.songlists];
}

function loadSonglists() {
  try {
    const raw = localStorage.getItem(SONGLISTS_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    state.songlists = Array.isArray(arr)
      ? arr.filter(l => l && l.id && !l.builtin && Array.isArray(l.songKeys))
      : [];
  } catch (e) {
    state.songlists = [];
  }
}

function saveSonglists() {
  try { localStorage.setItem(SONGLISTS_KEY, JSON.stringify(state.songlists)); } catch (e) { /* ignore */ }
}

function getSonglistKeys(list) {
  if (!list) return [];
  if (list.builtin) return Object.keys(state.favoritesMap);
  return Array.isArray(list.songKeys) ? list.songKeys : [];
}

function isSongInSonglist(song, list) {
  const key = getFavoriteKey(song);
  if (!key) return false;
  return getSonglistKeys(list).includes(key);
}

function isSongInAnySonglist(song) {
  return getAllSonglists().some(list => isSongInSonglist(song, list));
}

function findSongByFavoriteKey(key) {
  return state.allSongs.find(song => getFavoriteKey(song) === key) || null;
}

function getSonglistSongsWithMeta(list) {
  const keys = new Set(getSonglistKeys(list));
  return state.allSongs
    .filter(song => keys.has(getFavoriteKey(song)))
    .map(song => ({ key: getFavoriteKey(song), song }));
}

function getSonglistSongCount(list) {
  return getSonglistSongsWithMeta(list).length;
}

async function toggleSongInSonglist(song, list) {
  if (!song || !list) return;
  if (list.builtin) {
    await toggleFavoriteBySong(song); // 中意歌曲歌单 = 收藏/取消收藏
    renderSonglistPanel();
    return;
  }
  const key = getFavoriteKey(song);
  if (!key) return;
  const idx = list.songKeys.indexOf(key);
  if (idx >= 0) list.songKeys.splice(idx, 1);
  else list.songKeys.push(key);
  saveSonglists();
}

function createSonglist(name) {
  const trimmed = String(name || '').trim();
  if (!trimmed) return null;
  const id = 'sl_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const list = { id, name: trimmed, builtin: false, songKeys: [] };
  state.songlists.push(list);
  saveSonglists();
  return list;
}

function deleteSonglist(id) {
  if (id === 'favorites') return;
  state.songlists = state.songlists.filter(l => l.id !== id);
  saveSonglists();
  if (state.songlistView.type === 'detail' && state.songlistView.id === id) {
    state.songlistView = { type: 'list' };
  }
}

// 歌单面板：列表 / 详情 两视图
function renderSonglistPanel() {
  const wrap = dom.songlistBodyWrap;
  if (state.songlistView.type === 'detail') {
    const list = getAllSonglists().find(l => l.id === state.songlistView.id);
    if (!list) {
      state.songlistView = { type: 'list' };
      renderSonglistPanel();
      return;
    }
    renderSonglistDetail(wrap, list);
    return;
  }
  const lists = getAllSonglists();
  wrap.innerHTML = lists.map(list => {
    const icon = list.builtin ? '❤️' : '🎵';
    const delBtn = list.builtin ? '' : `<button type="button" class="mini-btn" data-songlist-del="${escHtml(list.id)}" title="删除歌单">${iconSvg('delete')}</button>`;
    return `
      <div class="songlist-item-row">
        <button type="button" class="songlist-item${list.builtin ? ' builtin' : ''}" data-songlist-open="${escHtml(list.id)}">
          <span class="songlist-item-icon">${icon}</span>
          <span class="songlist-item-main">
            <span class="songlist-item-name">${escHtml(list.name)}</span>
            <span class="songlist-item-count">${getSonglistSongCount(list)} 首</span>
          </span>
        </button>
        <button type="button" class="songlist-play-btn" data-songlist-playlist-play="${escHtml(list.id)}" title="播放歌单：将播放列表重置为该歌单内全部曲目并开始播放">${iconSvg('caret-right')}</button>
        ${delBtn}
      </div>`;
  }).join('') || '<div class="songlist-empty">还没有歌单<br>点「＋ 新建」创建一个吧</div>';
}

// 播放歌单：把播放列表重置为该歌单内的曲目并从第一首开始播放
function playSonglist(listId) {
  const list = getAllSonglists().find(l => l.id === listId);
  if (!list) return;
  const songs = getSonglistSongsWithMeta(list).map(item => item.song);
  if (!songs.length) {
    showToast('这个歌单还没有歌曲');
    return;
  }
  state.playlist = songs.map(snapshotOf);
  savePlaylist();
  player.queue = state.playlist;
  player.playMode = 'list';
  playSongAt(0);
  renderPlaylist();
  updatePlayerUI();
}

function renderSonglistDetail(wrap, list) {
  const items = getSonglistSongsWithMeta(list);
  wrap.innerHTML = `
    <div class="songlist-detail-head">
      <button class="tool-btn" id="songlistBackBtn" title="返回">${iconSvg('arrow-left')}</button>
      <span class="songlist-detail-name">${escHtml(list.name)}</span>
      <span class="songlist-detail-count">${items.length} 首</span>
      <button type="button" class="tool-btn primary" data-songlist-detail-play="${escHtml(list.id)}" title="播放歌单">${iconSvg('caret-right')}</button>
    </div>
    ${items.length ? items.map(item => {
      const isPlaying = player.queue === state.playlist && player.index >= 0 &&
        state.playlist[player.index] && state.playlist[player.index].song_id === item.song.song_id;
      return `
      <div class="songlist-song${isPlaying ? ' playing' : ''}" data-songlist-play="${escHtml(item.key)}">
        <div class="songlist-song-main">
          <div class="songlist-song-name">${escHtml(item.song.display_song_name || item.song.song_name || '')}</div>
          <div class="songlist-song-artist">${escHtml(item.song.artist || '')}</div>
        </div>
        <button type="button" class="mini-btn" data-songlist-copy="${escHtml(item.key)}" title="复制歌名">${iconSvg('copy')}</button>
        <button type="button" class="mini-btn danger" data-songlist-remove="${escHtml(item.key)}" title="从歌单移除">${iconSvg('close')}</button>
      </div>`;
    }).join('') : '<div class="songlist-empty">这个歌单还没有歌曲<br>在歌曲卡片上点 📁 就能加入</div>'}
  `;
}

// 歌单选择浮层（歌曲卡片 📁）
let pickerSong = null;

function openSonglistPicker(song) {
  pickerSong = song;
  dom.pickerSongName.textContent = song ? (song.display_song_name || song.song_name || '') : '';
  renderSonglistPicker();
  dom.songlistPickerOverlay.classList.add('show');
}

function closeSonglistPicker() {
  dom.songlistPickerOverlay.classList.remove('show');
  pickerSong = null;
}

function renderSonglistPicker() {
  if (!pickerSong) return;
  dom.pickerBody.innerHTML = getAllSonglists().map(list => {
    const checked = isSongInSonglist(pickerSong, list);
    return `
      <button type="button" class="picker-item${checked ? ' checked' : ''}" data-picker-list="${escHtml(list.id)}">
        <span class="picker-item-check">${iconSvg('check')}</span>
        <span class="picker-item-main">
          <span class="picker-item-name">${escHtml(list.name)}</span>
          <span class="picker-item-count">${getSonglistSongCount(list)} 首</span>
        </span>
      </button>`;
  }).join('');
}

async function togglePickerList(listId) {
  if (!pickerSong) return;
  const list = getAllSonglists().find(l => l.id === listId);
  if (!list) return;
  await toggleSongInSonglist(pickerSong, list);
  renderSonglistPicker();
  renderSonglistPanel();
  renderSongs(); // 刷新卡片 📁 高亮
}

function confirmCreateSonglist() {
  const name = (dom.songlistNewName.value || '').trim();
  if (!name) {
    showToast('歌单名不能为空');
    return;
  }
  const list = createSonglist(name);
  dom.songlistDialogOverlay.classList.remove('show');
  if (list) {
    showToast(`已创建歌单：${list.name}`);
    renderSonglistPanel();
  }
}

function togglePlay() {
  if (player.queue.length === 0 || player.index < 0) {
    playAllSongs();
    return;
  }
  if (player.audio.paused) {
    player.audio.play().catch(err => {
      if (isPlayAborted(err)) return;
      console.warn('[播放器] 恢复播放失败:', err);
      showToast(`播放失败：${err.message || err}`);
    });
  } else {
    player.audio.pause();
  }
}

function playNext(auto = false) {
  if (!player.queue.length) return;
  const mode = player.playMode;
  // 单曲循环：自动播完时重播当前曲目
  if (mode === 'single' && auto) {
    player.audio.currentTime = 0;
    player.audio.play().catch(err => {
      if (isPlayAborted(err)) return;
      console.warn('[播放器] 单曲重播失败:', err);
      showToast(`播放失败：${err.message || err}`);
    });
    return;
  }
  let next;
  if (mode === 'random') {
    // 按内部洗牌顺序播放（不重复）；播完一轮自动重新洗牌
    if (!player.shuffleOrder || player.shuffleOrder.length !== player.queue.length) {
      buildShuffleOrder();
    }
    player.shufflePos += 1;
    if (player.shufflePos >= player.shuffleOrder.length) {
      buildShuffleOrder(); // 一轮播完，重新洗牌
    }
    next = player.shuffleOrder[player.shufflePos];
  } else {
    // 歌单循环 / 单曲循环下的手动切歌：按顺序下一首，播完回到第一首
    next = player.index + 1;
    if (next >= player.queue.length) next = 0;
  }
  playSongAt(next);
}

function playPrev() {
  if (!player.queue.length) return;
  let prev;
  if (player.playMode === 'random' && player.shuffleOrder && player.shuffleOrder.length) {
    player.shufflePos -= 1;
    if (player.shufflePos < 0) player.shufflePos = player.shuffleOrder.length - 1; // 回到上一轮最后
    prev = player.shuffleOrder[player.shufflePos];
  } else {
    prev = player.index - 1;
    if (prev < 0) prev = player.queue.length - 1;
  }
  playSongAt(prev);
}

async function loadAudioIndex() {
  try {
    const room = state.currentRoom;
    if (room.audioIndexDataUrl) {
      state.audioIndex = await fetchLocalJson(room.audioIndexDataUrl);
    }
    if (room.cutInfoDataUrl) {
      state.cutInfo = await fetchLocalJson(room.cutInfoDataUrl);
    }
  } catch (err) {
    console.warn('[播放器] 音频索引加载失败:', err.message);
    state.audioIndex = null;
  }
  state.audioIndexLoaded = true;
  updatePlayerUI();
  // 音频索引加载完成后，若歌单已渲染过则重建一次以显示播放按钮
  if (state.allSongs.length) renderSongs();
}

player.audio.addEventListener('ended', () => playNext(true));
player.audio.addEventListener('play', () => { player.playing = true; updatePlayerUI(); });
player.audio.addEventListener('pause', () => { player.playing = false; updatePlayerUI(); });
player.audio.addEventListener('loadedmetadata', () => {
  const dur = Number.isFinite(player.audio.duration) ? player.audio.duration : 0;
  dom.playerTimeDur.textContent = formatAudioTime(dur);
  dom.playerSeek.max = Math.max(1, Math.floor(dur));
  dom.playerSeek.value = player.audio.currentTime || 0;
});
player.audio.addEventListener('timeupdate', () => {
  const cur = player.audio.currentTime || 0;
  const dur = player.audio.duration || 0;
  dom.playerTimeCur.textContent = formatAudioTime(cur);
  if (dur) {
    dom.playerSeek.max = Math.max(1, Math.floor(dur));
    // 拖动进度条时不要覆盖滑块位置，松开后再同步
    if (!seekDragging) dom.playerSeek.value = cur;
  }
});
player.audio.addEventListener('error', () => {
  showToast('音频加载失败，可能暂时没有收录');
  player.playing = false;
  updatePlayerUI();
});

let songRenderToken = 0; // 分批渲染令牌：新一轮渲染使进行中的批次失效

function renderSongs(errorMessage = '') {
  if (errorMessage) {
    dom.songListWrap.innerHTML = `
      <div class="card empty-card">
        <div class="empty-title">歌曲加载失败</div>
        <div>${escHtml(errorMessage)}</div>
      </div>
    `;
    deselectSong(true);
    return;
  }

  if (state.isSongLoading && state.allSongs.length === 0) {
    dom.songListWrap.innerHTML = `
      <div class="card empty-card">
        <div class="empty-title">正在加载歌单…</div>
        <div>等一下哦，我在读取歌单数据。</div>
      </div>
    `;
    return;
  }

  if (state.filteredSongs.length === 0) {
    dom.songListWrap.innerHTML = `
      <div class="card empty-card">
        <div class="empty-title">没有找到匹配歌曲</div>
        <div>可以试试换个关键词，或者把高级筛选清掉一点。</div>
      </div>
    `;
    deselectSong(true);
    return;
  }

  // 分批渲染：每帧插入 80 行，避免上千行一次性渲染阻塞主线程
  const list = state.filteredSongs;
  const token = ++songRenderToken;
  const CHUNK = 80;
  let i = 0;
  let html = '';
  dom.songListWrap.innerHTML = '';
  function step() {
    if (token !== songRenderToken) return; // 新一轮渲染已开始，放弃本批
    const end = Math.min(i + CHUNK, list.length);
    for (; i < end; i++) html += getSongCardHtml(list[i]);
    dom.songListWrap.insertAdjacentHTML('beforeend', html);
    html = '';
    if (i < list.length) requestAnimationFrame(step);
  }
  step();
}

function syncFilterSummary() {
  const activeParts = [];
  if (state.songFilters.languages.length) activeParts.push(`语言 ${state.songFilters.languages.join(' / ')}`);
  if (state.songFilters.tags.length) activeParts.push(`标签 ${state.songFilters.tags.join(' / ')}`);
  if (state.songFilters.countMin !== null || state.songFilters.countMax !== null) {
    activeParts.push(`次数 ${state.songFilters.countMin ?? '不限'}-${state.songFilters.countMax ?? '不限'}`);
  }
  if (state.songFilters.daysMin !== null || state.songFilters.daysMax !== null) {
    activeParts.push(`天数 ${state.songFilters.daysMin ?? '不限'}-${state.songFilters.daysMax ?? '不限'}`);
  }
  dom.toggleFilterBtn.classList.toggle('active', state.filtersVisible || activeParts.length > 0);
  dom.favoritesOnlyBtn.classList.toggle('active', state.favoritesOnly);
  dom.favoritesOnlyBtn.textContent = state.favoritesOnly ? '只看中意（开）' : '仅看中意';
}

function selectSong(song) {
  state.selectedSong = song;
  dom.actionPanel.style.display = 'block';
  dom.selectedSongName.textContent = `🎵 ${song.display_song_name || song.song_name || ''}`;
  const cutUrl = getSongCutUrl(song.cut_link);
  const cutTitle = cutTitleOf(song);
  dom.selectedSongCutWrap.innerHTML = cutUrl
    ? `歌切：<a href="${escHtml(cutUrl)}" target="_blank" rel="noreferrer" title="${escHtml(cutTitle || cutUrl)}">${escHtml(cutTitle || '打开对应视频')}</a>`
    : '歌切：暂时还没有补到对应视频';
  renderSongs();
}

function deselectSong(silent = false) {
  state.selectedSong = null;
  dom.actionPanel.style.display = 'none';
  dom.selectedSongCutWrap.innerHTML = '歌切：暂时还没有补到对应视频';
  if (!silent) renderSongs();
}

async function doCopySong() {
  if (!state.selectedSong) return;
  const name = state.selectedSong.display_song_name || state.selectedSong.song_name || '';
  await copyToClipboard(name);
  showToast(`已复制歌名：${name}`);
}

// 生成并复制「点歌」文本：点歌 歌名[ 版本/歌手]（ゆめこ → yumeko）
async function copyOrderTextOf(song, withPrefix = false) {
  if (!song) return;
  const name = (song.display_song_name || song.song_name || '').trim();
  if (!name) return;
  let version = (song.display_version || '').trim();
  if (version === 'ゆめこ') version = 'yumeko';
  const artist = (song.artist || '').trim();
  const parts = [name];
  if (version) parts.push(version);
  else if (artist) parts.push(artist);
  const text = (withPrefix ? '点歌 ' : '') + parts.join(' ');
  await copyToClipboard(text);
  showToast(`已复制：${text}`);
}

// 复制「歌名 + 版本/歌手」（不含点歌前缀；ゆめこ → yumeko）
async function doCopyOrderText() {
  if (!state.selectedSong) return;
  await copyOrderTextOf(state.selectedSong, false);
}

function renderLanguageChips() {
  const langs = Array.from(new Set(state.allSongs.map(song => song.language || '').filter(Boolean))).sort((a, b) => a.localeCompare(b, 'zh-CN'));
  if (langs.length === 0) {
    dom.languageChips.innerHTML = '<span class="muted">暂无语言标签</span>';
    return;
  }
  dom.languageChips.innerHTML = langs.map(lang => {
    const active = state.songFilters.languages.includes(lang);
    return `<button class="filter-chip${active ? ' active' : ''}" data-lang-chip="${escHtml(lang)}">${escHtml(lang)}</button>`;
  }).join('');
}

// 标签筛选：取全部歌曲 type 标签中出现次数最高的前 N 个
const TAG_FILTER_LIMIT = 10;

function getTopTags(limit = TAG_FILTER_LIMIT) {
  const count = new Map();
  state.allSongs.forEach(song => {
    String(song.type || '').split(/[、,，/／|｜\s]+/).map(t => t.trim()).filter(Boolean).forEach(tag => {
      count.set(tag, (count.get(tag) || 0) + 1);
    });
  });
  return Array.from(count.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh-CN'))
    .slice(0, limit)
    .map(([tag]) => tag);
}

function renderTagChips() {
  const topTags = getTopTags();
  if (topTags.length === 0) {
    dom.tagChips.innerHTML = '<span class="muted">暂无标签</span>';
    return;
  }
  dom.tagChips.innerHTML = topTags.map(tag => {
    const active = state.songFilters.tags.includes(tag);
    return `<button class="filter-chip${active ? ' active' : ''}" data-tag-chip="${escHtml(tag)}">${escHtml(tag)}</button>`;
  }).join('');
}

function favoriteSnapshotFromSong(song, overrides = {}) {
  return {
    key: getFavoriteKey(song),
    song_id: song.song_id,
    row_key: song.row_key || song.song_name || '',
    song_name: song.song_name || '',
    display_song_name: song.display_song_name || song.song_name || '',
    artist: song.artist || '',
    artist_search: song.artist_search || '',
    feat_artist: song.feat_artist || '',
    sing_count: song.sing_count || 0,
    last_sing_at: song.last_sing_at || '',
    status_labels: song.status_labels || '',
    language: song.language || '',
    display_version: song.display_version || '',
    tone: song.tone ?? '',
    remark: song.remark || '',
    type: song.type || '',
    identification: song.identification || '',
    importedManual: false,
    ...overrides
  };
}

function normalizeFavoriteMap(raw) {
  if (!raw || typeof raw !== 'object') return {};
  const out = {};
  Object.keys(raw).forEach(key => {
    const item = raw[key];
    if (!item || typeof item !== 'object') return;
    out[key] = {
      key,
      song_id: item.song_id ?? null,
      row_key: item.row_key || item.song_name || '',
      song_name: item.song_name || item.display_song_name || '',
      display_song_name: item.display_song_name || item.song_name || '',
      artist: item.artist || '',
      artist_search: item.artist_search || '',
      feat_artist: item.feat_artist || '',
      sing_count: Number(item.sing_count || 0),
      last_sing_at: item.last_sing_at || '',
      status_labels: item.status_labels || '',
      language: item.language || '',
      display_version: item.display_version || '',
      tone: item.tone ?? '',
      remark: item.remark || '',
      type: item.type || '',
      identification: item.identification || '',
      importedManual: !!item.importedManual
    };
  });
  return out;
}

function hydrateFavoriteList() {
  const songsByKey = new Map(state.allSongs.map(song => [getFavoriteKey(song), song]));
  state.favoriteList = Object.values(state.favoritesMap).map(snapshot => {
    const liveSong = snapshot.key ? songsByKey.get(snapshot.key) : null;
    if (liveSong) {
      return favoriteSnapshotFromSong(liveSong, { key: snapshot.key, importedManual: !!snapshot.importedManual });
    }
    return { ...snapshot };
  }).filter(item => item && item.key);
}

async function loadFavorites() {
  const result = await storageGet([FAVORITES_KEY, 'favorites:miting', 'favorites:xiaosonglu']);
  state.favoritesMap = normalizeFavoriteMap(result[FAVORITES_KEY]);

  // 迁移旧版「按房间分存」的收藏 → 全局共享存档（改为歌名键）
  let migrated = 0;
  ['miting', 'xiaosonglu'].forEach(roomKey => {
    const legacy = result[`favorites:${roomKey}`];
    if (!legacy || typeof legacy !== 'object') return;
    Object.values(normalizeFavoriteMap(legacy)).forEach(item => {
      const name = String(item.display_song_name || item.song_name || '').trim();
      if (!name) return;
      const key = `name:${name}`;
      if (!state.favoritesMap[key]) {
        state.favoritesMap[key] = { ...item, key };
        migrated += 1;
      }
    });
  });
  if (migrated) {
    await saveFavorites();
    await storageRemove(['favorites:miting', 'favorites:xiaosonglu']);
  }

  hydrateFavoriteList();
  renderFavorites();
  // 读取当前清单名，显示在中意模块
  const curNameObj = await storageGet(FAV_CURRENT_KEY);
  state.favCurrentNameValue = curNameObj[FAV_CURRENT_KEY] || '';
  updateFavCurrentNameUi();
}

async function saveFavorites() {
  await storageSet({ [FAVORITES_KEY]: state.favoritesMap });
}

async function toggleFavoriteBySong(song) {
  const key = getFavoriteKey(song);
  if (!key || !canFavoriteSong(song)) return;
  if (state.favoritesMap[key]) delete state.favoritesMap[key];
  else state.favoritesMap[key] = favoriteSnapshotFromSong(song);
  await saveFavorites();
  hydrateFavoriteList();
  applySongFilters();
  renderSonglistPanel();
}

function getFavoriteArtistLine(song) {
  return [song.artist || '', song.feat_artist ? `feat. ${song.feat_artist}` : ''].filter(Boolean).join(' · ');
}

function getFavoriteImportKey(name, artist = '') {
  // 与全局存档一致用歌名键
  return `name:${String(name || '').trim()}`;
}

function findSongForImportedLine(name, artist = '') {
  const targetName = String(name || '').trim().toLowerCase();
  const targetArtist = String(artist || '').trim().toLowerCase();
  if (!targetName) return null;
  const exact = state.allSongs.find(song => {
    const names = [song.display_song_name, song.song_name, song.row_key, song.search_name]
      .map(item => String(item || '').trim().toLowerCase())
      .filter(Boolean);
    if (!names.includes(targetName)) return false;
    if (!targetArtist) return true;
    const artists = [song.artist, song.artist_search, song.feat_artist]
      .map(item => String(item || '').trim().toLowerCase())
      .filter(Boolean);
    return artists.some(item => item.includes(targetArtist));
  });
  if (exact) return exact;
  return state.allSongs.find(song => {
    const names = [song.display_song_name, song.song_name, song.row_key, song.search_name]
      .map(item => String(item || '').trim().toLowerCase())
      .filter(Boolean);
    return names.some(item => item.includes(targetName) || targetName.includes(item));
  }) || null;
}

function renderFavorites() {
  hydrateFavoriteList();
  // 只显示当前歌单里存在的歌（主播唱过的）
  const roomKeys = new Set(state.allSongs.map(song => getFavoriteKey(song)));
  const list = state.favoriteList
    .filter(item => item.key && roomKeys.has(item.key))
    .sort((a, b) => compareSongs(a, b, 'last_sing_at', 'desc'));
  dom.favoritesCountText.textContent = `${list.length} 首`;
  dom.favoritesMetaText.textContent = list.length
    ? `共 ${list.length} 首`
    : '还没有中意歌曲。';

  if (!list.length) {
    dom.favoritesListWrap.innerHTML = '<div class="fav-empty">还没有中意歌曲。可以在总览点星星收藏，或导入一份存档。</div>';
    return;
  }

  dom.favoritesListWrap.innerHTML = list.map(song => {
    const artistLine = getFavoriteArtistLine(song) || '未填写歌手';
    const lastText = song.last_sing_at ? `最近 ${formatLastSing(song.last_sing_at)}` : '还没有最近演唱数据';
    const statuses = getVisibleStatusLabels(song.status_labels);
    const days = getDaysAgo(song.last_sing_at);
    const extraBadges = [];
    if (song.language) extraBadges.push(`<span class="badge ${getLanguageBadgeClass(song.language)}">${escHtml(song.language)}</span>`);
    if (song.display_version) extraBadges.push(`<span class="badge">Ver. ${escHtml(song.display_version)}</span>`);
    getVisibleTypeLabels(song.type).forEach(type => extraBadges.push(`<span class="badge">${escHtml(type)}</span>`));
    if (song.importedManual) extraBadges.push('<span class="badge">导入</span>');
    return `
      <div class="fav-item" data-favorite-key-item="${escHtml(song.key)}">
        <div class="fav-item-main">
          <div class="fav-item-name">${escHtml(song.display_song_name || song.song_name || '')}</div>
          <div class="fav-item-meta">${escHtml(artistLine)}<br>${escHtml(lastText)}</div>
          <div class="fav-item-extra">
            ${extraBadges.join('')}
            <span class="badge count">次数 ${escHtml(song.sing_count || 0)}</span>
            ${song.tone !== '' && song.tone !== null && song.tone !== undefined ? `<span class="badge tone">Tone ${escHtml(formatTone(song.tone))}</span>` : ''}
            ${days === null ? '' : `<span class="fav-item-days">${days} 天</span>`}
          </div>
          ${statuses.length ? `<div class="fav-item-status" style="margin-top:8px;">${statuses.map(item => `<span class="badge status">${escHtml(item)}</span>`).join('')}</div>` : ''}
          <div class="fav-item-actions">
            ${song.song_name || song.display_song_name ? `<button class="tool-btn" data-favorite-copy-key="${escHtml(song.key)}">复制歌名</button>` : ''}
          </div>
        </div>
        <button class="fav-item-remove" data-favorite-remove-key="${escHtml(song.key)}" title="移除">${iconSvg('close')}</button>
      </div>
    `;
  }).join('');
}

async function clearFavorites() {
  if (!state.favoriteList.length) {
    showToast('中意清单已经是空的啦');
    return;
  }
  if (!window.confirm(`确定清空 ${state.favoriteList.length} 首中意歌曲吗？`)) return;
  state.favoritesMap = {};
  await saveFavorites();
  hydrateFavoriteList();
  applySongFilters();
  showToast('已清空中意清单');
}

// ===== 中意清单 服务器存档（访客用清单名区分） =====

// 上传存档：打开弹窗输入清单名
function openFavUpload() {
  const cur = (state.favCurrentNameValue || '').trim();
  dom.favUploadName.value = cur;
  dom.favUploadOverlay.classList.add('show');
  setTimeout(() => dom.favUploadName.focus(), 50);
}
function closeFavUpload() {
  dom.favUploadOverlay.classList.remove('show');
  dom.favUploadName.value = '';
}
// 把当前 favoritesMap 上传到服务器，同名询问覆盖
async function submitFavUpload() {
  const name = dom.favUploadName.value.trim();
  if (!name) { showToast('先给清单起个名字吧'); return; }
  const url = FAV_API_BASE + encodeURIComponent(name);
  const payload = { songs: state.favoritesMap };
  let res;
  try {
    res = await fetch(url, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
  } catch (e) { showToast('上传失败：网络错误'); return; }
  if (!res.ok) { showToast('上传失败：' + res.status); return; }
  const data = await res.json();
  // 已存在同名 → 询问是否覆盖
  if (data.exists) {
    if (!window.confirm(`服务器已有同名清单「${name}」，是否覆盖？`)) return;
    res = await fetch(url, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
    if (!res.ok) { showToast('覆盖失败：' + res.status); return; }
  }
  setFavCurrentName(name);
  state.favCurrentNameValue = name;
  updateFavCurrentNameUi();
  closeFavUpload();
  showToast(`已上传清单「${name}」`);
}

// 导入存档：打开弹窗输入清单名
function openFavLoad() {
  dom.favLoadName.value = (state.favCurrentNameValue || '').trim();
  dom.favLoadOverlay.classList.add('show');
  setTimeout(() => dom.favLoadName.focus(), 50);
}
function closeFavLoad() {
  dom.favLoadOverlay.classList.remove('show');
  dom.favLoadName.value = '';
}
// 从服务器拉取清单并导入
async function submitFavLoad() {
  const name = dom.favLoadName.value.trim();
  if (!name) { showToast('先输入清单名'); return; }
  const url = FAV_API_BASE + encodeURIComponent(name);
  let res;
  try {
    res = await fetch(url);
  } catch (e) { showToast('拉取失败：网络错误'); return; }
  if (res.status === 404) { showToast(`没有找到清单「${name}」`); dom.favLoadOverlay.classList.remove('show'); return; }
  if (!res.ok) { showToast('拉取失败：' + res.status); return; }
  const data = await res.json();
  if (!data.songs || typeof data.songs !== 'object') { showToast('清单内容无效'); return; }
  state.favoritesMap = normalizeFavoriteMap(data.songs);
  await saveFavorites();
  hydrateFavoriteList();
  applySongFilters();
  setFavCurrentName(name);
  state.favCurrentNameValue = name;
  updateFavCurrentNameUi();
  closeFavLoad();
  showToast(`已导入清单「${name}」，共 ${state.favoriteList.length} 首`);
}

// 刷新清单：按当前清单名从服务器拉取
async function refreshFavoritesFromServer() {
  const name = (state.favCurrentNameValue || '').trim();
  if (!name) { showToast('还没有当前清单名，先上传或导入一个存档'); return; }
  const url = FAV_API_BASE + encodeURIComponent(name);
  let res;
  try {
    res = await fetch(url);
  } catch (e) { showToast('刷新失败：网络错误'); return; }
  if (res.status === 404) { showToast(`服务器没有清单「${name}」`); return; }
  if (!res.ok) { showToast('刷新失败：' + res.status); return; }
  const data = await res.json();
  if (!data.songs || typeof data.songs !== 'object') { showToast('清单内容无效'); return; }
  state.favoritesMap = normalizeFavoriteMap(data.songs);
  await saveFavorites();
  hydrateFavoriteList();
  applySongFilters();
  showToast(`已刷新清单「${name}」`);
}

// ===== 中意清单 本地 TXT 导入/导出 =====

// 下载存档：把当前中意清单导出为 TXT 文件
function exportFavoritesToFile() {
  if (!state.favoriteList.length) {
    showToast('中意清单还是空的');
    return;
  }
  const lines = ['歌名\t歌手\t次数\t最近演唱日期'];
  state.favoriteList.forEach(song => {
    let artist = song.artist || '';
    if (song.feat_artist) artist = artist ? `${artist} feat. ${song.feat_artist}` : `feat. ${song.feat_artist}`;
    lines.push([
      song.display_song_name || song.song_name || '',
      artist,
      song.sing_count || 0,
      song.last_sing_at || ''
    ].join('\t'));
  });
  const text = '\uFEFF' + lines.join('\r\n'); // BOM 便于 Excel 打开
  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  const fileName = `小松绿歌单-中意 ${now.getFullYear()}.${pad(now.getMonth()+1)}.${pad(now.getDate())}.txt`;
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  showToast(`已下载存档：${fileName}`);
}

// 导入本地存档：弹出文件选择，读取 TXT 并导入
function handleFavoritesFileImport() {
  const file = dom.favoritesImportFileInput.files && dom.favoritesImportFileInput.files[0];
  dom.favoritesImportFileInput.value = ''; // 允许重复选同一文件
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    importFavoritesFromTxt(String(reader.result || ''));
  };
  reader.onerror = () => showToast('读取存档文件失败');
  reader.readAsText(file, 'utf-8');
}

// 解析 TXT 存档文本并导入中意清单（歌名\t歌手\t次数\t日期，每行一首）
async function importFavoritesFromTxt(rawText) {
  const lines = String(rawText || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (!lines.length) { showToast('文件里没有内容'); return; }
  let matched = 0, manual = 0;
  lines.forEach(line => {
    const parts = line.split('\t').map(x => x.trim());
    const first = parts[0] || '';
    if (!first || first === '歌名') return; // 跳过表头
    const artist = parts[1] || '';
    const found = findSongForImportedLine(first, artist);
    if (found) {
      state.favoritesMap[getFavoriteKey(found)] = favoriteSnapshotFromSong(found);
      matched += 1;
      return;
    }
    const key = getFavoriteImportKey(first, artist);
    state.favoritesMap[key] = {
      key, song_id: null, row_key: first, song_name: first,
      display_song_name: first, artist, artist_search: '',
      feat_artist: '', sing_count: 0, last_sing_at: '',
      status_labels: '', language: '', display_version: '',
      tone: '', remark: '', type: '', identification: '',
      importedManual: true
    };
    manual += 1;
  });
  await saveFavorites();
  hydrateFavoriteList();
  applySongFilters();
  showToast(`导入完成：匹配 ${matched} 首，手动保留 ${manual} 首`);
}

// 语言 全选/全不选 = 不过滤（全选只是视觉上全勾选）
function setLanguageChipsAll(all) {
  state.songFilters.languages = [];
  renderLanguageChips();
  dom.languageChips.querySelectorAll('[data-lang-chip]').forEach(el => {
    el.classList.toggle('active', all);
  });
  applySongFilters();
}

// 预设按钮高亮：与当前次数/天数输入一致
function syncPresetButtons() {
  dom.countPresetRow.querySelectorAll('.preset-btn').forEach(btn => {
    const min = btn.dataset.countMin === '' ? null : Number(btn.dataset.countMin);
    const max = btn.dataset.countMax === '' ? null : Number(btn.dataset.countMax);
    btn.classList.toggle('active', min === state.songFilters.countMin && max === state.songFilters.countMax);
  });
  dom.daysPresetRow.querySelectorAll('.preset-btn').forEach(btn => {
    const min = btn.dataset.daysMin === '' ? null : Number(btn.dataset.daysMin);
    const max = btn.dataset.daysMax === '' ? null : Number(btn.dataset.daysMax);
    btn.classList.toggle('active', min === state.songFilters.daysMin && max === state.songFilters.daysMax);
  });
}

async function fetchHistoryMeta(room, forceRefresh = false) {
  if (room.placeholder || !room.supportsHistory || (!room.historyPageUrl && !room.historyDataUrl)) {
    state.historyMeta = { dateTree: {}, latest: null };
    return state.historyMeta;
  }

  const keys = getStorageKeys(state.currentRoomKey);
  if (!forceRefresh) {
    const cached = await storageGet([keys.historyCache, keys.historyCacheTime]);
    if (cached[keys.historyCache] && cached[keys.historyCacheTime] && Date.now() - cached[keys.historyCacheTime] < HISTORY_CACHE_TTL) {
      state.historyMeta = cached[keys.historyCache];
      return state.historyMeta;
    }
  }

  let meta;
  if (room.sourceType === 'local-json' && room.historyDataUrl) {
    meta = await fetchLocalJson(room.historyDataUrl);
    meta.latest = meta.latest || findLatestDateFromTree(meta.dateTree || {});
  }

  await storageSet({
    [keys.historyCache]: meta,
    [keys.historyCacheTime]: Date.now()
  });
  state.historyMeta = meta;
  return meta;
}

function findLatestDateFromTree(dateTree) {
  const years = Object.keys(dateTree || {}).sort((a, b) => Number(b) - Number(a));
  for (const year of years) {
    const months = Object.keys(dateTree[year] || {}).sort((a, b) => Number(b) - Number(a));
    for (const month of months) {
      const days = Object.keys(dateTree[year][month] || {}).sort((a, b) => Number(b) - Number(a));
      if (days.length) return { year, month, day: days[0] };
    }
  }
  return null;
}

function fillHistoryDateSelectors() {
  const meta = state.historyMeta;
  const dateTree = (meta && meta.dateTree) || {};
  const years = Object.keys(dateTree).sort((a, b) => Number(b) - Number(a));
  dom.historyYearSelect.innerHTML = years.map(year => `<option value="${year}">${year} 年</option>`).join('');

  if (!years.length) {
    dom.historyMonthSelect.innerHTML = '';
    dom.historyDaySelect.innerHTML = '';
    return;
  }

  const current = state.historySelectedDate || meta.latest || { year: years[0] };
  dom.historyYearSelect.value = current.year;
  fillHistoryMonthSelector();
  dom.historyMonthSelect.value = current.month;
  fillHistoryDaySelector();
  dom.historyDaySelect.value = current.day;
}

function fillHistoryMonthSelector() {
  const year = dom.historyYearSelect.value;
  const dateTree = (state.historyMeta && state.historyMeta.dateTree) || {};
  const months = Object.keys((dateTree[year] || {})).sort((a, b) => Number(b) - Number(a));
  dom.historyMonthSelect.innerHTML = months.map(month => `<option value="${month}">${month} 月</option>`).join('');
}

function fillHistoryDaySelector() {
  const year = dom.historyYearSelect.value;
  const month = dom.historyMonthSelect.value;
  const dateTree = (state.historyMeta && state.historyMeta.dateTree) || {};
  const days = Object.keys((((dateTree[year] || {})[month]) || {})).sort((a, b) => Number(b) - Number(a));
  dom.historyDaySelect.innerHTML = days.map(day => `<option value="${day}">${day} 日</option>`).join('');
}

async function loadHistory(forceRefreshMeta = false) {
  const room = state.currentRoom;
  if (room.placeholder || !room.supportsHistory) {
    dom.historyMetaText.textContent = '历史数据暂不可用。';
    dom.historyListWrap.innerHTML = `
      <div class="card empty-card">
        <div class="empty-title">历史页面暂时不可用</div>
        <div>暂时还没有历史歌单数据。</div>
      </div>
    `;
    return;
  }

  try {
    const meta = await fetchHistoryMeta(room, forceRefreshMeta);
    if (!meta || !meta.latest) {
      dom.historyMetaText.textContent = '没有可用的历史日期。';
      dom.historyListWrap.innerHTML = `
        <div class="card empty-card">
          <div class="empty-title">还没有历史数据</div>
          <div>这个房间暂时没有读到历史每日歌曲记录。</div>
        </div>
      `;
      return;
    }

    if (!state.historySelectedDate) state.historySelectedDate = meta.latest;
    fillHistoryDateSelectors();
    await loadHistoryPage(1);
  } catch (error) {
    console.error('[歌单网页] 加载历史元数据失败:', error);
    dom.historyMetaText.textContent = `历史数据加载失败：${error.message}`;
    dom.historyListWrap.innerHTML = `
      <div class="card empty-card">
        <div class="empty-title">历史数据加载失败</div>
        <div>${escHtml(error.message)}</div>
      </div>
    `;
  }
}

async function loadHistoryPage(page = 1) {
  const room = state.currentRoom;
  if (room.placeholder || (!room.historyPageUrl && !room.historyDataUrl)) return;
  const year = dom.historyYearSelect.value;
  const month = dom.historyMonthSelect.value;
  const day = dom.historyDaySelect.value;
  if (!year || !month || !day) return;

  state.isHistoryLoading = true;
  state.historySelectedDate = { year, month, day };
  dom.historyMetaText.textContent = `正在读取 ${year}-${month}-${day} 的历史记录…`;
  dom.historyListWrap.innerHTML = `
    <div class="card empty-card">
      <div class="empty-title">历史加载中…</div>
      <div>等一下，我在翻歌单档案。</div>
    </div>
  `;

  try {
    let parsed;
    if (room.sourceType === 'local-json' && room.historyDataUrl) {
      const payload = state.historyMeta && state.historyMeta.byDate ? state.historyMeta : await fetchLocalJson(room.historyDataUrl);
      const dateKey = `${year}-${month}-${day}`;
      const entries = Array.isArray(payload.byDate && payload.byDate[dateKey]) ? payload.byDate[dateKey].map(mapLocalHistoryEntry) : [];
      parsed = paginateLocalHistory(entries, page, room.historyPageSize || 30);
    }

    state.historyEntries = parsed.entries;
    state.historyPage = parsed.page;
    state.historyTotalPages = parsed.totalPages;
    renderHistoryEntries();
    const totalCount = room.sourceType === 'local-json' && state.historyMeta && state.historyMeta.byDate
      ? ((state.historyMeta.byDate[`${year}-${month}-${day}`] || []).length)
      : parsed.entries.length;
    dom.historyMetaText.textContent = `${year}-${month}-${day} · 第 ${state.historyPage} / ${state.historyTotalPages} 页 · 共 ${totalCount} 条`;
    syncHistoryPager();
  } catch (error) {
    console.error('[歌单网页] 加载历史列表失败:', error);
    dom.historyMetaText.textContent = `历史记录加载失败：${error.message}`;
    dom.historyListWrap.innerHTML = `
      <div class="card empty-card">
        <div class="empty-title">历史记录加载失败</div>
        <div>${escHtml(error.message)}</div>
      </div>
    `;
  } finally {
    state.isHistoryLoading = false;
  }
}

function renderHistoryEntries() {
  if (!state.historyEntries.length) {
    dom.historyListWrap.innerHTML = `
      <div class="card empty-card">
        <div class="empty-title">这一天没有记录</div>
        <div>可以换个日期看看，也许那天刚好没有唱歌。</div>
      </div>
    `;
    return;
  }

  dom.historyListWrap.innerHTML = state.historyEntries.map((entry, index) => {
    return `
    <div class="history-item" data-history-index="${index}">
      <div class="history-top">
        <div class="history-main">
          <div class="history-name">${escHtml(entry.song_name)}</div>
          <div class="history-sub">演唱时间：${escHtml(entry.sing_time || '未记录')}${entry.artist ? ` · ${escHtml(entry.artist)}` : ''}</div>
        </div>
        ${entry.song_name ? `<button class="tool-btn" data-history-copy="${index}">复制歌名</button>` : ''}
      </div>
      ${entry.replay_title || entry.replay_url ? `<div class="history-sub" style="margin-top:8px;">回放：${entry.replay_url ? `<a href="${escHtml(entry.replay_url)}" target="_blank" rel="noreferrer">${escHtml(entry.replay_title || '打开回放')}</a>` : escHtml(entry.replay_title)}</div>` : ''}
    </div>
  `;
  }).join('');
}

function syncHistoryPager() {
  dom.historyPageInfo.textContent = `第 ${state.historyPage} / ${state.historyTotalPages} 页`;
  dom.historyPrevBtn.disabled = state.historyPage <= 1;
  dom.historyNextBtn.disabled = state.historyPage >= state.historyTotalPages;
}

async function loadSongDetail(songName, displayLabel, singCount) {
  if (!songName) return;
  dom.detailTitle.textContent = displayLabel || songName;
  dom.detailSub.textContent = singCount != null ? `总演唱 ${singCount} 次` : '正在加载详情…';
  dom.detailBody.innerHTML = '<div class="muted">正在加载演唱详情…</div>';
  dom.detailOverlay.classList.add('show');
  dom.detailModal.classList.add('show');

  const cacheKey = `${state.currentRoomKey}:${songName}`;
  if (state.detailsCache[cacheKey]) {
    renderSongDetail(state.detailsCache[cacheKey]);
    return;
  }

  try {
    let parsed;
    if (state.currentRoom.sourceType === 'local-json' && state.currentRoom.detailDataUrl) {
      const detailsPayload = state.detailsCache[`__details_file__:${state.currentRoomKey}`] || await fetchLocalJson(state.currentRoom.detailDataUrl);
      state.detailsCache[`__details_file__:${state.currentRoomKey}`] = detailsPayload;
      const bySongKey = detailsPayload.bySongKey || {};
      const match = Object.values(bySongKey).find(item => {
        return item && [item.row_key, item.song_name, item.display_song_name].filter(Boolean).includes(songName);
      });
      parsed = match ? {
        display_song_name: match.display_song_name || match.song_name || songName,
        total_count: match.total_count,
        cut_link: getSongCutUrl(match.cut_link),
        entries: Array.isArray(match.entries) ? match.entries.map(entry => ({
          ...entry,
          cut_link: getSongCutUrl(entry.cut_link)
        })) : []
      } : { display_song_name: displayLabel || songName, total_count: singCount || 0, cut_link: '', entries: [] };
    }
    state.detailsCache[cacheKey] = parsed;
    renderSongDetail(parsed);
  } catch (error) {
    console.error('[歌单网页] 详情加载失败:', error);
    dom.detailBody.innerHTML = `<div class="muted">加载失败：${escHtml(error.message)}</div>`;
  }
}

function renderSongDetail(detail) {
  if (detail.display_song_name) dom.detailTitle.textContent = detail.display_song_name;
  if (detail.total_count != null) dom.detailSub.textContent = `总演唱 ${detail.total_count} 次`;
  const primaryCutUrl = getSongCutUrl(detail.cut_link);
  if (!detail.entries.length) {
    dom.detailBody.innerHTML = '<div class="muted">没有找到对应的演唱记录。</div>';
    return;
  }
  const rows = detail.entries.map(item => {
    const visibleStatus = getVisibleStatusText(item.status) || '—';
    return `
    <tr>
      <td>${escHtml(item.date || '—')}</td>
      <td>${escHtml(item.time || '—')}</td>
      <td>${escHtml(visibleStatus)}</td>
    </tr>
  `;
  }).join('');
  const replayExtra = detail.entries.some(item => item.replay_title || item.replay_url)
    ? `<div style="margin-top:10px; font-size:12px; color:#6271a8; line-height:1.7;">${detail.entries.map(item => {
        if (!item.replay_title && !item.replay_url) return '';
        const label = escHtml(item.date || '未标日期');
        const text = escHtml(item.replay_title || '打开回放');
        return item.replay_url
          ? `<div>${label}：<a href="${escHtml(item.replay_url)}" target="_blank" rel="noreferrer">${text}</a></div>`
          : `<div>${label}：${text}</div>`;
      }).filter(Boolean).join('')}</div>`
    : '';
  const clipExtra = primaryCutUrl || detail.entries.some(item => item.cut_link)
    ? `<div style="margin-top:10px; font-size:12px; color:#6271a8; line-height:1.7;">${[
        primaryCutUrl ? `<div>歌曲歌切：<a href="${escHtml(primaryCutUrl)}" target="_blank" rel="noreferrer">打开对应视频</a></div>` : '',
        ...detail.entries.map(item => {
          const entryCutUrl = getSongCutUrl(item.cut_link);
          if (!entryCutUrl || entryCutUrl === primaryCutUrl) return '';
          const label = escHtml(item.date || '未标日期');
          return `<div>${label}：<a href="${escHtml(entryCutUrl)}" target="_blank" rel="noreferrer">打开该次歌切</a></div>`;
        }).filter(Boolean)
      ].join('')}</div>`
    : '';
  dom.detailBody.innerHTML = `
    <table>
      <thead>
        <tr><th>演唱日期</th><th>演唱时间</th><th>状态</th></tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
    ${clipExtra}
    ${replayExtra}
  `;
}

function closeDetailModal() {
  dom.detailOverlay.classList.remove('show');
  dom.detailModal.classList.remove('show');
}

function syncFilterInputs() {
  dom.sortFieldSelect.value = state.songFilters.sortField;
  dom.sortDirSelect.value = state.songFilters.sortDir;
}

function parseNullableNumber(value) {
  const trimmed = String(value || '').trim();
  if (!trimmed) return null;
  const num = Number(trimmed);
  return Number.isFinite(num) ? num : null;
}

function applyFilterInputs() {
  state.songFilters.sortField = dom.sortFieldSelect.value;
  state.songFilters.sortDir = dom.sortDirSelect.value;
  syncPresetButtons();
  applySongFilters();
}

function resetSongFilters() {
  state.songFilters = {
    query: '',
    countMin: null,
    countMax: null,
    daysMin: null,
    daysMax: null,
    languages: [],
    tags: [],
    derivativeOnly: false,
    sortField: 'last_sing_at',
    sortDir: 'desc'
  };
  if (dom.derivativeOnlyBtn) dom.derivativeOnlyBtn.checked = false;
  if (dom.favoritesOnlyBtn) dom.favoritesOnlyBtn.classList.remove('active');
  state.searchMode = 'mixed';
  dom.searchInput.value = '';
  syncSearchModeButtons();
  syncFilterInputs();
  syncPresetButtons();
  renderLanguageChips();
  renderTagChips();
  syncClearButton();
  applySongFilters();
}

function syncSearchModeButtons() {
  document.querySelectorAll('.search-mode-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.mode === state.searchMode);
  });
}

function syncClearButton() {
  dom.clearSearchBtn.classList.toggle('show', !!dom.searchInput.value);
}

async function initRoom(forceRefreshSongs = false) {
  const roomKey = 'xiaosonglu';
  state.currentRoomKey = roomKey;
  state.currentRoom = getRoomConfig(roomKey);
  state.settings.lastRoomKey = roomKey;
  await saveGlobalSettings();

  renderRoomContextSummary();
  state.allSongs = [];
  state.filteredSongs = [];
  state.favoritesMap = {};
  state.favoriteList = [];
  state.songDataUpdatedAt = null;
  state.songDataFromCache = false;
  state.historyEntries = [];
  state.historyMeta = null;
  state.historySelectedDate = null;
  state.historyPage = 1;
  state.historyTotalPages = 1;
  deselectSong(true);
  state.detailsCache = {};
  renderSongs();
  renderFavorites();

  // 并行加载：收藏 / 歌曲 / 历史互不依赖，一起拉取缩短首屏等待
  const [favResult] = await Promise.all([
    loadFavorites(),
    loadSongData(forceRefreshSongs),
    loadHistory(false)
  ]);
  void favResult;
  renderLanguageChips();
  renderTagChips();
  syncFilterInputs();
  syncPresetButtons();
  applySongFilters();
}

function bindDom() {
  [
    'refreshBtn','headerStatus','roomSubtitle','searchInput','clearSearchBtn','toggleFilterBtn','favoritesOnlyBtn',
    'songMetaText','songListWrap','filterCard','sortFieldSelect','sortDirSelect',
    'languageChips','tagChips','langAllBtn','langNoneBtn','tagAllBtn','tagNoneBtn','countPresetRow','daysPresetRow','resetFiltersBtn','derivativeOnlyBtn','actionPanel','selectedSongName','selectedSongCutWrap',
    'copySongBtn','copyOrderTextBtn','clearSelectionBtn','historyYearSelect','historyMonthSelect',
    'historyDaySelect','historyPrevBtn','historyNextBtn','historyPageInfo','historyMetaText','historyListWrap','favoritesRefreshBtn',
    'favoritesUploadBtn','favUploadOverlay','favUploadName','favUploadCancel','favUploadOk',
    'favoritesLoadBtn','favLoadOverlay','favLoadName','favLoadCancel','favLoadOk',
    'favCurrentName',
    'thanksBtn','thanksOverlay','thanksCloseBtn',
    'favoritesExportFileBtn','favoritesImportFileBtn','favoritesImportFileInput',
    'favoritesClearBtn','favoritesMetaText','favoritesCountText','favoritesListWrap',
    'detailOverlay','detailModal','detailTitle','detailSub','detailBody','detailCloseBtn','toast','backTopBtn',
    'playerBar','playerPrevBtn','playerToggleBtn','playerNextBtn','playerSongName','playerSongArtist','playerSeek','playerTimeCur','playerTimeDur','playerShuffleBtn','playerFavBtn','playerVolume','playAllBtn','playShuffleBtn',
    'playerTimerWrap','playerTimerBtn','playerTimerPopover','playerTimerPopTitle','timerValH','timerValM','timerCancelBtn','timerStartBtn',
    'playlistPanel','playlistCountText','playlistClearBtn','playlistListWrap',
    'songlistPanel','songlistNewBtn','songlistBodyWrap',
    'songlistDialogOverlay','songlistNewName','songlistDialogCancel','songlistDialogOk',
    'songlistPickerOverlay','pickerSongName','pickerBody','pickerCloseBtn',
    'mobileFabs','songlistFab','playlistFab','mobileTimerFab'
  ].forEach(id => dom[id] = $(id));
}

function bindEvents() {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(item => item.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach(panel => panel.classList.remove('active'));
      btn.classList.add('active');
      $(`tab-${btn.dataset.tab}`).classList.add('active');
    });
  });

  dom.refreshBtn.addEventListener('click', async () => {
    await initRoom(true);
    showToast('已经重新刷新歌单数据');
  });

  document.querySelectorAll('.search-mode-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      state.searchMode = btn.dataset.mode;
      syncSearchModeButtons();
      applySongFilters();
    });
  });

  dom.searchInput.addEventListener('input', () => {
    syncClearButton();
    applySongFilters();
  });

  dom.clearSearchBtn.addEventListener('click', () => {
    dom.searchInput.value = '';
    syncClearButton();
    applySongFilters();
    dom.searchInput.focus();
  });

  dom.toggleFilterBtn.addEventListener('click', () => {
    state.filtersVisible = !state.filtersVisible;
    dom.filterCard.style.display = state.filtersVisible ? 'block' : 'none';
    syncFilterSummary();
  });

  dom.favoritesOnlyBtn.addEventListener('click', () => {
    state.favoritesOnly = !state.favoritesOnly;
    applySongFilters();
  });
  // 二创歌曲开关：勾选显示二创歌曲，不勾选默认隐藏
  dom.derivativeOnlyBtn.addEventListener('change', () => {
    state.songFilters.derivativeOnly = !!dom.derivativeOnlyBtn.checked;
    applySongFilters();
  });

  [dom.sortFieldSelect, dom.sortDirSelect].forEach(el => {
    el.addEventListener('change', applyFilterInputs);
  });

  dom.languageChips.addEventListener('click', event => {
    const btn = event.target.closest('[data-lang-chip]');
    if (!btn) return;
    const lang = btn.dataset.langChip;
    if (state.songFilters.languages.includes(lang)) {
      state.songFilters.languages = state.songFilters.languages.filter(item => item !== lang);
    } else {
      state.songFilters.languages = [...state.songFilters.languages, lang];
    }
    renderLanguageChips();
    applySongFilters();
  });

  dom.tagChips.addEventListener('click', event => {
    const btn = event.target.closest('[data-tag-chip]');
    if (!btn) return;
    const tag = btn.dataset.tagChip;
    if (state.songFilters.tags.includes(tag)) {
      state.songFilters.tags = state.songFilters.tags.filter(item => item !== tag);
    } else {
      state.songFilters.tags = [...state.songFilters.tags, tag];
    }
    renderTagChips();
    applySongFilters();
  });

  // 次数/天数预设（事件委托）
  dom.countPresetRow.addEventListener('click', event => {
    const btn = event.target.closest('.preset-btn');
    if (!btn) return;
    state.songFilters.countMin = btn.dataset.countMin === '' ? null : Number(btn.dataset.countMin);
    state.songFilters.countMax = btn.dataset.countMax === '' ? null : Number(btn.dataset.countMax);
    syncFilterInputs();
    syncPresetButtons();
    applySongFilters();
  });

  dom.daysPresetRow.addEventListener('click', event => {
    const btn = event.target.closest('.preset-btn');
    if (!btn) return;
    state.songFilters.daysMin = btn.dataset.daysMin === '' ? null : Number(btn.dataset.daysMin);
    state.songFilters.daysMax = btn.dataset.daysMax === '' ? null : Number(btn.dataset.daysMax);
    syncFilterInputs();
    syncPresetButtons();
    applySongFilters();
  });

  // 语言 全选/全不选 = 不过滤（与网站语义一致）
  dom.langAllBtn.addEventListener('click', () => setLanguageChipsAll(true));
  dom.langNoneBtn.addEventListener('click', () => setLanguageChipsAll(false));

  // 标签 全选 = 只看这些标签；全不选 = 不过滤
  dom.tagAllBtn.addEventListener('click', () => {
    state.songFilters.tags = getTopTags();
    renderTagChips();
    applySongFilters();
  });
  dom.tagNoneBtn.addEventListener('click', () => {
    state.songFilters.tags = [];
    renderTagChips();
    applySongFilters();
  });

  dom.resetFiltersBtn.addEventListener('click', resetSongFilters);

  dom.songListWrap.addEventListener('click', async event => {
    const songlistPickBtn = event.target.closest('[data-songlist-pick]');
    if (songlistPickBtn) {
      const song = state.filteredSongs.find(item => item.song_id === Number(songlistPickBtn.dataset.songlistPick));
      if (song) openSonglistPicker(song);
      return;
    }

    const playBtn = event.target.closest('[data-play-song]');
    if (playBtn) {
      const song = state.filteredSongs.find(item => item.song_id === Number(playBtn.dataset.playSong));
      if (song) addToPlaylist(song);
      return;
    }

    const favoriteBtn = event.target.closest('[data-favorite-key]');
    if (favoriteBtn) {
      const songEl = favoriteBtn.closest('.song-item');
      const songId = Number(songEl && songEl.dataset.songId);
      const song = state.filteredSongs.find(item => item.song_id === songId);
      if (song) await toggleFavoriteBySong(song);
      return;
    }

    const detailBtn = event.target.closest('[data-detail-song]');
    if (detailBtn) {
      await loadSongDetail(detailBtn.dataset.detailSong, detailBtn.dataset.detailLabel, detailBtn.dataset.detailCount);
      return;
    }

    const cutLinkAnchor = event.target.closest('[data-song-cut-link]');
    if (cutLinkAnchor) {
      return;
    }

    const songEl = event.target.closest('.song-item');
    if (!songEl) return;
    const song = state.filteredSongs.find(item => item.song_id === Number(songEl.dataset.songId));
    // 点击歌曲卡片：复制「点歌 …」到剪贴板，不直接播放；播放请点卡片上的 ▶ 按钮
    if (song) await copyOrderTextOf(song, true);
  });

  dom.copySongBtn.addEventListener('click', doCopySong);
  dom.copyOrderTextBtn.addEventListener('click', doCopyOrderText);
  dom.clearSelectionBtn.addEventListener('click', () => deselectSong(false));

  // ===== 音频播放器事件 =====
  dom.playAllBtn.addEventListener('click', () => {
    player.playMode = 'list';
    playAllSongs();
  });
  dom.playShuffleBtn.addEventListener('click', playShuffleAll);
  dom.playerPrevBtn.addEventListener('click', playPrev);
  dom.playerToggleBtn.addEventListener('click', togglePlay);
  dom.playerNextBtn.addEventListener('click', () => playNext(false));
  dom.playerShuffleBtn.addEventListener('click', () => {
    // 播放模式轮切：歌单循环 → 随机播放 → 单曲循环 → 歌单循环
    const order = PLAY_MODES.map(m => m.key);
    const idx = order.indexOf(player.playMode);
    player.playMode = order[(idx + 1) % order.length];
    const mode = PLAY_MODE_MAP[player.playMode];
    updatePlayerUI();
    showToast(`播放模式：${mode.label}（${mode.desc}）`);
  });

  // 播放栏收藏按钮：把当前播放的歌加入/移出中意清单
  dom.playerFavBtn.addEventListener('click', async () => {
    const cur = player.current;
    if (!cur) return;
    await toggleFavoriteBySong(cur);
    updatePlayerFavState();
  });

  // ===== 睡眠定时（月亮图标）=====
  function adjustTimerValue(part, delta) {
    if (part === 'h') {
      timerState.pickerH = Math.max(0, Math.min(23, timerState.pickerH + delta));
      dom.timerValH.textContent = String(timerState.pickerH);
    } else {
      // 分钟：0-59 循环
      timerState.pickerM = ((timerState.pickerM + delta) % 60 + 60) % 60;
      dom.timerValM.textContent = String(timerState.pickerM);
    }
  }

  // 点击月亮图标：未打开则打开；已打开则确定（0:0 即关闭计时）
  dom.playerTimerBtn.addEventListener('click', () => {
    if (dom.playerTimerPopover.classList.contains('show')) {
      confirmTimerPopover();
    } else {
      openTimerPopover();
    }
  });

  // 上下箭头调整
  document.querySelectorAll('[data-timer-arrow]').forEach(btn => {
    btn.addEventListener('click', () => {
      const part = btn.dataset.timerArrow;
      const dir = Number(btn.dataset.dir);
      adjustTimerValue(part, dir);
    });
  });

  // 拖动数字调整（指针事件，上下拖动改值）
  let dragTimerPart = null;
  let dragTimerStartY = 0;
  let dragTimerAccum = 0;
  [dom.timerValH, dom.timerValM].forEach(el => {
    el.addEventListener('pointerdown', e => {
      dragTimerPart = el.dataset.timerValue;
      dragTimerStartY = e.clientY;
      dragTimerAccum = 0;
      el.setPointerCapture(e.pointerId);
    });
    el.addEventListener('pointermove', e => {
      if (!dragTimerPart) return;
      const deltaY = dragTimerStartY - e.clientY;
      dragTimerStartY = e.clientY;
      dragTimerAccum += deltaY;
      // 每 12px 触发一次调整，避免抖动
      while (Math.abs(dragTimerAccum) >= 12) {
        const step = dragTimerAccum > 0 ? 1 : -1;
        adjustTimerValue(dragTimerPart, step);
        dragTimerAccum -= step * 12;
      }
    });
    el.addEventListener('pointerup', () => { dragTimerPart = null; });
    el.addEventListener('pointercancel', () => { dragTimerPart = null; });
  });

  dom.timerCancelBtn.addEventListener('click', () => {
    closeTimerPopover();
  });

  dom.timerStartBtn.addEventListener('click', () => {
    confirmTimerPopover();
  });

  // 点击空白处关闭弹层（不影响正在进行的倒计时）。
  // 注意：点击月亮按钮本身（播放器栏或手机悬浮列）不算"空白处"，
  // 否则 pointerdown 先关、click 再开，会出现"闪关再开"。
  document.addEventListener('pointerdown', e => {
    if (!dom.playerTimerPopover.classList.contains('show')) return;
    const insideTimer = dom.playerTimerWrap.contains(e.target);
    const insideFab = dom.mobileFabs && dom.mobileFabs.contains(e.target);
    if (!insideTimer && !insideFab) {
      closeTimerPopover();
    }
  });
  // 进度条：拖动中不预览也不跳转，松开（change）后直接跳到对应进度
  dom.playerSeek.addEventListener('pointerdown', () => { seekDragging = true; });
  dom.playerSeek.addEventListener('change', () => {
    seekDragging = false;
    const dur = player.audio.duration;
    if (!Number.isFinite(dur) || dur <= 0) return;
    const t = Number(dom.playerSeek.value);
    if (Number.isFinite(t) && t >= 0) {
      player.audio.currentTime = Math.min(t, dur);
    }
  });
  // 在滑块外松开时也重置拖动状态，避免 timeupdate 一直不更新滑块
  document.addEventListener('pointerup', () => { seekDragging = false; });
  dom.playerVolume.addEventListener('input', () => {
    player.volume = Number(dom.playerVolume.value) / 100;
    player.audio.volume = player.volume;
  });

  // ===== 播放列表事件 =====
  dom.playlistClearBtn.addEventListener('click', () => {
    if (state.playlist.length) {
      clearPlaylist();
      showToast('播放列表已清空');
    }
  });
  dom.playlistListWrap.addEventListener('click', event => {
    const removeBtn = event.target.closest('[data-playlist-remove]');
    if (removeBtn) {
      removeFromPlaylist(Number(removeBtn.dataset.playlistRemove));
      return;
    }
    const copyBtn = event.target.closest('[data-playlist-copy]');
    if (copyBtn) {
      const item = state.playlist[Number(copyBtn.dataset.playlistCopy)];
      if (item) {
        copyToClipboard(item.display_song_name || item.song_name || '');
        showToast('已复制歌名');
      }
      return;
    }
    const row = event.target.closest('[data-playlist-index]');
    if (row) {
      const idx = Number(row.dataset.playlistIndex);
      const item = state.playlist[idx];
      const cur = player.current;
      // 点击正在播放的这首：暂停 / 继续（按歌曲身份判断，不依赖队列引用/索引）
      if (cur && item && player.index >= 0 && String(cur.song_id) === String(item.song_id)) {
        if (player.audio.paused) {
          player.audio.play().catch(() => {});
        } else {
          player.audio.pause();
        }
        updatePlayerUI();
      } else {
        player.queue = state.playlist;
        playSongAt(idx);
      }
      return;
    }
  });

  // ===== 歌单系统事件 =====
  dom.songlistNewBtn.addEventListener('click', () => {
    dom.songlistNewName.value = '';
    dom.songlistDialogOverlay.classList.add('show');
    dom.songlistNewName.focus();
  });
  dom.songlistDialogCancel.addEventListener('click', () => dom.songlistDialogOverlay.classList.remove('show'));
  dom.songlistDialogOk.addEventListener('click', confirmCreateSonglist);
  dom.songlistDialogOverlay.addEventListener('click', event => {
    if (event.target === dom.songlistDialogOverlay) dom.songlistDialogOverlay.classList.remove('show');
  });
  dom.songlistNewName.addEventListener('keydown', event => {
    if (event.key === 'Enter') confirmCreateSonglist();
    if (event.key === 'Escape') dom.songlistDialogOverlay.classList.remove('show');
  });

  dom.songlistBodyWrap.addEventListener('click', async event => {
    const listPlay = event.target.closest('[data-songlist-playlist-play]');
    if (listPlay) {
      playSonglist(listPlay.dataset.songlistPlaylistPlay);
      return;
    }
    const detailPlay = event.target.closest('[data-songlist-detail-play]');
    if (detailPlay) {
      playSonglist(detailPlay.dataset.songlistDetailPlay);
      return;
    }
    const del = event.target.closest('[data-songlist-del]');
    if (del) {
      const id = del.dataset.songlistDel;
      const list = state.songlists.find(l => l.id === id);
      if (list && confirm(`删除歌单「${list.name}」？`)) {
        deleteSonglist(id);
        renderSonglistPanel();
        showToast('歌单已删除');
      }
      return;
    }
    const open = event.target.closest('[data-songlist-open]');
    if (open) {
      state.songlistView = { type: 'detail', id: open.dataset.songlistOpen };
      renderSonglistPanel();
      return;
    }
    const back = event.target.closest('#songlistBackBtn');
    if (back) {
      state.songlistView = { type: 'list' };
      renderSonglistPanel();
      return;
    }
    const play = event.target.closest('[data-songlist-play]');
    if (play) {
      const song = findSongByFavoriteKey(play.dataset.songlistPlay);
      if (song) addToPlaylist(song);
      return;
    }
    const copy = event.target.closest('[data-songlist-copy]');
    if (copy) {
      const song = findSongByFavoriteKey(copy.dataset.songlistCopy);
      if (song) {
        copyToClipboard(song.display_song_name || song.song_name || '');
        showToast('已复制歌名');
      }
      return;
    }
    const remove = event.target.closest('[data-songlist-remove]');
    if (remove) {
      const list = getAllSonglists().find(l => l.id === state.songlistView.id);
      const song = findSongByFavoriteKey(remove.dataset.songlistRemove);
      if (list && song) await toggleSongInSonglist(song, list);
      renderSonglistPanel();
      renderSongs();
    }
  });

  dom.pickerBody.addEventListener('click', event => {
    const item = event.target.closest('[data-picker-list]');
    if (item) togglePickerList(item.dataset.pickerList);
  });
  dom.pickerCloseBtn.addEventListener('click', closeSonglistPicker);
  dom.songlistPickerOverlay.addEventListener('click', event => {
    if (event.target === dom.songlistPickerOverlay) closeSonglistPicker();
  });

  // 切换日期后直接加载对应日期的歌曲，无需再点"查看"
  dom.historyYearSelect.addEventListener('change', () => {
    fillHistoryMonthSelector();
    fillHistoryDaySelector();
    loadHistoryPage(1);
  });
  dom.historyMonthSelect.addEventListener('change', () => {
    fillHistoryDaySelector();
    loadHistoryPage(1);
  });
  dom.historyDaySelect.addEventListener('change', () => loadHistoryPage(1));
  dom.historyPrevBtn.addEventListener('click', () => loadHistoryPage(Math.max(1, state.historyPage - 1)));
  dom.historyNextBtn.addEventListener('click', () => loadHistoryPage(Math.min(state.historyTotalPages, state.historyPage + 1)));

  dom.historyListWrap.addEventListener('click', async event => {
    const btn = event.target.closest('[data-history-copy]');
    if (!btn) return;
    const entry = state.historyEntries[Number(btn.dataset.historyCopy)];
    if (!entry || !entry.song_name) return;
    await copyToClipboard(entry.song_name);
    showToast(`已复制歌名：${entry.song_name}`);
  });

  dom.favoritesRefreshBtn.addEventListener('click', refreshFavoritesFromServer);
  dom.favoritesUploadBtn.addEventListener('click', openFavUpload);
  dom.favUploadCancel.addEventListener('click', closeFavUpload);
  dom.favUploadOk.addEventListener('click', submitFavUpload);
  dom.favoritesLoadBtn.addEventListener('click', openFavLoad);
  dom.favLoadCancel.addEventListener('click', closeFavLoad);
  dom.favLoadOk.addEventListener('click', submitFavLoad);
  dom.favoritesExportFileBtn.addEventListener('click', exportFavoritesToFile);
  dom.favoritesImportFileBtn.addEventListener('click', () => dom.favoritesImportFileInput.click());
  dom.favoritesImportFileInput.addEventListener('change', handleFavoritesFileImport);
  dom.favoritesClearBtn.addEventListener('click', clearFavorites);
  dom.thanksBtn.addEventListener('click', () => dom.thanksOverlay.classList.add('show'));
  dom.thanksCloseBtn.addEventListener('click', () => dom.thanksOverlay.classList.remove('show'));
  dom.thanksOverlay.addEventListener('click', event => { if (event.target === dom.thanksOverlay) dom.thanksOverlay.classList.remove('show'); });

  dom.favoritesListWrap.addEventListener('click', async event => {
    const removeBtn = event.target.closest('[data-favorite-remove-key]');
    if (removeBtn) {
      const key = removeBtn.dataset.favoriteRemoveKey;
      if (key && state.favoritesMap[key]) {
        delete state.favoritesMap[key];
        await saveFavorites();
        hydrateFavoriteList();
        applySongFilters();
      }
      return;
    }

    const copyBtn = event.target.closest('[data-favorite-copy-key]');
    if (copyBtn) {
      const key = copyBtn.dataset.favoriteCopyKey;
      const snapshot = state.favoriteList.find(item => item.key === key);
      if (!snapshot) return;
      await copyToClipboard(snapshot.display_song_name || snapshot.song_name || '');
      showToast('已复制歌名');
    }
  });

  dom.detailOverlay.addEventListener('click', closeDetailModal);
  dom.detailCloseBtn.addEventListener('click', closeDetailModal);
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') closeDetailModal();
  });

  // ===== 回到顶部：滚动超过一屏高度后显示，点击平滑回顶 =====
  const BACK_TOP_THRESHOLD = 480;
  const updateBackTop = () => {
    const y = window.scrollY || document.documentElement.scrollTop || 0;
    dom.backTopBtn.classList.toggle('show', y > BACK_TOP_THRESHOLD);
  };
  window.addEventListener('scroll', updateBackTop, { passive: true });
  updateBackTop();
  dom.backTopBtn.addEventListener('click', () => {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
}

async function init() {
  bindDom();
  bindEvents();
  syncClearButton();
  syncSearchModeButtons();
  syncFilterInputs();
  initPanelDrag(dom.playlistPanel);
  initPanelDrag(dom.songlistPanel);
  initMobileFabs();

  await loadGlobalSettings();
  loadDerivativeSongs(); // 加载本地二创歌曲（勾选"只看二创"时显示）
  // 音频索引与歌曲/历史数据并行加载，缩短首屏等待
  const audioIndexPromise = loadAudioIndex();
  await initRoom(false);
  loadPlaylist();
  renderPlaylist();
  loadSonglists();
  renderSonglistPanel();
  await audioIndexPromise;
}

init().catch(error => {
  console.error('[歌单网页] 初始化失败:', error);
  if (!dom.headerStatus) return;
  setHeaderStatus('初始化失败', 'err');
  showToast(`初始化失败：${error.message}`);
});
