// /api/data - 读取/保存按钮墙元数据（分类+按钮 meta），存 R2 的 `meta` key
// GET 公开（游客也能看到列表）；PUT 需管理员 token
import { isAdmin, unauth } from '../_auth.js';

const META_KEY = 'meta';
const DEFAULT_META = {
  cats: [
    { id: 'mdichang', name: '名场面' },
    { id: 'bdong', name: 'b动静' },
    { id: 'nangyang', name: '娘养' },
    { id: 'other', name: '其他' }
  ],
  buttons: []
};

export async function onRequestGet(context) {
  const { env } = context;
  const obj = await env.xsl_buttons.get(META_KEY);
  if (!obj) {
    return new Response(JSON.stringify(DEFAULT_META), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }
  return new Response(obj.body, {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

export async function onRequestPut(context) {
  const { request, env } = context;
  if (!(await isAdmin(env, request))) return unauth();
  let meta = null;
  try { meta = await request.json(); } catch (e) { /* ignore */ }
  if (!meta || typeof meta !== 'object' || !Array.isArray(meta.cats) || !Array.isArray(meta.buttons)) {
    return new Response(JSON.stringify({ error: 'invalid meta' }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });
  }
  await env.xsl_buttons.put(META_KEY, JSON.stringify(meta), {
    httpMetadata: { contentType: 'application/json' },
  });
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}
