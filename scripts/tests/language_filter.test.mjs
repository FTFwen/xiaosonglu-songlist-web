import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const sharedSource = readFileSync(join(ROOT, 'js', 'shared.js'), 'utf8');
const appSource = readFileSync(join(ROOT, 'js', 'app.js'), 'utf8');

function loadShared() {
  const context = { console };
  vm.createContext(context);
  vm.runInContext(
    `${sharedSource}\nglobalThis.__api = { splitLanguageTags, songMatchesLanguageFilter, normalizeLanguageTag };`,
    context
  );
  return context.__api;
}

const { splitLanguageTags, songMatchesLanguageFilter } = loadShared();

test('composite language labels split into their components', () => {
  assert.deepEqual(Array.from(splitLanguageTags('中文/日文')), ['中文', '日文']);
  assert.deepEqual(Array.from(splitLanguageTags('日文/英文')), ['日文', '英文']);
  assert.deepEqual(Array.from(splitLanguageTags(' 日语 / 英文 ')), ['日文', '英文']);
  assert.deepEqual(Array.from(splitLanguageTags('中文、日文')), ['中文', '日文']);
  assert.deepEqual(Array.from(splitLanguageTags('中文')), ['中文']);
  assert.deepEqual(Array.from(splitLanguageTags('')), []);
  assert.deepEqual(Array.from(splitLanguageTags(null)), []);
  assert.deepEqual(Array.from(splitLanguageTags('中文/中文')), ['中文'], '重复成分要去重');
});

test('selecting one component keeps composite songs in the list', () => {
  for (const selected of [['日文'], ['中文'], ['英文']]) {
    const label = `选 ${selected[0]}`;
    if (selected[0] === '中文') {
      assert.equal(songMatchesLanguageFilter('中文/英文', selected), true, `${label}: 中文/英文 应命中`);
      assert.equal(songMatchesLanguageFilter('日文/英文', selected), false, `${label}: 日文/英文 不应命中`);
    }
    if (selected[0] === '日文') {
      assert.equal(songMatchesLanguageFilter('日文/英文', selected), true, `${label}: 日文/英文 应命中`);
      assert.equal(songMatchesLanguageFilter('中文/日文', selected), true, `${label}: 中文/日文 应命中`);
      assert.equal(songMatchesLanguageFilter('中文/英文', selected), false, `${label}: 中文/英文 不应命中`);
    }
    if (selected[0] === '英文') {
      assert.equal(songMatchesLanguageFilter('日文/英文', selected), true, `${label}: 日文/英文 应命中`);
      assert.equal(songMatchesLanguageFilter('中文/英文', selected), true, `${label}: 中文/英文 应命中`);
      assert.equal(songMatchesLanguageFilter('中文', selected), false, `${label}: 纯中文不应命中`);
    }
  }
});

test('empty selection means no language filtering, multiple selections union', () => {
  assert.equal(songMatchesLanguageFilter('中文/日文', []), true);
  assert.equal(songMatchesLanguageFilter('', []), true);
  assert.equal(songMatchesLanguageFilter('中文/日文', ['中文', '日文']), true);
  assert.equal(songMatchesLanguageFilter('英文', ['中文', '日文']), false);
  assert.equal(songMatchesLanguageFilter('', ['中文']), false, '无语言标签的歌在勾选语言时应被排除');
});

test('legacy composite filter values from localStorage still match atomically', () => {
  assert.equal(songMatchesLanguageFilter('中文', ['中文/日文']), true);
  assert.equal(songMatchesLanguageFilter('日文', ['中文/日文']), true);
});

test('app filter and chips use the shared helpers instead of exact equality', () => {
  assert.match(appSource, /songMatchesLanguageFilter\(song\.language \|\| '', state\.songFilters\.languages\)/);
  assert.match(appSource, /state\.allSongs\.flatMap\(song => splitLanguageTags\(song\.language \|\| ''\)\)/);
  assert.doesNotMatch(appSource, /selectedLanguages\.includes\(normalizeLanguageTag\(song\.language/);
});
