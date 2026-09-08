// /api/fav/<name> - 中意清单存档（访客用清单名区分，公开读写）
// GET 读、PUT 写（覆盖）。存储到 R2 的 fav/<name>.json。
const PREFIX = 'fav/';
const MAX_NAME_LENGTH = 30;
const MAX_PAYLOAD_BYTES = 1024 * 1024;

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'access-control-allow-origin': '*',
  'access-control-expose-headers': 'etag',
  'cache-control': 'no-store',
};

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), { status, headers: { ...JSON_HEADERS, ...extraHeaders } });
}

function archiveNameOf(params) {
  // 当前 Pages worker 的路由匹配器把 pathname 中的参数原样交给函数，这里只解码一次。
  let name = String(params.name || '');
  try { name = decodeURIComponent(name); } catch (error) { /* malformed encoding is rejected below */ }
  name = name.trim();
  if (!name || [...name].length > MAX_NAME_LENGTH) return '';
  if (/[\\/\u0000-\u001f\u007f]/.test(name)) return '';
  return name;
}

function etagOf(object) {
  if (!object) return '';
  if (object.httpEtag) return object.httpEtag;
  return object.etag ? `"${object.etag}"` : '';
}

function jsonWithObjectEtag(data, object, status = 200) {
  const etag = etagOf(object);
  return json({ ...data, etag }, status, etag ? { etag } : {});
}

export async function onRequestGet(context) {
  const { env, params } = context;
  const name = archiveNameOf(params);
  if (!name) return json({ error: 'invalid name' }, 400);
  const obj = await env.xsl_buttons.get(PREFIX + name);
  if (!obj) return json({ error: 'no such list' }, 404);
  const etag = etagOf(obj);
  return new Response(obj.body, {
    status: 200,
    headers: { ...JSON_HEADERS, ...(etag ? { etag } : {}) }
  });
}

export async function onRequestPut(context) {
  const { request, env, params } = context;
  const name = archiveNameOf(params);
  if (!name) return json({ error: 'invalid name' }, 400);

  const declaredLength = Number(request.headers.get('content-length') || 0);
  if (declaredLength > MAX_PAYLOAD_BYTES) return json({ error: 'payload too large' }, 413);

  let data = null;
  try { data = await request.json(); } catch (error) { /* handled below */ }
  if (!data || typeof data !== 'object' || Array.isArray(data) ||
      !data.songs || typeof data.songs !== 'object' || Array.isArray(data.songs)) {
    return json({ error: 'invalid data' }, 400);
  }

  const payload = { name, songs: data.songs, savedAt: new Date().toISOString() };
  const body = JSON.stringify(payload);
  if (new TextEncoder().encode(body).byteLength > MAX_PAYLOAD_BYTES) {
    return json({ error: 'payload too large' }, 413);
  }

  const hasExpectedEtag = Object.prototype.hasOwnProperty.call(data, 'expectedEtag');
  const expectedEtag = data.expectedEtag == null ? '' : String(data.expectedEtag);
  let existing = null;
  let stored = null;

  if (!hasExpectedEtag) {
    existing = await env.xsl_buttons.head(PREFIX + name);
    stored = await env.xsl_buttons.put(PREFIX + name, body, {
      httpMetadata: { contentType: 'application/json' },
    });
  } else if (!expectedEtag) {
    stored = await env.xsl_buttons.put(PREFIX + name, body, {
      httpMetadata: { contentType: 'application/json' },
      onlyIf: { etagDoesNotMatch: '*' },
    });
    if (!stored) {
      const latest = await env.xsl_buttons.head(PREFIX + name);
      return jsonWithObjectEtag({ error: 'archive changed' }, latest, 409);
    }
  } else {
    stored = await env.xsl_buttons.put(PREFIX + name, body, {
      httpMetadata: { contentType: 'application/json' },
      onlyIf: { etagMatches: expectedEtag.replace(/^"|"$/g, '') },
    });
    if (!stored) {
      const latest = await env.xsl_buttons.head(PREFIX + name);
      return jsonWithObjectEtag({ error: 'archive changed' }, latest, 409);
    }
    existing = { etag: expectedEtag.replace(/^"|"$/g, '') };
  }

  return jsonWithObjectEtag({
    ok: true,
    name,
    exists: !!existing,
    savedAt: payload.savedAt,
  }, stored);
}
