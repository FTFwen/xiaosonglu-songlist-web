const key = 'memes/v1/state.json';
const methods = 'GET, POST, OPTIONS';
const limit = 8192;
const firstId = 1_000_000;

class ApiError extends Error {
  constructor(status, code) { super(code); this.status = status; }
}

const normalize = value => value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase();
const validId = value => Number.isSafeInteger(value) && value > 0;

function response(status, body, origin, extra = {}) {
  return new Response(body === null ? null : JSON.stringify(body), { status, headers: {
    'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', vary: 'Origin',
    ...(origin ? { 'access-control-allow-origin': origin } : {}), ...extra,
  } });
}

async function parseBody(request) {
  if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    throw new ApiError(415, 'json_required');
  }
  if (Number(request.headers.get('content-length')) > limit) throw new ApiError(413, 'payload_too_large');
  if (!request.body) throw new ApiError(400, 'invalid_json');
  const reader = request.body.getReader();
  const bytes = new Uint8Array(limit);
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (size + value.byteLength > limit) {
        void reader.cancel().catch(() => {});
        throw new ApiError(413, 'payload_too_large');
      }
      bytes.set(value, size);
      size += value.byteLength;
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size)));
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(400, 'invalid_json');
  } finally { reader.releaseLock(); }
}

function actionOf(body) {
  if (body?.action === 'copy') {
    if (!validId(body.id)) throw new ApiError(400, 'invalid_id');
    return { type: 'copy', id: body.id };
  }
  if (body?.action !== 'submit') throw new ApiError(400, 'invalid_action');
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (!text || [...text].length > 2000 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(text)) throw new ApiError(400, 'invalid_text');
  if (!Array.isArray(body.tags) || !body.tags.length || body.tags.length > 8) throw new ApiError(400, 'invalid_tags');
  const tags = new Map();
  for (const value of body.tags) {
    const tag = typeof value === 'string' ? value.trim().replace(/\s+/gu, ' ') : '';
    if (!tag || [...tag].length > 24 || /[\x00-\x1f\x7f]/u.test(tag)) throw new ApiError(400, 'invalid_tags');
    if (!tags.has(normalize(tag))) tags.set(normalize(tag), tag);
  }
  return { type: 'submit', text, tags };
}

function validRows(rows, submitted) {
  return Array.isArray(rows) && rows.every(row => validId(row?.id) &&
    (submitted ? row.id >= firstId : row.id < firstId) &&
    typeof row.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(row.date) &&
    typeof row.text === 'string' && row.text.trim() && Array.isArray(row.tags) &&
    row.tags.length && row.tags.every(tag => typeof tag === 'string' && tag.trim())) &&
    new Set(rows.map(row => row.id)).size === rows.length;
}

async function readCatalog(request, assets) {
  const res = await assets.fetch(new Request(new URL('/memes/seed.json', request.url)));
  if (!res.ok) throw new ApiError(503, 'catalog_unavailable');
  const rows = await res.json();
  if (!validRows(rows, false) || !rows.length) throw new ApiError(503, 'catalog_invalid');
  return rows;
}

async function readState(bucket) {
  const record = await bucket.get(key);
  if (!record) return { state: { version: 1, submissions: [], copies: {} }, etag: null };
  const state = JSON.parse(await record.text());
  if (!record.etag || state?.version !== 1 || !validRows(state.submissions, true) ||
      !state.copies || typeof state.copies !== 'object' || Array.isArray(state.copies) ||
      !Object.entries(state.copies).every(([id, count]) => /^[1-9]\d*$/.test(id) && Number.isSafeInteger(count) && count >= 0)) {
    throw new ApiError(503, 'storage_unavailable');
  }
  return { state, etag: record.etag };
}

function mutate(seed, state, action) {
  const rows = [...seed, ...state.submissions];
  if (action.type === 'copy') {
    if (!rows.some(row => row.id === action.id)) throw new ApiError(404, 'not_found');
    const copies = (state.copies[action.id] ?? 0) + 1;
    if (!Number.isSafeInteger(copies)) throw new ApiError(503, 'storage_unavailable');
    state.copies[action.id] = copies;
    return { status: 200, copies };
  }
  if (rows.some(row => normalize(row.text) === normalize(action.text))) throw new ApiError(409, 'duplicate_text');
  if (state.submissions.length >= 5000) throw new ApiError(503, 'storage_full');
  const labels = new Map();
  let id = firstId;
  for (const row of rows) {
    id = Math.max(id, row.id + 1);
    for (const tag of row.tags) if (!labels.has(normalize(tag))) labels.set(normalize(tag), tag);
  }
  const entry = {
    id, date: new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10), text: action.text,
    tags: Array.from(action.tags, ([normalized, label]) => labels.get(normalized) ?? label),
  };
  state.submissions.push(entry);
  return { status: 201, entry: { ...entry, copies: 0 } };
}

export async function onRequest({ request, env }) {
  let origin = '';
  try {
    const sent = request.headers.get('origin');
    const target = new URL(request.url).origin;
    // The production reverse proxy rewrites Host and preserves the browser Origin.
    const proxied = sent === 'https://viridis.love' && target === 'https://xsl-songlist.pages.dev';
    if (sent !== null && sent !== target && !proxied) throw new ApiError(403, 'forbidden_origin');
    origin = sent || '';
    const method = request.method;
    if (method === 'OPTIONS') return response(204, null, origin, {
      'access-control-allow-methods': methods, 'access-control-allow-headers': 'Content-Type',
    });
    if (method !== 'GET' && method !== 'POST') throw new ApiError(405, 'method_not_allowed');
    if (method === 'POST' && !origin) throw new ApiError(403, 'forbidden_origin');
    const action = method === 'POST' ? actionOf(await parseBody(request)) : null;
    const bucket = env?.xsl_buttons;
    if (typeof bucket?.get !== 'function' || typeof bucket?.put !== 'function') throw new ApiError(503, 'storage_unavailable');
    const seed = await readCatalog(request, env.ASSETS);
    if (!action) {
      const { state } = await readState(bucket);
      const entries = [...seed, ...state.submissions].map(({ id, date, text, tags }) => ({ id, date, text, tags, copies: state.copies[id] ?? 0 }));
      return response(200, { ok: true, entries }, origin);
    }
    for (let attempt = 0; attempt < 10; attempt++) {
      if (attempt) await new Promise(resolve => setTimeout(resolve, Math.min(50, 2 ** attempt) + Math.random() * 10));
      const { state, etag } = await readState(bucket);
      const { status, ...result } = mutate(seed, state, action);
      const saved = await bucket.put(key, JSON.stringify(state), {
        onlyIf: etag ? { etagMatches: etag } : { etagDoesNotMatch: '*' },
        httpMetadata: { contentType: 'application/json', cacheControl: 'no-store' },
      });
      if (saved) return response(status, { ok: true, ...result }, origin);
    }
    throw new ApiError(503, 'storage_busy');
  } catch (error) {
    const status = error instanceof ApiError ? error.status : 503;
    return response(status, { ok: false, error: error instanceof ApiError ? error.message : 'service_unavailable' },
      origin, status === 405 ? { allow: methods } : {});
  }
}
