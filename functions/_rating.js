// _rating.js - 歌曲评分共享逻辑（`_` 前缀不会被注册为路由，可被 functions/api/rating/* 导入）
//
// 存储布局（R2 bucket `xsl_buttons`，这里只把 R2 当键值存储用，歌曲音频仍走静态资产）：
//   rating/v1/agg-<bucket>.json    每首歌的总分/人数/分布（服务端聚合，供所有人读）
//   rating/v1/user-<bucket>.json   同一分片内各访客对每首歌的评分（按访客标识哈希，只回给本人）
//
// 两个文件用同一个 bucket 函数分片，所以一次评分只读写一对小文件；
// 评分明细不会随聚合返回值下发，避免把所有人的打分一览暴露出去。
// 访客标识来自 Cloudflare 注入的 CF-Connecting-IP，经盐值哈希后落盘，R2 里不出现明文 IP。

// 分片数：越多 → 单首歌的并发写入越不容易撞车；越少 → 前端拿一屏评分需要的请求越少。
// 168 首歌散在 16 片里，平均每片约 10 首，一屏卡片大约只涉及十来个分片。
export const BUCKET_COUNT = 16;
const STORAGE_VERSION = 'v1';
const AGG_PREFIX = `rating/${STORAGE_VERSION}/agg-`;
const USER_PREFIX = `rating/${STORAGE_VERSION}/user-`;
const MAX_KEY_LENGTH = 120;
const MAX_KEY_BYTES = 360;
const MAX_SHARD_BYTES = 2 * 1024 * 1024;
const DETAIL_WRITE_ATTEMPTS = 8;
const AGG_WRITE_ATTEMPTS = 8;
const RETRY_BASE_MS = 60;
const RETRY_MAX_MS = 800;
const DEFAULT_SALT = 'xsl-rating-default-salt';

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'access-control-allow-origin': '*',
  'access-control-expose-headers': 'etag',
  'cache-control': 'no-store',
};

export function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), { status, headers: { ...JSON_HEADERS, ...extraHeaders } });
}

// 与前端 js/rating.js 的 hashSongKey 必须逐位一致：按 UTF-16 码元做 djb2。
// 前端只用服务端返回的 bucket 做一致性校验，不自己决定分片。
export function hashSongKey(value) {
  const text = String(value == null ? '' : value);
  let hash = 5381;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
  }
  return hash >>> 0;
}

export function bucketOf(songKey) {
  return hashSongKey(songKey) % BUCKET_COUNT;
}

// 归一化请以「歌名」为稳定键：歌名跨房间、跨管线重建都不变，song_id 会随收录顺序浮动。
export function normalizeSongKey(raw) {
  const text = String(raw == null ? '' : raw).replace(/\s+/g, ' ').trim();
  if (!text) return '';
  if ([...text].length > MAX_KEY_LENGTH) return '';
  if (new TextEncoder().encode(text).byteLength > MAX_KEY_BYTES) return '';
  if (/[\u0000-\u001f\u007f]/.test(text)) return '';
  return text;
}

// 评分接受 1-10 的任意整数分（半颗星就是 1 分），0 表示撤销。
// 0 会删除明细并把它从平均分里扣掉。
export function normalizeScore(raw) {
  const score = Number(raw);
  if (!Number.isInteger(score) || score < 0 || score > 10) return null;
  return score;
}

export function clientIdOf(context) {
  const { request, env } = context;
  const ip = String(request.headers.get('CF-Connecting-IP') || '').trim();
  if (!ip) return '';
  const salt = String((env && env.RATING_IP_SALT) || '') || DEFAULT_SALT;
  return `ip:${hashSongKey(`${salt}\u0000${ip}`)}`;
}

export function requestKeyOf(context) {
  const { request } = context;
  const url = new URL(request.url);
  const fromQuery = normalizeSongKey(url.searchParams.get('key') || '');
  if (fromQuery) return fromQuery;
  return normalizeSongKey(request.headers.get('x-rating-key') || '');
}

function aggregateEntry(entry) {
  const total = Number(entry && entry.total) || 0;
  const count = Number(entry && entry.count) || 0;
  const average = count > 0 ? total / count : 0;
  const distribution = entry && entry.distribution && typeof entry.distribution === 'object' ? entry.distribution : {};
  return {
    total: Math.max(0, total),
    count: Math.max(0, count),
    average: Math.round(average * 100) / 100,
    distribution: normalizeDistribution(distribution),
  };
}

// 分布只保留 1-10 的合法档位，脏数据在读取时忽略，不影响响应。
function normalizeDistribution(raw) {
  const result = {};
  for (let score = 1; score <= 10; score++) {
    const value = Number(raw[score]);
    if (Number.isInteger(value) && value > 0) result[String(score)] = value;
  }
  return result;
}

// 访客自己的评分只回给他本人，同一分片里其他人的明细不下发。
export function ownScoreOf(details, clientId, songKey) {
  if (!details || !clientId) return 0;
  const own = details[clientId];
  if (!own || typeof own !== 'object') return 0;
  const record = own[songKey];
  if (!record || typeof record !== 'object') return 0;
  const score = Number(record.score);
  return Number.isInteger(score) && score > 0 && score <= 10 ? score : 0;
}

// 一次 get 同时拿到「快照」和它的 ETag：二者必须来自同一个版本，
// 否则会出现「读旧快照 → 中途别人写入 → head 取到新 ETag → 条件写入通过并覆盖别人」的丢失更新。
async function readShard(env, key) {
  const object = await env.xsl_buttons.get(key);
  if (!object) return { data: null, etag: '' };
  const etag = etagOf(object);
  try {
    const parsed = JSON.parse(await object.text());
    return { data: parsed && typeof parsed === 'object' ? parsed : null, etag };
  } catch (error) {
    return { data: null, etag };
  }
}

function songsOf(shard) {
  return shard && shard.songs && typeof shard.songs === 'object' ? shard.songs : {};
}

function byteLengthOf(text) {
  return new TextEncoder().encode(text).byteLength;
}

function detailsOf(shard) {
  return shard && shard.details && typeof shard.details === 'object' ? shard.details : {};
}

function etagOf(metadata) {
  const httpEtag = metadata && metadata.httpEtag;
  if (httpEtag) return httpEtag;
  const etag = metadata && metadata.etag;
  return etag ? `"${etag}"` : '';
}

function bareEtag(value) {
  const etag = String(value || '').trim().replace(/^W\//i, '').trim();
  return etag.replace(/^"|"$/g, '');
}

async function putJson(env, key, payload, onlyIf) {
  const body = JSON.stringify(payload);
  if (byteLengthOf(body) > MAX_SHARD_BYTES) return null;
  return env.xsl_buttons.put(key, body, {
    httpMetadata: { contentType: 'application/json' },
    ...(onlyIf ? { onlyIf } : {}),
  });
}

// 通用「读-改-写」：每次都按当前 ETag 做条件写入，冲突就重读重试。
// 无条件写入会让并发请求互相覆盖（8 个人同时评分只剩 1 个人的记录），所以一律走条件写入。
// 返回 { payload } 表示成功（null 表示放弃），返回 { conflict: true } 表示重试次数用尽。
async function writeShard(env, key, attempts, build) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    // 指数退避 + 抖动：几个请求同时撞车后错开重试时机，避免一直踩在同一拍上。
    if (attempt > 0) {
      const backoff = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (attempt - 1));
      await sleep(backoff + Math.floor(Math.random() * RETRY_BASE_MS));
    }
    const shard = await readShard(env, key);
    const next = build(shard.data);
    if (!next) return { payload: null };
    // 用与快照同源的 ETag 做条件写入；对象不存在时用 create-only，避免并发创建互相覆盖。
    const onlyIf = shard.etag
      ? { etagMatches: bareEtag(shard.etag) }
      : { etagDoesNotMatch: '*' };
    const written = await putJson(env, key, next.payload, onlyIf);
    if (written) return next;
  }
  return { conflict: true };
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// 顺序固定为「先明细、后聚合」：明细写成功而聚合最终没跟上时返回失败让访客重试，
// 重试时 delta 归零，聚合会被自然补偿。
export async function applyRating(context, songKey, clientId, score) {
  const { env } = context;
  const bucket = bucketOf(songKey);
  const detailKey = `${USER_PREFIX}${bucket}.json`;
  const aggKey = `${AGG_PREFIX}${bucket}.json`;
  const now = new Date().toISOString();
  const owner = clientId || `anon:${bucket}`;

  // 第一次构建时顺手记下这位访客原先的评分，聚合需要用它算 delta。
  let previous = 0;
  const detail = await writeShard(env, detailKey, DETAIL_WRITE_ATTEMPTS, function (shard) {
    const details = { ...detailsOf(shard) };
    const own = details[owner] && typeof details[owner] === 'object' ? { ...details[owner] } : {};
    previous = ownScoreOf({ [owner]: own }, owner, songKey);
    if (score > 0) own[songKey] = { score, at: now };
    else delete own[songKey];
    if (Object.keys(own).length) details[owner] = own;
    else delete details[owner];
    return { payload: { v: STORAGE_VERSION, details, updatedAt: now } };
  });
  if (detail.conflict) return { ok: false, error: 'rating write conflict, please retry' };
  if (!detail.payload) return { ok: false, error: 'rating store is full for this shard' };

  let aggregate = null;
  const agg = await writeShard(env, aggKey, AGG_WRITE_ATTEMPTS, function (shard) {
    const songs = { ...songsOf(shard) };
    const rawEntry = songs[songKey] && typeof songs[songKey] === 'object' ? songs[songKey] : {};
    const distribution = { ...(rawEntry.distribution && typeof rawEntry.distribution === 'object' ? rawEntry.distribution : {}) };
    const total = (Number(rawEntry.total) || 0) - previous + score;
    const count = (Number(rawEntry.count) || 0) + (previous > 0 ? 0 : 1) - (score > 0 ? 0 : 1);
    if (previous > 0) {
      const key = String(previous);
      const left = (Number(distribution[key]) || 0) - 1;
      if (left > 0) distribution[key] = left;
      else delete distribution[key];
    }
    if (score > 0) distribution[String(score)] = (Number(distribution[String(score)]) || 0) + 1;
    if (total > 0 && count > 0) songs[songKey] = { total, count, distribution, updatedAt: now };
    else delete songs[songKey];
    aggregate = aggregateEntry(songs[songKey]);
    return { payload: { v: STORAGE_VERSION, songs, updatedAt: now }, aggregate };
  });
  if (agg.conflict) return { ok: false, error: 'rating is busy, please retry' };
  if (!agg.payload) return { ok: false, error: 'rating store is full for this shard' };

  return { ok: true, bucket, score, previous, aggregate: agg.aggregate || aggregate };
}

// 批量读：同一分片里的多首歌只读一对文件，前端一次请求就能铺满整屏卡片。
export async function readRatings(context, songKeys, clientId) {
  const { env } = context;
  if (!songKeys.length) return {};
  const bucket = bucketOf(songKeys[0]);
  const [aggShard, detailShard] = await Promise.all([
    readShard(env, `${AGG_PREFIX}${bucket}.json`),
    clientId ? readShard(env, `${USER_PREFIX}${bucket}.json`) : Promise.resolve({ data: null, etag: '' }),
  ]);
  const songs = songsOf(aggShard.data);
  const details = detailsOf(detailShard.data);
  const result = {};
  for (const songKey of songKeys) {
    result[songKey] = {
      bucket,
      average: aggregateEntry(songs[songKey]),
      own: clientId ? ownScoreOf(details, clientId, songKey) : 0,
    };
  }
  return result;
}

export { DEFAULT_SALT as RATING_DEFAULT_SALT };
