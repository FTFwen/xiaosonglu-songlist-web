const ROOM_CONFIGS = {
  miting: {
    key: 'miting',
    roomId: '31368705',
    name: '米汀',
    title: '米汀歌单',
    subtitle: 'song.nagisa.live 临时网页歌单',
    orderPrefix: '点歌 ',
    sourceType: 'song-nagisa-live',
    sourceLabel: 'song.nagisa.live',
    songPageUrl: 'https://song.nagisa.live/song_all_readonly',
    historyPageUrl: 'https://song.nagisa.live/history',
    detailApiBase: 'https://song.nagisa.live/songs_count',
    supportsHistory: true,
    supportsFavorites: true,
    supportsRemoteDetails: true,
    placeholder: false,
    notes: '支持歌曲总览、历史每日歌曲、中意清单和演唱详情。'
  },
  xiaosonglu: {
    key: 'xiaosonglu',
    roomId: '1727071052',
    name: '小松绿',
    title: '小松绿歌单',
    subtitle: '小松绿唱过的歌都在这里',
    orderPrefix: '点歌 ',
    sourceType: 'local-json',
    sourceLabel: '小松绿直播回放识歌（本地数据）',
    songDataUrl: 'data/xiaosonglu/song_catalog.json',
    historyDataUrl: 'data/xiaosonglu/history_index.json',
    detailDataUrl: 'data/xiaosonglu/song_details.json',
    audioIndexDataUrl: 'data/xiaosonglu/audio_index.json',
    cutInfoDataUrl: 'data/xiaosonglu/song_cut_info.json',
    historyPageSize: 30,
    supportsHistory: true,
    supportsFavorites: true,
    supportsRemoteDetails: false,
    placeholder: false,
    notes: '通过小松绿 B 站直播回放识别唱歌片段，聚合为本地歌单与历史数据。'
  }
};

const ROOM_ORDER = ['miting', 'xiaosonglu'];
const SUPPORTED_ROOM_IDS = ROOM_ORDER.map(key => ROOM_CONFIGS[key].roomId);
const BILIBILI_ROOM_RE = /^https:\/\/live\.bilibili\.com\/(\d+)/i;

// Keep legacy/localStorage data on the same language tag vocabulary as the
// generated ledger. Delimiters are preserved for composite labels.
const LANGUAGE_TAG_ALIASES = Object.freeze({ '日语': '日文' });
const LANGUAGE_SEPARATOR_RE = /([、,，/／|｜])/u;
function normalizeLanguageTag(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  return text.split(LANGUAGE_SEPARATOR_RE).map(part => {
    if (LANGUAGE_SEPARATOR_RE.test(part)) return part;
    const token = part.trim();
    return LANGUAGE_TAG_ALIASES[token] || token;
  }).join('');
}

// Keep legacy/localStorage type labels deduplicated without guessing broad
// categories. Ambiguous labels such as “虚拟歌手” must be resolved during review.
const TYPE_TAG_ALIASES = Object.freeze({});
const TYPE_TAG_SEPARATOR_RE = /[、,，/／|｜]/u;
function normalizeTypeTags(value) {
  const values = Array.isArray(value) ? value : [value];
  const seen = new Set();
  return values
    .flatMap(item => String(item ?? '').split(TYPE_TAG_SEPARATOR_RE))
    .map(item => TYPE_TAG_ALIASES[item.trim()] || item.trim())
    .filter(item => item && !seen.has(item) && seen.add(item))
    .join('、');
}

function getRoomConfig(roomKey) {
  return ROOM_CONFIGS[roomKey] || ROOM_CONFIGS.miting;
}

function getRoomKeyById(roomId) {
  const id = String(roomId || '').trim();
  return ROOM_ORDER.find(key => ROOM_CONFIGS[key].roomId === id) || null;
}

function detectRoomFromUrl(url) {
  const text = String(url || '');
  const match = text.match(BILIBILI_ROOM_RE);
  if (!match) {
    return { roomKey: null, roomId: null, supported: false };
  }
  const roomId = match[1];
  const roomKey = getRoomKeyById(roomId);
  return {
    roomKey,
    roomId,
    supported: !!roomKey
  };
}

function getStorageKeys(roomKey) {
  const key = roomKey || 'default';
  return {
    songCache: `songCache:${key}`,
    songCacheTime: `songCacheTime:${key}`,
    favorites: `favorites:${key}`,
    callwords: `callwords:${key}`,
    historyCache: `historyCache:${key}`,
    historyCacheTime: `historyCacheTime:${key}`,
    bubblePosition: `bubblePosition:${key}`,
    settings: 'settings:global'
  };
}

function normalizeRoomSong(raw, index) {
  const songId = raw.song_id != null && raw.song_id !== '' ? Number(raw.song_id) : index + 1;
  return {
    song_id: Number.isFinite(songId) ? songId : index + 1,
    song_name: raw.song_name || raw.display_song_name || raw.row_key || '',
    display_song_name: raw.display_song_name || raw.song_name || raw.row_key || '',
    artist: raw.artist || '',
    artist_search: raw.artist_search || '',
    feat_artist: raw.feat_artist || '',
    remark: raw.remark || '',
    tone: raw.tone === undefined ? '' : raw.tone,
    language: normalizeLanguageTag(raw.language || ''),
    type: normalizeTypeTags(raw.type || ''),
    identification: raw.identification || '',
    display_version: raw.display_version || '',
    search_name: raw.search_name || '',
    cut_link: raw.cut_link || '',
    sing_count: raw.sing_count == null || raw.sing_count === '' ? 0 : Number(raw.sing_count),
    status_labels: raw.status_labels || '',
    last_sing_at: raw.last_sing_at || '',
    row_key: raw.row_key || raw.song_name || raw.display_song_name || String(songId)
  };
}

function getFavoriteKey(song) {
  if (!song) return '';
  // 中意存档跨直播间通用：用「歌名」做全局键（同一首歌在不同房间的 song_id 不同）
  const name = String(song.display_song_name || song.song_name || song.row_key || '').trim();
  return name ? `name:${name}` : '';
}

function isLockedSong(song) {
  const identification = String(song && song.identification || '').trim();
  const type = String(song && song.type || '').trim();
  return identification === '锁定' || type === '锁定';
}

function isBannedSong(song) {
  const identification = String(song && song.identification || '').trim();
  const type = String(song && song.type || '').trim();
  return identification === '禁曲' || type === '禁曲';
}

function canFavoriteSong(song) {
  return !!getFavoriteKey(song) && !isLockedSong(song) && !isBannedSong(song);
}
