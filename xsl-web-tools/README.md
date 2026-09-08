# xsl-web-tools

这是当前仓库根布局对应的站点同步与 Cloudflare Pages 部署工具，替代暂时无法迁入的旧 `xsl-web-tools/`。

## 一键执行每日链路

```powershell
# 扫描、构建、测试、同步并做部署预检
.\xsl-web-tools\run_daily_song_pipeline.ps1

# 仅当本轮站点数据确有变化时请求条件化部署
.\xsl-web-tools\run_daily_song_pipeline.ps1 -Deploy
```

每日链路先调用 `tools/sync_viridis_baseline.py`：线上 JSON 使用 ETag / Last-Modified 条件请求，304 不下载正文；本地内容领先线上时只报告 `local-divergence-preserved`，绝不覆盖。随后直播扫描按 liveId 与本地分页 checkpoint 复用证据缓存。若仍有 `review-needed` 候选，脚本会完成构建与校验，但只做部署预检，等待复核后再上线。

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

# 条件满足时部署；无凭证或内容哈希未变化会安全跳过
.\xsl-web-tools\deploy_web.ps1 -Deploy
```

部署器具有以下保护：

1. 强制检查 `wrangler.toml`、`functions/` 与 `[[r2_buckets]]`，不允许降级成静态上传器。
2. 按项目规范先清理 `.wrangler/` 缓存。
3. 以当前 Git `HEAD` 创建隔离 staging，再只覆盖歌单管线拥有的数据文件；工作区里其他未提交的 UI 修改不会被顺带部署。
4. staging 中会再次删除视频目录、视频扩展名、弹幕/候选缓存、内部脚本目录、`ingestion_state.json` 与远端基线清单。
5. 使用 staging 全内容 SHA-256 与 `data/xiaosonglu/_deploy_state.json`（本地忽略文件）比较；无变化不部署。
6. 只有显式传入 `-Deploy` 且同时存在 `CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID` 时才调用 Wrangler。
7. 实际命令仍是 `wrangler pages deploy`，并从 staging 根读取完整 Pages Functions 与 R2 配置。

状态值：

- `preflight-only`：只完成安全预检。
- `skipped-missing-credentials`：没有凭证，安全不部署。
- `skipped-missing-wrangler`：没有可用 Wrangler/npx，安全不部署。
- `skipped-no-content-change`：与上次成功部署内容相同。
- `deployed`：部署成功并更新本地哈希状态。
- `deployment-failed`：Wrangler 返回错误，脚本以非零退出。

`-Force` 只会绕过内容哈希判断，不会绕过凭证、Functions 或 R2 安全检查。
