// 手机端播放栏渲染诊断（开发用，不参与部署）：
//   1. 从 index.html 抽出真实 <style> 内容
//   2. 生成只含播放栏的最小页面（三种评分状态各一份）
//   3. 交给无头浏览器截图或 dump 计算样式，就能看到真实排版
//
// 为什么需要它：grid-template-areas 一旦非法（例如命名区域不是矩形），
// 浏览器会**静默丢弃整条声明**，computed 值变成 none，控件全部掉进隐式列挤成一团。
// 这种问题读代码看不出来，只能真的渲染一次。回归守卫见 layout_invariants.test.mjs。
//
// 用法：
//   node scripts/tests/_mobilebar_render.mjs 390 844
//   & "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" `
//     --headless=new --disable-gpu --force-device-scale-factor=1 `
//     --window-size=390,700 --virtual-time-budget=2500 `
//     --dump-dom "file:///<repo>/_render_mobilebar_390.html"
//   或用 --screenshot="<repo>/_shot_390.png" 直接看图。
//
// 生成的 _render_mobilebar_*.html 与 _shot_*.png 已加入 .gitignore。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const width = Number(process.argv[2] || 390);
const height = Number(process.argv[3] || 844);

const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const styleMatch = /<style[^>]*>([\s\S]*?)<\/style>/.exec(html);
if (!styleMatch) throw new Error('index.html 里找不到 <style> 块');
const css = styleMatch[1];

// 播放栏本体（结构与 index.html 一致，用文字代替 svg 图标以免混淆）
const bar = `
  <div class="player-bar" id="playerBar">
    <button class="player-btn" id="playerPrevBtn" title="上一首">‹</button>
    <button class="player-btn primary" id="playerToggleBtn" title="播放 / 暂停">▶</button>
    <button class="player-btn" id="playerNextBtn" title="下一首">›</button>
    <div class="player-info">
      <div class="player-name" id="playerSongName">勾指起誓</div>
      <div class="player-artist" id="playerSongArtist">小松绿</div>
    </div>
    <div class="player-rating-host" id="playerRatingHost" data-rating-host></div>
    <div class="player-progress">
      <span class="player-time" id="playerTimeCur">00:12</span>
      <input type="range" class="player-range" id="playerSeek" min="0" max="1000" value="300" step="1">
      <span class="player-time"><span id="playerTimeDur">03:20</span></span>
    </div>
    <button class="player-btn" id="playerShuffleBtn" title="模式">↻</button>
    <button class="player-btn" id="playerFavBtn" title="收藏">♡</button>
    <div class="player-timer-wrap" id="playerTimerWrap">
      <button class="player-timer-btn" id="playerTimerBtn" title="睡眠定时">☾</button>
    </div>
    <div class="player-volume">
      <span>🔊</span>
      <input type="range" class="player-range" id="playerVolume" min="0" max="100" value="80">
    </div>
  </div>
`;

// 星形与 js/rating.js 里的三张配套图同形（空星 / 半星 / 满星）
function stars(score, interactive) {
  const outer = 'M12 1.8 15 8.4 22.2 9.3 17 14 18.4 21.2 12 17.7 5.6 21.2 7 14 1.8 9.3 9 8.4Z';
  let out = '';
  for (let i = 0; i < 5; i += 1) {
    const remaining = score - i * 2;
    const cls = remaining >= 2 ? 'is-full' : remaining >= 1 ? 'is-half' : 'is-empty';
    out += '<span class="rating-star">'
      + `<svg class="rating-star-shape ${cls}" viewBox="0 0 24 24"><path d="${outer}"></path></svg>`
      + (interactive ? '<span class="rating-star-hit half"></span><span class="rating-star-hit full"></span>' : '')
      + '</span>';
  }
  return out;
}

function host(state) {
  const avgScore = state === 'empty' ? 0 : 7;
  const ownScore = state === 'mine' ? 6 : 0;
  const avgText = state === 'empty' ? '' : '7.0';
  const ownText = state === 'mine' ? '6 分' : '';
  const openClass = state === 'mine' ? 'rating-open is-scored' : 'rating-open';
  return `<div class="song-rating">
      <div class="rating-line">
        <span class="rating-label">均分</span>
        <span class="rating-stars">${stars(avgScore, false)}</span>
        <span class="rating-avg-text">${avgText}</span>
      </div>
      <button type="button" class="${openClass}">
        <span class="rating-label">我的</span>
        <span class="rating-stars">${stars(ownScore, false)}</span>
        <span class="rating-own-text">${ownText}</span>
      </button>
    </div>`;
}

const states = ['empty', 'avg', 'mine'];
let page = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>mobilebar ${width}</title>
<style>${css}</style>
<style>
  /* 诊断页专用：三份播放栏纵向排开，方便一次截全 */
  body { margin: 0; padding: 0; background: #dfe4d0; }
  .diag-stack { display: flex; flex-direction: column; gap: 18px; padding: 14px 0 22px; }
  .diag-label { font: 12px/1.4 sans-serif; color: #3d4630; padding: 0 12px; }
  .player-bar { position: static !important; transform: none !important; margin: 0 auto !important; }
</style>
</head><body><div class="diag-stack">`;

for (const state of states) {
  page += `<div class="diag-label">状态：${state}（视口宽 ${width}px）</div>`;
  page += bar.replace(
    '<div class="player-rating-host" id="playerRatingHost" data-rating-host></div>',
    `<div class="player-rating-host" id="playerRatingHost" data-rating-host>${host(state)}</div>`,
  );
}

// 诊断脚本：把关键元素的计算样式与位置写进 DOM，配合 --dump-dom 读取
page += `<script>
window.addEventListener('load', function () {
  setTimeout(function () {
    var barEl = document.querySelector('.player-bar');
    var barCs = getComputedStyle(barEl);
    var barRect = barEl.getBoundingClientRect();
    var lines = document.querySelectorAll('#playerRatingHost .rating-line, #playerRatingHost .rating-open');
    var lineInfo = Array.prototype.map.call(lines, function (line) {
      var r = line.getBoundingClientRect();
      var label = line.querySelector('.rating-label');
      var st = line.querySelector('.rating-stars');
      var txt = line.querySelector('.rating-avg-text, .rating-own-text');
      var txtRect = txt ? txt.getBoundingClientRect() : null;
      return '[' + Math.round(r.left) + '..' + Math.round(r.right) + ']'
        + ' label@' + Math.round(label.getBoundingClientRect().left)
        + ' stars@' + Math.round(st.getBoundingClientRect().left)
        + ' text@' + Math.round(txtRect ? txtRect.left : 0)
        + ' textH=' + Math.round(txtRect ? txtRect.height : 0);
    }).join(' ');
    var star = document.querySelector('#playerRatingHost .rating-star');
    var starRect = star ? star.getBoundingClientRect() : null;
    var host = document.querySelector('#playerRatingHost');
    var hostRect = host.getBoundingClientRect();
    var parentRect = host.parentElement.getBoundingClientRect();
    var out = [
      'VIEWPORT innerWidth=' + window.innerWidth + ' docClientWidth=' + document.documentElement.clientWidth,
      'BAR rect=' + [Math.round(barRect.left), Math.round(barRect.top), Math.round(barRect.width), Math.round(barRect.height)].join(','),
      'BAR display=' + barCs.display + ' columns=' + barCs.gridTemplateColumns + ' rows=' + barCs.gridTemplateRows,
      'BAR areas=' + (barCs.gridTemplateAreas || '-') + ' width=' + barCs.width,
      'BAR scrollWidth=' + barEl.scrollWidth + ' clientWidth=' + barEl.clientWidth,
      'MEDIA768=' + window.matchMedia('(max-width: 768px)').matches + ' MEDIA560=' + window.matchMedia('(max-width: 560px)').matches,
      'STAR size=' + (starRect ? Math.round(starRect.width) + 'x' + Math.round(starRect.height) : '-'),
      'RATING host=' + [Math.round(hostRect.left), Math.round(hostRect.right)].join('..')
        + ' parent=' + [Math.round(parentRect.left), Math.round(parentRect.right)].join('..')
        + ' centerOK=' + (Math.abs((hostRect.left + hostRect.right) / 2 - (parentRect.left + parentRect.right) / 2) <= 1),
      'RATING lines=' + lineInfo,
    ];
    Array.prototype.forEach.call(document.querySelectorAll('.player-bar > *'), function (el) {
      var r = el.getBoundingClientRect();
      if (r.width || r.height) {
        out.push('CHILD ' + (el.id || el.className) + ' = ' + [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)].join(','));
      }
    });
    var pre = document.createElement('pre');
    pre.id = 'diagout';
    pre.textContent = out.join('\\n');
    document.body.appendChild(pre);
  }, 400);
});
</script>`;
page += '</div></body></html>';

const target = path.join(ROOT, `_render_mobilebar_${width}.html`);
fs.writeFileSync(target, page, 'utf8');
console.log(`wrote ${target} (${page.length} bytes, css ${css.length} bytes)`);
