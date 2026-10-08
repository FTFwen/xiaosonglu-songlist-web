// 二创歌曲（小松绿 AI 翻唱）回归测试
//
// 覆盖三件容易悄悄坏掉的事：
//   1. js/app.js 里登记的每个二创音频文件都真实存在，且 ?v= 与文件内容哈希一致
//      （换文件忘改版本号 → 用户永远听到浏览器缓存里的旧音频）
//   2. 内置二创歌不会被 localStorage 里的旧数据顶掉，身份（song_name / song_id）不重复
//   3. 二创歌曲走自己的 audio 字段，不会去歌切音频索引 audio_index.json 里抢同名歌的音频
//   4. 「二创歌曲」开关已从高级筛选抽屉搬到播放全部/随机播放右侧的同款工具按钮
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import vm from 'node:vm';

const root = new URL('../../', import.meta.url);
const appSource = await readFile(new URL('js/app.js', root), 'utf8');
const htmlSource = await readFile(new URL('index.html', root), 'utf8');
const headersSource = await readFile(new URL('_headers', root), 'utf8');

function sourceBetween(source, startText, endText) {
  const start = source.indexOf(startText);
  const end = source.indexOf(endText, start);
  assert.notEqual(start, -1, `missing source marker: ${startText}`);
  assert.notEqual(end, -1, `missing source marker: ${endText}`);
  return source.slice(start, end);
}

function evaluate(code, globals = {}) {
  const context = { ...globals };
  vm.runInNewContext(code, context);
  return context;
}

// 从 js/app.js 里取真实的 DERIVATIVE_TRACKS（而不是在测试里重复一份名单）
function readDerivativeTracks() {
  const table = sourceBetween(appSource, 'const DERIVATIVE_TRACKS', '// 内置的二创歌曲');
  const context = evaluate(`${table}\nglobalThis.__tracks = DERIVATIVE_TRACKS;`);
  assert.ok(Array.isArray(context.__tracks) && context.__tracks.length > 0, 'DERIVATIVE_TRACKS is empty');
  return context.__tracks;
}

test('每个二创音频文件都存在，且 URL 上的 ?v= 等于文件内容的 SHA-256 前 12 位', async () => {
  const tracks = readDerivativeTracks();
  const seen = new Set();
  for (const track of tracks) {
    const match = /^assets\/derivative\/([A-Za-z0-9._-]+)\?v=([0-9a-f]{12})$/.exec(String(track.audio || ''));
    assert.ok(match, `unexpected derivative audio url: ${track.audio}`);
    const [, fileName, version] = match;
    assert.ok(!seen.has(fileName), `duplicate derivative audio file: ${fileName}`);
    seen.add(fileName);
    const bytes = await readFile(new URL(`assets/derivative/${fileName}`, root));
    const actual = createHash('sha256').update(bytes).digest('hex').slice(0, 12);
    assert.equal(actual, version, `${fileName} 的内容哈希与 ?v=${version} 不一致（换文件后要同步改 js/app.js）`);
    assert.ok(bytes.length > 0, `${fileName} is empty`);
  }
});

test('内置二创歌身份唯一：song_id 不重复、song_name 不重复、音频歌带前缀', () => {
  const tracks = readDerivativeTracks();
  const block = sourceBetween(appSource, 'const DERIVATIVE_TRACKS', 'function loadDerivativeSongs');
  const context = evaluate(`${block}\nglobalThis.__builtin = BUILTIN_DERIVATIVE;`);
  const builtin = context.__builtin;

  assert.ok(Array.isArray(builtin) && builtin.length >= tracks.length);
  // 新上线的 13 首必须在内置列表里，且保留自己的 audio
  for (const track of tracks) {
    const found = builtin.find(song => song.song_name === track.song_name);
    assert.ok(found, `missing builtin derivative song: ${track.song_name}`);
    assert.equal(found.audio, track.audio);
    assert.equal(found.artist, '小松绿AI');
    assert.match(found.display_version, /^$|^1\.[01]$/);
    assert.equal(found.song_name, found.display_song_name);
    // 带前缀，避免和同名直播歌共用收藏/评分身份（normalizeSongIdentity 先取 song_name）
    assert.ok(found.song_name.startsWith('小松绿-'), `非直播歌前缀缺失: ${found.song_name}`);
  }

  const ids = builtin.map(song => song.song_id);
  assert.equal(new Set(ids).size, ids.length, 'song_id 有重复，卡片播放键会匹配错歌');
  assert.ok(ids.every(id => Number.isInteger(id) && id < 0), '二创歌需要负数 song_id 才不会和真实歌曲撞 id');
  const names = builtin.map(song => String(song.song_name).trim().toLowerCase());
  assert.equal(new Set(names).size, names.length, 'song_name 有重复');
});

test('loadDerivativeSongs 保留内置二创歌，localStorage 只作补充', () => {
  const tracks = readDerivativeTracks();
  const block = sourceBetween(appSource, 'const DERIVATIVE_KEY', '// 保存二创歌曲到本地');
  const stored = JSON.stringify([{ song_name: '本地导入的歌', display_song_name: '本地导入的歌' }]);
  const context = evaluate(
    `${block}\nloadDerivativeSongs();\nglobalThis.__songs = state.derivativeSongs;`,
    {
      localStorage: { getItem: key => (key === 'songs:derivative' ? stored : null), setItem: () => {} },
      state: { derivativeSongs: [] },
      normalizeLanguageTag: value => String(value || ''),
      normalizeTypeTags: value => String(value || ''),
    }
  );
  const songs = context.__songs;
  const local = songs.find(song => song.song_name === '本地导入的歌');
  assert.ok(local, '本地导入的二创歌丢了');
  assert.ok(Number.isInteger(local.song_id) && local.song_id < 0, '本地歌没分到唯一负数 id');
  for (const track of tracks) {
    const found = songs.find(song => song.song_name === track.song_name);
    assert.ok(found, `localStorage 有数据时内置二创歌被顶掉了: ${track.song_name}`);
    assert.equal(found.audio, track.audio);
    assert.equal(found.derivative, true);
    assert.equal(found.custom, true);
  }
});

test('audioUrlOf 优先用歌曲自带的二创音频，不去音频索引里抢同名歌', () => {
  const versionLine = /^const AUDIO_ASSET_VERSION = '[^']+';$/m.exec(appSource)?.[0];
  assert.ok(versionLine, 'missing AUDIO_ASSET_VERSION');
  const block = sourceBetween(appSource, 'function versionedAudioUrl', '// 歌切切片标题');
  const origin = 'https://viridis.love';
  const context = evaluate(
    `${versionLine}\n${block}\nglobalThis.__urlOf = audioUrlOf;`,
    {
      URL,
      document: { baseURI: `${origin}/` },
      window: { location: { origin }, APP_BASE_URL: '' },
      state: {
        audioIndex: {
          audios: {
            // 故意放一条同名 + 同 row_key 的歌切音频，二创歌不该用它
            '小松绿-云烟成雨': 'assets/audio/song_999.m4a',
            '普通歌切': 'assets/audio/song_1.m4a',
          },
        },
      },
    }
  );
  const audioUrlOf = context.__urlOf;

  assert.equal(
    audioUrlOf({ song_name: '小松绿-云烟成雨', audio: 'assets/derivative/yunyan-chengyu.mp3?v=a57ebeff7a64' }),
    `${origin}/assets/derivative/yunyan-chengyu.mp3?v=a57ebeff7a64`
  );
  // 普通歌切仍然走索引，并由 versionedAudioUrl 补上 assets/audio/ 的版本号
  assert.equal(
    audioUrlOf({ song_name: '普通歌切' }),
    `${origin}/assets/audio/song_1.m4a?v=4`
  );
  assert.equal(audioUrlOf({ song_name: '没有音频的歌' }), '');
  assert.equal(audioUrlOf(null), '');
});

test('「二创歌曲」开关是播放全部/随机播放右侧的同款工具按钮，不再在高级筛选抽屉里', () => {
  const occurrences = htmlSource.match(/id="derivativeOnlyBtn"/g) || [];
  assert.equal(occurrences.length, 1, 'derivativeOnlyBtn 在 index.html 里必须且只能出现一次');

  const inputCheckbox = /<input[^>]*id="derivativeOnlyBtn"/.test(htmlSource);
  assert.equal(inputCheckbox, false, '二创开关不应再是 checkbox（要放到高级筛选外面）');

  const buttonMatch = /<button[^>]*id="derivativeOnlyBtn"[^>]*>/.exec(htmlSource);
  assert.ok(buttonMatch, '缺 id="derivativeOnlyBtn" 的按钮');
  assert.match(buttonMatch[0], /class="[^"]*\btool-btn\b/, '二创按钮要用和其它工具按钮一样的 class');
  assert.match(buttonMatch[0], /aria-pressed="false"/);

  // 位置：随机播放按钮之后
  const shuffleIndex = htmlSource.indexOf('id="playShuffleBtn"');
  const derivativeIndex = htmlSource.indexOf('id="derivativeOnlyBtn"');
  assert.notEqual(shuffleIndex, -1, 'missing playShuffleBtn');
  assert.ok(derivativeIndex > shuffleIndex, '二创按钮应该在随机播放右边');

  // 抽屉里不能再出现二创开关（范围 = 抽屉头部关闭按钮 到 底部「完成并收起」）
  const drawerStart = htmlSource.indexOf('id="closeFilterDrawerBtn"');
  const drawerEnd = htmlSource.indexOf('id="confirmFilterDrawerBtn"');
  assert.ok(drawerStart !== -1 && drawerEnd > drawerStart, 'missing filter drawer markers');
  const drawer = htmlSource.slice(drawerStart, drawerEnd);
  assert.equal(/derivativeOnlyBtn/.test(drawer), false, '高级筛选抽屉里还留着二创开关');
  assert.equal(/二创/.test(drawer), false, '高级筛选抽屉里还留着二创文案');
});

test('二创音频目录有独立的 Content-Type，且 app.js 引用带版本号', () => {
  assert.match(headersSource, /\/assets\/derivative\/\*\s*\n\s*Content-Type: audio\/mpeg/, '_headers 缺少 /assets/derivative/* 的 audio/mpeg');
  assert.match(headersSource, /\/assets\/audio\/\*\s*\n\s*Content-Type: audio\/mp4/, '_headers 缺少 /assets/audio/* 的 audio/mp4');
  assert.match(htmlSource, /js\/app\.js\?v=\d+/, 'index.html 引用 app.js 时必须带 ?v= 版本号');
});
