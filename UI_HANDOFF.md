# 小松绿歌单网站 · UI 优化交接文档

> 给 antigravity 环境 / 后续 UI 美化工作的完整交接。
> 目标：**保持功能与 UI 控件位置基本不变**，丰富动效、用更好看的 UI 替换（可把主题人物身上的元素做成 icon，允许用 AI 生图）。
> 最后更新：2026-09（源数据已同步 GitHub main）。

---

## 〇、一句话

这是一个「V 圈歌单」风格个人站：主站歌单 + 按钮墙 + 24点，橄榄绿/奶油主题 + 毛玻璃 + 园艺少女主题人物。代码是**纯静态 HTML/CSS/JS**（CSS 全部内联在各页 `<style>` 里），托管 Cloudflare Pages，动态部分走 Pages Functions + R2。

---

## 一、接入与运行

### Git（antigravity 直接 clone）
```bash
git clone https://github.com/FTFwen/xiaosonglu-songlist-web.git
cd xiaosonglu-songlist-web
```
- 分支：`main`
- 线上：https://viridis.love （主站）、https://viridis.love/buttons （按钮墙）、https://viridis.love/24xsl （24点）

### 本地预览
直接浏览器打开对应 html（file://）即可看 UI：
- 主站 `index.html`
- 按钮墙 `buttons/index.html`
- 24点 `24xsl/index.html`

### 部署（重要，改完要发版才用）
```bash
# 每次部署前必须清缓存，否则 functions 不编译 /api/* 会挂
Remove-Item -Recurse -Force .wrangler      # Linux: rm -rf .wrangler
wrangler pages deploy . --project-name xsl-songlist --branch main --commit-dirty=true
```
> 需要环境变量：`CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID`（见协作文档，另传）。
> **提醒**：改 JS/CSS 后记得升版本号（`js/app.js?v=5x` 这种），否则 CDN 缓存旧文件，看不到效果。

---

## 二、页面 / 文件地图

| 路径 | 说明 | UI 所在 |
|------|------|---------|
| `index.html` | 主站「小松绿歌单」（歌曲列表/筛选/播放器/中意/历史/歌单） | `<style>` 内联 CSS |
| `js/app.js` | 主站逻辑（播放器/收藏/筛选/存档/二创歌） | — |
| `js/shared.js` | 共享工具 | — |
| `js/data.js` | 歌单数据（生成产物，勿手改） | — |
| `buttons/index.html` | 按钮墙（磁帖/播放器/后台管理/编辑模式） | `<style>` |
| `buttons/buttons.js` | 按钮墙逻辑 | — |
| `24xsl/index.html` | 24点小游戏 | `<style>` |
| `assets/` | 字体/背景/图标图片 | 见下 |
| `data/xiaosonglu/*` | 采集数据（勿手改） | — |
| `functions/` | Cloudflare 后端接口 `/api/*`（勿动） | — |

> ⚠️ **布局关键**：三页共用一套「书签页签 `.site-tabs`」（左侧竖排）与「移动端竖排导航」（header-nav/banner-nav）。改动 UI 时三页风格需保持一致（主站页签图标 SVG sprite 与按钮墙/24点各自 sprite 需同步加图标）。

---

## 三、设计系统（现状）

### 主题色（CSS 变量，定义在 index.html `:root`）
当前橄榄/奶油主题（页面实际生效的一套）：
```css
:root {
  --bg: #f4f6e8;        /* 页面浅米绿背景 */
  --surface: #ffffff;   /* 卡片面 */
  --line: #e3e8c8;      /* 描边 */
  --text: #3d4630;      /* 正文深绿灰 */
  --primary: #8a9a4e;   /* 橄榄绿主色 */
  /* 另有一组蓝色旧变量 --bg #eef3ff / --primary #5b6ee1 等，若看到蓝紫色是旧值残留 */
}
```
其余变量（--surface-soft / --primary-soft / --danger 等）散在各 `<style>` 顶部，可自行 grep `--` 收集。

### 视觉语言现状
- **毛玻璃卡片**：半透明底 + `backdrop-filter: blur(...)`，桌面/手机已调透明度和模糊（0.4/0.2 alpha、blur 5-10px 手机端、18px 桌面端）
- **卡片圆角** 14px、悬浮微上浮 `translateY(-3px)` + 阴影加深（主站歌曲卡）
- **背景**：浅绿渐变 + 园艺少女人物（桌面 `bg-person.webp` 右下；手机版 `bg-mobile-person.webp` 被主题色遮罩淡化 + 底部有半透明遮罩）
- **字体**：标题/分类用「站酷快乐体」子集 `assets/xiaosonglu-kuaile-subset.woff2`（仅含常用字 + 标题/分类字，约 48KB，**生僻字自动回退微软雅黑**——别在快乐体文本里写生僻字）；正文微软雅黑
- **图标**：Ant Design 线性 SVG sprite（`<symbol id="icon-xxx">`，`fill: currentColor`），三页各自有 sprite

---

## 四、主题人物 & 可提取的 icon 元素

网站主题人物 = **园艺少女**（绿短发、荷包蛋贝雷帽、棕色格子背带裙、手持浇花壶、壶里小动物与花、腿上贴创可贴、身旁有花/向日葵）。整体是「治愈森系 / 橄榄奶油」画风，背景偏暖米色/奶油。

### 现有可复用素材（assets/ 内）
| 文件 | 内容 | 用途 |
|------|------|------|
| `assets/bg-person.webp`（~86KB） | 少女上半身透明抠图（桌面色背景人物） | 桌面背景 |
| `assets/bg-mobile-person.webp`（~130KB） | 少女全身 + 签名「梦溪云」，白底抠除（手机背景） | 手机背景 |
| `assets/xiaosonglu-logo.png` | 标题小 logo | header |
| `assets/24xsl-title.webp` | 「24点」小牌 | 页签图标 |
| `assets/bg-garden.png` / `assets/bg-mobile-person.png` | 早期素材（已被 webp 取代，可留作图源） | 备选 |

> **生图建议**：可直接拿上述抠好的人物图做元素提取，或生成统一风格的「荷包蛋 / 向日葵 / 浇花壶 / 星星 / 叶子」线性 icon（配色贴合 #8a9a4e 橄榄 + 奶油 #fdf7d8 + 暖红点缀）。**已上线的例子**：标本馆页签用 🌻 emoji；建议统一后全站换同风格。

---

## 五、UI 优化方向（antigravity 任务）

在「**功能不变、控件位置大致不变**」前提下：

1. **动效丰富**（重点）
   - 卡片 hover：现有歌曲卡上浮，可推广到磁帖/按钮/面板；加入 `transition` 统一时长（~0.18s ease）
   - 页面入场：淡入/轻微上移（列表、卡片分批显现）
   - 按钮按压反馈（active scale 0.96）
   - 弹窗/抽屉：fade + scale 过渡
   - 播放器进度条、音量、爱心/收藏反馈小动效
   - 尊重 `prefers-reduced-motion`
2. **更好看的 UI 替换**（保持布局）
   - 统一圆角/阴影/描边体系，卡片加更精致的毛玻璃 + 光感（高光边）
   - 导航页签、搜索框、下拉、chip（筛选标签）、磁帖、播放器控件逐个打磨
   - 图标替换成「主题人物元素」风格（见四），并统一 size/currentColor
   - 背景人物与页面层次再优化（透明度、位置），保证文字可读
3. **移动端**：竖排导航/悬浮按钮/毛玻璃透明度的观感统一打磨

### 不动的东西（红线）
- 功能逻辑、数据结构、控件**位置**基本不变（只改观感/动效）
- `functions/`、R2、按钮墙上传/播放逻辑、存档接口**不动**
- 生成的数据 JSON / `js/data.js` 不手改
- 别把快乐体字子集外的生僻字加进快乐体文本（会回退）

---

## 六、改完验证清单
- [ ] 本地 file:// 三页都能打开、无 JS 报错
- [ ] 桌面 + 手机视口（≤768px）都正常
- [ ] 播放器能播、收藏/中意/存档按钮可用、筛选可用、二创歌「只看二创」可用
- [ ] 按钮墙播放、编辑模式、后台不坏
- [ ] 动效流畅不卡顿、尊重 reduced-motion

---

## 七、参考
- 仓库内 `COLLABORATION.md`：git/部署/结构
- 本地（不在 git）`E:\tool\plugin\docs\`：功能说明.md、阿里云 CDN 方案
- 备案进行中（阿里云），通过后可切国内 CDN（与本 UI 任务无关，勿阻塞）
