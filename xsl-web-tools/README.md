# xsl-web-tools

这是当前仓库根布局对应的站点同步与 Cloudflare Pages 部署工具，替代暂时无法迁入的旧 `xsl-web-tools/`。

## 一键执行每日链路

```powershell
# 扫描、构建、测试、同步并做部署预检
.\xsl-web-tools\run_daily_song_pipeline.ps1

# 请求条件化部署；是否有变化由完整 staging 哈希统一判断；上传暂态错误自动串行重试
.\xsl-web-tools\run_daily_song_pipeline.ps1 -Deploy
```

每日链路先调用 `tools/sync_song_audio_assets.py`。它用受版本管理的 `data/xiaosonglu/audio_asset_baseline.json` 逐项校验当前权威音频集合（目前 166 个文件）的路径、字节数、M4A 文件头与 SHA-256；只有本机缺失或损坏时才联网补齐，正常复跑不会请求音频，也不会重写本地清单。`.part` 续传会校验 Range 起点、最终长度和权威哈希；来源默认是当前生产站，也可用 `XSL_AUDIO_BASE_URL` 指向已验证的历史部署。

音频集合确实发生人工审核过的增删时，优先通过下文带 curated 的下载/入库流水线完成，它会把本次 `copied` / `replaced` / 安全恢复项作为唯一允许变更的集合。若必须单独维护 baseline，每个获准目标都要显式传入 `--adopt-spec "PATH|BYTES|SHA256"`；仅给路径或裸 `--adopt-baseline` 会被拒绝，未列出的旧资产仍按旧 baseline 强校验，防止顺带采纳无关文件变化。日常自动化不会静默接受集合变化。

随后 `tools/sync_viridis_baseline.py` 对线上 JSON 使用 ETag / Last-Modified 条件请求，304 不下载正文；本地内容领先线上时只报告 `local-divergence-preserved`，绝不覆盖。直播扫描再按 liveId 与本地分页 checkpoint 复用证据缓存。若仍有 `review-needed` 候选，脚本会完成构建与校验，但只做部署预检，等待复核后再上线。

语言标签在流水线中统一规范化：日语只输出 `日文`，旧别名 `日语` 会在审核导入、派生构建和前端缓存读取时折叠，校验阶段会拦截未规范的事实记录。类型标签遵循同一套收敛原则：优先复用 `data/xiaosonglu/type_tag_registry.json` 中已有且更精准的标签；本次 `虚拟歌手` 已人工归为 `中V`，但它不是全局同义词，后续裸 `虚拟歌手` 输入会被拦截并要求选择 `中V`、`Vocaloid`、`日V` 等精准类别。只有先在注册表 `approvedTags` 与 `approvalLog` 中登记新标签和理由，构建/校验/导入才会接受它。

## 下载并导入已审核的歌切音频

`tools/download_song_cut_audio.py` 会按已审核 curated JSON 中的 Bilibili 分P顺序串行下载音频，支持 `.part` 续传与有限重试；默认按 liveId/replayId 使用隔离的来源子目录，完成文件必须通过 M4A 头和 ffprobe 音频流检查，并写入 URL/歌曲/文件哈希绑定的 `_source_manifest.json`。Cookie 只能通过工作区外文件的路径在运行时提供，下载器不会输出 yt-dlp 原始日志，避免泄露签名媒体 URL 或 Cookie 派生信息。

无人值守任务可在任务环境中设置 `XSL_BILIBILI_COOKIE_FILE`，再一次性执行。若 curated 中出现同场同名章节，计划任务不会把它直接当成复唱去重：必须先检查歌曲是否真正相同；误标应改用其他 UP 主歌切或 B 站搜索结果，真正复唱则需填写含独立、可核验 B 站视频页和说明的 `sameNameReview`（不能把正在核对的同一合集/歌切换个 `?p=`、域名别名或默认端口当作证据，任意 HTTPS 占位链接也不接受）。若审核后的 curated 中所有归一化歌曲名已经存在于权威音频索引，复跑才会返回 `already-indexed`，不会再次下载整套分P，也不再要求 Cookie：

```powershell
$env:XSL_BILIBILI_COOKIE_FILE = '<工作区外的 Netscape Cookie 文件路径>'
.\xsl-web-tools\run_daily_song_pipeline.ps1 `
  -DownloadSongCutAudio `
  -CuratedSongBatch data/xiaosonglu/_curated_2026-09-08.json `
  -SongCutSourceDir assets/audio/source `
  -Deploy -AllowOAuth
```

已经由其他受信工具下载好编号音频时，可改用 `-IngestSongCutAudio` 跳过下载，但来源目录仍须提供 URL 绑定的 `_source_manifest.json`；也可向计划脚本逐项传 `-ReviewedSongCutSourceSpec "PART|BYTES|SHA256|SOURCE_IDENTITY"`（直接调用 Python 时对应 `--reviewed-source-spec`），不能只凭编号信任旧文件。导入器检查 curated 分段与 `01_*.m4a` 等来源编号一一对应、M4A 容器头、复制结果和归一化去重键；导入、索引和权威基线采用事务式恢复，失败不会留下新索引配旧基线。普通条目默认 `keep-existing`；受审核的替换必须显式填写 `audioAction: "replace-existing"`、`audioReplacementReason`、完整 `audioSha256`、`audioBytes` 和固定 `audioTarget`，重分配旧路径时还要填写 `audioPreviousSongName`。下载侧的 URL 绑定来源清单会阻止旧分P复用，索引则写入 `?v=<SHA-256 前缀>`，计划任务只有在文件、映射和 baseline 同时匹配时才幂等跳过。没有显式下载/导入开关的日常运行不会静默接受音频集合变化。

## 同步站点镜像

根目录 `data/xiaosonglu/` 和 `js/data.js` 是规范副本；`workshop/` 下的旧站点镜像只接受单向同步：

```powershell
# 检查是否有漂移（有漂移返回非零）
.\xsl-web-tools\sync_workspace_data.ps1 -Check

# 按内容哈希复制，仅写入有变化的文件
.\xsl-web-tools\sync_workspace_data.ps1 -Apply
```

同步范围只有前端实际读取的 JSON 与 `js/data.js`，不会复制弹幕缓存、候选文件或视频。

## Windows 每日计划任务

`run_scheduled_song_pipeline.ps1` 是无人值守入口：固定请求完整静态 Pages 部署，写入忽略目录中的逐次日志和原子状态文件，保留 30 天日志；失败返回非零，任务计划程序会按设置重试。`install_scheduled_song_pipeline.ps1` 幂等创建当前用户的每日任务（默认本地时间 12:30、错过后补跑、忽略并发实例、失败后重试两次）。在当前非管理员账户下任务使用 `Interactive` 登录类型，因此系统会在该用户已登录时自动执行；切勿把 Cloudflare token 或密码写进任务。任务使用当前用户已有的 Wrangler OAuth；Bilibili 只保存工作区外 Cookie **路径**，不复制或输出内容。若以后以管理员身份部署并需要锁屏状态仍运行，可把安装器的 principal 改为受机器策略允许的 S4U/服务账户模式。

```powershell
.\xsl-web-tools\install_scheduled_song_pipeline.ps1 `
  -DownloadSongCutAudio `
  -BilibiliCookieFile 'C:\Users\<用户>\Downloads\www.bilibili.com_cookies.txt'
```

任务会临时把本机 `Pluto` 代理组选到“自动选择”（计划任务参数使用 ASCII 安全别名 `__AUTO__`），仅 Wrangler 上传走 `127.0.0.1:17890`，结束后恢复原代理组选项。歌曲音频仍全部作为 Pages 静态资产，既不上传到 R2，也不会拆成多个替换彼此的 Pages 快照。

## 条件化 Wrangler 部署

```powershell
# 只做安全预检和隔离部署目录，不联网部署
.\xsl-web-tools\deploy_web.ps1

# 自动化：条件满足时使用环境变量凭据部署
.\xsl-web-tools\deploy_web.ps1 -Deploy

# 已在任务运行账户执行过 wrangler login 时，显式允许使用本机 OAuth
.\xsl-web-tools\deploy_web.ps1 -Deploy -AllowOAuth
# daily wrapper 同样支持；网络到 Cloudflare 大文件上传不稳定时可显式给任务使用本机可信代理
.\xsl-web-tools\run_daily_song_pipeline.ps1 -Deploy -AllowOAuth `
  -HttpsProxy http://127.0.0.1:17890 `
  -ClashController http://127.0.0.1:8765 `
  -ClashProxyGroup Pluto -ClashProxyChoice __AUTO__
```

部署器具有以下保护：

1. 同时检查工作区和最终 staging 的 `wrangler.toml`、`functions/` 与 `[[r2_buckets]]`，不允许降级成静态上传器。
2. 先取得工作区级互斥锁，避免两个任务同时删除 staging 或触发 Cloudflare bulk-operation 冲突；随后按项目规范清理 `.wrangler/` 缓存。
3. 以当前 Git `HEAD` 创建隔离 staging，再只覆盖歌单管线拥有的数据文件、type 标签注册表、语言/type 标签兼容所需的显式前端文件与本机忽略的歌曲音频；工作区里其他未提交的 UI 修改不会被顺带部署，所需 overlay 缺失会直接失败。
4. 要求 `audio_index.json` 与受版本管理的权威音频集合完全一致；复制前后都校验当前全部 166 个文件的安全路径、字节数、M4A 文件头与 SHA-256，少一首或多一首都拒绝部署。
5. staging 会先使用临时复制的私有 baseline/state 重新执行构建确定性、数据验证与 Workshop 镜像检查，再删除视频目录、视频扩展名、弹幕/候选缓存、内部脚本目录、`audio_asset_baseline.json`、`ingestion_state.json` 与远端基线清单；因此并发构建也不能留下混合快照。
6. 使用 staging 全内容 SHA-256 与按 project/branch 校验的 `data/xiaosonglu/_deploy_state.json`（本地忽略文件）比较；内容无变化时仍先对生产站执行完整验证，线上已回滚或缺失则重新部署。
7. 自动化只有显式传入 `-Deploy` 且存在成对的 `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID`，或显式传入 `-AllowOAuth` 时才调用 Wrangler；任务已登录的 OAuth 会话必须显式允许，不会静默借用登录态。使用 OAuth 时会清除所有继承的 account ID 和 token 环境变量，确保 OAuth 明确优先。若直连在约 5 分钟处持续触发 `UND_ERR_HEADERS_TIMEOUT`，可显式传 `-HttpsProxy`；只接受不含内嵌凭据的 HTTP(S) URL，并在调用结束恢复环境变量。无人值守任务还可同时传本机回环 `-ClashController`、代理组与选项：部署前临时选择已验证的自动线路，结束后恢复原选项；控制器被强制限制在 loopback，三个参数必须成组出现。
8. 实际命令仍是 `wrangler pages deploy`，并从 staging 根读取完整 Pages Functions 与 R2 配置。首轮使用差分上传；失败后的偶数轮传 `--skip-caching` 绕过已知差分协调故障，下一轮再用差分路径复用上轮已经接收的内容寻址资产。每轮都向 Wrangler 提交同一个完整快照，只有全部资产齐备后才创建一次站点部署，不是分片发布。
9. 上传失败只在明确属于网络、限流、过期上传凭据或 Cloudflare bulk-operation 暂态错误时串行重试；每次重试使用同一完整 staging 快照，并采用指数退避（默认最多 5 次、30 秒起步、最多等待 300 秒），绝不把站点拆成多个独立 Pages 部署。Wrangler 默认固定为已验证的 `4.130.0`，升级需显式传入 `-WranglerVersion`。
10. 不只信任进程退出码：若 Wrangler 4.130.0 异步输出 `Failed to upload files`、Cloudflare API 失败或 ENOENT 等致命诊断，即使 Node 错误地返回 0，仍判定失败、绝不写入成功状态。
11. Wrangler 成功后还要从自定义域和该次返回的 `pages.dev` URL 校验音频映射、歌曲数量、关键 HTML/JS/数据文件的内容哈希、样本音频、审核替换音频的完整字节/SHA 与 `/buttons/`；验证不通过不会写成功状态，而是按完整快照重试。自定义域若由 Cloudflare Insights 在 `</body>` 前注入受管 beacon，仅允许移除一个结构严格匹配的空脚本及相邻换行后再与 staging SHA 比较：脚本必须为空正文且属性集合、Insights 来源、integrity 语法、`crossorigin=anonymous` 都须精确符合已知契约，`data-cf-beacon` 也只接受已观察到的整数 `spa=2` 或 `server_timing` 两种 JSON 结构；注释包装中不能夹带任何额外文字、标签或第二段脚本；页面其余任一字节变化仍会失败，JS/JSON/音频始终使用原始字节哈希。

按钮墙鉴权只接受 Cloudflare Pages Secrets：`BUTTONS_ADMIN_ACCOUNTS`（JSON 数组，或兼容的 `BUTTONS_ADMIN_USER` / `BUTTONS_ADMIN_PASS`）与 `BUTTONS_ADMIN_SECRET`。仓库和前端静态包不再内置默认账号、密码或 HMAC 密钥；未配置 Secret 时登录会 fail-closed。

在歌曲音频仍由 Git 忽略、尚未迁入 R2 或 Git LFS 之前，**禁止**绕过本脚本直接执行 `wrangler pages deploy`，也不要启用会直接发布仓库快照的 Cloudflare Pages Git 自动部署；这两条旁路都不会携带本机的 `assets/audio/`。

状态值：

- `preflight-only`：只完成安全预检。
- `skipped-missing-credentials`：请求了部署但没有凭证，安全不部署并返回非零。
- `skipped-missing-wrangler`：请求了部署但没有可用 Wrangler/npx，安全不部署并返回非零。
- `verified-no-content-change`：与上次成功部署内容相同，并已重新验证生产站当前仍提供预期字节。
- `deployed`：部署成功并更新本地哈希状态。
- `deployment-failed`：Wrangler 返回错误，脚本以非零退出；结构化结果中的 `deploymentAttempts` 会记录每次尝试、是否可重试以及下一次等待时间。

`-Force` 只会绕过内容哈希判断，不会绕过凭证、Functions 或 R2 安全检查。`-DeployAttempts`、`-RetryBaseSeconds` 与 `-RetryMaxSeconds` 可由自动化任务调整，但每次仍必须发布同一完整 staging 快照。
