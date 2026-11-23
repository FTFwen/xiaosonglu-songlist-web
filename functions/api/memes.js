const key = 'memes/v1/state.json';
const methods = 'GET, POST, OPTIONS';
const limit = 32 * 1024;
const catalogLimit = 1024 * 1024;
const stateLimit = 4 * 1024 * 1024;
const maxCatalogRows = 512;
const maxSubmissions = 5000;
const encoder = new TextEncoder();
const firstId = 1_000_000;

class ApiError extends Error {
  constructor(status, code) { super(code); this.status = status; }
}

const normalize = value => value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase();
const validId = value => Number.isSafeInteger(value) && value > 0;

function response(status, body, origin, extra = {}) {
  const payload = body === null ? null : JSON.stringify(body).replace(/[<>&\u2028\u2029]/g, char =>
    `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
  return new Response(payload, { status, headers: {
    'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', vary: 'Origin',
    'x-content-type-options': 'nosniff',
    ...(origin ? { 'access-control-allow-origin': origin } : {}), ...extra,
  } });
}

async function readJsonStream(message, maxBytes, tooLarge) {
  if (Number(message.headers.get('content-length')) > maxBytes) throw tooLarge;
  if (!message.body) throw new SyntaxError('Missing body');
  const reader = message.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let size = 0;
  let text = '';
  let doneReading = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw tooLarge;
      text += decoder.decode(value, { stream: true });
    }
    doneReading = true;
    return JSON.parse(text + decoder.decode());
  } finally {
    if (!doneReading) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function parseBody(request) {
  if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    throw new ApiError(415, 'json_required');
  }
  try {
    return await readJsonStream(request, limit, new ApiError(413, 'payload_too_large'));
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(400, 'invalid_json');
  }
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
  let res;
  try {
    res = await assets.fetch(new Request(new URL('/memes/seed.json', request.url)));
    if (!res.ok) throw new Error('Catalog fetch failed');
  } catch { throw new ApiError(503, 'catalog_unavailable'); }
  const invalid = new ApiError(503, 'catalog_invalid');
  let rows;
  try { rows = await readJsonStream(res, catalogLimit, invalid); }
  catch { throw invalid; }
  if (!Array.isArray(rows) || !rows.length || rows.length > maxCatalogRows || !validRows(rows, false)) throw invalid;
  return rows;
}

async function readState(bucket) {
  const invalid = new ApiError(503, 'storage_unavailable');
  let record;
  try { record = await bucket.get(key); }
  catch { throw new ApiError(503, 'service_unavailable'); }
  if (!record) return { state: { version: 1, submissions: [], copies: {} }, etag: null };
  const etag = record.etag || record.httpEtag?.replace(/^"|"$/g, '');
  if (!etag || record.size > stateLimit) throw invalid;
  let state;
  try {
    const text = await record.text();
    if (encoder.encode(text).byteLength > stateLimit) throw invalid;
    state = JSON.parse(text);
  } catch { throw invalid; }
  if (state?.version !== 1 || !Array.isArray(state.submissions) || state.submissions.length > maxSubmissions ||
      !validRows(state.submissions, true) || !state.copies || typeof state.copies !== 'object' ||
      Array.isArray(state.copies) || !Object.entries(state.copies).every(([id, count]) =>
        /^[1-9]\d*$/.test(id) && validId(Number(id)) && Number.isSafeInteger(count) && count >= 0)) throw invalid;
  return { state, etag };
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
  if (state.submissions.length >= maxSubmissions) throw new ApiError(503, 'storage_full');
  const labels = new Map();
  let id = firstId;
  for (const row of rows) {
    id = Math.max(id, row.id + 1);
    for (const tag of row.tags) if (!labels.has(normalize(tag))) labels.set(normalize(tag), tag);
  }
  if (!validId(id)) throw new ApiError(503, 'storage_full');
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
    const url = new URL(request.url);
    const target = url.origin;
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
    if (!action && url.searchParams.get('view') === 'counts') {
      const { state } = await readState(bucket);
      return response(200, { ok: true, copies: state.copies }, origin);
    }
    const [seed, initial] = await Promise.all([readCatalog(request, env.ASSETS), readState(bucket)]);
    if (!action) {
      const { state } = initial;
      const entries = [...seed, ...state.submissions].map(({ id, date, text, tags }) => ({ id, date, text, tags, copies: state.copies[id] ?? 0 }));
      return response(200, { ok: true, entries }, origin);
    }
    for (let attempt = 0; attempt < 10; attempt++) {
      if (attempt) await new Promise(resolve => setTimeout(resolve, Math.min(50, 2 ** attempt) + Math.random() * 10));
      const { state, etag } = attempt === 0 ? initial : await readState(bucket);
      const { status, ...result } = mutate(seed, state, action);
      const serialized = JSON.stringify(state);
      if (encoder.encode(serialized).byteLength > stateLimit) throw new ApiError(503, 'storage_full');
      const saved = await bucket.put(key, serialized, {
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
