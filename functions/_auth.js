// _auth.js - Pages Functions 共享鉴权模块（`_` 前缀不会被注册为路由，可 import）
// 管理员账号列表 + HMAC token：登录校验后签发，写操作带 Bearer header
// 默认账号：文/0212、咸鱼/xsl。可通过 CF Secret BUTTONS_ADMIN_ACCOUNTS(JSON数组) 覆盖。
const DEFAULT_ADMINS = [
  { user: '文', pass: '0212' },
  { user: '咸鱼', pass: 'xsl' },
];
const DEFAULT_SECRET = 'xsl-buttons-secret-2026'; // 建议在 Pages 项目设置 Secrets 里覆盖为随机值
const TTL_SECONDS = 7 * 24 * 3600; // token 有效 7 天

function secret(env) { return env.BUTTONS_ADMIN_SECRET || DEFAULT_SECRET; }
// 解析管理员账号列表：优先 Secret JSON 数组；否则兼容旧单账号环境变量；兜底默认列表
function admins(env) {
  if (env.BUTTONS_ADMIN_ACCOUNTS) {
    try {
      const arr = JSON.parse(env.BUTTONS_ADMIN_ACCOUNTS);
      if (Array.isArray(arr) && arr.length) {
        return arr.filter(a => a && a.user && a.pass);
      }
    } catch (e) { /* ignore malformed */ }
  }
  if (env.BUTTONS_ADMIN_USER && env.BUTTONS_ADMIN_PASS) {
    return [{ user: env.BUTTONS_ADMIN_USER, pass: env.BUTTONS_ADMIN_PASS }];
  }
  return DEFAULT_ADMINS;
}

function b64encode(buf) {
  let bin = '';
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}
function b64decode(str) {
  const bin = atob(str);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

async function hmac(env, msg) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret(env)),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg));
  return b64encode(sig);
}

// 校验管理员账号密码，成功返回 token（否则 null）
export async function makeToken(env, user, pass) {
  const list = admins(env);
  if (!list.some(a => a.user === user && a.pass === pass)) return null;
  const exp = Math.floor(Date.now() / 1000) + TTL_SECONDS;
  const payload = b64encode(new TextEncoder().encode(JSON.stringify({ u: user, exp })));
  const sig = await hmac(env, payload);
  return `${payload}.${sig}`;
}

// 校验 Bearer token，成功返回 true
export async function checkToken(env, request) {
  const auth = request.headers.get('Authorization') || '';
  const m = auth.match(/^Bearer\s+(.+)$/);
  if (!m) return false;
  const token = m[1];
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return false;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expect = await hmac(env, payload);
  if (expect !== sig) return false;
  try {
    const data = JSON.parse(new TextDecoder().decode(b64decode(payload)));
    if (!data.exp || data.exp < Math.floor(Date.now() / 1000)) return false;
    return true;
  } catch (e) {
    return false;
  }
}

// 便捷：校验请求是否为管理员（写操作调用）
export async function isAdmin(env, request) {
  return checkToken(env, request);
}

// 返回 401 响应
export function unauth() {
  return new Response(JSON.stringify({ error: 'unauthorized' }), {
    status: 401,
    headers: { 'content-type': 'application/json' },
  });
}
