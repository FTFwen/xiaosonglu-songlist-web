(() => {
  'use strict';

  const DEFAULT_ENDPOINT = 'https://sync.viridis.love';
  const ROOM_RE = /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{8}$/;
  const HOST_STORAGE_PREFIX = 'xsl:listen:host:';
  const SESSION_KEY = 'xsl:listen:session:v1';
  const HEARTBEAT_MS = 5000;
  const PING_MS = 15000;
  const RECONNECT_MAX_MS = 15000;

  const state = {
    adapter: null,
    endpoint: DEFAULT_ENDPOINT,
    showMessage: () => {},
    socket: null,
    roomCode: '',
    role: '',
    hostToken: '',
    connected: false,
    connecting: false,
    applyingRemote: false,
    leaving: false,
    autoplayBlocked: false,
    revision: -1,
    memberCount: 0,
    hostConnected: false,
    clockOffsetMs: 0,
    reconnectAttempt: 0,
    reconnectTimer: null,
    heartbeatTimer: null,
    pingTimer: null,
    publishTimer: null,
    hostPublishTimer: null,
    lastPublishedSignature: '',
    initialized: false,
    ui: {},
  };

  function endpointUrl(path = '') {
    return `${String(state.endpoint || DEFAULT_ENDPOINT).replace(/\/$/, '')}${path}`;
  }

  function socketUrl(path) {
    const url = new URL(endpointUrl(path), window.location.href);
    url.protocol = url.protocol === 'http:' ? 'ws:' : 'wss:';
    return url;
  }

  function normalizeCode(value) {
    const code = String(value || '').trim().toUpperCase().replace(/[\s-]+/g, '');
    return ROOM_RE.test(code) ? code : '';
  }

  function roleLabel() {
    if (state.role === 'host') return '房主';
    if (state.role === 'member') return '成员';
    return '未加入';
  }

  function setStatus(text, kind = '') {
    if (!state.ui.status) return;
    state.ui.status.textContent = text;
    state.ui.status.dataset.state = kind;
  }

  function render() {
    const active = !!state.roomCode;
    if (state.ui.launch) {
      state.ui.launch.classList.toggle('active', active);
      state.ui.launch.title = active ? `一起听歌 · ${state.roomCode}` : '一起听歌';
      state.ui.launch.setAttribute('aria-label', state.ui.launch.title);
    }
    if (state.ui.fab) {
      state.ui.fab.classList.toggle('active', active);
      state.ui.fab.title = active ? `一起听歌 · ${state.roomCode}` : '一起听歌';
      state.ui.fab.setAttribute('aria-label', state.ui.fab.title);
    }
    if (state.ui.fabDesktop) {
      state.ui.fabDesktop.classList.toggle('active', active);
      state.ui.fabDesktop.title = active ? `一起听歌 · ${state.roomCode}` : '一起听歌';
      state.ui.fabDesktop.setAttribute('aria-label', state.ui.fabDesktop.title);
    }
    if (!state.ui.roomView) return;
    state.ui.lobbyView.hidden = active;
    state.ui.roomView.hidden = !active;
    state.ui.roomCode.textContent = state.roomCode || '--------';
    state.ui.role.textContent = roleLabel();
    state.ui.members.textContent = `${state.memberCount} 位成员`;
    state.ui.copy.hidden = !active;
    state.ui.closeRoom.hidden = state.role !== 'host';
    state.ui.leave.textContent = state.role === 'host' ? '退出并关闭房间' : '离开房间';
    state.ui.unlock.hidden = !state.autoplayBlocked || state.role !== 'member';
    if (!active) setStatus('创建一个房间，或者输入房间号加入。');
    else if (state.connecting) setStatus('正在连接房间…', 'connecting');
    else if (!state.connected) setStatus('连接已断开，正在尝试重连…', 'offline');
    else if (state.autoplayBlocked) setStatus('已经跟上房主，点一下才能开始发声。', 'blocked');
    else if (state.role === 'host') setStatus('已连接，你的播放操作会同步给大家。', 'synced');
    else setStatus(state.hostConnected ? '已同步房主的播放状态。' : '房主暂时离线，等待重连。', state.hostConnected ? 'synced' : 'offline');
  }

  function injectUi() {
    if (document.getElementById('listenTogetherOverlay')) return;
    const launch = document.createElement('button');
    launch.type = 'button';
    launch.id = 'listenTogetherLaunch';
    launch.className = 'player-btn listen-together-launch';
    launch.title = '一起听歌';
    launch.setAttribute('aria-label', '一起听歌');
    launch.innerHTML = '<svg class="icon" aria-hidden="true"><use href="#icon-phone"></use></svg>';
    const playerBar = document.getElementById('playerBar');
    const timerWrap = document.getElementById('playerTimerWrap');
    if (playerBar) playerBar.insertBefore(launch, timerWrap || null);
    else document.body.appendChild(launch);

    // 手机端：播放栏是固定 6 列网格，塞不进新按钮；入口改为右下角悬浮按钮列。
    const fab = document.createElement('button');
    fab.type = 'button';
    fab.id = 'listenTogetherFab';
    fab.className = 'mobile-fab listen-fab';
    fab.title = '一起听歌';
    fab.setAttribute('aria-label', '一起听歌');
    fab.innerHTML = '<svg class="icon" aria-hidden="true"><use href="#icon-phone"></use></svg>';
    const fabs = document.getElementById('mobileFabs');
    if (fabs) fabs.appendChild(fab);
    else document.body.appendChild(fab);

    // 桌面端还没播放时播放栏是隐藏的，补一个右下角悬浮入口；
    // 播放开始（body.has-player）后自动隐藏，让位给播放栏里的图标按钮。
    const fabDesktop = document.createElement('button');
    fabDesktop.type = 'button';
    fabDesktop.id = 'listenTogetherFabDesktop';
    fabDesktop.className = 'listen-fab-desktop';
    fabDesktop.title = '一起听歌';
    fabDesktop.setAttribute('aria-label', '一起听歌');
    fabDesktop.innerHTML = '<svg class="icon" aria-hidden="true"><use href="#icon-phone"></use></svg>';
    document.body.appendChild(fabDesktop);

    const overlay = document.createElement('div');
    overlay.id = 'listenTogetherOverlay';
    overlay.className = 'listen-together-overlay';
    overlay.hidden = true;
    overlay.innerHTML = `
      <section class="listen-together-dialog" role="dialog" aria-modal="true" aria-labelledby="listenTogetherTitle">
        <header class="listen-together-head">
          <div><h3 id="listenTogetherTitle">一起听歌</h3><p>房主控制播放，大家在自己的设备上听同一首歌。</p></div>
          <button type="button" class="listen-together-close" aria-label="关闭">×</button>
        </header>
        <div class="listen-together-lobby">
          <button type="button" class="tool-btn primary listen-create">创建房间</button>
          <div class="listen-together-divider"><span>或</span></div>
          <label class="listen-together-label" for="listenTogetherCode">输入 8 位房间号</label>
          <div class="listen-together-join-row">
            <input id="listenTogetherCode" class="dialog-input" maxlength="9" autocomplete="off" spellcheck="false" placeholder="例如 ABCD2345">
            <button type="button" class="tool-btn listen-join">加入</button>
          </div>
        </div>
        <div class="listen-together-room" hidden>
          <div class="listen-together-code-row">
            <div><span>房间号</span><strong class="listen-room-code">--------</strong></div>
            <button type="button" class="tool-btn listen-copy">复制</button>
          </div>
          <div class="listen-together-meta"><span class="listen-role">未加入</span><span class="listen-members">0 位成员</span></div>
          <p class="listen-together-status" aria-live="polite"></p>
          <button type="button" class="tool-btn primary listen-unlock" hidden>点一下，开始同步播放</button>
          <div class="listen-together-actions">
            <button type="button" class="tool-btn danger listen-leave">离开房间</button>
            <button type="button" class="tool-btn danger listen-close-room" hidden>关闭房间</button>
          </div>
        </div>
      </section>`;
    document.body.appendChild(overlay);
    state.ui = {
      launch,
      fab,
      fabDesktop,
      overlay,
      close: overlay.querySelector('.listen-together-close'),
      lobbyView: overlay.querySelector('.listen-together-lobby'),
      roomView: overlay.querySelector('.listen-together-room'),
      create: overlay.querySelector('.listen-create'),
      input: overlay.querySelector('#listenTogetherCode'),
      join: overlay.querySelector('.listen-join'),
      roomCode: overlay.querySelector('.listen-room-code'),
      role: overlay.querySelector('.listen-role'),
      members: overlay.querySelector('.listen-members'),
      status: overlay.querySelector('.listen-together-status'),
      copy: overlay.querySelector('.listen-copy'),
      unlock: overlay.querySelector('.listen-unlock'),
      leave: overlay.querySelector('.listen-leave'),
      closeRoom: overlay.querySelector('.listen-close-room'),
    };
    launch.addEventListener('click', openPanel);
    fab.addEventListener('click', openPanel);
    fabDesktop.addEventListener('click', openPanel);
    state.ui.close.addEventListener('click', closePanel);
    overlay.addEventListener('pointerdown', event => { if (event.target === overlay) closePanel(); });
    state.ui.create.addEventListener('click', createRoom);
    state.ui.join.addEventListener('click', () => joinRoom(state.ui.input.value));
    state.ui.input.addEventListener('input', () => { state.ui.input.value = state.ui.input.value.toUpperCase().replace(/[^23456789A-HJ-NP-Z]/g, '').slice(0, 8); });
    state.ui.input.addEventListener('keydown', event => { if (event.key === 'Enter') joinRoom(state.ui.input.value); });
    state.ui.copy.addEventListener('click', copyInvite);
    state.ui.unlock.addEventListener('click', unlockPlayback);
    state.ui.leave.addEventListener('click', () => leaveRoom({ close: state.role === 'host' }));
    state.ui.closeRoom.addEventListener('click', () => leaveRoom({ close: true }));
    render();
  }

  function openPanel() {
    state.ui.overlay.hidden = false;
    document.body.classList.add('listen-together-open');
    render();
    if (!state.roomCode) setTimeout(() => state.ui.input.focus(), 0);
  }

  function closePanel() {
    state.ui.overlay.hidden = true;
    document.body.classList.remove('listen-together-open');
  }

  function persistSession() {
    try {
      if (!state.roomCode) sessionStorage.removeItem(SESSION_KEY);
      else sessionStorage.setItem(SESSION_KEY, JSON.stringify({ roomCode: state.roomCode, role: state.role }));
      if (state.role === 'host' && state.hostToken) localStorage.setItem(`${HOST_STORAGE_PREFIX}${state.roomCode}`, state.hostToken);
    } catch (_) { /* private mode may reject storage */ }
  }

  function readHostToken(roomCode) {
    try { return localStorage.getItem(`${HOST_STORAGE_PREFIX}${roomCode}`) || ''; } catch (_) { return ''; }
  }

  function clearTimers() {
    clearTimeout(state.reconnectTimer);
    clearInterval(state.heartbeatTimer);
    clearInterval(state.pingTimer);
    clearTimeout(state.publishTimer);
    clearTimeout(state.hostPublishTimer);
    state.reconnectTimer = state.heartbeatTimer = state.pingTimer = state.publishTimer = state.hostPublishTimer = null;
  }

  async function createRoom() {
    if (state.connecting) return;
    state.connecting = true;
    setStatus('正在创建房间…', 'connecting');
    try {
      const response = await fetch(endpointUrl('/rooms'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || !result.roomCode || !result.hostToken) throw new Error(result.error || `创建失败 (${response.status})`);
      await connect({ roomCode: result.roomCode, role: 'host', hostToken: result.hostToken, fresh: true });
      state.showMessage(`房间 ${result.roomCode} 已创建`);
    } catch (error) {
      state.connecting = false;
      setStatus(`创建失败：${friendlyError(error)}`, 'error');
      render();
    }
  }

  async function joinRoom(value) {
    const roomCode = normalizeCode(value);
    if (!roomCode) {
      setStatus('房间号应为 8 位大写字母或数字。', 'error');
      return;
    }
    await connect({ roomCode, role: 'member', hostToken: '', fresh: true });
  }

  async function connect({ roomCode, role, hostToken, fresh = false }) {
    const normalized = normalizeCode(roomCode);
    if (!normalized) throw new Error('invalid_room_code');
    disconnectSocket(false);
    state.roomCode = normalized;
    state.role = role === 'host' ? 'host' : 'member';
    state.hostToken = state.role === 'host' ? (hostToken || readHostToken(normalized)) : '';
    if (state.role === 'host' && !state.hostToken) {
      state.role = 'member';
      throw new Error('host_token_missing');
    }
    state.leaving = false;
    state.connecting = true;
    state.connected = false;
    state.autoplayBlocked = false;
    if (fresh) state.revision = -1;
    persistSession();
    render();
    const url = socketUrl(`/rooms/${normalized}`);
    url.searchParams.set('role', state.role);
    const socket = new WebSocket(url.href);
    state.socket = socket;
    socket.addEventListener('open', () => {
      if (state.socket !== socket) return;
      state.connecting = false;
      state.connected = true;
      state.reconnectAttempt = 0;
      // 房主的第一条消息必须是 hello 认证；提前发 ping 会被服务端以
      // 「缺少房主凭证」断开（4003）并陷入重连循环，所以房主等 ready 再发消息。
      if (state.role !== 'host') {
        startTimers();
        sendPing();
      }
      render();
    });
    socket.addEventListener('message', event => { if (state.socket === socket) handleMessage(event.data); });
    socket.addEventListener('close', event => {
      if (state.socket !== socket) return;
      state.connected = false;
      state.connecting = false;
      clearInterval(state.heartbeatTimer);
      clearInterval(state.pingTimer);
      state.heartbeatTimer = state.pingTimer = null;
      render();
      if (!state.leaving && state.roomCode && event.code !== 4000 && event.code !== 4004) scheduleReconnect();
    });
    socket.addEventListener('error', () => {
      if (state.socket === socket) setStatus('实时连接暂时不可用。', 'error');
    });
  }

  function disconnectSocket(markLeaving = true) {
    if (markLeaving) state.leaving = true;
    clearTimers();
    const socket = state.socket;
    state.socket = null;
    if (socket) {
      try { socket.close(1000, 'client disconnect'); } catch (_) { /* ignore */ }
    }
    state.connected = false;
    state.connecting = false;
  }

  function scheduleReconnect() {
    clearTimeout(state.reconnectTimer);
    const delay = Math.min(RECONNECT_MAX_MS, 800 * (2 ** state.reconnectAttempt)) + Math.floor(Math.random() * 300);
    state.reconnectAttempt += 1;
    state.reconnectTimer = setTimeout(() => connect({ roomCode: state.roomCode, role: state.role, hostToken: state.hostToken }).catch(() => scheduleReconnect()), delay);
  }

  function startTimers() {
    clearInterval(state.heartbeatTimer);
    clearInterval(state.pingTimer);
    if (state.role === 'host') state.heartbeatTimer = setInterval(() => publishNow('heartbeat', true), HEARTBEAT_MS);
    state.pingTimer = setInterval(sendPing, PING_MS);
  }

  function send(message) {
    if (!state.socket || state.socket.readyState !== WebSocket.OPEN) return false;
    try { state.socket.send(JSON.stringify(message)); return true; } catch (_) { return false; }
  }

  function sendPing() {
    send({ type: 'ping', clientSentAtMs: Date.now() });
  }

  async function handleMessage(raw) {
    let message;
    try { message = JSON.parse(raw); } catch (_) { return; }
    if (!message || typeof message !== 'object') return;
    if (message.type === 'auth_required' && state.role === 'host') {
      send({ type: 'hello', hostToken: state.hostToken });
      return;
    }
    if (message.type === 'ready') {
      state.role = message.role === 'host' ? 'host' : 'member';
      state.hostConnected = state.role === 'host';
      if (message.role === 'host') {
        startTimers();
        sendPing();
        // 稍等一下再广播状态，避开服务端 100ms 的消息频率限制。
        state.hostPublishTimer = setTimeout(() => {
          state.hostPublishTimer = null;
          if (state.connected && state.role === 'host') publishNow('connected', true);
        }, 180);
      }
      render();
      return;
    }
    if (message.type === 'pong') {
      const receivedAt = Date.now();
      const sentAt = Number(message.clientSentAtMs);
      const serverAt = Number(message.serverNowMs);
      if (Number.isFinite(sentAt) && Number.isFinite(serverAt) && receivedAt >= sentAt) {
        const estimate = serverAt - ((sentAt + receivedAt) / 2);
        state.clockOffsetMs = state.clockOffsetMs ? state.clockOffsetMs * 0.7 + estimate * 0.3 : estimate;
      }
      return;
    }
    if (message.type === 'presence') {
      state.memberCount = Math.max(0, Number(message.memberCount) || 0);
      state.hostConnected = !!message.hostConnected;
      render();
      return;
    }
    if (message.type === 'snapshot' && message.state) {
      await applySnapshot(message.state);
      return;
    }
    if (message.type === 'room_closed') {
      state.showMessage(message.reason === 'host_left' ? '房主已离开，房间关闭啦' : '房间已经关闭');
      resetRoom();
      return;
    }
    if (message.type === 'error') {
      const text = message.message || message.code || '房间服务暂时出错';
      setStatus(text, 'error');
      if (message.code === 'host_replaced') resetRoom();
    }
  }

  async function applySnapshot(snapshot) {
    const revision = Number(snapshot.revision);
    if (!Number.isSafeInteger(revision) || revision <= state.revision) return;
    state.revision = revision;
    if (state.role === 'host') return;
    const serverNow = Date.now() + state.clockOffsetMs;
    const changedAt = Number(snapshot.changedAtServerMs);
    const basePosition = Math.max(0, Number(snapshot.positionSeconds) || 0);
    const targetPositionSeconds = snapshot.playing && Number.isFinite(changedAt)
      ? basePosition + Math.max(0, serverNow - changedAt) / 1000
      : basePosition;
    state.applyingRemote = true;
    try {
      const result = await state.adapter.applyRemoteSnapshot({ ...snapshot, targetPositionSeconds });
      state.autoplayBlocked = !!(result && result.autoplayBlocked);
    } catch (error) {
      state.autoplayBlocked = false;
      setStatus(`暂时没同步上：${friendlyError(error)}`, 'error');
    } finally {
      state.applyingRemote = false;
      render();
    }
  }

  function publish(reason = 'control') {
    if (state.role !== 'host' || state.applyingRemote) return;
    clearTimeout(state.publishTimer);
    state.publishTimer = setTimeout(() => publishNow(reason, false), 40);
  }

  function publishNow(reason = 'control', force = false) {
    if (state.role !== 'host' || !state.connected || state.applyingRemote) return false;
    const snapshot = state.adapter.getSnapshot();
    if (!snapshot || !snapshot.track) return false;
    const signature = JSON.stringify(snapshot);
    if (!force && signature === state.lastPublishedSignature) return false;
    state.lastPublishedSignature = signature;
    return send({ type: reason === 'heartbeat' ? 'heartbeat' : 'state', state: snapshot });
  }

  async function unlockPlayback() {
    try {
      const result = await state.adapter.unlockPlayback();
      state.autoplayBlocked = !!(result && result.autoplayBlocked);
      render();
    } catch (error) {
      setStatus(`播放没有启动：${friendlyError(error)}`, 'error');
    }
  }

  async function copyInvite() {
    const url = new URL(window.location.href);
    url.searchParams.set('listen', state.roomCode);
    const text = `${state.roomCode}\n${url.href}`;
    try {
      await navigator.clipboard.writeText(text);
      state.showMessage('房间号和邀请链接已复制');
    } catch (_) {
      state.showMessage(`房间号：${state.roomCode}`);
    }
  }

  function leaveRoom({ close = false } = {}) {
    if (close && state.role === 'host') send({ type: 'close' });
    else send({ type: 'leave' });
    resetRoom();
  }

  function resetRoom() {
    const oldCode = state.roomCode;
    const oldRole = state.role;
    disconnectSocket(true);
    if (oldRole === 'host' && oldCode) {
      try { localStorage.removeItem(`${HOST_STORAGE_PREFIX}${oldCode}`); } catch (_) { /* ignore */ }
    }
    state.roomCode = '';
    state.role = '';
    state.hostToken = '';
    state.revision = -1;
    state.memberCount = 0;
    state.hostConnected = false;
    state.autoplayBlocked = false;
    state.lastPublishedSignature = '';
    persistSession();
    render();
  }

  function friendlyError(error) {
    const code = String(error && (error.message || error) || '未知错误');
    const map = {
      room_not_found: '没有找到这个房间，可能已经关闭了',
      room_full: '房间已经满了',
      invalid_host_token: '房主凭证已经失效',
      host_token_missing: '本机没有这个房间的房主凭证',
      invalid_room_code: '房间号格式不正确',
      'Failed to fetch': '连接不到房间服务，请稍后重试',
    };
    return map[code] || code;
  }

  function restoreSession() {
    let saved = null;
    try { saved = JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null'); } catch (_) { saved = null; }
    const queryCode = normalizeCode(new URLSearchParams(window.location.search).get('listen'));
    if (queryCode) {
      openPanel();
      state.ui.input.value = queryCode;
      joinRoom(queryCode);
      return;
    }
    const roomCode = normalizeCode(saved && saved.roomCode);
    if (!roomCode) return;
    const role = saved.role === 'host' && readHostToken(roomCode) ? 'host' : 'member';
    connect({ roomCode, role, hostToken: role === 'host' ? readHostToken(roomCode) : '' }).catch(() => render());
  }

  function init(options = {}) {
    if (state.initialized) return window.XSLListenTogether;
    if (!options.adapter || typeof options.adapter.getSnapshot !== 'function' || typeof options.adapter.applyRemoteSnapshot !== 'function') {
      throw new Error('XSLListenTogether requires a player adapter');
    }
    state.adapter = options.adapter;
    state.endpoint = options.endpoint || window.XSL_LISTEN_ENDPOINT || DEFAULT_ENDPOINT;
    state.showMessage = typeof options.showMessage === 'function' ? options.showMessage : state.showMessage;
    injectUi();
    state.initialized = true;
    restoreSession();
    return window.XSLListenTogether;
  }

  window.XSLListenTogether = {
    init,
    publish,
    publishNow,
    open: openPanel,
    leave: leaveRoom,
    isMember: () => state.role === 'member' && !!state.roomCode,
    isHost: () => state.role === 'host' && !!state.roomCode,
    isApplyingRemote: () => state.applyingRemote,
    getState: () => ({ roomCode: state.roomCode, role: state.role, connected: state.connected, revision: state.revision, autoplayBlocked: state.autoplayBlocked }),
  };
})();
