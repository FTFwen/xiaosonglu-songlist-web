# 国内直连提速方案 · 阿里云 OSS + CDN 接入

> 目的：viridis.love 现在托管在 Cloudflare Pages（海外节点），国内直连卡顿。
> 方案：静态资源走阿里云 OSS + CDN 国内节点加速；动态后端保留 Cloudflare。

---

## 一、为什么卡

Cloudflare 没有国内节点，**首屏 2.5~3MB 静态资源**走海外链路，国内一打开就慢：

| 资源 | 体积 | 是否首屏 |
|------|------|--------|
| 背景图（手机版 bg-mobile-person.png） | 1.05MB | 是 |
| 背景图（桌版 bg-person.png） | 608KB | 是 |
| 快乐体字体（woff2） | 436KB | 是 |
| js/data.js（歌单数据） | 373KB(gzip) | 是 |
| 歌单 song_catalog.json | 116KB | 是 |
| js/app.js | 104KB | 是 |

> 按钮墙音频（R2）、中意清单存档（/api/*）是**点操作才请求**，不是首屏卡顿主因，本期不迁移。

---

## 二、架构设计（静态国内 + 动态保留)

把资源分成两类，分开放：

| 类型 | 内容 | 放哪 | 说明 |
|------|------|------|------|
| **静态** | 页面 html、图片、字体、CSS、JS、歌单 JSON | **阿里云 OSS + CDN** | 国内加速，首屏主打 |
| **动态后端** | 按钮墙音频（/api/audio/*）、中意清单存档（/api/fav/*、/api/data） | **Cloudflare Pages Functions + R2** | 点操作才请求，国内延迟可接受 |

### 域名/子域名规划（关键）
不能整站 DNS 指向阿里云，否则 /api/* 的 functions 就找不到了。所以：

- `viridis.love`（主域）→ 解析到 **阿里云 OSS/CDN**（托管静态页面）
- `api.viridis.love`（子域）→ 解析到 **Cloudflare Pages**（保留 /api/*，承载后端 functions）

页面里的前端 JS 会把 API 请求地址改成 **`https://api.viridis.love/api/...`**（替换原来同域的 `/api`）。这样：
- 国内用户打开主域 → 静态秒开（阿里云 CDN）
- 点音频/存档 → 请求子域 api.viridis.love → 回 CF functions → R2 音频

### ⚠️ 注意
- 音频（R2 中约几百 MB）仍是 CF 拉取，点按钮时才加载，偶尔略慢但可接受。若以后要彻底提速，再单独把音频搬到阿里云 OSS（本期不做）。
- CORS：页面在 viridis.love，请求 api.viridis.love，需在 CF functions 响应头加 `Access-Control-Allow-Origin: https://viridis.love`（现有代码已带 `*`，兼容）。

---

## 三、备案流程（先做，审核 1~2 周）

阿里云 CDN 加速 `viridis.love` 必须 ICP 备案。

1. 确认域名 **viridis.love** 能备案：
   - `viridis.love` 是 `.love` 后缀，非主流。备案要求域名在国内可查到注册信息且可实名。**先到阿里云备案系统提交域名核验**，确认 `.love` 是否在可备案后缀列表（若不在，需换 `.com` 等，或考虑用已备案域名）。
2. 阿里云备案流程：
   - 注册阿里云账号 → 实名认证
   - 进入「ICP 备案」→ 填写域名/主体信息（个人或企业）
   - 上传证件 → 人脸核验 → 提交管局审核（1~2 周）
   - 审核通过后，域名即可绑定阿里云 OSS/CDN 加速。
3. 备好**域名 DNS 管理**（切换解析到阿里云）。

---

## 四、阿里云配置步骤（备案通过后）

1. **创建 OSS Bucket**（如 `xsl-songlist-static`），设为公共读。
2. **上传静态文件**：把 web-deploy 里除 `functions/`、`_routes.json` 之外的所有静态文件（`index.html`、`buttons/`、`24xsl/`、`assets/`、`js/`、`data/`、`_headers` 对应规则）上传到 OSS。
3. **配置 CDN**（创建 CDN 加速域名 `viridis.love`）：
   - 源站类型：OSS（指向上面 bucket）
   - 回源方式：默认 OSS 回源
   - 配置缓存规则（图片/字体 30 天，JS/CSS 7 天，html 短缓存）
4. **绑定域名 + 备案**：CDN 域名绑定 `viridis.love`，填备案号。
5. **DNS 解析**：`viridis.love` CNAME 到阿里云 CDN 域名；`api.viridis.love` CNAME 到 Cloudflare Pages 域名。
6. **HTTPS**：CDN 上申请/配置 SSL 证书（免费 DV）。

---

## 五、前端代码改动（备案/解析完成后）

把静态页面里的 API 根地址从同域 `/api` 改成子域：
- 主站 `js/app.js`、按钮墙 `js/buttons.js` 里的 `fetch('/api/...')` → `fetch('https://api.viridis.love/api/...')`
- 涉及点：`/api/data`、`/api/audio/*`、`/api/fav/*`
- 主站加载歌单 JSON（/data/xiaosonglu/*.json）走静态，无需改（在 OSS 里）。

---

## 六、成本估算（大概）

| 项 | 费用 |
|----|------|
| 阿里云 OSS 存储（静态文件约 2~3M 文本/图片 + 若干） | 极低（几毛~几块/月） |
| OSS 流量 / CDN 流量 | 按量计费，个人站很少（几块/月内） |
| CDN 回源 / 请求 | 低 |
| 备案 | 免费（阿里云代提交） |
| 域名改解析 | 免费 |

> 整体月成本通常 **几块到十几块**，取决于访问量。

---

## 七、本期计划（等备案）

- [ ] 确认 `.love` 能否备案（阿里云域名核验）
- [ ] 提交 ICP 备案（阿里云）
- [ ] 备案通过 → 建 OSS + CDN
- [ ] 改 DNS（主域→阿里云 CDN，api 子域→CF）
- [ ] 前端 JS 的 API 地址改子域
- [ ] 上线验证（国内资源加速 + api 正常）

> 在备案审核期间，网站保持现状（Cloudflare）可正常用，只是国内略慢，不影响功能。
