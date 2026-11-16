// Public shared lyric calibration. One latest object per stable catalog row, no visitor identity.
const MAX_BODY_BYTES = 4096;
const WRITE_ATTEMPTS = 12;
const KEY_PATTERN = /^(song|derivative)-([1-9]\d{0,14})$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;

class ApiError extends Error {
  constructor(status, code) { super(code); this.status = status; }
}

function allowedOrigin(request) {
  const origin = request.headers.get('origin');
  if (origin === null) return '';
  let parsed;
  try { parsed = new URL(origin); } catch { throw new ApiError(403, 'forbidden_origin'); }
  if (parsed.origin !== origin) throw new ApiError(403, 'forbidden_origin');
  if (origin === new URL(request.url).origin || [
    'https://viridis.love', 'https://xsl-songlist.pages.dev', 'https://workshop.viridis.love',
  ].includes(origin) || /^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.xsl-songlist\.pages\.dev$/.test(origin)) return origin;
  throw new ApiError(403, 'forbidden_origin');
}

function response(data, status, origin, extra = {}) {
  return new Response(data === null ? null : JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      vary: 'Origin',
      ...(origin ? { 'access-control-allow-origin': origin } : {}),
      ...extra,
    },
  });
}

function checkKey(key) {
  if (typeof key !== 'string' || !KEY_PATTERN.test(key)) throw new ApiError(400, 'invalid_key');
  return key;
}

function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function validRowKey(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 1024 &&
    value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);
}
function validSource(value) { return Number.isSafeInteger(value) && value > 0; }
function validOffset(value) { return typeof value === 'number' && Number.isFinite(value) && value >= -600 && value <= 600; }
function normalizeOffset(value) { return Math.round(value * 1000) / 1000 || 0; }

async function readBody(request) {
  if ((request.headers.get('content-type') || '').split(';')[0].trim().toLowerCase() !== 'application/json') {
    throw new ApiError(415, 'json_required');
  }
  const length = request.headers.get('content-length');
  if (length !== null && Number(length) > MAX_BODY_BYTES) throw new ApiError(413, 'payload_too_large');
  if (!request.body) throw new ApiError(400, 'invalid_json');
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        // Do not wait on a potentially unbounded sender before responding.
        void reader.cancel().catch(() => {});
        throw new ApiError(413, 'payload_too_large');
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!object(body)) throw new ApiError(400, 'invalid_payload');
    return body;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(400, 'invalid_json');
  } finally { reader.releaseLock(); }
}

async function canonicalOf(context, key) {
  if (typeof context.env?.ASSETS?.fetch !== 'function') throw new ApiError(503, 'catalog_unavailable');
  let asset;
  let data;
  try {
    // Always root-relative: a nested API route must not change the asset path.
    const url = new URL(`/data/lyrics/tracks/${key}.json`, context.request.url);
    asset = await context.env.ASSETS.fetch(new Request(url, { headers: { accept: 'application/json' } }));
    if (asset.status === 404) throw new ApiError(404, 'not_found');
    if (!asset.ok) throw new ApiError(503, 'catalog_unavailable');
    data = await asset.json();
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(503, 'catalog_unavailable');
  }
  const [, kind, id] = KEY_PATTERN.exec(key);
  const expectedId = Number(id) * (kind === 'derivative' ? -1 : 1);
  if (!object(data) || data.key !== key || data.songId !== expectedId || !validRowKey(data.rowKey) ||
      !object(data.match) || typeof data.match.status !== 'string') throw new ApiError(503, 'catalog_invalid');
  if (!['matched', 'candidate', 'candidate_review_required', 'version_review_required'].includes(data.match.status)) throw new ApiError(409, 'lyrics_unavailable');
  if (!object(data.audio) || typeof data.audio.sha256 !== 'string' || !HASH_PATTERN.test(data.audio.sha256) || !validSource(data.match.sourceId)) {
    throw new ApiError(503, 'catalog_invalid');
  }
  return { key, rowKey: data.rowKey, audioSha256: data.audio.sha256, sourceId: data.match.sourceId };
}

async function storageKey(rowKey) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(rowKey));
  return `lyrics-offset/v1/${Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('')}.json`;
}

function bucketOf(context) {
  const bucket = context.env?.xsl_buttons;
  if (typeof bucket?.get !== 'function' || typeof bucket?.put !== 'function') throw new ApiError(503, 'storage_unavailable');
  return bucket;
}

async function snapshot(bucket, key) {
  try {
    const entry = await bucket.get(key);
    if (!entry) return { record: null, etag: null };
    const etag = entry.etag || entry.httpEtag?.replace(/^"|"$/g, '');
    if (!etag) throw new Error('missing etag');
    return { record: JSON.parse(await entry.text()), etag };
  } catch { throw new ApiError(503, 'storage_unavailable'); }
}

function currentRecord(record, canonical) {
  if (!object(record) || record.rowKey !== canonical.rowKey || record.audioSha256 !== canonical.audioSha256 ||
      record.sourceId !== canonical.sourceId || !validOffset(record.offsetSeconds) ||
      normalizeOffset(record.offsetSeconds) !== record.offsetSeconds ||
      typeof record.updatedAt !== 'string' || !Number.isFinite(Date.parse(record.updatedAt))) return null;
  // Project only public fields. An ID renumber keeps the stable row's calibration, but returns the current key.
  return { ...canonical, offsetSeconds: record.offsetSeconds, updatedAt: record.updatedAt };
}

async function writeRecord(context, canonical, offsetSeconds) {
  const bucket = bucketOf(context);
  const key = await storageKey(canonical.rowKey);
  for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt++) {
    if (attempt) await new Promise(resolve => setTimeout(resolve, Math.min(80, 2 ** attempt) + Math.floor(Math.random() * 8)));
    const previous = await snapshot(bucket, key);
    // Recheck on CAS retries: a newer catalog must not be overwritten using stale audio/source metadata.
    const latest = attempt ? await canonicalOf(context, canonical.key) : canonical;
    if (latest.rowKey !== canonical.rowKey || latest.audioSha256 !== canonical.audioSha256 || latest.sourceId !== canonical.sourceId) {
      throw new ApiError(409, 'version_mismatch');
    }
    const record = { ...canonical, offsetSeconds, updatedAt: new Date().toISOString() };
    let written;
    try {
      written = await bucket.put(key, JSON.stringify(record), {
        onlyIf: previous.etag ? { etagMatches: previous.etag } : { etagDoesNotMatch: '*' },
        httpMetadata: { contentType: 'application/json', cacheControl: 'no-store' },
      });
    } catch { throw new ApiError(503, 'storage_unavailable'); }
    if (written) return record;
  }
  throw new ApiError(503, 'storage_busy');
}

export async function onRequest(context) {
  let origin = '';
  try {
    origin = allowedOrigin(context.request);
    const method = context.request.method;
    if (method === 'OPTIONS') return response(null, 204, origin, {
      'access-control-allow-methods': 'GET, PUT, OPTIONS',
      'access-control-allow-headers': 'Content-Type',
    });
    if (method !== 'GET' && method !== 'PUT') return response({ ok: false, error: 'method_not_allowed' }, 405, origin, { allow: 'GET, PUT, OPTIONS' });
    const body = method === 'PUT' ? await readBody(context.request) : null;
    const url = new URL(context.request.url);
    const key = checkKey(body ? body.key : url.searchParams.get('key'));
    if (!body && url.searchParams.getAll('key').length !== 1) throw new ApiError(400, 'invalid_key');
    if (body && (!validRowKey(body.rowKey) || typeof body.audioSha256 !== 'string' || !HASH_PATTERN.test(body.audioSha256) ||
        !validSource(body.sourceId) || !validOffset(body.offsetSeconds))) throw new ApiError(400, 'invalid_payload');
    const canonical = await canonicalOf(context, key);
    if (body) {
      if (body.rowKey !== canonical.rowKey || body.audioSha256 !== canonical.audioSha256 || body.sourceId !== canonical.sourceId) {
        throw new ApiError(409, 'version_mismatch');
      }
      const record = await writeRecord(context, canonical, normalizeOffset(body.offsetSeconds));
      return response({ ok: true, record }, 200, origin);
    }
    const stored = await snapshot(bucketOf(context), await storageKey(canonical.rowKey));
    return response({ ok: true, record: currentRecord(stored.record, canonical) }, 200, origin);
  } catch (error) {
    return response({ ok: false, error: error instanceof ApiError ? error.message : 'service_unavailable' },
      error instanceof ApiError ? error.status : 503, origin);
  }
}
