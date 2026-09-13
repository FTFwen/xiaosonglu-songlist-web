// 布局回归测试：守住两个曾经真实踩过的坑。
//
// 坑一：grid-template-areas 里的命名区域必须是矩形。同一个名字若出现在
//   跨行跨列的位置（例如第 4 列的第 2 行 + 整行第 3 行，拼成 L 形），
//   浏览器会判定**整条声明非法并静默丢弃**，computed 值变成 none。
//   后果是所有 grid-area 定位全部失效，控件掉进隐式列挤成一团。
//   这个失败没有任何报错，只有真的渲染才会发现，所以必须在测试里守住。
//
// 坑二：网格轨道数必须够。用 grid-column: 8 落位时如果只声明了 6 条轨道，
//   浏览器会补出暗含轨道，宽度失控（曾经把播放栏从 370px 撑到 472px）。
//
// 运行：node --test scripts/tests/layout_invariants.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../../', import.meta.url);
const indexHtml = await readFile(new URL('index.html', root), 'utf8');
const crossPageCss = await readFile(new URL('css/cross-page-player.css', root), 'utf8');
const listenCss = await readFile(new URL('css/listen-together.css', root), 'utf8');

function styleBlocks(html) {
  return [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map(match => match[1]);
}

// 去掉注释，避免注释里提到属性名时被误判
function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

// 从 CSS 里取出所有真实的 `<property>: <value>;` 声明
function declarations(css, property) {
  const clean = stripComments(css);
  const found = [];
  const pattern = new RegExp(`(?:^|[;{\\s])${property}\\s*:`, 'g');
  let match;
  while ((match = pattern.exec(clean)) !== null) {
    let i = pattern.lastIndex;
    let depth = 0;
    let value = '';
    while (i < clean.length) {
      const ch = clean[i];
      if (ch === '(') depth += 1;
      if (ch === ')') depth -= 1;
      if (depth === 0 && (ch === ';' || ch === '}')) break;
      value += ch;
      i += 1;
    }
    found.push(value.trim());
  }
  return found;
}

function parseAreaRows(value) {
  return [...value.matchAll(/"([^"]*)"/g)]
    .map(match => match[1].trim().split(/\s+/).filter(Boolean));
}

// 取出所有 selector 匹配的规则体（同名选择器可能有多条，例如手机端播放栏的
// backdrop-filter 补丁和网格规则是同名分开写的）
function rulesFor(css, selector) {
  const clean = stripComments(css);
  const bodies = [];
  const pattern = new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{`, 'g');
  let match;
  while ((match = pattern.exec(clean)) !== null) {
    bodies.push(clean.slice(match.index, clean.indexOf('}', match.index)));
  }
  return bodies;
}

function mobilePlayerBarGridRule(css) {
  const grid = rulesFor(css, 'html body .player-bar').find(body => /display:\s*grid/.test(body));
  assert.ok(grid, '找不到手机端播放栏的网格规则（html body .player-bar { display: grid }）');
  return grid;
}

test('grid-template-areas 的每个命名区域都必须是矩形', () => {
  const sources = [
    { name: 'index.html 内联样式', css: styleBlocks(indexHtml).join('\n') },
    { name: 'css/cross-page-player.css', css: crossPageCss },
    { name: 'css/listen-together.css', css: listenCss },
  ];

  let checked = 0;
  for (const { name, css } of sources) {
    for (const value of declarations(css, 'grid-template-areas')) {
      const rows = parseAreaRows(value);
      assert.ok(rows.length > 0, `${name}: 无法解析的 grid-template-areas → ${value}`);
      checked += 1;

      const columnCounts = new Set(rows.map(row => row.length));
      assert.equal(columnCounts.size, 1, `${name}: grid-template-areas 每行列数必须一致 → ${value}`);

      const cells = new Map();
      rows.forEach((row, rowIndex) => {
        row.forEach((cellName, columnIndex) => {
          if (cellName === '.') return; // 空位不算区域
          if (!cells.has(cellName)) cells.set(cellName, []);
          cells.get(cellName).push([rowIndex, columnIndex]);
        });
      });

      for (const [cellName, list] of cells) {
        const rowIndexes = list.map(([r]) => r);
        const columnIndexes = list.map(([, c]) => c);
        const minRow = Math.min(...rowIndexes);
        const maxRow = Math.max(...rowIndexes);
        const minColumn = Math.min(...columnIndexes);
        const maxColumn = Math.max(...columnIndexes);
        const expected = (maxRow - minRow + 1) * (maxColumn - minColumn + 1);
        assert.equal(
          list.length,
          expected,
          `${name}: 命名区域「${cellName}」不是矩形（占 ${list.length} 格，矩形应为 ${expected} 格）→ ${value}`,
        );
      }
    }
  }

  assert.ok(checked > 0, '应当至少检查到一条 grid-template-areas 声明（跨页播放器用到了它）');
});

test('手机端播放栏用显式行列定位，且声明的轨道数覆盖所有落位', () => {
  const css = styleBlocks(indexHtml).join('\n');
  const clean = stripComments(css);
  const mobileRule = mobilePlayerBarGridRule(css);

  assert.match(mobileRule, /display:\s*grid\s*!important/, '手机端播放栏必须是网格');
  assert.doesNotMatch(mobileRule, /grid-template-areas/, '手机端播放栏不应使用命名区域（会被 L 形判非法）');

  const columnDecl = declarations(mobileRule, 'grid-template-columns')[0];
  assert.ok(columnDecl, '手机端播放栏必须声明 grid-template-columns');
  const trackCount = columnDecl.split(/\s+(?![^(]*\))/).filter(Boolean).length;

  const placements = [...clean.matchAll(/\.player-bar[^{}]*\{[^}]*grid-column:\s*([^;]+);/g)]
    .map(match => match[1].trim());
  assert.ok(placements.length > 0, '手机端播放栏应当用 grid-column 落位');

  for (const placement of placements) {
    if (placement === '1 / -1') continue; // 整行，不受轨道数限制
    for (const value of placement.split('/').map(part => part.trim())) {
      if (value === 'auto' || value === '-1') continue;
      const column = Number(value);
      assert.ok(Number.isFinite(column), `无法解析的 grid-column 落位: ${placement}`);
      assert.ok(
        column <= trackCount + 1,
        `grid-column 落位到第 ${column} 列，但只声明了 ${trackCount} 条轨道（会补出暗含轨道并撑宽布局）: ${placement}`,
      );
    }
  }
});

test('手机端播放栏宽度锁定为视口宽减 20px，避免被内容撑开', () => {
  const css = styleBlocks(indexHtml).join('\n');
  const mobileRule = mobilePlayerBarGridRule(css);
  assert.match(mobileRule, /width:\s*calc\(100vw\s*-\s*20px\)/, '手机端播放栏宽度必须显式锁定');
});
