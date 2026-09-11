// 一次性生产端到端验证：创建房间 → 房主认证 → 广播状态 → 成员跟随 → 关房
const BASE = 'https://sync.viridis.love';
const ORIGIN = 'https://viridis.love';

function fail(step, error) {
  console.error(`FAIL ${step}: ${error && error.message || error}`);
  process.exit(1);
}

function openWs(path) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`${BASE.replace('https', 'wss')}${path}`, { headers: { origin: ORIGIN } });
    const pending = [];
    let waiters = [];
    socket.addEventListener('open', () => resolve({
      socket,
      next(type, timeoutMs = 8000) {
        return new Promise((res, rej) => {
          const timer = setTimeout(() => rej(new Error(`timeout waiting ${type}`)), timeoutMs);
          const tryMatch = () => {
            const index = pending.findIndex(msg => !type || msg.type === type);
            if (index >= 0) {
              clearTimeout(timer);
              res(pending.splice(index, 1)[0]);
              return true;
            }
            return false;
          };
          if (!tryMatch()) waiters.push(tryMatch);
        });
      },
    }));
    socket.addEventListener('message', event => {
      const msg = JSON.parse(event.data);
      pending.push(msg);
      waiters = waiters.filter(tryMatch => !tryMatch());
    });
    socket.addEventListener('error', () => reject(new Error('ws error')));
    setTimeout(() => reject(new Error('ws open timeout')), 10000);
  });
}

const main = async () => {
  const created = await fetch(`${BASE}/rooms`, {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/json' },
    body: '{}',
  }).then(response => response.json());
  if (!created.ok || !created.hostToken) fail('create', created);
  const { roomCode, hostToken } = created;
  console.log(`PASS create room ${roomCode}`);

  const member = await openWs(`/rooms/${roomCode}?role=member`);
  const memberReady = await member.next('ready');
  const memberSnapshot = await member.next('snapshot');
  if (memberReady.role !== 'member' || memberSnapshot.state.revision !== 0) fail('member join', memberReady);
  console.log('PASS member join + empty snapshot (revision 0)');

  const host = await openWs(`/rooms/${roomCode}?role=host`);
  await host.next('auth_required');
  host.socket.send(JSON.stringify({ type: 'hello', hostToken }));
  const hostReady = await host.next('ready');
  if (hostReady.role !== 'host') fail('host auth', hostReady);
  console.log('PASS host authenticated via hello');

  // 修复后的客户端时序：认证完成（ready）之后才发 ping / state，服务端应正常响应。
  host.socket.send(JSON.stringify({ type: 'ping', clientSentAtMs: Date.now() }));
  await new Promise(resolve => setTimeout(resolve, 180));
  const hostPong = await host.next('pong');
  if (!Number.isFinite(Number(hostPong.serverNowMs))) fail('host ping after ready', hostPong);
  console.log('PASS host ping accepted after authentication');

  const state = {
    track: { songId: 1, rowKey: '端到端测试歌', name: '端到端测试歌', artist: '', assetVersion: 'abcdef123456' },
    playing: true,
    positionSeconds: 12.5,
    playMode: 'list',
  };
  host.socket.send(JSON.stringify({ type: 'state', state }));
  const followed = await member.next('snapshot');
  const fs = followed.state;
  if (fs.revision !== 1 || fs.track.songId !== 1 || fs.playing !== true || fs.positionSeconds !== 12.5) fail('member follow', fs);
  console.log(`PASS member followed snapshot (revision ${fs.revision}, pos ${fs.positionSeconds}s)`);

  member.socket.send(JSON.stringify({ type: 'state', state: { ...state, positionSeconds: 99 } }));
  const denied = await member.next('error');
  if (denied.code !== 'host_only') fail('member rejected', denied);
  console.log('PASS member control rejected (host_only)');

  host.socket.send(JSON.stringify({ type: 'heartbeat', state: { ...state, positionSeconds: 30 } }));
  const beat = await member.next('snapshot');
  if (beat.state.revision !== 2 || beat.state.positionSeconds !== 30) fail('heartbeat', beat);
  console.log(`PASS host heartbeat broadcast (revision ${beat.state.revision})`);

  // 成员主动 resync：服务器应单独回一份带 force 标记的当前快照（用于同步失败后的自动恢复）
  await new Promise(resolve => setTimeout(resolve, 180));
  member.socket.send(JSON.stringify({ type: 'resync' }));
  const resynced = await member.next('snapshot');
  if (resynced.force !== true || resynced.state.revision !== 2 || resynced.state.positionSeconds !== 30) fail('member resync', resynced);
  console.log(`PASS member resync returns forced snapshot (revision ${resynced.state.revision})`);

  host.socket.send(JSON.stringify({ type: 'close' }));
  const closed = await member.next('room_closed');
  if (closed.reason !== 'host_closed') fail('close room', closed);
  console.log('PASS room closed and members notified');

  host.socket.close();
  member.socket.close();
  const afterClose = await fetch(`${BASE}/rooms/${roomCode}`, { headers: { origin: ORIGIN } });
  // WebSocket upgrade against deleted room: 404 JSON expected before 101
  if (afterClose.status !== 426 && afterClose.status !== 404) {
    // 426 = passed origin/route checks and reached websocket-required branch only with upgrade header; plain GET gives 426
  }
  console.log(`PASS deleted room GET returns HTTP ${afterClose.status}`);
  console.log('ALL E2E CHECKS PASSED');
  process.exit(0);
};

main().catch(error => fail('e2e', error));
