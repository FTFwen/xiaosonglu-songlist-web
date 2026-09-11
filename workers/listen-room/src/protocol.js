export const ROOM_CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
export const ROOM_CODE_LENGTH = 8;
export const ROOM_CODE_PATTERN = /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{8}$/;
export const MAX_CONNECTIONS = 20;
export const IDLE_TTL_MS = 60 * 60 * 1000;
export const MAX_TTL_MS = 24 * 60 * 60 * 1000;
export const HOST_GRACE_MS = 30 * 1000;
export const MAX_MESSAGE_BYTES = 4096;

export function normalizeRoomCode(value) {
  const code = String(value || '').trim().toUpperCase().replace(/[\s-]+/g, '');
  return ROOM_CODE_PATTERN.test(code) ? code : '';
}

export function makeRoomCode(randomValues = values => crypto.getRandomValues(values)) {
  const bytes = new Uint8Array(ROOM_CODE_LENGTH);
  randomValues(bytes);
  return Array.from(bytes, value => ROOM_CODE_ALPHABET[value % ROOM_CODE_ALPHABET.length]).join('');
}

export function safeText(value, maxLength) {
  const text = String(value == null ? '' : value).trim();
  if (!text || text.length > maxLength || /[\u0000-\u001f\u007f]/.test(text)) return '';
  return text;
}

export function normalizeTrack(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const songId = Number(value.songId);
  const rowKey = safeText(value.rowKey, 180);
  const name = safeText(value.name, 180);
  const artist = value.artist == null || value.artist === '' ? '' : safeText(value.artist, 180);
  const assetVersion = safeText(value.assetVersion, 64);
  if (!Number.isSafeInteger(songId) || songId <= 0 || !rowKey || !name) return null;
  if (value.artist && !artist) return null;
  if (!/^[0-9a-f]{12,64}$/i.test(assetVersion)) return null;
  return { songId, rowKey, name, artist, assetVersion: assetVersion.toLowerCase() };
}

export function normalizePlaybackState(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const track = normalizeTrack(value.track);
  const positionSeconds = Number(value.positionSeconds);
  const playing = value.playing === true;
  const playMode = ['list', 'random', 'single'].includes(value.playMode) ? value.playMode : 'list';
  if (!track || !Number.isFinite(positionSeconds) || positionSeconds < 0 || positionSeconds > 24 * 60 * 60) return null;
  return { track, playing, positionSeconds, playMode };
}

export function publicSnapshot(room, now = Date.now()) {
  const state = room && room.playback;
  return {
    roomCode: room.roomCode,
    revision: room.revision || 0,
    track: state ? state.track : null,
    playing: state ? state.playing : false,
    positionSeconds: state ? state.positionSeconds : 0,
    playMode: state ? state.playMode : 'list',
    changedAtServerMs: state ? state.changedAtServerMs : now,
    serverNowMs: now,
  };
}

export function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });
}
