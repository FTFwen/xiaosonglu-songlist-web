import { readJson, writeJsonAtomic } from './io.mjs';

export const EMPTY_STATE = {
  schemaVersion: 1,
  roomKey: 'xiaosonglu',
  roomId: '1727071052',
  channelUid: '1891335475',
  baselineDate: '',
  updatedAt: '',
  processedLives: [],
};

export async function loadIngestionState(path) {
  try {
    const state = await readJson(path);
    if (!Array.isArray(state.processedLives)) state.processedLives = [];
    return { ...EMPTY_STATE, ...state };
  } catch (error) {
    if (error?.code === 'ENOENT') return structuredClone(EMPTY_STATE);
    throw error;
  }
}

function stableEntry(entry) {
  const { reviewedAt, scannedAt, ...rest } = entry;
  return rest;
}

export async function upsertLiveState(path, state, entry, options = {}) {
  const index = state.processedLives.findIndex(item => item.liveId === entry.liveId);
  const old = index === -1 ? null : state.processedLives[index];
  const merged = { ...(old ?? {}), ...entry };
  const unchanged = old && JSON.stringify(stableEntry(old)) === JSON.stringify(stableEntry(merged));
  if (unchanged) return { state, changed: false, entry: old };
  const nextEntry = {
    ...merged,
    ...(['fetching', 'fetch-error', 'review-needed'].includes(entry.decision)
      ? { scannedAt: entry.scannedAt ?? new Date().toISOString() }
      : { reviewedAt: entry.reviewedAt ?? new Date().toISOString() }),
  };
  const processedLives = [...state.processedLives];
  if (index === -1) processedLives.push(nextEntry);
  else processedLives[index] = nextEntry;
  processedLives.sort((left, right) => Number(left.startDate ?? 0) - Number(right.startDate ?? 0));
  const next = { ...state, updatedAt: new Date().toISOString(), processedLives };
  if (options.write) await writeJsonAtomic(path, next);
  return { state: next, changed: true, entry: nextEntry };
}
