import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');

test('desktop list cards avoid per-card backdrop sampling without removing their decoration', () => {
  const block = html.slice(html.indexOf('/* 桌面滚动性能：'), html.indexOf('</style>', html.indexOf('/* 桌面滚动性能：')));
  assert.match(block, /@media \(min-width: 769px\)/);
  assert.match(block, /backdrop-filter: none !important/);
  assert.match(block, /\.songlist-item, \.songlist-song, \.playlist-item/);
  assert.match(block, /linear-gradient/);
  assert.match(block, /\.song-item\.now-playing/);
  assert.doesNotMatch(block, /box-shadow: none|border: none/);
});
