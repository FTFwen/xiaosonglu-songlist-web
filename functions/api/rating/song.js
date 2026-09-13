// /api/rating/song - 单曲/批量评分读写（公开）
// GET  ?key=<歌名>&key=<歌名>...   一次最多 64 首，返回平均分/人数/分布 + 当前访客自己的评分
// PUT  { key, score }              写入单曲评分；score 为 0/2/4/6/8/10，0 表示撤销（需 confirmRemove）
//
// 访客身份用 Cloudflare 注入的 CF-Connecting-IP（见 functions/_rating.js），
// 落盘前经盐值哈希，R2 里不出现明文 IP。
import {
  applyRating,
  clientIdOf,
  json,
  normalizeScore,
  normalizeSongKey,
  readRatings,
  requestKeyOf,
} from '../../_rating.js';

const MAX_KEYS_PER_REQUEST = 64;
// 同一访客两次评分之间的最小间隔，防连点与脚本刷分。
const COOLDOWN_MS = 800;
const MAX_PAYLOAD_BYTES = 4096;

export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const keys = [];
  const seen = new Set();
  for (const raw of url.searchParams.getAll('key')) {
    const songKey = normalizeSongKey(raw);
    if (!songKey || seen.has(songKey)) continue;
    seen.add(songKey);
    keys.push(songKey);
  }
  if (!keys.length) return json({ error: 'invalid key' }, 400);
  if (keys.length > MAX_KEYS_PER_REQUEST) return json({ error: 'too many keys' }, 400);

  const clientId = clientIdOf(context);
  const items = await readRatings(context, keys, clientId);
  return json({
    ok: true,
    items,
    // 拿不到 CF-Connecting-IP 时只能匿名只读，前端据此关掉打分交互。
    identified: !!clientId,
  });
}

export async function onRequestPut(context) {
  const { request } = context;
  const declaredLength = Number(request.headers.get('content-length') || 0);
  if (declaredLength > MAX_PAYLOAD_BYTES) return json({ error: 'payload too large' }, 413);

  // 先取 URL/头里的 key，再读 body：body 是流，读掉就没了。
  let songKey = requestKeyOf(context);

  let body = null;
  try { body = await request.json(); } catch (error) { /* handled below */ }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return json({ error: 'invalid payload' }, 400);
  }
  const bodyKey = normalizeSongKey(body.key);
  if (songKey && bodyKey && bodyKey !== songKey) return json({ error: 'key mismatch' }, 400);
  songKey = songKey || bodyKey;
  if (!songKey) return json({ error: 'invalid key' }, 400);

  const score = normalizeScore(body.score);
  if (score === null) return json({ error: 'invalid score' }, 400);
  if (score === 0 && body.confirmRemove !== true) {
    return json({ error: 'removal requires confirmRemove' }, 400);
  }

  const clientId = clientIdOf(context);
  if (!clientId) return json({ error: 'cannot identify client ip' }, 400);

  const now = Date.now();
  const last = recentWrites.get(clientId) || 0;
  if (now - last < COOLDOWN_MS) {
    return json({ error: 'too many requests', retryAfterMs: COOLDOWN_MS - (now - last) }, 429);
  }
  recentWrites.set(clientId, now);
  if (recentWrites.size > 5000) {
    for (const [key, value] of recentWrites) {
      if (now - value > 10 * 60 * 1000) recentWrites.delete(key);
    }
  }

  const result = await applyRating(context, songKey, clientId, score);
  if (!result.ok) return json({ error: result.error }, 409);
  return json({
    ok: true,
    songKey,
    bucket: result.bucket,
    score: result.score,
    previous: result.previous,
    average: result.aggregate,
    own: result.score,
    identified: true,
  });
}

// 同一 worker 实例内的轻量节流表；多实例并存时只是放宽，不构成正确性依赖。
const recentWrites = new Map();
