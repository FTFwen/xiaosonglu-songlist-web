# 全库歌词数据准备

范围为当前 `data/xiaosonglu/song_catalog.json` 的全部主曲目，以及 `js/app.js` 声明的内置二创曲目；不包含用户浏览器本地导入。所有机器结果的 `humanVerified` 都为 `false`。本任务不修改网页 UI、不部署。

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

## 后续网页接入约束

网页应按 `key` 及音频 SHA 取数据，保持“歌词作品对应”和“时间轴已校验”的区分。没有通过同步核验的条目可以作为静态歌词/待校准信息，不应自动滚动并声称准确同步。未找到或版本不明必须明确显示，不能借另一首同名歌兜底。
