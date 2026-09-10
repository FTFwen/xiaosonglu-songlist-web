import { createHash } from 'node:crypto';

export const ROOM_KEY = 'xiaosonglu';
export const ROOM_ID = '1727071052';

// Keep one canonical display/filter label for each language. Inputs from older
// ledgers and curated batches may use an alias, but generated data must not.
export const LANGUAGE_TAG_ALIASES = Object.freeze({
  '日语': '日文',
});
const LANGUAGE_SEPARATOR_RE = /([、,，/／|｜])/u;

export function normalizeLanguageTag(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  return text.split(LANGUAGE_SEPARATOR_RE).map(part => {
    if (LANGUAGE_SEPARATOR_RE.test(part)) return part;
    const token = part.trim();
    return LANGUAGE_TAG_ALIASES[token] ?? token;
  }).join('');
}

// Type tags use one reviewed vocabulary. Only true synonyms belong in the
// alias table. Broad/ambiguous labels must be resolved to a precise existing
// tag during review instead of being silently rewritten.
export const TYPE_TAG_ALIASES = Object.freeze({});
export const AMBIGUOUS_TYPE_TAGS = Object.freeze(['虚拟歌手']);
export const CUT_KINDS = Object.freeze(['single', 'collection', 'collection-chapter', 'compilation']);
const TYPE_TAG_SEPARATOR_RE = /[、,，/／|｜]/u;

export function splitTypeTags(value) {
  const values = Array.isArray(value) ? value : [value];
  return values
    .flatMap(item => String(item ?? '').split(TYPE_TAG_SEPARATOR_RE))
    .map(item => item.trim())
    .filter(Boolean);
}

export function normalizeTypeTags(value) {
  return uniqueInOrder(splitTypeTags(value).map(tag => TYPE_TAG_ALIASES[tag] ?? tag));
}

function hasTypeValue(value) {
  if (Array.isArray(value)) return value.some(item => String(item ?? '').trim());
  return String(value ?? '').trim() !== '';
}

function firstTypeValue(...values) {
  return values.find(hasTypeValue) ?? '';
}

export function getAmbiguousTypeTags(value, blockedTypeTags = AMBIGUOUS_TYPE_TAGS) {
  const blocked = new Set([...AMBIGUOUS_TYPE_TAGS, ...(blockedTypeTags ?? [])]);
  return uniqueInOrder(splitTypeTags(value).filter(tag => blocked.has(tag)));
}

export function getNonCanonicalTypeTags(value, blockedTypeTags = AMBIGUOUS_TYPE_TAGS) {
  const blocked = new Set([...AMBIGUOUS_TYPE_TAGS, ...(blockedTypeTags ?? [])]);
  return uniqueInOrder(splitTypeTags(value).filter(tag => Object.hasOwn(TYPE_TAG_ALIASES, tag) || blocked.has(tag)));
}

export function getUnknownTypeTags(value, approvedTypeTags) {
  if (approvedTypeTags == null) return [];
  const approved = approvedTypeTags instanceof Set ? approvedTypeTags : new Set(approvedTypeTags);
  return uniqueInOrder(normalizeTypeTags(value).filter(tag => !approved.has(tag)));
}

export function typeTagPolicyFromRegistry(registryDocument) {
  return {
    approvedTypeTags: new Set(
      (Array.isArray(registryDocument?.approvedTags) ? registryDocument.approvedTags : [])
        .map(tag => String(tag ?? '').trim())
        .filter(Boolean),
    ),
    blockedTypeTags: new Set(Object.keys(registryDocument?.blockedTags ?? {}).map(tag => tag.trim()).filter(Boolean)),
  };
}

export function validateTypeTagRegistry(registryDocument) {
  const errors = [];
  if (registryDocument?.schemaVersion !== 1) errors.push('type_tag_registry.json schemaVersion must be 1');
  const approved = Array.isArray(registryDocument?.approvedTags) ? registryDocument.approvedTags : [];
  const normalizedApproved = approved.map(tag => String(tag ?? '').trim());
  if (!approved.length) errors.push('type_tag_registry.json approvedTags must be a non-empty array');
  if (normalizedApproved.some(tag => !tag || splitTypeTags(tag).length !== 1)) {
    errors.push('type_tag_registry.json approvedTags must contain non-empty atomic tags');
  }
  if (new Set(normalizedApproved).size !== normalizedApproved.length) errors.push('type_tag_registry.json approvedTags contains duplicates');

  const approvedSet = new Set(normalizedApproved);
  const logged = new Set();
  const approvalLog = Array.isArray(registryDocument?.approvalLog) ? registryDocument.approvalLog : [];
  if (!approvalLog.length) errors.push('type_tag_registry.json approvalLog must be a non-empty array');
  approvalLog.forEach((entry, index) => {
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(String(entry?.date ?? ''))) errors.push(`type_tag_registry.json approvalLog[${index}] has invalid date`);
    if (!String(entry?.reason ?? '').trim()) errors.push(`type_tag_registry.json approvalLog[${index}] requires a reason`);
    if (!Array.isArray(entry?.tags) || !entry.tags.length) errors.push(`type_tag_registry.json approvalLog[${index}] requires tags`);
    for (const rawTag of entry?.tags ?? []) {
      const tag = String(rawTag ?? '').trim();
      if (!approvedSet.has(tag)) errors.push(`type_tag_registry.json approvalLog[${index}] references unapproved tag ${tag}`);
      if (logged.has(tag)) errors.push(`type_tag_registry.json approval log repeats tag ${tag}`);
      logged.add(tag);
    }
  });
  for (const tag of approvedSet) {
    if (!logged.has(tag)) errors.push(`type_tag_registry.json approved tag ${tag} has no approval reason`);
  }

  const blockedEntries = Object.entries(registryDocument?.blockedTags ?? {});
  blockedEntries.forEach(([rawTag, detail]) => {
    const tag = String(rawTag ?? '').trim();
    if (!tag) errors.push('type_tag_registry.json blockedTags contains an empty tag');
    if (approvedSet.has(tag)) errors.push(`type_tag_registry.json tag ${tag} cannot be both approved and blocked`);
    if (!String(detail?.reason ?? '').trim()) errors.push(`type_tag_registry.json blocked tag ${tag} requires a reason`);
    const suggestions = Array.isArray(detail?.suggestedExistingTags) ? detail.suggestedExistingTags : [];
    if (!suggestions.length) errors.push(`type_tag_registry.json blocked tag ${tag} requires suggestedExistingTags`);
    suggestions.forEach(suggestion => {
      if (!approvedSet.has(suggestion)) errors.push(`type_tag_registry.json blocked tag ${tag} suggests unapproved tag ${suggestion}`);
    });
  });
  return errors;
}

function typeTagErrors(value, label, { approvedTypeTags, blockedTypeTags } = {}) {
  const errors = [];
  const nonCanonical = getNonCanonicalTypeTags(value, blockedTypeTags);
  if (nonCanonical.length) errors.push(`${label} has ambiguous/noncanonical type tag(s) ${nonCanonical.join('、')}`);
  const nonCanonicalSet = new Set(nonCanonical);
  const unknown = getUnknownTypeTags(value, approvedTypeTags).filter(tag => !nonCanonicalSet.has(tag));
  if (unknown.length) errors.push(`${label} has unapproved type tag(s) ${unknown.join('、')}`);
  return errors;
}

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

export function validateSegments(segments, typeTagPolicy = {}) {
  const errors = [];
  const keys = new Map();
  requireArray(segments, 'segments').forEach((segment, index) => {
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(String(segment.replay_date ?? ''))) errors.push(`segments[${index}] has invalid replay_date`);
    if (!normalizeSongName(segment.song_name)) errors.push(`segments[${index}] has no song_name`);
    if (!Number.isSafeInteger(segment.segment_index) || segment.segment_index <= 0) errors.push(`segments[${index}] has invalid segment_index`);
    const rawLanguage = String(segment.language ?? '').trim();
    if (rawLanguage && normalizeLanguageTag(rawLanguage) !== rawLanguage) {
      errors.push(`segments[${index}] has noncanonical language tag ${rawLanguage}`);
    }
    errors.push(...typeTagErrors(segment.type, `segments[${index}]`, typeTagPolicy));
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
    const cutKind = String(item.clip_kind ?? '').trim().toLowerCase();
    if (!CUT_KINDS.includes(cutKind)) errors.push(`items[${index}] has unsupported clip_kind ${item.clip_kind ?? ''}`);
    try {
      const url = new URL(String(item.clip_url ?? ''));
      const isBilibili = ['www.bilibili.com', 'bilibili.com', 'm.bilibili.com'].includes(url.hostname.toLowerCase());
      if (isBilibili && ['collection', 'collection-chapter'].includes(cutKind)
        && (!/^\d+$/u.test(url.searchParams.get('p') ?? '') || [...url.searchParams.keys()].some(key => key !== 'p') || url.hash)) {
        errors.push(`items[${index}] multipart Bilibili cut must use only an exact ?p= chapter selector`);
      }
      if (isBilibili && ['single', 'compilation'].includes(cutKind) && (url.search || url.hash)) {
        errors.push(`items[${index}] standalone Bilibili cut must not contain a query or fragment`);
      }
    } catch {
      // URL shape is validated by higher-level consumers; only enforce canonical selectors on parseable Bilibili URLs here.
    }
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
    row.language = normalizeLanguageTag(override.language ?? row.language ?? '');
    const overrideType = firstTypeValue(override.type, override.type_tags);
    row.type = normalizeTypeTags(overrideType || row.type).join('、');
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

export function buildDerivedData({
  segmentsDocument,
  cutsDocument,
  overridesDocument,
  currentCatalog,
  currentCutInfo,
  typeTagRegistryDocument = null,
}) {
  const segments = requireArray(segmentsDocument?.segments, 'segmentsDocument.segments');
  const items = requireArray(cutsDocument?.items, 'cutsDocument.items');
  const typeTagPolicy = typeTagRegistryDocument ? typeTagPolicyFromRegistry(typeTagRegistryDocument) : {};
  const errors = [
    ...(typeTagRegistryDocument ? validateTypeTagRegistry(typeTagRegistryDocument) : []),
    ...validateSegments(segments, typeTagPolicy),
    ...validateCuts(items),
  ];
  Object.entries(overridesDocument?.bySongName ?? {}).forEach(([songName, override]) => {
    for (const [field, value] of [['type', override?.type], ['type_tags', override?.type_tags]]) {
      if (hasTypeValue(value)) errors.push(...typeTagErrors(value, `song_metadata_overrides.json ${field} for ${songName}`, typeTagPolicy));
    }
  });
  const generatedAt = segmentsDocument.updatedAt ?? new Date(0).toISOString();
  const cutGeneratedAt = [
    cutsDocument.updatedAt,
    currentCutInfo?.generatedAt,
    ...items.map(item => item.collected_at),
  ].filter(Boolean).sort().at(-1) ?? generatedAt;
  const catalog = buildCatalog(segments, overridesDocument, currentCatalog);
  catalog.forEach((song, index) => {
    errors.push(...typeTagErrors(song.type, `song_catalog.songs[${index}]`, typeTagPolicy));
  });
  if (errors.length) throw new Error(`Source validation failed:\n- ${errors.join('\n- ')}`);
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

function curatedTypeValue(song) {
  return firstTypeValue(song.typeTags, song.type_tags, song.type);
}

function sameNameReviewFor(song) {
  return song?.sameNameReview ?? song?.same_name_review ?? null;
}

function cutUrlForCuratedSong(song) {
  return song?.cut?.url ?? song?.cut?.clip_url ?? song?.cutUrl ?? song?.cut_url ?? song?.cutLink ?? song?.cut_link ?? '';
}

function normalizedReviewUrl(value) {
  try {
    const url = new URL(String(value ?? '').trim());
    if (url.protocol !== 'https:' || url.username || url.password) return '';
    const pathname = url.pathname.replace(/\/+$/u, '').toLowerCase();
    const rawHostname = url.hostname.toLowerCase();
    const hostname = ['www.bilibili.com', 'bilibili.com', 'm.bilibili.com'].includes(rawHostname)
      ? 'bilibili.com'
      : rawHostname;
    return `${url.protocol}//${hostname}${url.port ? `:${url.port}` : ''}${pathname}`;
  } catch {
    return '';
  }
}

function trustedSameNameEvidenceUrl(value) {
  try {
    const url = new URL(String(value ?? '').trim());
    return url.protocol === 'https:'
      && !url.username && !url.password && !url.port
      && ['www.bilibili.com', 'bilibili.com', 'm.bilibili.com'].includes(url.hostname.toLowerCase())
      && /^\/video\/bv[0-9a-z]+\/?$/iu.test(url.pathname);
  } catch {
    return false;
  }
}

function sameNameReviewIsComplete(song, sourceUrls = new Set()) {
  const review = sameNameReviewFor(song);
  const evidenceUrls = Array.isArray(review?.evidenceUrls)
    ? review.evidenceUrls
    : [review?.evidenceUrl].filter(Boolean);
  return review?.decision === 'confirmed-repeat'
    && String(review?.notes ?? '').trim().length > 0
    && evidenceUrls.some(value => {
      const url = normalizedReviewUrl(value);
      return trustedSameNameEvidenceUrl(value) && url && !sourceUrls.has(url);
    });
}

export function validateCuratedSameNameSongs(batch, existingSegments = []) {
  const errors = [];
  const seen = new Map();
  const existingByKey = new Map();
  const sourceUrlsByKey = new Map();
  const date = String(batch?.live?.date ?? '').trim();
  const live = batch?.live ?? {};
  const expectedReplayId = String(live.replayId ?? live.replay_id ?? (live.liveId ? `live:${live.liveId}` : ''));
  const addSourceUrl = (key, value) => {
    const url = normalizedReviewUrl(value);
    if (!url) return;
    if (!sourceUrlsByKey.has(key)) sourceUrlsByKey.set(key, new Set());
    sourceUrlsByKey.get(key).add(url);
  };
  for (const segment of existingSegments) {
    if (String(segment?.replay_date ?? '').trim() !== date) continue;
    const name = String(segment?.song_name ?? '').trim();
    if (!name) continue;
    const key = performanceKey(date, name);
    if (!existingByKey.has(key)) existingByKey.set(key, []);
    existingByKey.get(key).push(segment);
    addSourceUrl(key, segment.cut_link);
  }
  for (const song of batch?.songs ?? []) {
    const name = String(song?.songName ?? song?.song_name ?? '').trim();
    if (name) addSourceUrl(performanceKey(date, name), cutUrlForCuratedSong(song));
  }
  for (const [index, song] of (batch?.songs ?? []).entries()) {
    const name = String(song?.songName ?? song?.song_name ?? '').trim();
    if (!name) continue;
    const key = performanceKey(date, name);
    const expectedIndex = Number(song?.segmentIndex ?? song?.segment_index ?? index + 1);
    const existing = existingByKey.get(key) ?? [];
    const isIdempotent = Boolean(expectedReplayId) && existing.some(segment =>
      Number(segment?.segment_index) === expectedIndex
      && String(segment?.replay_id ?? '') === expectedReplayId);
    const requiresReview = seen.has(key) || (existing.length > 0 && !isIdempotent);
    if (requiresReview && !sameNameReviewIsComplete(song, sourceUrlsByKey.get(key) ?? new Set())) {
      errors.push(`songs[${index}] repeats ${name} in the same live without a confirmed sameNameReview backed by an independent Bilibili video evidence URL (not a cut URL being reviewed). Recheck the actual song; if the chapter title is wrong, search another uploader or Bilibili and correct it. If it is a true repeat, record decision=confirmed-repeat, independent evidenceUrl/evidenceUrls, and notes.`);
    }
    if (!seen.has(key)) seen.set(key, index);
  }
  return errors;
}

export function canonicalizeBilibiliCutUrl(value, kind, segmentIndex) {
  const text = String(value ?? '').trim();
  if (!text) return text;
  try {
    const url = new URL(text);
    const hostname = url.hostname.toLowerCase();
    const normalizedKind = String(kind ?? '').trim().toLowerCase();
    const isMultipart = ['collection', 'collection-chapter'].includes(normalizedKind);
    const part = Number(segmentIndex);
    if (url.protocol !== 'https:'
      || !['www.bilibili.com', 'bilibili.com', 'm.bilibili.com'].includes(hostname)
      || (isMultipart && (!Number.isSafeInteger(part) || part <= 0))) return text;
    url.search = '';
    url.hash = '';
    if (isMultipart) url.searchParams.set('p', String(part));
    return url.href;
  } catch {
    return text;
  }
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
  const segmentIndex = Number(song.segmentIndex ?? song.segment_index ?? index + 1);
  if (!Number.isSafeInteger(segmentIndex) || segmentIndex <= 0) throw new Error(`songs[${index}] must have a positive safe-integer segmentIndex`);
  const cutKind = song.cut?.kind ?? song.cut?.clip_kind ?? song.cutKind ?? song.cut_kind ?? 'single';
  const rawCutUrl = song.cut?.url ?? song.cutLink ?? song.cut_link ?? song.cutUrl ?? song.cut_url ?? '';
  const cutLink = canonicalizeBilibiliCutUrl(rawCutUrl, cutKind, segmentIndex);
  return {
    replay_id: replayId,
    replay_title: replayTitle,
    replay_url: replayUrl,
    replay_date: date,
    replay_date_source: live.replayDateSource ?? live.replay_date_source ?? 'live-api-date',
    segment_index: segmentIndex,
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
    language: normalizeLanguageTag(song.language ?? ''),
    tone: song.tone ?? '',
    status_labels: statuses,
    display_version: song.displayVersion ?? song.display_version ?? '',
    type: normalizeTypeTags(curatedTypeValue(song)).join('、'),
    remark: song.remark ?? '',
    identification: song.identification ?? '',
    cut_link: cutLink,
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
  const cutKind = cut.kind ?? cut.clip_kind ?? 'single';
  const cutUrl = canonicalizeBilibiliCutUrl(cut.url ?? cut.clip_url ?? '', cutKind, segment.segment_index);
  return {
    clip_date: date,
    date_source: cut.dateSource ?? cut.date_source ?? 'live-date',
    date_text: cut.dateText ?? cut.date_text ?? date,
    song_name: songName,
    song_name_source: cut.songNameSource ?? cut.song_name_source ?? 'manual-normalized',
    artist: cut.artist ?? segment.artist,
    clip_kind: cutKind,
    chapter_title: cut.chapterTitle ?? cut.chapter_title ?? '',
    clip_title: cut.title ?? cut.clip_title ?? songName,
    clip_url: cutUrl,
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

export function importCuratedBatch({
  segmentsDocument,
  cutsDocument,
  batch,
  now = new Date().toISOString(),
  approvedTypeTags = null,
  blockedTypeTags = AMBIGUOUS_TYPE_TAGS,
  blockedTypeTagDetails = {},
}) {
  if (!Array.isArray(batch?.songs)) throw new Error('Curated batch must contain a songs array');
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(String(batch.live?.date ?? ''))) throw new Error('Curated batch live.date must be YYYY-MM-DD');
  const stableLiveIdentity = String(batch.live?.replayId ?? batch.live?.replay_id ?? batch.live?.liveId ?? '').trim();
  if (!stableLiveIdentity) throw new Error('Curated batch live must contain a stable liveId or replayId');
  const cutKindErrors = batch.songs.flatMap((song, index) => {
    const topLevelCutUrl = song?.cutUrl ?? song?.cut_url ?? song?.cutLink ?? song?.cut_link;
    if (!song?.cut) return [topLevelCutUrl
      ? `songs[${index}] must use a nested cut object instead of top-level cut aliases`
      : `songs[${index}] must use a nested cut object`];
    const kind = String(song.cut.kind ?? song.cut.clip_kind ?? '').trim().toLowerCase();
    if (!kind) return [`songs[${index}].cut must declare kind`];
    if (!CUT_KINDS.includes(kind)) return [`songs[${index}].cut has unsupported kind ${kind}`];
    const cutUrl = String(song.cut.url ?? song.cut.clip_url ?? '').trim();
    if (!cutUrl) return [`songs[${index}].cut must contain url`];
    if (!trustedSameNameEvidenceUrl(cutUrl)) return [`songs[${index}].cut must be a canonical HTTPS Bilibili video URL`];
    return [];
  });
  if (cutKindErrors.length) throw new Error(`Curated cut-kind validation failed:\n- ${cutKindErrors.join('\n- ')}`);
  const audioActionErrors = batch.songs.flatMap((song, index) => {
    let action = String(song?.audioAction ?? song?.audio_action ?? 'keep-existing').trim().toLowerCase();
    if (song?.replaceExistingAudio === true) action = 'replace-existing';
    if (!['keep-existing', 'replace-existing'].includes(action)) return [`songs[${index}] has unsupported audioAction ${action}`];
    if (action !== 'replace-existing') return [];
    const reason = String(song?.audioReplacementReason ?? song?.audio_replacement_reason ?? '').trim();
    const hash = String(song?.audioSha256 ?? song?.audio_sha256 ?? '').trim().toLowerCase();
    const bytes = Number(song?.audioBytes ?? song?.audio_bytes ?? 0);
    const target = String(song?.audioTarget ?? song?.audio_target ?? '').trim().split('?')[0].replaceAll('\\', '/');
    const errors = [];
    if (!song?.cut) errors.push(`songs[${index}] replace-existing requires a nested cut object`);
    const declaredBvid = String(song?.cut?.bvid ?? song?.cut?.clip_bvid ?? '').trim();
    const cutPathBvid = String(song?.cut?.url ?? song?.cut?.clip_url ?? '').match(/\/video\/(BV[0-9A-Za-z]+)/u)?.[1] ?? '';
    if (!declaredBvid || declaredBvid.toLowerCase() !== cutPathBvid.toLowerCase()) errors.push(`songs[${index}] replace-existing requires cut.bvid matching its Bilibili video URL`);
    if (!reason) errors.push(`songs[${index}] replace-existing requires audioReplacementReason`);
    if (!/^[0-9a-f]{64}$/u.test(hash) || !Number.isSafeInteger(bytes) || bytes <= 0) errors.push(`songs[${index}] replace-existing requires reviewed audioSha256 and audioBytes`);
    if (!/^assets\/audio\/[A-Za-z0-9][A-Za-z0-9._-]*\.m4a$/u.test(target)) errors.push(`songs[${index}] replace-existing requires a safe explicit audioTarget`);
    return errors;
  });
  if (audioActionErrors.length) throw new Error(`Curated audio-action validation failed:\n- ${audioActionErrors.join('\n- ')}`);
  const factActionErrors = batch.songs.flatMap((song, index) => {
    const action = String(song?.factAction ?? song?.fact_action ?? 'keep-existing').trim().toLowerCase();
    if (!['keep-existing', 'replace-existing-segment'].includes(action)) return [`songs[${index}] has unsupported factAction ${action}`];
    if (action !== 'replace-existing-segment') return [];
    const errors = [];
    if (!String(song?.factReplacementReason ?? song?.fact_replacement_reason ?? '').trim()) errors.push(`songs[${index}] replace-existing-segment requires factReplacementReason`);
    if (!normalizeSongName(song?.previousSongName ?? song?.previous_song_name)) errors.push(`songs[${index}] replace-existing-segment requires previousSongName`);
    if (!/^BV[0-9A-Za-z]+$/u.test(String(song?.previousCutBvid ?? song?.previous_cut_bvid ?? '').trim())) errors.push(`songs[${index}] replace-existing-segment requires previousCutBvid`);
    const declaredBvid = String(song?.cut?.bvid ?? song?.cut?.clip_bvid ?? '').trim();
    const cutPathBvid = String(song?.cut?.url ?? song?.cut?.clip_url ?? '').match(/\/video\/(BV[0-9A-Za-z]+)/u)?.[1] ?? '';
    if (!declaredBvid || declaredBvid.toLowerCase() !== cutPathBvid.toLowerCase()) errors.push(`songs[${index}] replace-existing-segment requires cut.bvid matching its Bilibili video URL`);
    const segmentIndex = Number(song?.segmentIndex ?? song?.segment_index);
    if (!Number.isSafeInteger(segmentIndex) || segmentIndex <= 0) errors.push(`songs[${index}] replace-existing-segment requires a positive segmentIndex`);
    return errors;
  });
  if (factActionErrors.length) throw new Error(`Curated fact-action validation failed:\n- ${factActionErrors.join('\n- ')}`);
  const sourceSegments = requireArray(segmentsDocument.segments, 'segmentsDocument.segments');
  const replacementReplayId = String(batch.live?.replayId ?? batch.live?.replay_id ?? `live:${batch.live?.liveId ?? ''}`);
  const supersededSegments = new Map(batch.songs.flatMap(song => {
    const action = String(song?.factAction ?? song?.fact_action ?? 'keep-existing').trim().toLowerCase();
    if (action !== 'replace-existing-segment') return [];
    const segmentIndex = Number(song.segmentIndex ?? song.segment_index);
    return [[`${replacementReplayId}::${segmentIndex}`, normalizeSongName(song.previousSongName ?? song.previous_song_name)]];
  }));
  const effectiveSourceSegments = sourceSegments.filter(segment => {
    const previousName = supersededSegments.get(`${segment.replay_id}::${Number(segment.segment_index)}`);
    return !previousName || normalizeSongName(segment.song_name) !== previousName;
  });
  const sameNameErrors = validateCuratedSameNameSongs(batch, effectiveSourceSegments);
  if (sameNameErrors.length) throw new Error(`Curated same-name review failed:\n- ${sameNameErrors.join('\n- ')}`);
  const segments = [...sourceSegments];
  const cuts = [...requireArray(cutsDocument.items, 'cutsDocument.items')];
  const approvedTypeTagSet = approvedTypeTags == null
    ? new Set(segments.flatMap(item => normalizeTypeTags(item.type)))
    : new Set(approvedTypeTags);
  const typeTagPolicy = { approvedTypeTags: approvedTypeTagSet, blockedTypeTags };
  const incomingTypeValues = batch.songs.flatMap(song => [song.typeTags, song.type_tags, song.type].filter(hasTypeValue));
  const incomingTypeTags = new Set(batch.songs.flatMap(song => normalizeTypeTags(curatedTypeValue(song))));
  const observedTypeTags = new Set(segments.flatMap(item => normalizeTypeTags(item.type)));
  const ambiguousTypeTags = getAmbiguousTypeTags(incomingTypeValues, blockedTypeTags);
  if (ambiguousTypeTags.length) {
    const details = ambiguousTypeTags.map(tag => {
      const suggestions = blockedTypeTagDetails?.[tag]?.suggestedExistingTags;
      return Array.isArray(suggestions) && suggestions.length ? `${tag}（请从 ${suggestions.join('、')} 等已有精准标签中选择）` : tag;
    });
    throw new Error(`Ambiguous type tag(s) require a precise reviewed category: ${details.join('；')}`);
  }
  const newTypeTags = [...incomingTypeTags].filter(tag => !observedTypeTags.has(tag));
  const unapprovedTypeTags = getUnknownTypeTags(newTypeTags, approvedTypeTagSet);
  if (unapprovedTypeTags.length) {
    throw new Error(`Unapproved type tag(s): ${unapprovedTypeTags.join('、')}. Check the existing vocabulary first; only when none applies, add the new tag and its reason to type_tag_registry.json.`);
  }
  const segmentKeys = new Set(segments.map(item => performanceKey(item.replay_date, item.song_name)));
  const primaryCutKeys = new Set(cuts.filter(item => item.duplicate_status === 'primary').map(item => performanceKey(item.clip_date, item.song_name)));
  const insertedSegments = [];
  const insertedCuts = [];
  const dedupedSegments = [];
  const skipped = [];
  let cutsChanged = false;

  const reconcileFactReplacementCut = (song, segment, index) => {
    const expectedCut = makeCut(batch, song, segment, index, now);
    if (!expectedCut) throw new Error(`replace-existing-segment requires a replacement cut for segment ${segment.segment_index}`);
    const previousNameKey = normalizeSongName(song.previousSongName ?? song.previous_song_name);
    const previousBvid = String(song.previousCutBvid ?? song.previous_cut_bvid).toLowerCase();
    const previousIndexes = cuts.flatMap((item, itemIndex) =>
      item.clip_date === segment.replay_date
        && normalizeSongName(item.song_name) === previousNameKey
        && String(item.clip_bvid ?? '').toLowerCase() === previousBvid ? [itemIndex] : []);
    if (previousIndexes.length > 1) throw new Error(`replace-existing-segment found multiple previous cuts ${song.previousCutBvid ?? song.previous_cut_bvid}`);
    for (const itemIndex of previousIndexes.sort((left, right) => right - left)) {
      cuts.splice(itemIndex, 1);
      cutsChanged = true;
    }
    const desiredNameKey = normalizeSongName(segment.song_name);
    const desiredIndexes = cuts.flatMap((item, itemIndex) =>
      item.clip_date === expectedCut.clip_date && normalizeSongName(item.song_name) === desiredNameKey ? [itemIndex] : []);
    const exactIndexes = desiredIndexes.filter(itemIndex =>
      String(cuts[itemIndex].clip_url ?? '') === String(expectedCut.clip_url ?? '')
      && String(cuts[itemIndex].clip_bvid ?? '').toLowerCase() === String(expectedCut.clip_bvid ?? '').toLowerCase());
    if (exactIndexes.length > 1) throw new Error(`replace-existing-segment found multiple exact replacement cuts for ${segment.song_name}`);
    const keepIndex = exactIndexes[0] ?? -1;
    for (const itemIndex of desiredIndexes.filter(value => value !== keepIndex).sort((left, right) => right - left)) {
      cuts.splice(itemIndex, 1);
      cutsChanged = true;
    }
    if (keepIndex === -1) {
      cuts.push(expectedCut);
      insertedCuts.push(expectedCut);
      cutsChanged = true;
    }
    primaryCutKeys.delete(performanceKey(segment.replay_date, song.previousSongName ?? song.previous_song_name));
    primaryCutKeys.add(performanceKey(expectedCut.clip_date, expectedCut.song_name));
  };

  const reconcileExistingSegmentCut = (song, segment, index) => {
    const expectedCut = makeCut(batch, song, segment, index, now);
    if (!expectedCut) return;
    const expectedKey = performanceKey(expectedCut.clip_date, expectedCut.song_name);
    const keyedCuts = cuts.filter(item => performanceKey(item.clip_date, item.song_name) === expectedKey);
    const exactCut = keyedCuts.find(item =>
      String(item.clip_url ?? '') === String(expectedCut.clip_url ?? '')
      && (!expectedCut.clip_bvid || String(item.clip_bvid ?? '').toLowerCase() === String(expectedCut.clip_bvid).toLowerCase()));
    if (exactCut) return;
    if (keyedCuts.length) {
      throw new Error(`Existing ${expectedCut.song_name} fact has a conflicting cut ledger; use an explicit reviewed replacement instead of overwriting it`);
    }
    if (expectedCut.duplicate_status === 'primary' && primaryCutKeys.has(expectedKey)) {
      expectedCut.duplicate_status = 'secondary';
      expectedCut.duplicate_of = expectedCut.duplicate_of || expectedCut.duplicate_key;
    } else if (expectedCut.duplicate_status === 'primary') primaryCutKeys.add(expectedKey);
    cuts.push(expectedCut);
    insertedCuts.push(expectedCut);
    cutsChanged = true;
  };

  batch.songs.forEach((song, index) => {
    const segment = makeSegment(batch, song, index);
    const key = performanceKey(segment.replay_date, segment.song_name);
    const factAction = String(song.factAction ?? song.fact_action ?? 'keep-existing').trim().toLowerCase();
    if (factAction === 'replace-existing-segment') {
      const coordinateIndexes = segments.flatMap((item, itemIndex) =>
        item.replay_id === segment.replay_id && Number(item.segment_index) === Number(segment.segment_index) ? [itemIndex] : []);
      if (coordinateIndexes.length !== 1) throw new Error(`replace-existing-segment requires exactly one fact at ${segment.replay_id} segment ${segment.segment_index}`);
      const targetIndex = coordinateIndexes[0];
      const oldSegment = segments[targetIndex];
      const oldNameKey = normalizeSongName(oldSegment.song_name);
      const desiredNameKey = normalizeSongName(segment.song_name);
      const previousNameKey = normalizeSongName(song.previousSongName ?? song.previous_song_name);
      if (oldNameKey !== desiredNameKey && oldNameKey !== previousNameKey) {
        throw new Error(`replace-existing-segment expected ${song.previousSongName ?? song.previous_song_name} or ${segment.song_name} at ${segment.replay_id} segment ${segment.segment_index}, found ${oldSegment.song_name}`);
      }
      if (oldNameKey === previousNameKey) {
        const previousBvid = String(song.previousCutBvid ?? song.previous_cut_bvid);
        const segmentCutBvid = String(oldSegment.cut_link ?? '').match(/\/video\/(BV[0-9A-Za-z]+)/u)?.[1] ?? '';
        const matchingPreviousCuts = cuts.filter(item =>
          item.clip_date === segment.replay_date
          && normalizeSongName(item.song_name) === previousNameKey
          && String(item.clip_bvid ?? '').toLowerCase() === previousBvid.toLowerCase());
        if (segmentCutBvid.toLowerCase() !== previousBvid.toLowerCase() || matchingPreviousCuts.length !== 1) {
          throw new Error(`replace-existing-segment previousCutBvid does not exactly match the stale segment and cut ledger`);
        }
        if (segmentKeys.has(key)) throw new Error(`replace-existing-segment would collide with an existing ${segment.song_name} fact`);
        segmentKeys.delete(performanceKey(oldSegment.replay_date, oldSegment.song_name));
        segmentKeys.add(key);
      }
      if (JSON.stringify(oldSegment) !== JSON.stringify(segment)) {
        segments[targetIndex] = segment;
        insertedSegments.push(segment);
      } else {
        skipped.push(`${segment.replay_id}::${segment.segment_index}::${segment.song_name}`);
      }
      reconcileFactReplacementCut(song, segment, index);
      return;
    }
    if (segmentKeys.has(key)) {
      const exactSegment = segments.find(item =>
        item.replay_id === segment.replay_id
        && Number(item.segment_index) === Number(segment.segment_index)
        && normalizeSongName(item.song_name) === normalizeSongName(segment.song_name));
      if (exactSegment) {
        let reconciledSegment = exactSegment;
        if (song.cut && String(exactSegment.cut_link ?? '') !== String(segment.cut_link ?? '')) {
          if (String(exactSegment.cut_link ?? '').trim()) {
            throw new Error(`Existing ${segment.song_name} fact has a conflicting cut_link; use an explicit reviewed replacement instead of overwriting it`);
          }
          const exactIndex = segments.indexOf(exactSegment);
          reconciledSegment = { ...exactSegment, cut_link: segment.cut_link };
          segments[exactIndex] = reconciledSegment;
          insertedSegments.push(reconciledSegment);
        }
        reconcileExistingSegmentCut(song, reconciledSegment, index);
        skipped.push(`${segment.replay_date}::${segment.song_name}`);
      } else {
        const expectedCut = makeCut(batch, song, segment, index, now);
        const hasCanonicalCut = expectedCut && cuts.some(item => performanceKey(item.clip_date, item.song_name) === performanceKey(expectedCut.clip_date, expectedCut.song_name));
        if (expectedCut && !hasCanonicalCut) reconcileExistingSegmentCut(song, segment, index);
        dedupedSegments.push({ replay_id: segment.replay_id, segment_index: segment.segment_index, replay_date: segment.replay_date, song_name: segment.song_name });
        skipped.push(`${segment.replay_date}::${segment.song_name}`);
      }
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
  const nextCutsDocument = cutsChanged || insertedCuts.length ? { ...cutsDocument, updatedAt: now, items: cuts } : cutsDocument;
  const errors = [...validateSegments(nextSegmentsDocument.segments, typeTagPolicy), ...validateCuts(nextCutsDocument.items)];
  if (errors.length) throw new Error(`Import validation failed:\n- ${errors.join('\n- ')}`);
  return { segmentsDocument: nextSegmentsDocument, cutsDocument: nextCutsDocument, insertedSegments, insertedCuts, dedupedSegments, cutsChanged, skipped, newTypeTags };
}
