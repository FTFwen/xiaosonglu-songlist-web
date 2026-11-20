import test from 'node:test';
import assert from 'node:assert/strict';
import { countAndSelect } from '../sync_live_memes.mjs';

const base = Date.UTC(2026, 10, 1);
const day = 86_400_000;
const seed = [{ id: 1, text: '这个梗条目' }, { id: 85, text: '别的梗' }];
const users = [{ id: 1000000, text: '观众投稿' }];
const channel = new Map();
const archives = new Map();
for (let i = 0; i < 4; i++) {
  const startDate = base + day * i;
  channel.set(`live${i}`, { liveId: `live${i}`, startDate, stopDate: startDate + 100000, isFinish: true, isFull: i !== 3 });
  const records = [
    ...Array.from({ length: 11 }, (_, n) => ({ text: '大大方方！', ts: startDate + n * 9000 })),
    { text: '这个梗条目。', ts: startDate },
    { text: '不把这个梗条目作为子串来统计', ts: startDate },
    { text: '观众投稿', ts: startDate },
  ];
  archives.set(`live${i}`, { live: { startDate }, records, stats: { apiTotal: records.length } });
}

test('whole-message counts exclude incomplete streams and preserve public IDs', () => {
  const { stats, appended } = countAndSelect({ archives, channel, seed, users, now: base + 4 * day });
  assert.deepEqual(stats.counts, { 1: 3, 85: 0, 86: 33, 1000000: 3 });
  assert.deepEqual(appended.map(({ id, text }) => ({ id, text })), [{ id: 86, text: '大大方方' }]);
  assert.equal(Object.keys(stats.coverage.streams).length, 3);
});

test('discovery reports unapproved candidates without publishing them', () => {
  const { appended, suggestions } = countAndSelect({ archives, channel, seed, users, now: base + 4 * day, reviewed: [], discover: true });
  assert.deepEqual(appended, []);
  assert.deepEqual(suggestions, [{ text: '大大方方！', count: 33, streams: 3 }]);
});
