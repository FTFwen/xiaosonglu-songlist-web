# 全库歌词数据准备

范围为当前 `data/xiaosonglu/song_catalog.json` 的全部主曲目，以及 `js/app.js` 声明的内置二创曲目；不包含用户浏览器本地导入。所有机器结果的 `humanVerified` 都为 `false`。这些数据用于网站画中画歌词；访客共享偏移独立保存在服务器，不改写机器核验结果。

## 产物

- `index.json`：当前全量曲目身份、文件位置、来源匹配状态及音频校准状态。
- `tracks/`：按原始 `songId` / `rowKey` 分开保存；重复演唱、半首、二创不合并时间轴。`audio.sha256` 绑定实际音频内容。
- `sources/`：平台返回的原始 LRC、翻译、罗马音、解析后的原文时间戳与来源链接。不改写平台原文。
- `overrides.json`：已研究的同名歧义、别名、作品来源及版本限制，包含证据链接和选择理由。检索脚本保留这些条目；改变选择需修改该文件并重新应用。
- `evidence/`：Whisper 逐词概率、时间戳、识别窗口、模型与音频哈希。它是机器识别证据，不是人工听审。
- `draft-lrc/`：仅输出来源为 `matched` 且首句及两个不同中尾抽样均通过阈值的机器草稿。不能直接作为已核验歌词上线。
- `coverage.json`、`REPORT.md`：覆盖统计和逐首状态；`review-queue.json` 列出剩余核验事项。

## 状态含义

`match.status=matched` 只表示作品来源的题名/艺人启发式对应或有记录的定点复核，不能证明现场音频时间轴正确。`candidate_review_required` 表示翻唱源、同名或作品身份仍需确认；`version_review_required` 表示短版、demo、翻填、语种或版本疑问。语种冲突也可能来自旧台账误标，不能只按标签改成另一种歌词。

`alignment.offsetSeconds = 本地音频首句秒数 - 来源首句秒数`。校准仅使用统一平移，不自动处理现场漏句、变速、重唱、间奏或不同编曲。

首句候选要求文本相似度至少 0.72、识别词平均概率至少 0.35。中间及结尾两个抽查需采用不同歌词行，来源时间相隔至少 15 秒；两个残差绝对值均不超过 1.25 秒才标记 `asr_consistent_draft`。大多数唱词未被 base 模型可靠识别，保留 `anchor_not_found`，不能降低阈值后伪装成同步完成。`spotcheck_review_required` 仅有首句候选；`timing_drift_review_required` 表示抽查已提示统一偏移不能对齐。

## 重现流程

在仓库根目录执行，避免两个会写 `tracks/` 的进程同时运行：

```powershell
# Node.js 需要内置 fetch。已存在音频由项目原有流程管理。
# Python 需要 openai-whisper、torch，以及 tools/ffmpeg 下的 ffmpeg。
python -m pip install --target .tmp/lyrics-python-deps opencc-python-reimplemented==0.1.7
node scripts/match_song_lyrics.mjs
node scripts/apply_lyrics_overrides.mjs
python scripts/align_song_lyrics.py
node scripts/report_song_lyrics.mjs
node scripts/validate_lyrics.mjs
node --test scripts/tests/lyrics_matching.test.mjs
```

检索会访问网易云公开接口；ASR 读取本地音频，在 CPU 上可能耗时。`match_song_lyrics.mjs --retry` 只重试未找到及候选来源；复核条目仍被保护。`apply_lyrics_overrides.mjs --fetch-sources-only` 可仅下载复核来源，不写逐曲状态。音频校准缓存要求 SHA 和窗口一致；`align_song_lyrics.py --retry` 会重新评估失败/待核验结果，复用适用转写证据。

若只修改来源或状态而不运行 ASR，也应重跑报告，避免索引快照陈旧。更新了来源的旧时间轴不得沿用。`validate_lyrics.mjs` 默认实际读取音频并验证哈希、来源、身份、证据及状态一致性，不检查听感，不会把机器草稿升级为人工确认。

## 自动加歌同步

每日任务通过 `run_scheduled_song_pipeline.ps1` 调用日线，在歌曲/音频目录生成后、部署前运行 `node scripts/sync_song_lyrics.mjs`。它仅检索新增、身份变化及 `fetch_error` 条目，保留既有作品复核结果；无变更时不重写歌词与报告。`identity-bindings.json` 保存构建期的复核身份绑定，避免歌曲编号调整后把旧覆盖应用到另一首歌。

新歌词会和本次歌曲、音频一起进入部署快照并接受完整性校验。找不到或版本不明保留明确状态。此流程不自动运行全库 Whisper，也不把新增平台歌词视为已经准确校时；可继续在画中画中调整并上传共享偏移。音频 SHA 或歌词来源变更后旧共享偏移自动失效。

## 网页使用与共享偏移

网页按 `key`、`rowKey`、音频 SHA 和歌词来源核验数据，保持“歌词作品对应”和“时间轴已校验”的区分。已确认作品来源的歌词默认随音频滚动；未校准时间显示待校准提示，不声称准确同步。未找到或版本不明必须明确显示，不能借另一首同名歌兜底。

画中画的音量滑块控制主页面正在使用的同一个音频，并与主播放器音量同步。在偏移区右上角点击“上传”，直接提交当前显示的总偏移秒数；不上传音频或歌词文件。

- `GET /api/lyrics/offset?key=song-225`：读取当前歌曲的共享偏移，二创使用 `derivative-<正数ID>`。没有记录或旧记录的音频/来源版本已失效时，返回空记录并沿用本地数据中的原始偏移。
- `PUT /api/lyrics/offset`：提交 `{key,rowKey,audioSha256,sourceId,offsetSeconds}`，偏移必须是有限数字且在 −600 到 +600 秒内。服务端重新读取歌曲台账核对身份和版本，不接受把其他歌曲或旧版本偏移写入当前歌曲。
- 记录存于已有 R2 存储的 `lyrics-offset/v1/` 命名空间，按稳定 `rowKey` 的 SHA-256 定位单个对象，每首仅保存最新成功上传的记录；服务端生成更新时间，条件写入处理并发覆盖。
- 总偏移沿用 `音频时间 − 歌词来源时间` 的定义。共享偏移替代原始机器偏移，不再与其重复相加；±0.5 秒是在当前基准上做本地微调，点击上传后才共享。重新打开或切回歌曲时读取最新共享值。
- 访客上传表示社区校准贡献，不改变 `humanVerified` 或 ASR 证据状态。网络读取失败不阻止歌词显示，上传失败不清除本地调整，也不报告成功。

接口返回 JSON 且设置 `Cache-Control: no-store`。正式域名 `/api/` 经 ECS 透明转发至 Pages Functions，和 Pages 域名共用同一份 R2 数据。相关回归检查为 `scripts/tests/lyrics_offset_api.test.mjs` 与 `scripts/tests/lyrics_pip.test.mjs`。
