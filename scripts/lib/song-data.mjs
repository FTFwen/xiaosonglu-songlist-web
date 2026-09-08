import { createHash } from 'node:crypto';

export const ROOM_KEY = 'xiaosonglu';
export const ROOM_ID = '1727071052';

const CATALOG_FIELDS = [
  'song_name', 'show_as_song_name', 'display_song_name', 'artist', 'artist_search',
  'feat_artist', 'remark', 'tone', 'language', 'type', 'identification',
  'display_version', 'search_name', 'cut_link',
];

export function normalizeSongName(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .trim()
    .replace(/\s+/g, ' ')
    .toLocaleLowerCase('und');
}

export function performanceKey(date, songName) {
  return `${String(date ?? '').trim()}::${normalizeSongName(songName)}`;
}

export function splitStatuses(value) {
  if (Array.isArray(value)) return value.map(item => String(item).trim()).filter(Boolean);
  return String(value ?? '').split(/[、,，]/u).map(item => item.trim()).filter(Boolean);
}

function uniqueInOrder(values) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

function requireArray(value, name) {
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`);
  return value;
}

export function validateSegments(segments) {
  const errors = [];
  const keys = new Map();
  requireArray(segments, 'segments').forEach((segment, index) => {
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(String(segment.replay_date ?? ''))) errors.push(`segments[${index}] has invalid replay_date`);
    if (!normalizeSongName(segment.song_name)) errors.push(`segments[${index}] has no song_name`);
    const key = performanceKey(segment.replay_date, segment.song_name);
    if (keys.has(key)) errors.push(`duplicate performance ${segment.replay_date}::${segment.song_name} at indexes ${keys.get(key)} and ${index}`);
    else keys.set(key, index);
  });
  return errors;
}

export function validateCuts(items) {
  const errors = [];
  const primaryKeys = new Map();
  requireArray(items, 'song-cut items').forEach((item, index) => {
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(String(item.clip_date ?? ''))) errors.push(`items[${index}] has invalid clip_date`);
    if (!normalizeSongName(item.song_name)) errors.push(`items[${index}] has no song_name`);
    const expected = `${item.clip_date}::${item.song_name}`;
    if (item.duplicate_key !== expected) errors.push(`items[${index}] duplicate_key must be ${expected}`);
    if ((item.duplicate_status ?? 'primary') === 'primary') {
      const key = performanceKey(item.clip_date, item.song_name);
      if (primaryKeys.has(key)) errors.push(`multiple primary cuts for ${item.clip_date}::${item.song_name}`);
      else primaryKeys.set(key, index);
    }
  });
  return errors;
}

function groupSegments(segments) {
  const groups = new Map();
  for (const segment of segments) {
    const key = normalizeSongName(segment.row_key || segment.song_name);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(segment);
  }
  return groups;
}

function overrideFor(overrides, base) {
  const table = overrides?.bySongName ?? {};
  return table[base.song_name] ?? table[base.row_key] ?? {};
}

function buildCatalog(segments, overrides, currentCatalog) {
  const groups = groupSegments(segments);
  const currentSongs = Array.isArray(currentCatalog?.songs) ? currentCatalog.songs : [];
  const ids = new Map(currentSongs.map(song => [normalizeSongName(song.row_key || song.song_name), Number(song.song_id)]));
  const previousOrder = new Map(currentSongs.map((song, index) => [normalizeSongName(song.row_key || song.song_name), index]));
  let nextId = Math.max(0, ...ids.values().filter(Number.isFinite)) + 1;
  const songs = [];

  for (const [normalizedKey, performances] of groups) {
    const base = performances[0];
    const override = overrideFor(overrides, base);
    const row = { song_id: ids.get(normalizedKey) ?? nextId++ };
    for (const field of CATALOG_FIELDS) row[field] = base[field] ?? '';
    row.song_name = override.song_name ?? row.song_name;
    row.show_as_song_name = override.show_as_song_name ?? row.show_as_song_name ?? '';
    row.display_song_name = override.display_song_name ?? row.display_song_name ?? row.song_name;
    row.artist = override.artist ?? row.artist ?? '';
    row.artist_search = override.artist_search ?? row.artist_search ?? row.artist;
    row.feat_artist = override.feat_artist ?? row.feat_artist ?? '';
    row.remark = override.remark ?? row.remark ?? '';
    row.tone = override.tone ?? row.tone ?? '';
    row.language = override.language ?? row.language ?? '';
    row.type = override.type ?? (Array.isArray(override.type_tags) ? override.type_tags.join('、') : row.type ?? '');
    row.identification = override.identification ?? row.identification ?? '';
    row.display_version = override.display_version ?? row.display_version ?? '';
    row.search_name = override.search_name ?? row.search_name ?? '';
    row.cut_link = override.cut_link ?? row.cut_link ?? '';
    row.sing_count = performances.length;
    row.status_labels = uniqueInOrder(performances.flatMap(item => splitStatuses(item.status_labels))).join('、');
    row.last_sing_at = performances.map(item => item.replay_date).filter(Boolean).sort().at(-1) ?? '';
    row.row_key = override.row_key ?? base.row_key ?? row.song_name;
    Object.defineProperty(row, '__previousOrder', { value: previousOrder.get(normalizedKey) ?? Number.MAX_SAFE_INTEGER, enumerable: false });
    songs.push(row);
  }

  songs.sort((left, right) =>
    right.sing_count - left.sing_count ||
    left.__previousOrder - right.__previousOrder ||
    left.song_name.localeCompare(right.song_name, 'zh-CN'),
  );
  return songs;
}

function historyEntry(segment) {
  return {
    song_name: segment.display_song_name || segment.song_name || '',
    sing_time: segment.start_time ?? '',
    statuses: splitStatuses(segment.status_labels),
    artist: segment.artist ?? '',
    replay_id: segment.replay_id ?? '',
    replay_title: segment.replay_title ?? '',
    replay_url: segment.replay_url ?? '',
    start_time: segment.start_time ?? '',
    end_time: segment.end_time ?? '',
    row_key: segment.row_key ?? segment.song_name ?? '',
    lyric_excerpt: segment.lyric_excerpt ?? '',
    song_resolution_method: segment.song_resolution_method ?? '',
    cut_link: segment.cut_link ?? '',
  };
}

function buildHistory(segments) {
  const byDate = {};
  const sortedDates = uniqueInOrder(segments.map(segment => segment.replay_date)).sort();
  for (const date of sortedDates) {
    byDate[date] = segments
      .filter(segment => segment.replay_date === date)
      .sort((left, right) => {
        const leftTime = String(left.start_time ?? '');
        const rightTime = String(right.start_time ?? '');
        if (!leftTime && rightTime) return -1;
        if (leftTime && !rightTime) return 1;
        return leftTime.localeCompare(rightTime) || Number(left.segment_index ?? 0) - Number(right.segment_index ?? 0);
      })
      .map(historyEntry);
  }
  const latestDate = sortedDates.at(-1) ?? '';
  const [year = '', month = '', day = ''] = latestDate.split('-');
  const dateTree = {};
  for (const date of [...sortedDates].reverse()) {
    const [entryYear, entryMonth, entryDay] = date.split('-');
    dateTree[entryYear] ??= {};
    dateTree[entryYear][entryMonth] ??= {};
    dateTree[entryYear][entryMonth][entryDay] = byDate[date].length;
  }
  return { latest: { year, month, day }, dateTree, byDate };
}

function detailEntry(segment) {
  return {
    date: segment.replay_date ?? '',
    time: segment.start_time ?? '',
    end_time: segment.end_time ?? '',
    status: splitStatuses(segment.status_labels).join('、'),
    artist: segment.artist ?? '',
    replay_id: segment.replay_id ?? '',
    replay_title: segment.replay_title ?? '',
    replay_url: segment.replay_url ?? '',
    remark: segment.remark ?? '',
    lyric_excerpt: segment.lyric_excerpt ?? '',
    song_resolution_method: segment.song_resolution_method ?? '',
    replay_date_source: segment.replay_date_source ?? '',
    cut_link: segment.cut_link ?? '',
  };
}

function buildDetails(segments, overrides) {
  const bySongKey = {};
  for (const performances of groupSegments(segments).values()) {
    const base = performances[0];
    const override = overrideFor(overrides, base);
    const rowKey = override.row_key ?? base.row_key ?? base.song_name;
    const ordered = [...performances].sort((left, right) =>
      String(right.replay_date ?? '').localeCompare(String(left.replay_date ?? '')) ||
      Number(right.segment_index ?? 0) - Number(left.segment_index ?? 0),
    );
    bySongKey[rowKey] = {
      row_key: rowKey,
      song_name: override.song_name ?? base.song_name ?? '',
      display_song_name: override.display_song_name ?? base.display_song_name ?? base.song_name ?? '',
      artist: override.artist ?? base.artist ?? '',
      cut_link: override.cut_link ?? base.cut_link ?? '',
      total_count: ordered.length,
      entries: ordered.map(detailEntry),
    };
  }
  return bySongKey;
}

function cutScore(item) {
  const kind = item.clip_kind === 'single' ? 30 : item.clip_kind === 'collection-chapter' ? 20 : 10;
  const primary = item.duplicate_status === 'primary' ? 12 : item.duplicate_status === 'secondary' ? 3 : 0;
  const title = item.chapter_title || item.clip_title || '';
  const titleMatch = normalizeSongName(title).includes(normalizeSongName(item.song_name)) ? 5 : 0;
  return kind + primary + titleMatch;
}

function buildCutInfo(items, currentCutInfo) {
  const groups = new Map();
  for (const item of items) {
    if (!item.clip_url || item.duplicate_status === 'duplicate') continue;
    const key = normalizeSongName(item.song_name);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  const cuts = { ...(currentCutInfo?.cuts ?? {}) };
  const known = new Set(Object.keys(cuts).map(normalizeSongName));
  for (const group of groups.values()) {
    const best = [...group].sort((left, right) =>
      cutScore(right) - cutScore(left) ||
      String(right.clip_date ?? '').localeCompare(String(left.clip_date ?? '')) ||
      items.indexOf(right) - items.indexOf(left),
    )[0];
    const normalized = normalizeSongName(best.song_name);
    if (known.has(normalized)) continue;
    cuts[best.song_name] = {
      title: best.chapter_title || best.clip_title || best.song_name,
      kind: best.clip_kind || 'single',
      url: best.clip_url,
    };
    known.add(normalized);
  }
  return cuts;
}

export function buildDerivedData({ segmentsDocument, cutsDocument, overridesDocument, currentCatalog, currentCutInfo }) {
  const segments = requireArray(segmentsDocument?.segments, 'segmentsDocument.segments');
  const items = requireArray(cutsDocument?.items, 'cutsDocument.items');
  const errors = [...validateSegments(segments), ...validateCuts(items)];
  if (errors.length) throw new Error(`Source validation failed:\n- ${errors.join('\n- ')}`);
  const generatedAt = segmentsDocument.updatedAt ?? new Date(0).toISOString();
  const cutGeneratedAt = [
    cutsDocument.updatedAt,
    currentCutInfo?.generatedAt,
    ...items.map(item => item.collected_at),
  ].filter(Boolean).sort().at(-1) ?? generatedAt;
  const catalog = buildCatalog(segments, overridesDocument, currentCatalog);
  const history = buildHistory(segments);
  const details = buildDetails(segments, overridesDocument);
  const cutInfo = buildCutInfo(items, currentCutInfo);
  return {
    song_catalog: { roomKey: ROOM_KEY, roomId: ROOM_ID, generatedAt, source: 'local-replay-ingestion', songs: catalog },
    history_index: { roomKey: ROOM_KEY, roomId: ROOM_ID, generatedAt, source: 'local-replay-ingestion', ...history },
    song_details: { roomKey: ROOM_KEY, roomId: ROOM_ID, generatedAt, source: 'local-replay-ingestion', bySongKey: details },
    song_cut_info: {
      roomKey: ROOM_KEY,
      roomId: ROOM_ID,
      generatedAt: cutGeneratedAt,
      source: 'song-cut-title-index',
      description: '每首歌对应的歌切切片标题（单曲歌切视频标题 / 合集分P标题），供前端歌切链接显示。',
      count: Object.keys(cutInfo).length,
      cuts: cutInfo,
    },
  };
}

function csvCell(value) {
  const text = Array.isArray(value) ? value.join('、') : String(value ?? '');
  return /[",\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export const CUT_CSV_COLUMNS = [
  'clip_date', 'date_source', 'date_text', 'song_name', 'song_name_source', 'artist',
  'clip_kind', 'chapter_title', 'clip_title', 'clip_url', 'clip_bvid', 'uploader',
  'duration', 'source_query', 'duplicate_key', 'duplicate_status', 'duplicate_of',
  'collected_at', 'notes',
];

function parseCsv(text) {
  if (!text) return [];
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') { cell += '"'; index += 1; }
      else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') { row.push(cell); cell = ''; }
    else if (char === '\n') {
      row.push(cell.replace(/\r$/u, ''));
      rows.push(row);
      row = [];
      cell = '';
    } else cell += char;
  }
  if (cell || row.length) { row.push(cell.replace(/\r$/u, '')); rows.push(row); }
  const [header = [], ...values] = rows;
  return values.filter(value => value.some(Boolean)).map(value => Object.fromEntries(header.map((key, index) => [key, value[index] ?? ''])));
}

export function buildCutCsv(items, existingCsv = '') {
  const existing = new Map(parseCsv(existingCsv).map(row => [`${row.clip_date}\u0000${row.song_name}\u0000${row.clip_url}`, row]));
  const enriched = items.map(item => {
    const old = existing.get(`${item.clip_date}\u0000${item.song_name}\u0000${item.clip_url}`);
    if (!old || String(old.notes ?? '').length <= String(item.notes ?? '').length) return item;
    return { ...item, notes: old.notes };
  });
  const ordered = enriched
    .map((item, index) => ({ item, index }))
    .sort((left, right) =>
      String(right.item.clip_date ?? '').localeCompare(String(left.item.clip_date ?? '')) ||
      String(left.item.song_name ?? '').localeCompare(String(right.item.song_name ?? ''), 'zh-CN') ||
      String(left.item.clip_url ?? '').localeCompare(String(right.item.clip_url ?? ''), 'zh-CN') ||
      left.index - right.index,
    )
    .map(({ item }) => item);
  return `${[CUT_CSV_COLUMNS.join(','), ...ordered.map(item => CUT_CSV_COLUMNS.map(column => csvCell(item[column])).join(','))].join('\r\n')}\r\n`;
}

export function buildEmbeddedData(data, audioIndex) {
  const values = { ...data, audio_index: audioIndex };
  const orderedKeys = ['song_catalog', 'history_index', 'song_details', 'audio_index', 'song_cut_info'];
  const stamp = [data.song_catalog.generatedAt, audioIndex?.generatedAt, data.song_cut_info.generatedAt].filter(Boolean).sort().at(-1);
  const humanStamp = stamp ? new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Hong_Kong', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(new Date(stamp)) : '';
  // Keep the historic layout: the property itself is indented, while JSON.stringify owns nested indentation.
  const body = orderedKeys.map(key => `  ${key}: ${JSON.stringify(values[key], null, 2)}`).join(',\n');
  return `// 本文件由 scripts/build_xiaosonglu_song_data.mjs 从 data/xiaosonglu/ 生成，供 file:// 离线回退使用。\n// 生成时间：${humanStamp}\n// 数据源：data/xiaosonglu/（song_catalog / history_index / song_details / audio_index / song_cut_info）\nwindow.XSL_DATA = {\n${body}\n};\n`;
}

export function contentHash(value) {
  return createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
}

export function makeSegment(batch, song, index) {
  const live = batch.live ?? {};
  const songName = String(song.songName ?? song.song_name ?? '').trim();
  if (!songName) throw new Error(`songs[${index}] has no songName`);
  const date = String(live.date ?? song.replay_date ?? '').trim();
  const replayId = String(live.replayId ?? live.replay_id ?? `live:${live.liveId ?? ''}`);
  const replayTitle = String(live.replayTitle ?? live.replay_title ?? `【小松绿Viridis】${live.title ?? ''} ${date}`.trim());
  const replayUrl = String(live.replayUrl ?? live.replay_url ?? '');
  const statuses = splitStatuses(song.statusLabels ?? song.status_labels ?? ['自动识别待人工复核']);
  return {
    replay_id: replayId,
    replay_title: replayTitle,
    replay_url: replayUrl,
    replay_date: date,
    replay_date_source: live.replayDateSource ?? live.replay_date_source ?? 'live-api-date',
    segment_index: Number(song.segmentIndex ?? song.segment_index ?? index + 1),
    start_time: song.startTime ?? song.start_time ?? '',
    end_time: song.endTime ?? song.end_time ?? '',
    lyric_excerpt: song.lyricExcerpt ?? song.lyric_excerpt ?? '',
    song_search_query: song.songSearchQuery ?? song.song_search_query ?? songName,
    song_resolution_method: song.songResolutionMethod ?? song.song_resolution_method ?? 'danmaku-lyrics',
    song_name: songName,
    display_song_name: song.displaySongName ?? song.display_song_name ?? songName,
    artist: song.artist ?? '',
    artist_search: song.artistSearch ?? song.artist_search ?? song.artist ?? '',
    feat_artist: song.featArtist ?? song.feat_artist ?? '',
    language: song.language ?? '',
    tone: song.tone ?? '',
    status_labels: statuses,
    display_version: song.displayVersion ?? song.display_version ?? '',
    type: Array.isArray(song.typeTags) ? song.typeTags.join('、') : song.type ?? '',
    remark: song.remark ?? '',
    identification: song.identification ?? '',
    cut_link: song.cutLink ?? song.cut_link ?? song.cut?.url ?? '',
    confidence: Number(song.confidence ?? 0.6),
    row_key: song.rowKey ?? song.row_key ?? songName,
    search_name: song.searchName ?? song.search_name ?? '',
    resolution_candidates: Array.isArray(song.resolutionCandidates ?? song.resolution_candidates)
      ? (song.resolutionCandidates ?? song.resolution_candidates)
      : [],
  };
}

export function makeCut(batch, song, segment, index, collectedAt) {
  if (!song.cut) return null;
  const cut = song.cut;
  const songName = segment.song_name;
  const date = String(cut.clipDate ?? cut.clip_date ?? segment.replay_date);
  return {
    clip_date: date,
    date_source: cut.dateSource ?? cut.date_source ?? 'live-date',
    date_text: cut.dateText ?? cut.date_text ?? date,
    song_name: songName,
    song_name_source: cut.songNameSource ?? cut.song_name_source ?? 'manual-normalized',
    artist: cut.artist ?? segment.artist,
    clip_kind: cut.kind ?? cut.clip_kind ?? 'single',
    chapter_title: cut.chapterTitle ?? cut.chapter_title ?? '',
    clip_title: cut.title ?? cut.clip_title ?? songName,
    clip_url: cut.url ?? cut.clip_url ?? '',
    clip_bvid: cut.bvid ?? cut.clip_bvid ?? '',
    uploader: cut.uploader ?? '',
    duration: cut.duration ?? '',
    source_query: cut.sourceQuery ?? cut.source_query ?? '',
    duplicate_key: `${date}::${songName}`,
    duplicate_status: cut.duplicateStatus ?? cut.duplicate_status ?? 'primary',
    duplicate_of: cut.duplicateOf ?? cut.duplicate_of ?? '',
    collected_at: cut.collectedAt ?? cut.collected_at ?? collectedAt,
    notes: cut.notes ?? '',
  };
}

export function importCuratedBatch({ segmentsDocument, cutsDocument, batch, now = new Date().toISOString() }) {
  if (!Array.isArray(batch?.songs)) throw new Error('Curated batch must contain a songs array');
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(String(batch.live?.date ?? ''))) throw new Error('Curated batch live.date must be YYYY-MM-DD');
  const segments = [...requireArray(segmentsDocument.segments, 'segmentsDocument.segments')];
  const cuts = [...requireArray(cutsDocument.items, 'cutsDocument.items')];
  const segmentKeys = new Set(segments.map(item => performanceKey(item.replay_date, item.song_name)));
  const primaryCutKeys = new Set(cuts.filter(item => item.duplicate_status === 'primary').map(item => performanceKey(item.clip_date, item.song_name)));
  const insertedSegments = [];
  const insertedCuts = [];
  const skipped = [];

  batch.songs.forEach((song, index) => {
    const segment = makeSegment(batch, song, index);
    const key = performanceKey(segment.replay_date, segment.song_name);
    if (segmentKeys.has(key)) {
      skipped.push(`${segment.replay_date}::${segment.song_name}`);
      return;
    }
    segmentKeys.add(key);
    segments.push(segment);
    insertedSegments.push(segment);
    const cut = makeCut(batch, song, segment, index, now);
    if (cut) {
      const cutKey = performanceKey(cut.clip_date, cut.song_name);
      if (cut.duplicate_status === 'primary' && primaryCutKeys.has(cutKey)) {
        cut.duplicate_status = 'secondary';
        cut.duplicate_of = cut.duplicate_of || cut.duplicate_key;
      } else if (cut.duplicate_status === 'primary') primaryCutKeys.add(cutKey);
      cuts.push(cut);
      insertedCuts.push(cut);
    }
  });

  const nextSegmentsDocument = insertedSegments.length ? { ...segmentsDocument, updatedAt: now, segments } : segmentsDocument;
  const nextCutsDocument = insertedCuts.length ? { ...cutsDocument, updatedAt: now, items: cuts } : cutsDocument;
  const errors = [...validateSegments(nextSegmentsDocument.segments), ...validateCuts(nextCutsDocument.items)];
  if (errors.length) throw new Error(`Import validation failed:\n- ${errors.join('\n- ')}`);
  return { segmentsDocument: nextSegmentsDocument, cutsDocument: nextCutsDocument, insertedSegments, insertedCuts, skipped };
}
