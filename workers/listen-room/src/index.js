import {
  HOST_GRACE_MS,
  IDLE_TTL_MS,
  MAX_CONNECTIONS,
  MAX_MESSAGE_BYTES,
  MAX_TTL_MS,
  jsonResponse,
  makeRoomCode,
  normalizePlaybackState,
  normalizeRoomCode,
  publicSnapshot,
} from './protocol.js';

const ROOM_KEY = 'room';
const ALARM_KIND_KEY = 'alarmKind';
const DEFAULT_ALLOWED_ORIGINS = ['https://viridis.love', 'https://www.viridis.love', 'https://xsl-songlist.pages.dev'];

function allowedOrigins(env) {
  const configured = String(env.ALLOWED_ORIGINS || '').split(',').map(value => value.trim()).filter(Boolean);
  return new Set(configured.length ? configured : DEFAULT_ALLOWED_ORIGINS);
}

function corsHeaders(request, env) {
  const origin = request.headers.get('origin') || '';
  return allowedOrigins(env).has(origin) ? { 'access-control-allow-origin': origin, vary: 'Origin' } : {};
}

function originAllowed(request, env) {
  const origin = request.headers.get('origin');
  return !origin || allowedOrigins(env).has(origin);
}

function randomToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

async function sha256(value) {
  const bytes = new TextEncoder().encode(String(value));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

function constantTimeEqual(left, right) {
  const a = String(left || '');
  const b = String(right || '');
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) difference |= a.charCodeAt(index) ^ b.charCodeAt(index);
  return difference === 0;
}

function parseRoomPath(pathname) {
  const match = pathname.match(/^\/rooms\/([^/]+)$/);
  return match ? normalizeRoomCode(match[1]) : '';
}

function safeSend(socket, message) {
  try {
    socket.send(JSON.stringify(message));
    return true;
  } catch (_) {
    return false;
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = corsHeaders(request, env);
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          ...cors,
          'access-control-allow-methods': 'GET, POST, OPTIONS',
          'access-control-allow-headers': 'content-type',
          'access-control-max-age': '86400',
        },
      });
    }
    if (!originAllowed(request, env)) return jsonResponse({ ok: false, error: 'origin_not_allowed' }, 403);
    if (request.method === 'GET' && url.pathname === '/health') {
      return jsonResponse({ ok: true, service: 'xsl-listen-room', now: Date.now() }, 200, cors);
    }
    if (request.method === 'POST' && url.pathname === '/rooms') {
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const roomCode = makeRoomCode();
        const stub = env.LISTEN_ROOMS.getByName(roomCode);
        const hostToken = randomToken();
        const response = await stub.fetch(new Request(`https://room.internal/create/${roomCode}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ hostToken, now: Date.now() }),
        }));
        if (response.status === 409) continue;
        if (!response.ok) return jsonResponse({ ok: false, error: 'room_create_failed' }, 502, cors);
        return jsonResponse({ ok: true, roomCode, hostToken, expiresInSeconds: MAX_TTL_MS / 1000 }, 201, cors);
      }
      return jsonResponse({ ok: false, error: 'room_code_exhausted' }, 503, cors);
    }
    const roomCode = parseRoomPath(url.pathname);
    if (request.method === 'GET' && roomCode) {
      if ((request.headers.get('upgrade') || '').toLowerCase() !== 'websocket') {
        return jsonResponse({ ok: false, error: 'websocket_required' }, 426, cors);
      }
      const role = url.searchParams.get('role') === 'host' ? 'host' : 'member';
      const proxyUrl = new URL(request.url);
      proxyUrl.hostname = 'room.internal';
      proxyUrl.pathname = `/connect/${roomCode}`;
      proxyUrl.search = '';
      proxyUrl.searchParams.set('role', role);
      return env.LISTEN_ROOMS.getByName(roomCode).fetch(new Request(proxyUrl, request));
    }
    return jsonResponse({ ok: false, error: 'not_found' }, 404, cors);
  },
};

export class ListenRoom {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === 'POST' && url.pathname.startsWith('/create/')) return this.create(request, url);
    if (request.method === 'GET' && url.pathname.startsWith('/connect/')) return this.connect(request, url);
    return jsonResponse({ ok: false, error: 'not_found' }, 404);
  }

  async create(request, url) {
    const roomCode = normalizeRoomCode(url.pathname.split('/').pop());
    if (!roomCode) return jsonResponse({ ok: false, error: 'invalid_room_code' }, 400);
    return this.ctx.blockConcurrencyWhile(async () => {
      if (await this.ctx.storage.get(ROOM_KEY)) return jsonResponse({ ok: false, error: 'room_exists' }, 409);
      let body;
      try { body = await request.json(); } catch (_) { body = null; }
      const hostToken = body && String(body.hostToken || '');
      if (!/^[0-9a-f]{64}$/.test(hostToken)) return jsonResponse({ ok: false, error: 'invalid_host_token' }, 400);
      const now = Date.now();
      const room = {
        schemaVersion: 1,
        roomCode,
        hostTokenHash: await sha256(hostToken),
        createdAt: now,
        lastActivityAt: now,
        absoluteExpiresAt: now + MAX_TTL_MS,
        hostDisconnectedAt: null,
        revision: 0,
        playback: null,
      };
      await this.ctx.storage.put(ROOM_KEY, room);
      await this.scheduleAlarm(room, now);
      return jsonResponse({ ok: true, roomCode }, 201);
    });
  }

  async connect(request, url) {
    const roomCode = normalizeRoomCode(url.pathname.split('/').pop());
    const room = await this.ctx.storage.get(ROOM_KEY);
    const now = Date.now();
    if (!room || room.roomCode !== roomCode || this.expired(room, now)) {
      if (room) await this.closeRoom('expired');
      return jsonResponse({ ok: false, error: 'room_not_found' }, 404);
    }
    if (this.ctx.getWebSockets().length >= MAX_CONNECTIONS) return jsonResponse({ ok: false, error: 'room_full' }, 429);
    const role = url.searchParams.get('role') === 'host' ? 'host' : 'member';
    room.lastActivityAt = now;
    await this.ctx.storage.put(ROOM_KEY, room);
    await this.scheduleAlarm(room, now);
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ role: role === 'host' ? 'pending-host' : 'member', joinedAt: now, lastMessageAt: 0 });
    if (role === 'member') {
      safeSend(server, { type: 'ready', role, roomCode, maxConnections: MAX_CONNECTIONS, serverNowMs: now });
      safeSend(server, { type: 'snapshot', state: publicSnapshot(room, now) });
      this.broadcastPresence();
    } else {
      safeSend(server, { type: 'auth_required', role: 'host', roomCode, serverNowMs: now });
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(socket, rawMessage) {
    if (typeof rawMessage !== 'string' || new TextEncoder().encode(rawMessage).byteLength > MAX_MESSAGE_BYTES) {
      safeSend(socket, { type: 'error', code: 'invalid_message', message: '消息格式不正确。' });
      return;
    }
    let message;
    try { message = JSON.parse(rawMessage); } catch (_) { message = null; }
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      safeSend(socket, { type: 'error', code: 'invalid_message', message: '消息格式不正确。' });
      return;
    }
    const attachment = socket.deserializeAttachment() || { role: 'member', lastMessageAt: 0 };
    const now = Date.now();
    if (now - Number(attachment.lastMessageAt || 0) < 100) {
      safeSend(socket, { type: 'error', code: 'rate_limited', message: '操作太快啦，请稍后再试。' });
      return;
    }
    attachment.lastMessageAt = now;
    socket.serializeAttachment(attachment);
    if (attachment.role === 'pending-host') {
      if (message.type !== 'hello' || !/^[0-9a-f]{64}$/.test(String(message.hostToken || ''))) {
        safeSend(socket, { type: 'error', code: 'host_token_required', message: '缺少房主凭证。' });
        try { socket.close(4003, 'host token required'); } catch (_) { /* ignore */ }
        return;
      }
      const room = await this.ctx.storage.get(ROOM_KEY);
      const candidateHash = await sha256(message.hostToken);
      if (!room || !constantTimeEqual(candidateHash, room.hostTokenHash)) {
        safeSend(socket, { type: 'error', code: 'invalid_host_token', message: '房主凭证已经失效。' });
        try { socket.close(4003, 'invalid host token'); } catch (_) { /* ignore */ }
        return;
      }
      for (const other of this.ctx.getWebSockets()) {
        if (other === socket) continue;
        const otherAttachment = other.deserializeAttachment() || {};
        if (otherAttachment.role === 'host') {
          safeSend(other, { type: 'error', code: 'host_replaced', message: '房主已在另一处重新连接。' });
          try { other.close(4001, 'host replaced'); } catch (_) { /* ignore */ }
        }
      }
      attachment.role = 'host';
      socket.serializeAttachment(attachment);
      room.hostDisconnectedAt = null;
      room.lastActivityAt = now;
      await this.ctx.storage.put(ROOM_KEY, room);
      await this.scheduleAlarm(room, now);
      safeSend(socket, { type: 'ready', role: 'host', roomCode: room.roomCode, maxConnections: MAX_CONNECTIONS, serverNowMs: now });
      safeSend(socket, { type: 'snapshot', state: publicSnapshot(room, now) });
      this.broadcastPresence();
      return;
    }
    if (message.type === 'ping') {
      safeSend(socket, { type: 'pong', clientSentAtMs: Number(message.clientSentAtMs) || 0, serverNowMs: now });
      return;
    }
    if (message.type === 'leave') {
      try { socket.close(1000, 'left room'); } catch (_) { /* ignore */ }
      return;
    }
    if (message.type === 'resync') {
      // 成员同步失败（如加载音频出错）后的主动恢复请求：单独下发当前快照。
      // force 标记让客户端绕过已消费的 revision 重新应用同一份状态。
      const room = await this.ctx.storage.get(ROOM_KEY);
      if (!room || this.expired(room, now)) {
        safeSend(socket, { type: 'room_closed', reason: 'expired' });
        try { socket.close(4004, 'room expired'); } catch (_) { /* ignore */ }
        return;
      }
      safeSend(socket, { type: 'snapshot', state: publicSnapshot(room, now), force: true });
      return;
    }
    if (attachment.role !== 'host' || !['state', 'heartbeat', 'close'].includes(message.type)) {
      safeSend(socket, { type: 'error', code: 'host_only', message: '只有房主可以控制播放。' });
      return;
    }
    const room = await this.ctx.storage.get(ROOM_KEY);
    if (!room || this.expired(room, now)) {
      safeSend(socket, { type: 'room_closed', reason: 'expired' });
      try { socket.close(4004, 'room expired'); } catch (_) { /* ignore */ }
      return;
    }
    if (message.type === 'close') {
      await this.closeRoom('host_closed');
      return;
    }
    const playback = normalizePlaybackState(message.state);
    if (!playback) {
      safeSend(socket, { type: 'error', code: 'invalid_state', message: '播放状态不正确。' });
      return;
    }
    room.revision = Number(room.revision || 0) + 1;
    room.lastActivityAt = now;
    room.hostDisconnectedAt = null;
    room.playback = { ...playback, changedAtServerMs: now };
    await this.ctx.storage.put(ROOM_KEY, room);
    await this.scheduleAlarm(room, now);
    this.broadcast({ type: 'snapshot', state: publicSnapshot(room, now) });
  }

  async webSocketClose(socket, code, reason) {
    const attachment = socket.deserializeAttachment() || {};
    if (attachment.role === 'host') {
      const room = await this.ctx.storage.get(ROOM_KEY);
      if (room) {
        room.hostDisconnectedAt = Date.now();
        await this.ctx.storage.put(ROOM_KEY, room);
        await this.ctx.storage.put(ALARM_KIND_KEY, 'host-grace');
        await this.ctx.storage.setAlarm(room.hostDisconnectedAt + HOST_GRACE_MS);
        this.broadcast({ type: 'presence', memberCount: this.memberCount(), hostConnected: false });
      }
    } else {
      this.broadcastPresence();
    }
    try { socket.close(code, reason); } catch (_) { /* runtime may already have closed */ }
  }

  async webSocketError(socket) {
    try { socket.close(1011, 'websocket error'); } catch (_) { /* ignore */ }
  }

  async alarm() {
    const room = await this.ctx.storage.get(ROOM_KEY);
    if (!room) return;
    const now = Date.now();
    const hostConnected = this.ctx.getWebSockets().some(socket => (socket.deserializeAttachment() || {}).role === 'host');
    if (!hostConnected && room.hostDisconnectedAt && now - room.hostDisconnectedAt >= HOST_GRACE_MS) {
      await this.closeRoom('host_left');
      return;
    }
    if (this.expired(room, now)) {
      await this.closeRoom('expired');
      return;
    }
    await this.scheduleAlarm(room, now);
  }

  expired(room, now) {
    return now >= Number(room.absoluteExpiresAt || 0) || now - Number(room.lastActivityAt || room.createdAt || 0) >= IDLE_TTL_MS;
  }

  async scheduleAlarm(room, now) {
    const idleAt = Number(room.lastActivityAt || now) + IDLE_TTL_MS;
    const alarmAt = Math.min(idleAt, Number(room.absoluteExpiresAt || now + MAX_TTL_MS));
    await this.ctx.storage.put(ALARM_KIND_KEY, 'expiry');
    await this.ctx.storage.setAlarm(alarmAt);
  }

  memberCount() {
    return this.ctx.getWebSockets().filter(socket => (socket.deserializeAttachment() || {}).role !== 'host').length;
  }

  broadcastPresence() {
    const hostConnected = this.ctx.getWebSockets().some(socket => (socket.deserializeAttachment() || {}).role === 'host');
    this.broadcast({ type: 'presence', memberCount: this.memberCount(), hostConnected });
  }

  broadcast(message) {
    for (const socket of this.ctx.getWebSockets()) safeSend(socket, message);
  }

  async closeRoom(reason) {
    this.broadcast({ type: 'room_closed', reason });
    for (const socket of this.ctx.getWebSockets()) {
      try { socket.close(4000, reason); } catch (_) { /* ignore */ }
    }
    await this.ctx.storage.deleteAll();
  }
}
