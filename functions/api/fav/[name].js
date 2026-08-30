// /api/fav/<name> - 中意清单存档（访客用清单名区分，公开读写）
// GET 读、PUT 写（覆盖）。存储到 R2 的 fav/<name>.json。
const PREFIX = 'fav/';

export async function onRequestGet(context) {
  const { env, params } = context;
  let name = params.name;
  if (!name) return new Response('not found', { status: 404 });
  try { name = decodeURIComponent(name); } catch (e) { /* keep */ }
  const obj = await env.xsl_buttons.get(PREFIX + name);
  if (!obj) return new Response(JSON.stringify({ error: 'no such list' }), { status: 404, headers: { 'content-type': 'application/json' } });
  return new Response(obj.body, {
    status: 200,
    headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' },
  });
}

export async function onRequestPut(context) {
  const { request, env, params } = context;
  let name = params.name;
  if (!name) return new Response('bad request', { status: 400 });
  try { name = decodeURIComponent(name); } catch (e) { /* keep */ }
  let data = null;
  try { data = await request.json(); } catch (e) { /* ignore */ }
  if (!data || typeof data !== 'object') {
    return new Response(JSON.stringify({ error: 'invalid data' }), { status: 400, headers: { 'content-type': 'application/json' } });
  }
  // 检查是否已存在同名（用于前端提示覆盖）
  const existing = await env.xsl_buttons.get(PREFIX + name);
  const payload = { name, songs: data.songs || {}, savedAt: new Date().toISOString() };
  await env.xsl_buttons.put(PREFIX + name, JSON.stringify(payload), {
    httpMetadata: { contentType: 'application/json' },
  });
  return new Response(JSON.stringify({ ok: true, name, exists: !!existing }), {
    status: 200,
    headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' },
  });
}
