// /api/login - 管理员登录，校验账号密码后签发 token
import { makeToken } from '../_auth.js';

export async function onRequestPost(context) {
  const { request, env } = context;
  let body = {};
  try { body = await request.json(); } catch (e) { /* ignore */ }
  const user = String(body.user || '').trim();
  const pass = String(body.pass || '');
  const token = await makeToken(env, user, pass);
  if (!token) {
    return new Response(JSON.stringify({ error: '用户名或密码错误' }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    });
  }
  return new Response(JSON.stringify({ ok: true, token }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}
