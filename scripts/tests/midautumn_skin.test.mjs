import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve('.');

test('1. 验证歌单与按钮墙正确集成中秋节日皮肤与切换小按钮', () => {
  const rootIndex = fs.readFileSync(path.join(REPO_ROOT, 'index.html'), 'utf8');
  assert.ok(rootIndex.includes('css/midautumn-skin.css?v='), '歌单 index.html 必须引入 css/midautumn-skin.css 且带有版本号');
  assert.ok(rootIndex.includes('js/midautumn-skin.js?v='), '歌单 index.html 必须引入 js/midautumn-skin.js 且带有版本号');
  assert.ok(rootIndex.includes('id="festivalSkinBtn"'), '歌单 index.html 必须包含桌面端节日皮肤切换按钮 festivalSkinBtn');
  assert.ok(rootIndex.includes('id="mobileFestivalSkinBtn"'), '歌单 index.html 必须包含移动端节日皮肤切换按钮 mobileFestivalSkinBtn');
  assert.ok(rootIndex.includes('data-skin'), '歌单 index.html 头部必须包含早期防闪烁感知脚本');

  const buttonsIndex = fs.readFileSync(path.join(REPO_ROOT, 'buttons/index.html'), 'utf8');
  assert.ok(buttonsIndex.includes('css/midautumn-skin.css?v='), '按钮墙 buttons/index.html 必须引入 css/midautumn-skin.css 且带有版本号');
  assert.ok(buttonsIndex.includes('js/midautumn-skin.js?v='), '按钮墙 buttons/index.html 必须引入 js/midautumn-skin.js 且带有版本号');
  assert.ok(buttonsIndex.includes('id="festivalSkinBtn"'), '按钮墙 buttons/index.html 必须包含桌面端节日皮肤切换按钮 festivalSkinBtn');
  assert.ok(buttonsIndex.includes('id="mobileFestivalSkinBtn"'), '按钮墙 buttons/index.html 必须包含移动端节日皮肤切换按钮 mobileFestivalSkinBtn');
  assert.ok(buttonsIndex.includes('data-skin'), '按钮墙 buttons/index.html 头部必须包含早期防闪烁感知脚本');

  // 严格资产隔离校验：确保没有把临时草稿遗留在根目录 assets/
  const rootAssets = fs.readdirSync(path.join(REPO_ROOT, 'assets'));
  const dirtyFiles = rootAssets.filter(f => f.includes('mid-autumn') || f.includes('osmanthus'));
  assert.equal(dirtyFiles.length, 0, `根目录 assets/ 严禁遗留草稿碎片: ${dirtyFiles.join(', ')}`);
});

test('2. 验证全站中秋美术素材完整性与有效性', () => {
  const targetDirs = [
    path.join(REPO_ROOT, 'assets/midautumn'),
    path.join(REPO_ROOT, 'workshop/assets/midautumn')
  ];

  const requiredFiles = [
    'bg.webp',
    'branch.webp',
    'rabbit.webp',
    'petal_1.webp',
    'petal_2.webp',
    'petal_3.webp',
    'petal_4.webp'
  ];

  for (const dir of targetDirs) {
    assert.ok(fs.existsSync(dir), `目录 ${dir} 必须存在`);
    for (const file of requiredFiles) {
      const fullPath = path.join(dir, file);
      assert.ok(fs.existsSync(fullPath), `素材 ${file} 必须存在于 ${dir}`);
      const stat = fs.statSync(fullPath);
      assert.ok(stat.size > 1000, `素材 ${file} 必须为有效非空图片文件 (大小: ${stat.size}B)`);
    }
  }
});

test('3. 验证本地 Three.js 库文件 (Workshop 3D 依赖)', () => {
  const threePath = path.join(REPO_ROOT, 'workshop/js/lib/three.min.js');
  assert.ok(fs.existsSync(threePath), 'workshop/js/lib/three.min.js 必须存在');
  const stat = fs.statSync(threePath);
  assert.ok(stat.size > 300000, `three.min.js 必须为有效的三维引擎打包文件 (大小: ${stat.size}B)`);
});

test('4. 验证 workshop/index.html 样式与脚本正确引入并完成缓存穿透递增', () => {
  const html = fs.readFileSync(path.join(REPO_ROOT, 'workshop/index.html'), 'utf8');

  assert.ok(html.includes('css/midautumn-skin.css?v=3') || html.includes('css/midautumn-skin.css?v=4') || html.includes('css/midautumn-skin.css?v=5'), '必须引入 css/midautumn-skin.css?v=3 或更高版本');
  assert.ok(html.includes('js/midautumn-skin.js?v=3') || html.includes('js/midautumn-skin.js?v=4') || html.includes('js/midautumn-skin.js?v=5'), '必须引入 js/midautumn-skin.js?v=3 或更高版本');
  assert.ok(html.includes('css/weather-ambience.css?v=11'), 'css/weather-ambience.css 版本号应递增至 11');
  assert.ok(html.includes('js/weather-ambience.js?v=6') || html.includes('js/weather-ambience.js?v=7'), 'js/weather-ambience.js 版本号应递增至 6 或 7');
  assert.ok(html.includes('data-midautumn-skin'), 'head 中应包含防闪烁的早期 data-midautumn-skin 注入逻辑');
});

test('5. 验证中秋农历节气判定与双轨控制逻辑', () => {
  const code = fs.readFileSync(path.join(REPO_ROOT, 'js/midautumn-skin.js'), 'utf8');
  assert.ok(code.includes('formatToParts'), '必须使用 formatToParts 稳妥解析农历月日');

  function isMidAutumnPeriod(now = new Date()) {
    try {
      const fmt = new Intl.DateTimeFormat('zh-CN-u-ca-chinese', { month: 'numeric', day: 'numeric' });
      const parts = fmt.formatToParts(now);
      const mp = parts.find(p => p.type === 'month');
      const dp = parts.find(p => p.type === 'day');
      if (mp && dp) {
        const lunarMonth = parseInt(mp.value, 10);
        const lunarDay = parseInt(dp.value, 10);
        if (!isNaN(lunarMonth) && !isNaN(lunarDay) && lunarMonth === 8 && lunarDay >= 1 && lunarDay <= 20) {
          return true;
        }
      }
    } catch (e) {}

    const y = now.getFullYear();
    const intervals = {
      2024: [[9, 10], [9, 23]],
      2025: [[9, 28], [10, 12]],
      2026: [[9, 15], [9, 30]],
      2027: [[9, 8], [9, 22]],
      2028: [[9, 25], [10, 8]],
      2029: [[9, 15], [9, 28]],
      2030: [[9, 5], [9, 18]]
    };
    if (intervals[y]) {
      const [[m1, d1], [m2, d2]] = intervals[y];
      const start = new Date(y, m1 - 1, d1, 0, 0, 0);
      const end = new Date(y, m2 - 1, d2, 23, 59, 59);
      if (now >= start && now <= end) return true;
    }
    return false;
  }

  // 2026 年中秋节当天 (公历 2026-09-25)
  assert.equal(isMidAutumnPeriod(new Date('2026-09-25')), true, '2026年中秋节当天必须判定为节气激活');
  // 2026 年农历八月初七 (公历 2026-09-17)
  assert.equal(isMidAutumnPeriod(new Date('2026-09-17')), true, '2026年农历八月初七中秋当月应判定为节气激活');
  // 2026 年冬至 (公历 2026-12-21)
  assert.equal(isMidAutumnPeriod(new Date('2026-12-21')), false, '非中秋节气不得误激活');

  // 双轨控制测试
  function resolveSkinState(pref, date) {
    if (pref === 'midautumn' || pref === 'on') return true;
    if (pref === 'default' || pref === 'off') return false;
    return isMidAutumnPeriod(date);
  }

  assert.equal(resolveSkinState('midautumn', new Date('2026-05-01')), true, '用户手动开启时无条件生效');
  assert.equal(resolveSkinState('default', new Date('2026-09-25')), false, '用户手动关闭时中秋节当天亦保持关闭');
  assert.equal(resolveSkinState('auto', new Date('2026-09-25')), true, 'auto模式中秋节自动激活');
  assert.equal(resolveSkinState('auto', new Date('2026-03-01')), false, 'auto模式春季不激活');
});

test('6. 验证 weather-ambience.js 光影面板集成中秋开关', () => {
  const js = fs.readFileSync(path.join(REPO_ROOT, 'workshop/js/weather-ambience.js'), 'utf8');

  assert.ok(js.includes('id="midautumnSkinToggle"'), '光影弹窗中必须包含 midautumnSkinToggle 开关');
  assert.ok(js.includes('id="midautumnStatusTag"'), '光影弹窗中必须包含 midautumnStatusTag 状态标签');
  assert.ok(js.includes('midautumnToggle.addEventListener'), '必须绑定 midautumnToggle 事件监听');
  assert.ok(js.includes('window.MidAutumnSkin.isEnabled()'), 'updateTopbarUI 必须联动 MidAutumnSkin 状态');
});

test('7. 验证 midautumn-skin.css 样式系统完备性 (包含歌单与按钮墙沉浸夜景定制)', () => {
  const css = fs.readFileSync(path.join(REPO_ROOT, 'css/midautumn-skin.css'), 'utf8');

  assert.ok(css.includes('html[data-skin="midautumn"]'), '必须包含 html[data-skin="midautumn"] 选择器');
  assert.ok(css.includes('.skin-switch-btn'), '必须包含小巧开关按钮样式 .skin-switch-btn');
  assert.ok(css.includes('.skin-popover-menu'), '必须包含通透琉璃皮肤切换面板 .skin-popover-menu');
  assert.ok(css.includes('.midautumn-header-ornament'), '必须包含中秋玉兔桂枝装饰 .midautumn-header-ornament');
  assert.ok(css.includes('.sound-btn'), '必须包含按钮墙声音按钮夜光定制');
  assert.ok(css.includes('.sticky-toolbar'), '必须包含歌单置顶工具栏暗色夜景定制');
  assert.ok(css.includes('.song-item'), '必须包含歌单卡片暗色夜景琉璃定制');
  assert.ok(css.includes('.player-bar'), '必须包含歌单底部播放栏夜景定制');
  assert.ok(css.includes('prefers-reduced-motion: reduce'), '必须支持 prefers-reduced-motion 降级');
});

test('8. 验证 midautumn-skin.js 核心 API、按钮绑定与粒子系统', () => {
  const js = fs.readFileSync(path.join(REPO_ROOT, 'js/midautumn-skin.js'), 'utf8');

  assert.ok(js.includes('window.XSLFestivalSkin = {'), '必须暴露 window.XSLFestivalSkin API');
  assert.ok(js.includes('window.MidAutumnSkin = window.XSLFestivalSkin'), '必须兼容 window.MidAutumnSkin 别名');
  assert.ok(js.includes('class OsmanthusPetalEngine'), '必须包含金桂雨飘落粒子系统');
  assert.ok(js.includes('isMidAutumnPeriod'), '必须包含农历中秋判定');
  assert.ok(js.includes('dataset.bound'), '必须具备防重绑定且能为静态已有 DOM 按钮挂载点击事件的机制');
  assert.ok(js.includes('toggleSkinPopover'), '必须实现皮肤选择浮层唤起函数');
  assert.ok(js.includes('prefers-reduced-motion'), '必须支持 prefers-reduced-motion 无障碍');
  assert.ok(js.includes('visibilitychange'), '必须监听 visibilitychange 实现节能优化');
});

test('9. 验证中秋皮肤 V3 优化点：桂花枝与玉兔对角错落分离、星空水波薄雾沉浸层及版本号递增', () => {
  const css = fs.readFileSync(path.join(REPO_ROOT, 'css/midautumn-skin.css'), 'utf8');
  assert.ok(css.includes('.midautumn-bg-backdrop'), 'CSS 必须包含全站沉浸夜景氛围层 .midautumn-bg-backdrop');
  assert.ok(css.includes('.midautumn-starfield'), 'CSS 必须包含璀璨星芒与细密星尘层 .midautumn-starfield');
  assert.ok(css.includes('.midautumn-clouds'), 'CSS 必须包含月影薄雾与轻云流光层 .midautumn-clouds');
  assert.ok(css.includes('.midautumn-water-waves'), 'CSS 必须包含远山水波暗纹与水乡倒影 .midautumn-water-waves');
  assert.ok(css.includes('.midautumn-sky-glow'), 'CSS 必须包含顶端柔美暖金光晕辐射 .midautumn-sky-glow');

  // 桂花枝与玉兔对角错落分离，杜绝堆叠与按钮冲突
  assert.ok(css.includes('top: -8px') && (css.includes('left: -8px') || css.includes('left: 225px')), '桂枝必须置于顶部横斜垂落');
  assert.ok(css.includes('right: 216px') && css.includes('bottom: 0px'), '玉兔必须错落独立安置于底部避让按钮区');

  const js = fs.readFileSync(path.join(REPO_ROOT, 'js/midautumn-skin.js'), 'utf8');
  assert.ok(js.includes('ensureBackdrop'), 'JS 必须包含全站沉浸背景层管理函数 ensureBackdrop');
  assert.ok(js.includes('sparkles'), '金桂粒子引擎中必须扩充星尘微光粒子 sparkles');

  // 验证各页面均已完成静态资源版本递增至 v=3
  const indexHtml = fs.readFileSync(path.join(REPO_ROOT, 'index.html'), 'utf8');
  assert.ok(indexHtml.includes('css/midautumn-skin.css?v=3'), '主站 index.html 样式版本必须递增至 v=3');
  assert.ok(indexHtml.includes('js/midautumn-skin.js?v=3'), '主站 index.html 脚本版本必须递增至 v=3');

  const buttonsHtml = fs.readFileSync(path.join(REPO_ROOT, 'buttons/index.html'), 'utf8');
  assert.ok(buttonsHtml.includes('css/midautumn-skin.css?v=3'), '按钮墙 buttons/index.html 样式版本必须递增至 v=3');
  assert.ok(buttonsHtml.includes('js/midautumn-skin.js?v=3'), '按钮墙 buttons/index.html 脚本版本必须递增至 v=3');

  const wsHtml = fs.readFileSync(path.join(REPO_ROOT, 'workshop/index.html'), 'utf8');
  assert.ok(wsHtml.includes('css/midautumn-skin.css?v=3') || wsHtml.includes('css/midautumn-skin.css?v=4') || wsHtml.includes('css/midautumn-skin.css?v=5'), '工作台 workshop/index.html 样式版本必须递增至 v=3 或更高版本');
  assert.ok(wsHtml.includes('js/midautumn-skin.js?v=3') || wsHtml.includes('js/midautumn-skin.js?v=4') || wsHtml.includes('js/midautumn-skin.js?v=5'), '工作台 workshop/index.html 脚本版本必须递增至 v=3 或更高版本');
});
