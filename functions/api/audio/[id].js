// /api/audio/<id> - 单个音频对象
// GET 公开（游客可播放）；PUT 上传、DELETE 删除（需管理员 token）
import { isAdmin, unauth } from '../../_auth.js';

const AUDIO_PREFIX = 'audio/';

export async function onRequestGet(context) {
  const { env, params } = context;
  const id = params.id;
  if (!id) return new Response('not found', { status: 404 });
  const obj = await env.xsl_buttons.get(AUDIO_PREFIX + id);
  if (!obj) return new Response('not found', { status: 404 });
  const headers = new Headers();
  if (obj.httpMetadata && obj.httpMetadata.contentType) {
    headers.set('content-type', obj.httpMetadata.contentType);
  } else {
    headers.set('content-type', 'audio/mpeg');
  }
  // 允许跨域读取 + 支持音频范围请求
  headers.set('accept-ranges', 'bytes');
  headers.set('access-control-allow-origin', '*');
  return new Response(obj.body, { status: 200, headers });
}

export async function onRequestPut(context) {
  const { request, env, params } = context;
  if (!(await isAdmin(env, request))) return unauth();
  const id = params.id;
  if (!id) return new Response('bad request', { status: 400 });
  const contentType = request.headers.get('content-type') || 'audio/mpeg';
  const blob = await request.arrayBuffer();
  await env.xsl_buttons.put(AUDIO_PREFIX + id, blob, {
    httpMetadata: { contentType },
  });
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

export async function onRequestDelete(context) {
  const { request, env, params } = context;
  if (!(await isAdmin(env, request))) return unauth();
  const id = params.id;
  if (!id) return new Response('bad request', { status: 400 });
  await env.xsl_buttons.delete(AUDIO_PREFIX + id);
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}
