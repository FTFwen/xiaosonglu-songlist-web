# xsl-web-tools

这是当前仓库根布局对应的站点同步与 Cloudflare Pages 部署工具，替代暂时无法迁入的旧 `xsl-web-tools/`。

## 一键执行每日链路

```powershell
# 扫描、构建、测试、同步并做部署预检
.\xsl-web-tools\run_daily_song_pipeline.ps1

# 请求条件化部署；是否有变化由完整 staging 哈希统一判断
.\xsl-web-tools\run_daily_song_pipeline.ps1 -Deploy
```

每日链路先调用 `tools/sync_song_audio_assets.py`。它用受版本管理的 `data/xiaosonglu/audio_asset_baseline.json` 逐项校验 137 个预期文件的路径、字节数、M4A 文件头与 SHA-256；只有本机缺失或损坏时才联网补齐，正常复跑不会请求音频，也不会重写本地清单。`.part` 续传会校验 Range 起点、最终长度和权威哈希；来源默认是当前生产站，也可用 `XSL_AUDIO_BASE_URL` 指向已验证的历史部署。

音频集合确实发生人工审核过的增删时，先从可信部署补齐文件，再显式执行 `python tools/sync_song_audio_assets.py --source-base <可信部署> --adopt-baseline` 并审阅、提交新的权威基线；日常自动化不会静默接受集合变化。

随后 `tools/sync_viridis_baseline.py` 对线上 JSON 使用 ETag / Last-Modified 条件请求，304 不下载正文；本地内容领先线上时只报告 `local-divergence-preserved`，绝不覆盖。直播扫描再按 liveId 与本地分页 checkpoint 复用证据缓存。若仍有 `review-needed` 候选，脚本会完成构建与校验，但只做部署预检，等待复核后再上线。

## 同步站点镜像

根目录 `data/xiaosonglu/` 和 `js/data.js` 是规范副本；`workshop/` 下的旧站点镜像只接受单向同步：

```powershell
# 检查是否有漂移（有漂移返回非零）
.\xsl-web-tools\sync_workspace_data.ps1 -Check

# 按内容哈希复制，仅写入有变化的文件
.\xsl-web-tools\sync_workspace_data.ps1 -Apply
```

同步范围只有前端实际读取的 JSON 与 `js/data.js`，不会复制弹幕缓存、候选文件或视频。

## 条件化 Wrangler 部署

```powershell
# 只做安全预检和隔离部署目录，不联网部署
.\xsl-web-tools\deploy_web.ps1

# 自动化：条件满足时使用环境变量凭据部署
.\xsl-web-tools\deploy_web.ps1 -Deploy

# 人工已执行 wrangler login 时，显式允许使用本机 OAuth
.\xsl-web-tools\deploy_web.ps1 -Deploy -AllowOAuth
```

部署器具有以下保护：

1. 同时检查工作区和最终 staging 的 `wrangler.toml`、`functions/` 与 `[[r2_buckets]]`，不允许降级成静态上传器。
2. 按项目规范先清理 `.wrangler/` 缓存。
3. 以当前 Git `HEAD` 创建隔离 staging，再只覆盖歌单管线拥有的数据文件与本机忽略的歌曲音频；工作区里其他未提交的 UI 修改不会被顺带部署，所需 overlay 缺失会直接失败。
4. 要求 `audio_index.json` 与受版本管理的权威音频集合完全一致；复制前后都校验 137 个文件的安全路径、字节数、M4A 文件头与 SHA-256，少一首或多一首都拒绝部署。
5. staging 中会再次删除视频目录、视频扩展名、弹幕/候选缓存、内部脚本目录、`audio_asset_baseline.json`、`ingestion_state.json` 与远端基线清单。
6. 使用 staging 全内容 SHA-256 与按 project/branch 校验的 `data/xiaosonglu/_deploy_state.json`（本地忽略文件）比较；无变化不部署。
7. 自动化只有显式传入 `-Deploy` 且同时存在 `CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID` 时才调用 Wrangler；人工会话可在确认 `wrangler login` 成功后显式传入 `-AllowOAuth`，不会静默借用登录态。
8. 实际命令仍是 `wrangler pages deploy`，并从 staging 根读取完整 Pages Functions 与 R2 配置。

在歌曲音频仍由 Git 忽略、尚未迁入 R2 或 Git LFS 之前，**禁止**绕过本脚本直接执行 `wrangler pages deploy`，也不要启用会直接发布仓库快照的 Cloudflare Pages Git 自动部署；这两条旁路都不会携带本机的 `assets/audio/`。

状态值：

- `preflight-only`：只完成安全预检。
- `skipped-missing-credentials`：请求了部署但没有凭证，安全不部署并返回非零。
- `skipped-missing-wrangler`：请求了部署但没有可用 Wrangler/npx，安全不部署并返回非零。
- `skipped-no-content-change`：与上次成功部署内容相同。
- `deployed`：部署成功并更新本地哈希状态。
- `deployment-failed`：Wrangler 返回错误，脚本以非零退出。

`-Force` 只会绕过内容哈希判断，不会绕过凭证、Functions 或 R2 安全检查。
