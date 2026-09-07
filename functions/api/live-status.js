// /api/live-status - 为前端代理小松绿直播状态，统一提供 CORS 与短缓存。
const UPSTREAM_URL = 'https://api.sumire.live/api/live/viridis/status';

const RESPONSE_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, OPTIONS',
  'access-control-allow-headers': 'content-type',
  'cache-control': 'public, max-age=15, s-maxage=30, stale-while-revalidate=60',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: RESPONSE_HEADERS });
}

export function onRequestOptions() {
  return new Response(null, { status: 204, headers: RESPONSE_HEADERS });
}

export async function onRequestGet() {
  try {
    const response = await fetch(UPSTREAM_URL, {
      headers: { accept: 'application/json' },
      cf: { cacheEverything: true, cacheTtl: 30 },
    });
    if (!response.ok) throw new Error(`upstream ${response.status}`);

    const payload = await response.json();
    const status = payload && payload.status;
    if (!payload || payload.ok !== true || !status || typeof status.live !== 'boolean') {
      throw new Error('invalid upstream payload');
    }

    return json({
      ok: true,
      status: {
        live: status.live,
        title: typeof status.title === 'string' ? status.title.trim() : '',
        startedAt: typeof status.startedAt === 'string' ? status.startedAt : null,
      },
    });
  } catch (error) {
    console.warn('[live-status] upstream unavailable', error);
    return json({ ok: false, error: 'live_status_unavailable' }, 502);
  }
}
