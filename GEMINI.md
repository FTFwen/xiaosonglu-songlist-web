# 项目规则与上下文指南 (GEMINI.md)

本项目为**小松绿歌单网站（xiaosonglu-songlist-web）**及周边子站的前端开发与维护项目。在当前项目的所有对话中，AI 助手必须严格遵循以下技能调用规范与开发准则。

---

## 1. 核心技能 (Skills) 自动生效要求

1. **`modern-web-guidance`（现代 Web 开发规范）- 强制优先**
   - 每次涉及 HTML、CSS、客户端 JavaScript 编写、重构、动效设计与 UI 改造时，**必须优先**检索并遵循现代 Web 标准最佳实践。
   - 在 Windows 环境下优先执行：`npx.cmd -y modern-web-guidance@latest search "<query>"` 并使用 `retrieve` 获取标准实现方案。
   - 优先采用现代标准特性（如 CSS 变量体系、`:has()`、现代视口单位、View Transitions、原生 Popover/Dialog 等），避免引入冗余庞大的三方库。

2. **`chrome-devtools`（浏览器调试与页面测试）**
   - 在调试页面报错、DOM 结构排查、控制台日志分析、响应式截图与交互流程验证时，调用 Chrome DevTools 工具链进行页面审查。

3. **`debug-optimize-lcp` & `a11y-debugging`（性能与可访问性）**
   - 当涉及首屏加载性能、图片加载优化（如背景 webp 优先级）、字体加载或无障碍审计时主动参考并应用。

---

## 2. 项目架构与技术栈概况

- **技术栈**：纯静态前端（原生 HTML5 / CSS3 / JavaScript ES6+）
- **托管与云服务**：Cloudflare Pages + Cloudflare Pages Functions (`functions/api/*`) + Cloudflare R2（音频存储）
- **主要模块**：
  - 主站歌单（`index.html` + `js/app.js`）
  - 按钮墙（`buttons/index.html` + `buttons/buttons.js`）
  - 24点小游戏（`24xsl/index.html`）
  - 共享模块（`js/shared.js`）
  - 静态资源（`assets/`：包含字体、背景 webp、SVG 图标等）

---

## 3. 开发准则与关键红线

1. **禁止手动修改数据产物**
   - `data/xiaosonglu/*.json` 以及 `js/data.js`（`window.XSL_DATA`）是外部采集管线生成的汇总产物，**切勿手动编辑修改**（会被后续管线覆盖）。

2. **版本号缓存穿透（必须执行）**
   - 修改 HTML、CSS、JS 逻辑后，**必须同步递增静态资源引入的版本号**（例如 `js/app.js?v=XX`），以防止 Cloudflare CDN 及浏览器强缓存导致更新不生效。

3. **UI 与动效设计约束**
   - **布局原则**：遵循“功能逻辑与核心控件位置保持基本不变，打磨视觉细节与动效体验”的原则。
   - **动效无障碍**：所有动效需统一考虑 `prefers-reduced-motion: reduce` 媒体查询，保障可访问性。
   - **字体子集保护**：站酷快乐体（`assets/xiaosonglu-kuaile-subset.woff2`）为常用字精简子集，不可将生僻字直接套用该字体（避免文字回退撕裂）。

4. **Cloudflare 部署规范**
   - 本地使用 wrangler 部署前，**必须先递归清理本地构建缓存**：
     `Remove-Item -Recurse -Force .wrangler`（PowerShell）
     否则 `functions/` 目录将无法正常编译，导致 `/api/*` 后端接口异常。
