# 小松绿歌单网站 · 协同开发指南

> 本仓库：小松绿歌单网站（viridis.love）+ 按钮墙（/buttons）+ 24点（/24xsl）。
> 另一台设备接入后，按本文档即可克隆、了解结构、部署、协同。

---

## 一、仓库信息

- **Git 地址**：`https://github.com/FTFwen/xiaosonglu-songlist-web.git`
- **分支**：`main`
- **技术栈**：静态网页（HTML/CSS/JS）+ Cloudflare Pages（托管）+ Cloudflare Pages Functions（后端接口）+ Cloudflare R2（按钮墙音频存储）

---

## 二、在另一台设备接入（首次）

```bash
# 1. 克隆
git clone https://github.com/FTFwen/xiaosonglu-songlist-web.git
cd xiaosonglu-songlist-web

# 2. 安装 wrangler（Cloudflare 部署 CLI，全局）
npm install -g wrangler
# 或 npx wrangler（免安装）

# 3. node（数据脚本可能需要）
# 已装 Node.js 即可
```

> 如需提交权限，先在 GitHub 账号 `FTFwen` 里把你加为协作者（Settings → Collaborators），或配置你的 git 凭证。

---

## 三、目录结构

| 路径 | 说明 |
|------|------|
| `index.html` | 主站「小松绿歌单」页面 |
| `buttons/` | 按钮墙子站点（index.html + buttons.js） |
| `24xsl/` | 24点小游戏 |
| `js/app.js` | 主站逻辑（播放器/筛选/中意/播放列表等） |
| `js/shared.js` | 共享工具（getFavoriteKey 等） |
| `js/buttons.js` | 按钮墙逻辑（界面/上传/播放） |
| `js/data.js` | 生成的歌单数据（`window.XSL_DATA`，离线回退用） |
| `assets/` | 字体/背景/图标/音频（音频被 .gitignore，不入库） |
| `data/xiaosonglu/*.json/csv` | 歌单/歌切/历史的**采集数据**（生成产物，会常更新） |
| `functions/` | Cloudflare Pages Functions（后端接口 /api/*） |
| `wrangler.toml` | Cloudflare 配置 |
| `_routes.json` / `_headers` | 路由与缓存头 |
| `manifest`/目录内 `.gitignore` | 排除项 |

---

## 四、部署（重要）

部署用 **wrangler**，每次**必须先删除 `.wrangler` 缓存**，否则 `functions/` 可能不编译，`/api/*` 会返回 HTML（而非接口），按钮墙音频/存档全挂。

```bash
# 1. 清理本地构建缓存（关键！）
Remove-Item -Recurse -Force .wrangler
#（PowerShell；Linux 用 rm -rf .wrangler）

# 2. 部署
# 需环境变量（见下）；or npx wrangler
wrangler pages deploy . --project-name xsl-songlist --branch main --commit-dirty=true
```

### 环境变量（勿在文档写死，每台设备本地配置）
部署需要以下 Cloudflare 凭证，**作为环境变量**（不要提交进仓库）：

```
CLOUDFLARE_API_TOKEN    # Cloudflare Pages 部署 token
CLOUDFLARE_ACCOUNT_ID   # Cloudflare 账号 ID
```

- 按钮墙管理员账号：由 Cloudflare Pages Secrets 里的 `BUTTONS_ADMIN_ACCOUNTS`（JSON 数组）配置
- 这几位变量/SECRET **另见交接说明**，不要写进公开仓库

---

## 五、数据文件说明

- `data/xiaosonglu/song_catalog.json`：歌曲总目录
- `data/xiaosonglu/history_index.json`：历史演唱记录
- `data/xiaosonglu/audio_index.json`：音频路径映射（歌名→assets/audio/文件）
- `js/data.js`：由上述 JSON **生成**的汇总（`window.XSL_DATA`，file:// 离线打开时用）

> 这些是**数据采集管线**生成的产物，会随采集更新而变动。普通开发**不要手改** JSON（改动会被管线覆盖）；要改歌数据优先改数据源。

---

## 六、协同规范

1. **分支**：默认在 `main` 上直接提交（个人项目）；若多人协作建议开分支 PR。
2. **提交**：
   ```bash
   git add -A
   git commit -m "说明改动"
   git push
   ```
3. **不要提交**：`assets/audio/*.mp3`（音频大，已 gitignore）、`.wrangler/`、内部临时 `_*` 文件（预览/审核/探测）。
4. 改动网页代码（HTML/JS/CSS）后，**升版本号强制刷新缓存**：如 `js/app.js?v=56` → `?v=57`（CDN 会缓存旧 JS）。
5. 改动 `data/` 或 `js/data.js` 后，注意 CDN 对 `/data/*` 有 1 小时缓存，确认效果需强刷（Ctrl+Shift+R）。

---

## 七、本地预览

直接在浏览器打开 `index.html`（`file://`）即可看主站；按钮墙 `buttons/index.html`；24点 `24xsl/index.html`。

> 注意：`file://` 打开时部分接口（fetch `/api/*`）不可用，按钮墙音频/存档需线上部署后才有。
